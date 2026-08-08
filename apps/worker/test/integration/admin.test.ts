import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREVO_PROVIDER_KEY,
  type Principal,
  type ProviderKey,
  type ProviderPlugin,
} from "@unimailbox/contracts";
import { TEST_ADMIN_PERMISSIONS } from "@unimailbox/test-kit";
import { AdminApplicationService } from "../../src/modules/administration";
import { ProviderRegistry } from "../../src/integrations/providers";
import { createBrevoProviderPlugin } from "../../src/integrations/brevo";
import { CredentialCipher } from "../../src/platform/crypto";
import { CursorCodec } from "../../src/modules/messages/cursor";
import { createAttachmentStore } from "../../src/platform/attachment-store";

const cipher = new CredentialCipher("e".repeat(32));

// Tests in this file exercise admin code paths beyond the M1 surface (e.g.
// `user.manage`, `message.read_all`). They need the full permission key set
// at runtime; production admins only ever get the 5-key MVP grant — see
// issue #14 / blueprint §3.3.
const administrator: Principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  permissions: new Set(TEST_ADMIN_PERMISSIONS),
};

function service(fetcher = vi.fn()) {
  const brevoPlugin: ProviderPlugin = createBrevoProviderPlugin(fetcher);
  const envRecord = env as unknown as Record<string, unknown>;
  const baseEnv = {
    DB: env.DB,
    KV: env.KV,
    ATTACHMENTS: envRecord.ATTACHMENTS as R2Bucket | undefined,
    OUTBOUND_QUEUE: env.OUTBOUND_QUEUE,
    ASSETS: {} as Fetcher,
    AUTH_SIGNING_KEY: "x".repeat(32),
    CREDENTIAL_ENCRYPTION_KEY: "e".repeat(32),
  };
  return new AdminApplicationService(
    {
      env: baseEnv,
      providers: new ProviderRegistry(
        new Map<ProviderKey, ProviderPlugin>([
          [BREVO_PROVIDER_KEY, brevoPlugin],
        ]),
      ),
      credentials: cipher,
      attachmentStore: createAttachmentStore(baseEnv),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    new CursorCodec("k".repeat(32)),
  );
}

async function seedAdministrator() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, 'admin@example.com', 'hash', 'salt', 1, 'Admin')`,
    ).bind("11111111-1111-4111-8111-111111111111"),
    env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, 'member@example.com', 'hash', 'salt', 1, 'Member')`,
    ).bind("22222222-2222-4222-8222-222222222222"),
    env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, 'inactive@example.com', 'hash', 'salt', 1, 'Inactive')`,
    ).bind("33333333-3333-4333-8333-333333333333"),
    env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(
      "33333333-3333-4333-8333-333333333333",
    ),
  ]);
}

describe("AdminApplicationService user and role management", () => {
  beforeEach(async () => {
    await seedAdministrator();
  });

  it("lists users and roles", async () => {
    const admin = service();
    const users = await admin.listUsers(administrator);
    const roles = await admin.listRoles(administrator);
    const roleOptions = await admin.listUserRoleOptions({
      ...administrator,
      permissions: new Set(["user.manage"]),
    });
    expect(users.length).toBeGreaterThan(0);
    expect(roles.length).toBeGreaterThan(0);
    expect(roleOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "administrator" }),
      ]),
    );
  });

  it("creates, updates, and deletes a user", async () => {
    const admin = service();
    const created = await admin.createUser(administrator, {
      email: "newuser@example.com",
      password: "strong-password-1234",
      displayName: "New User",
      roleIds: [],
    });
    await admin.updateUser(administrator, created.id, {
      displayName: "Renamed",
      status: "suspended",
      roleIds: [],
    });
    await admin.deleteUser(administrator, created.id);
  });

  it("forbids an administrator from deleting themselves", async () => {
    await expect(
      service().deleteUser(administrator, administrator.userId),
    ).rejects.toMatchObject({ code: "USER_SELF_DELETE_FORBIDDEN" });
  });

  it("creates and updates a custom role", async () => {
    const admin = service();
    const role = await admin.createRole(administrator, {
      name: `Auditor-${crypto.randomUUID()}`,
      description: "Read-only auditor",
      permissions: ["user.read", "role.read"],
    });
    const updated = await admin.updateRole(administrator, role.id, {
      description: "Auditor with analytics access",
      permissions: ["user.read", "analytics.read"],
    });
    expect(updated.permissions).toEqual(["user.read", "analytics.read"]);
    const all = await env.DB.prepare(
      "SELECT id, name, is_system FROM roles ORDER BY id",
    ).all<{ id: string; name: string; is_system: number }>();
    const found = all.results.filter((row) => row.id === role.id);
    expect(found).toHaveLength(1);
    expect(found[0]?.is_system).toBe(0);
    await env.DB.prepare("DELETE FROM roles WHERE id = ?").bind(role.id).run();
  });

  it("rejects invalid permissions when creating a role", async () => {
    await expect(
      service().createRole(administrator, {
        name: "Bad",
        description: "Invalid",
        permissions: ["not.a.permission"],
      }),
    ).rejects.toMatchObject({ code: "ROLE_PERMISSION_INVALID" });
  });

  it("forbids updating or deleting system roles", async () => {
    const admin = service();
    const systemRoleId = await env.DB.prepare(
      "SELECT id FROM roles WHERE is_system = 1 LIMIT 1",
    )
      .first<{ id: string }>()
      .then((row) => row?.id ?? "");
    await expect(
      admin.updateRole(administrator, systemRoleId, {
        description: "tweak",
        permissions: ["user.read"],
      }),
    ).rejects.toMatchObject({ code: "SYSTEM_ROLE_IMMUTABLE" });
  });
});

describe("AdminApplicationService domains and signatures", () => {
  beforeEach(async () => {
    await seedAdministrator();
  });

  async function seedDomain(name: string) {
    const domain = { id: crypto.randomUUID(), name };
    await env.DB.prepare(
      "INSERT INTO domains (id, name, status) VALUES (?, ?, 'active')",
    )
      .bind(domain.id, domain.name)
      .run();
    return domain;
  }

  it("updates and deletes domains", async () => {
    const admin = service();
    const created = await seedDomain("example.com");
    const updated = await admin.updateDomain(administrator, created.id, {
      status: "disabled",
    });
    expect(updated.status).toBe("disabled");
    await expect(
      admin.deleteDomain(administrator, created.id),
    ).resolves.toBeUndefined();
  });

  it("validates a selected provider and sends a domain-scoped test email", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          sender: { email: string };
          to: Array<{ email: string }>;
        };
        expect(body.sender.email).toBe("postmaster@provider.example.com");
        expect(body.to[0]?.email).toBe("owner@example.net");
        return Response.json(
          { messageId: "provider-test-id" },
          { status: 201 },
        );
      },
    );
    const admin = service(fetcher);
    const domain = await seedDomain("provider.example.com");
    const credentialId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO encrypted_credentials (
           id, encrypted_payload, encryption_version
         ) VALUES (?, ?, 1)`,
      ).bind(
        credentialId,
        await cipher.encrypt({
          apiKey: "xkeysib-test",
          webhookSecret: "webhook-test",
        }),
      ),
      env.DB.prepare(
        `INSERT INTO provider_connections (
           id, provider_key, label, credential_id, status
         ) VALUES (?, 'brevo', 'Primary', ?, 'active')`,
      ).bind(connectionId, credentialId),
    ]);

    await expect(
      admin.updateDomain(administrator, domain.id, {
        outboundConnectionId: connectionId,
      }),
    ).resolves.toMatchObject({ outboundConnectionId: connectionId });
    await expect(
      admin.testDomainProvider(
        administrator,
        domain.id,
        "OWNER@EXAMPLE.NET",
        "provider-test-request",
      ),
    ).resolves.toMatchObject({
      domainId: domain.id,
      providerKey: "brevo",
      connectionId,
      providerMessageId: "provider-test-id",
    });
  });

  it("rejects an inactive provider selection and can clear a saved selection", async () => {
    const admin = service();
    const domain = await seedDomain("disabled-provider.example.com");
    const credentialId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO encrypted_credentials (
           id, encrypted_payload, encryption_version
         ) VALUES (?, 'encrypted', 1)`,
      ).bind(credentialId),
      env.DB.prepare(
        `INSERT INTO provider_connections (
           id, provider_key, label, credential_id, status
         ) VALUES (?, 'brevo', 'Disabled', ?, 'disabled')`,
      ).bind(connectionId, credentialId),
    ]);
    await expect(
      admin.updateDomain(administrator, domain.id, {
        outboundConnectionId: connectionId,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_INACTIVE" });
    await expect(
      admin.updateDomain(administrator, domain.id, {
        outboundConnectionId: null,
      }),
    ).resolves.toMatchObject({ outboundConnectionId: null });
  });

  it("forbids deleting a domain that still has mailboxes", async () => {
    const admin = service();
    const domain = await seedDomain("active.example.com");
    await env.DB.prepare(
      `INSERT INTO mailboxes (
         id, domain_id, owner_user_id, address, display_name
       ) VALUES (?, ?, ?, 'someone@active.example.com', 'Someone')`,
    )
      .bind(
        "44444444-4444-4444-8444-444444444444",
        domain.id,
        administrator.userId,
      )
      .run();
    await expect(
      admin.deleteDomain(administrator, domain.id),
    ).rejects.toMatchObject({ code: "DOMAIN_IN_USE" });
  });

  it("returns and updates a signature", async () => {
    const admin = service();
    const domain = await seedDomain("sig.example.com");
    const empty = await admin.getSignature(administrator, domain.id);
    expect(empty).toMatchObject({ domain_id: domain.id });
    await admin.putSignature(administrator, domain.id, {
      html: "<p>UniMailbox Team</p>",
      text: "UniMailbox Team",
      enabled: true,
    });
    const stored = await admin.getSignature(administrator, domain.id);
    expect(stored).toMatchObject({ is_enabled: 1 });
  });
});

describe("AdminApplicationService settings and analytics", () => {
  beforeEach(async () => {
    await seedAdministrator();
  });

  it("returns the current settings", async () => {
    const settings = await service().getSettings(administrator);
    expect(settings).toBeTruthy();
  });

  it("updates editable settings and rejects unknown keys", async () => {
    const admin = service();
    await expect(
      admin.updateSettings(administrator, {
        site_title: "UniMailbox",
        not_a_real_key: "no",
      }),
    ).rejects.toMatchObject({ code: "SETTINGS_INPUT_INVALID" });
    await admin.updateSettings(administrator, {
      site_title: "UniMailbox",
      registration_enabled: 1,
    });
  });

  it("returns aggregate analytics", async () => {
    const analytics = await service().analytics(administrator);
    expect(analytics).toBeTruthy();
  });

  it("lists webhook events and audit events", async () => {
    const admin = service();
    const events = await admin.listWebhookEvents(administrator, 50);
    const audit = await admin.listAuditEvents(administrator, {
      limit: 50,
      query: "test",
    });
    expect(Array.isArray(events)).toBe(true);
    expect(Array.isArray(audit)).toBe(true);
  });
});

describe("AdminApplicationService global message access", () => {
  const domainId = "44444444-4444-4444-8444-444444444444";
  const mailboxId = "55555555-5555-4555-8555-555555555555";
  const messageId = "66666666-6666-4666-8666-666666666666";
  const attachmentId = "99999999-9999-4999-8999-999999999999";
  const attachmentFileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  beforeEach(async () => {
    await seedAdministrator();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO domains (id, name) VALUES (?, 'private.example.com')",
      ).bind(domainId),
      env.DB.prepare(
        `INSERT INTO mailboxes (
           id, domain_id, owner_user_id, address, display_name
         ) VALUES (?, ?, ?, 'private@private.example.com', 'Private')`,
      ).bind(mailboxId, domainId, "22222222-2222-4222-8222-222222222222"),
      env.DB.prepare(
        `INSERT INTO messages (
           id, domain_id, from_address, from_name, subject, html_body,
           text_body, status
         ) VALUES (?, ?, 'sender@example.net', 'Sender', 'Private subject',
                   '<p>Private body</p>', 'Private body', 'received')`,
      ).bind(messageId, domainId),
      env.DB.prepare(
        `INSERT INTO message_recipients (message_id, type, address)
         VALUES (?, 'to', 'private@private.example.com')`,
      ).bind(messageId),
      env.DB.prepare(
        `INSERT INTO mailbox_messages (id, mailbox_id, message_id, folder)
         VALUES (?, ?, ?, 'inbox')`,
      ).bind("77777777-7777-4777-8777-777777777777", mailboxId, messageId),
      env.DB.prepare(
        `INSERT INTO attachment_files (
           id, object_key, dedupe_key, md5, size_bytes
         ) VALUES (?, 'attachments/private', ?,
                   '5ebe2294ecd0e0f08eab7690d2a6ee69', 6)`,
      ).bind(attachmentFileId, "5ebe2294ecd0e0f08eab7690d2a6ee69:6"),
      env.DB.prepare(
        `INSERT INTO message_attachments (
           id, message_id, object_key, filename, mime_type, size_bytes,
           disposition, file_id, md5
         ) VALUES (?, ?, 'attachments/private', 'secret.txt', 'text/plain', 6,
                   'attachment', ?, '5ebe2294ecd0e0f08eab7690d2a6ee69')`,
      ).bind(attachmentId, messageId, attachmentFileId),
    ]);
    await env.ATTACHMENTS!.put("attachments/private", "secret", {
      httpMetadata: { contentType: "text/plain" },
    });
  });

  it("lists and views messages outside the administrator's mailbox access", async () => {
    const admin = service();
    const listed = await admin.listMessages(administrator, { limit: 50 });
    expect(listed).toMatchObject({
      nextCursor: null,
      items: [
        {
          id: messageId,
          domain_name: "private.example.com",
          mailbox_addresses: "private@private.example.com",
          recipient_addresses: "private@private.example.com",
          subject: "Private subject",
        },
      ],
    });
    await expect(
      admin.listAttachments(administrator, { q: "%", limit: 50 }),
    ).resolves.toMatchObject({ items: [] });

    const detail = await admin.getMessage(
      administrator,
      messageId,
      "admin-message-request",
    );
    expect(detail).toMatchObject({
      id: messageId,
      html_body: "<p>Private body</p>",
      recipients: [{ address: "private@private.example.com", type: "to" }],
      mailboxes: [
        {
          id: mailboxId,
          address: "private@private.example.com",
          folder: "inbox",
        },
      ],
      attachments: [
        {
          id: attachmentId,
          filename: "secret.txt",
          md5: "5ebe2294ecd0e0f08eab7690d2a6ee69",
        },
      ],
    });
    await expect(
      env.DB.prepare(
        `SELECT actor_user_id, action, resource_id, request_id
         FROM audit_events WHERE resource_id = ?`,
      )
        .bind(messageId)
        .first(),
    ).resolves.toMatchObject({
      actor_user_id: administrator.userId,
      action: "message.content.view",
      resource_id: messageId,
      request_id: "admin-message-request",
    });
  });

  it("searches, downloads, and audits global attachments", async () => {
    const admin = service();
    const listed = await admin.listAttachments(administrator, {
      q: "5ebe2294",
      limit: 50,
    });
    expect(listed).toMatchObject({
      nextCursor: null,
      items: [
        {
          id: attachmentId,
          message_id: messageId,
          filename: "secret.txt",
          md5: "5ebe2294ecd0e0f08eab7690d2a6ee69",
          reference_count: 1,
        },
      ],
    });
    const response = await admin.downloadAttachment(
      administrator,
      attachmentId,
      "admin-attachment-request",
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("secret");
    await expect(
      env.DB.prepare(
        `SELECT action, resource_type, resource_id, request_id
         FROM audit_events WHERE request_id = 'admin-attachment-request'`,
      ).first(),
    ).resolves.toMatchObject({
      action: "attachment.content.download",
      resource_type: "attachment",
      resource_id: attachmentId,
      request_id: "admin-attachment-request",
    });
  });

  it("scopes attachment access to the reader's authorized mailboxes", async () => {
    const mailboxReader: Principal = {
      userId: "22222222-2222-4222-8222-222222222222",
      email: "member@example.com",
      permissions: new Set(["message.read", "attachment.read"]),
    };
    const admin = service();
    await expect(
      admin.listMessages(mailboxReader, { limit: 50 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
    await expect(
      admin.getMessage(mailboxReader, messageId, "denied-request"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
    await expect(
      admin.listAttachments(mailboxReader, { limit: 50 }),
    ).resolves.toMatchObject({
      items: [{ id: attachmentId, message_id: messageId }],
    });
    const memberDownload = await admin.downloadAttachment(
      mailboxReader,
      attachmentId,
      "member-attachment-request",
    );
    await expect(memberDownload.text()).resolves.toBe("secret");

    const unrelatedReader: Principal = {
      userId: administrator.userId,
      email: administrator.email,
      permissions: new Set(["attachment.read"]),
    };
    await expect(
      admin.listAttachments(unrelatedReader, { limit: 50 }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      admin.downloadAttachment(unrelatedReader, attachmentId, "denied-request"),
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND", status: 404 });
    const readerWithoutAttachmentPermission: Principal = {
      ...mailboxReader,
      permissions: new Set(["message.read"]),
    };
    await expect(
      admin.listAttachments(readerWithoutAttachmentPermission, { limit: 50 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
    await expect(
      admin.downloadAttachment(
        readerWithoutAttachmentPermission,
        attachmentId,
        "permission-denied-request",
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
    const deniedAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE request_id IN (?, ?)`,
    )
      .bind("denied-request", "permission-denied-request")
      .first<number>("count");
    expect(deniedAudit).toBe(0);
  });

  it("manages mailbox access for a target user without disturbing ownership", async () => {
    const admin = service();
    const memberId = "22222222-2222-4222-8222-222222222222";
    const viewerDomainId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ownerMailboxId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sharedMailboxId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO domains (id, name) VALUES (?, 'shared.example.com')",
      ).bind(viewerDomainId),
      env.DB.prepare(
        `INSERT INTO mailboxes (
           id, domain_id, owner_user_id, address, display_name
         ) VALUES (?, ?, ?, 'someone@shared.example.com', 'Owner')`,
      ).bind(ownerMailboxId, viewerDomainId, administrator.userId),
      env.DB.prepare(
        `INSERT INTO mailboxes (
           id, domain_id, owner_user_id, address, display_name
         ) VALUES (?, ?, ?, 'support@shared.example.com', 'Support')`,
      ).bind(sharedMailboxId, viewerDomainId, memberId),
    ]);

    const emptyList = await admin.listUserMailboxes(administrator, memberId);
    // The shared seed mailbox is owned by memberId, so it shows up by default;
    // we only assert the new mailboxes we add below are absent at first.
    expect(emptyList.items.map((item) => item.mailboxId)).not.toContain(
      ownerMailboxId,
    );
    expect(emptyList.available).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mailboxId: ownerMailboxId,
          address: "someone@shared.example.com",
        }),
      ]),
    );

    const added = await admin.addUserMailboxAccess(
      administrator,
      memberId,
      { mailboxId: ownerMailboxId, role: "viewer" },
      "user-mailbox-add",
    );
    expect(added).toMatchObject({
      mailboxId: ownerMailboxId,
      address: "someone@shared.example.com",
      role: "viewer",
      ownerEmail: "admin@example.com",
    });
    await expect(
      env.DB.prepare(
        `SELECT role FROM mailbox_members
         WHERE mailbox_id = ? AND user_id = ?`,
      )
        .bind(ownerMailboxId, memberId)
        .first<{ role: string }>(),
    ).resolves.toMatchObject({ role: "viewer" });

    const listed = await admin.listUserMailboxes(administrator, memberId);
    const listedIds = listed.items.map((item) => item.mailboxId);
    expect(listedIds).toContain(ownerMailboxId);
    expect(listedIds).toContain(sharedMailboxId);
    expect(listed.available.map((item) => item.mailboxId)).not.toContain(
      ownerMailboxId,
    );
    const ownerEntry = listed.items.find(
      (item) => item.mailboxId === sharedMailboxId,
    );
    expect(ownerEntry?.role).toBe("owner");

    const updated = await admin.updateUserMailboxAccess(
      administrator,
      memberId,
      ownerMailboxId,
      { role: "admin" },
      "user-mailbox-update",
    );
    expect(updated.role).toBe("admin");

    await expect(
      admin.addUserMailboxAccess(
        administrator,
        administrator.userId,
        { mailboxId: ownerMailboxId, role: "viewer" },
        "self-owner-add",
      ),
    ).rejects.toMatchObject({ code: "MAILBOX_OWNER_MEMBERSHIP_INVALID" });

    await admin.removeUserMailboxAccess(
      administrator,
      memberId,
      ownerMailboxId,
      "user-mailbox-remove",
    );
    await expect(
      env.DB.prepare(
        `SELECT 1 FROM mailbox_members
         WHERE mailbox_id = ? AND user_id = ?`,
      )
        .bind(ownerMailboxId, memberId)
        .first(),
    ).resolves.toBeNull();
    const afterRemoval = await admin.listUserMailboxes(administrator, memberId);
    expect(afterRemoval.available.map((item) => item.mailboxId)).toContain(
      ownerMailboxId,
    );
    await expect(
      admin.removeUserMailboxAccess(
        administrator,
        memberId,
        ownerMailboxId,
        "user-mailbox-remove-twice",
      ),
    ).rejects.toMatchObject({ code: "MAILBOX_ACCESS_TARGET_NOT_FOUND" });

    await expect(
      admin.listUserMailboxes(
        administrator,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    await expect(
      admin.addUserMailboxAccess(
        administrator,
        memberId,
        { mailboxId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", role: "viewer" },
        "missing-mailbox",
      ),
    ).rejects.toMatchObject({ code: "MAILBOX_NOT_FOUND" });
  });

  it("paginates the complete message set with a signed cursor", async () => {
    const secondMessageId = "88888888-8888-4888-8888-888888888888";
    await env.DB.prepare(
      `INSERT INTO messages (
         id, domain_id, from_address, from_name, subject, status, created_at
       ) VALUES (?, ?, 'second@example.net', 'Second', 'Second subject',
                 'received', '2026-08-02 13:00:00')`,
    )
      .bind(secondMessageId, domainId)
      .run();
    const admin = service();
    const first = await admin.listMessages(administrator, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await admin.listMessages(administrator, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(
      [...first.items, ...second.items].map((message) => message.id).sort(),
    ).toEqual([messageId, secondMessageId].sort());
    expect(second.nextCursor).toBeNull();
    await expect(
      admin.listMessages(administrator, { limit: 1, cursor: "tampered" }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });
});
