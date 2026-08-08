import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREVO_PROVIDER_KEY,
  type Principal,
} from "@unimailbox/contracts";
import { TEST_ADMIN_PERMISSIONS } from "@unimailbox/test-kit";
import { AttachmentApplicationService } from "../../src/modules/attachments";
import { UploadTokenCodec } from "../../src/modules/attachments/upload-token";
import { MailboxApplicationService } from "../../src/modules/mailboxes";
import { MessageApplicationService } from "../../src/modules/messages";
import { CursorCodec } from "../../src/modules/messages/cursor";
import { DraftApplicationService } from "../../src/modules/messages/drafts";
import { ProviderRegistry } from "../../src/integrations/providers";
import { createBrevoProviderPlugin } from "../../src/integrations/brevo";
import { createAttachmentStore } from "../../src/platform/attachment-store";
import type { Env } from "../../src/platform/config";

// Tests here cover code paths from M2..M9 too. See issue #14 / blueprint §3.3
// — production admin principals receive only 5 MVP keys, so use the
// fully-privileged test-kit constant to exercise the broader surface.
const principal: Principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "owner@example.com",
  permissions: new Set(TEST_ADMIN_PERMISSIONS),
};

const senderId = "33333333-3333-4333-8333-333333333333";
const domainId = "22222222-2222-4222-8222-222222222222";

function fullEnv(): Env {
  return {
    ...(env as unknown as Env),
    ASSETS: {} as Fetcher,
    AUTH_SIGNING_KEY: "x".repeat(32),
    CREDENTIAL_ENCRYPTION_KEY: "x".repeat(32),
  };
}

function attachmentsService() {
  const codec = new UploadTokenCodec("k".repeat(32));
  const e = fullEnv();
  return new AttachmentApplicationService(e, codec, createAttachmentStore(e));
}

function messageService() {
  const e = fullEnv();
  const app = {
    env: e,
    providers: new ProviderRegistry(
      new Map([[BREVO_PROVIDER_KEY, createBrevoProviderPlugin(vi.fn())]]),
    ),
    credentials: { encrypt: vi.fn(), decrypt: vi.fn() } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    attachmentStore: createAttachmentStore(e),
    storageBackend: "r2" as const,
  };
  return new MessageApplicationService(
    app,
    new MailboxApplicationService(fullEnv()),
    new CursorCodec("k".repeat(32)),
  );
}

function draftService() {
  const e = fullEnv();
  const app = {
    env: e,
    providers: new ProviderRegistry(
      new Map([[BREVO_PROVIDER_KEY, createBrevoProviderPlugin(vi.fn())]]),
    ),
    credentials: { encrypt: vi.fn(), decrypt: vi.fn() } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    attachmentStore: createAttachmentStore(e),
    storageBackend: "r2" as const,
  };
  return new DraftApplicationService(
    app,
    new MailboxApplicationService(fullEnv()),
  );
}

async function seed() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, 'owner@example.com', 'h', 's', 1, 'Owner')`,
    ).bind(principal.userId),
    env.DB.prepare(
      "INSERT INTO domains (id, name) VALUES (?, 'example.com')",
    ).bind(domainId),
    env.DB.prepare(
      `INSERT INTO mailboxes (
         id, domain_id, owner_user_id, address, display_name
       ) VALUES (?, ?, ?, 'inbox@example.com', 'Inbox')`,
    ).bind(senderId, domainId, principal.userId),
  ]);
}

describe("AttachmentApplicationService", () => {
  beforeEach(seed);

  it("creates an attachment upload with a signed token", async () => {
    const service = attachmentsService();
    const url = "https://mail.example/api/v1/attachments/uploads";
    const created = await service.create(
      principal,
      {
        filename: "runbook.txt",
        contentType: "text/plain",
        size: 16,
        disposition: "attachment",
      },
      url,
    );
    expect(created.objectKey).toMatch(/^attachments\//u);
    expect(created.uploadUrl).toContain(created.attachmentId);
  });

  it("rejects an invalid upload token", async () => {
    const service = attachmentsService();
    await expect(
      service.uploadContent(
        "11111111-1111-4111-8111-111111111111",
        "garbage",
        new Request(
          "https://mail.example/api/v1/attachments/uploads/x/content",
          { method: "PUT", body: "hello" },
        ),
      ),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UPLOAD_TOKEN_INVALID" });
  });

  it("hashes and catalogs uploaded content before completing it", async () => {
    const service = attachmentsService();
    const created = await service.create(
      principal,
      {
        filename: "migration.txt",
        contentType: "text/plain",
        size: 3,
        disposition: "attachment",
      },
      "https://mail.example/api/v1/attachments/uploads",
    );
    const token = new URL(created.uploadUrl).searchParams.get("token") ?? "";
    await service.uploadContent(
      created.attachmentId,
      token,
      new Request(created.uploadUrl, {
        method: "PUT",
        headers: created.uploadHeaders,
        body: new Uint8Array([1, 2, 3]),
      }),
    );

    await expect(
      service.complete(principal, created.attachmentId),
    ).resolves.toEqual({
      attachmentId: created.attachmentId,
      status: "uploaded",
    });
    await expect(
      env.DB.prepare(
        `SELECT au.md5, au.file_id, af.object_key
         FROM attachment_uploads au
         JOIN attachment_files af ON af.id = au.file_id
         WHERE au.id = ?`,
      )
        .bind(created.attachmentId)
        .first(),
    ).resolves.toMatchObject({
      md5: "5289df737df57326fcdd22597afb1fac",
      object_key: created.objectKey,
    });
  });

  it("reuses one stored file for byte-identical uploads", async () => {
    const service = attachmentsService();
    const uploads = await Promise.all(
      ["first.txt", "second.txt"].map((filename) =>
        service.create(
          principal,
          {
            filename,
            contentType: "text/plain",
            size: 3,
            disposition: "attachment",
          },
          "https://mail.example/api/v1/attachments/uploads",
        ),
      ),
    );
    for (const upload of uploads) {
      await service.uploadContent(
        upload.attachmentId,
        new URL(upload.uploadUrl).searchParams.get("token") ?? "",
        new Request(upload.uploadUrl, {
          method: "PUT",
          headers: upload.uploadHeaders,
          body: new Uint8Array([1, 2, 3]),
        }),
      );
      await service.complete(principal, upload.attachmentId);
    }
    const rows = await env.DB.prepare(
      `SELECT au.file_id, au.object_key, af.object_key AS stored_object_key,
              au.md5
       FROM attachment_uploads au
       JOIN attachment_files af ON af.id = au.file_id
       ORDER BY au.filename`,
    ).all<{
      file_id: string;
      object_key: string;
      stored_object_key: string;
      md5: string;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(new Set(rows.results.map((row) => row.file_id)).size).toBe(1);
    expect(new Set(rows.results.map((row) => row.object_key)).size).toBe(2);
    expect(new Set(rows.results.map((row) => row.stored_object_key)).size).toBe(
      1,
    );
    expect(new Set(rows.results.map((row) => row.md5))).toEqual(
      new Set(["5289df737df57326fcdd22597afb1fac"]),
    );
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM attachment_files",
      ).first<number>("count"),
    ).resolves.toBe(1);
  });
});

describe("MessageApplicationService", () => {
  beforeEach(seed);

  it("encodes and decodes cursors", async () => {
    const codec = new CursorCodec("k".repeat(32));
    const cursor = { createdAt: "2026-07-27 12:00:00", id: "m1" };
    const token = await codec.encode(cursor);
    await expect(codec.decode(token)).resolves.toEqual(cursor);
  });

  it("returns an empty list for a mailbox with no messages", async () => {
    const result = await messageService().list(principal, senderId, {
      folder: "inbox",
      limit: 50,
    });
    expect(result.items).toEqual([]);
  });

  it("sends a cataloged upload using its canonical stored object", async () => {
    const attachments = attachmentsService();
    const upload = await attachments.create(
      principal,
      {
        filename: "send.txt",
        contentType: "text/plain",
        size: 3,
        disposition: "attachment",
      },
      "https://mail.example/api/v1/attachments/uploads",
    );
    await attachments.uploadContent(
      upload.attachmentId,
      new URL(upload.uploadUrl).searchParams.get("token") ?? "",
      new Request(upload.uploadUrl, {
        method: "PUT",
        headers: upload.uploadHeaders,
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    await attachments.complete(principal, upload.attachmentId);

    const sent = await messageService().send(
      principal,
      {
        mailboxId: senderId,
        to: ["inbox@example.com"],
        cc: [],
        bcc: [],
        subject: "Catalog attachment",
        html: "<p>body</p>",
        text: "body",
        includeSignature: false,
        attachmentIds: [upload.attachmentId],
      },
      "catalog-attachment-send",
    );

    await expect(
      env.DB.prepare(
        `SELECT ma.file_id, ma.object_key, ma.md5, au.status
         FROM message_attachments ma
         JOIN attachment_uploads au ON au.id = ma.upload_id
         WHERE ma.message_id = ?`,
      )
        .bind(sent.messageId)
        .first(),
    ).resolves.toMatchObject({
      md5: "5289df737df57326fcdd22597afb1fac",
      object_key: upload.objectKey,
      status: "consumed",
    });
  });

  it("lists and reads messages; supports setRead/starred/listAttachments/remove", async () => {
    const messages = messageService();
    const mailboxMessageId = "44444444-4444-4444-8444-444444444444";
    const messageId = "55555555-5555-4555-8555-555555555555";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (
           id, thread_id, from_address, subject, html_body, text_body, status
         ) VALUES (?, ?, 'sender@example.com', 'Hello', '<p>hi</p>', 'hi', 'received')`,
      ).bind(messageId, messageId),
      env.DB.prepare(
        `INSERT INTO mailbox_messages (
           id, mailbox_id, message_id, folder
         ) VALUES (?, ?, ?, 'inbox')`,
      ).bind(mailboxMessageId, senderId, messageId),
    ]);

    const list = await messages.list(principal, senderId, {
      folder: "inbox",
      limit: 50,
    });
    expect(list.items).toHaveLength(1);

    const detail = await messages.get(principal, messageId);
    expect(detail.mailboxMessageId).toBe(mailboxMessageId);

    await messages.setRead(principal, messageId, true);
    await messages.setStarred(principal, messageId, true);
    const attachments = await messages.listAttachments(principal, messageId);
    expect(attachments).toEqual([]);

    const readState = await env.DB.prepare(
      "SELECT is_read, is_starred FROM message_user_state WHERE mailbox_message_id = ?",
    )
      .bind(mailboxMessageId)
      .first<{ is_read: number; is_starred: number }>();
    expect(readState).toMatchObject({ is_read: 1, is_starred: 1 });
  });
});

describe("DraftApplicationService", () => {
  beforeEach(seed);

  it("creates, lists, fetches, and removes a draft", async () => {
    const drafts = draftService();
    const draft = await drafts.create(principal, {
      mailboxId: senderId,
      to: ["inbox@example.com"],
      cc: [],
      bcc: [],
      subject: "Test",
      html: "<p>body</p>",
      text: "body",
      includeSignature: true,
      attachmentIds: [],
    });
    expect(draft.id).toBeDefined();

    const list = await drafts.list(principal);
    expect(list).toHaveLength(1);

    const fetched = await drafts.get(principal, draft.id);
    expect(fetched.mailboxId).toBe(senderId);

    await drafts.remove(principal, draft.id);
    expect(await drafts.list(principal)).toHaveLength(0);
  });

  it("rejects a draft creation when the sender mailbox is missing", async () => {
    await expect(
      draftService().create(principal, {
        mailboxId: "99999999-9999-4999-8999-999999999999",
        to: ["inbox@example.com"],
        cc: [],
        bcc: [],
        subject: "Test",
        html: "<p>body</p>",
        text: "body",
        includeSignature: true,
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ code: "MAILBOX_PERMISSION_DENIED" });
  });

  it("keeps deduplicated bytes until the final draft reference is deleted", async () => {
    const attachmentService = attachmentsService();
    const uploads = [];
    for (const filename of ["first.bin", "second.bin"]) {
      const upload = await attachmentService.create(
        principal,
        {
          filename,
          contentType: "application/octet-stream",
          size: 3,
          disposition: "attachment",
        },
        "https://mail.example/api/v1/attachments/uploads",
      );
      await attachmentService.uploadContent(
        upload.attachmentId,
        new URL(upload.uploadUrl).searchParams.get("token") ?? "",
        new Request(upload.uploadUrl, {
          method: "PUT",
          headers: upload.uploadHeaders,
          body: new Uint8Array([1, 2, 3]),
        }),
      );
      await attachmentService.complete(principal, upload.attachmentId);
      uploads.push(upload);
    }
    const drafts = draftService();
    const created = [];
    for (const upload of uploads) {
      created.push(
        await drafts.create(principal, {
          mailboxId: senderId,
          to: ["inbox@example.com"],
          cc: [],
          bcc: [],
          subject: "Shared",
          html: "",
          text: "",
          includeSignature: false,
          attachmentIds: [upload.attachmentId],
        }),
      );
    }
    const objectKey = await env.DB.prepare(
      `SELECT af.object_key
       FROM attachment_files af
       JOIN message_attachments ma ON ma.file_id = af.id
       WHERE ma.message_id = ?`,
    )
      .bind(created[0]?.id)
      .first<string>("object_key");

    await drafts.remove(principal, created[0]!.id);
    expect(
      await createAttachmentStore(fullEnv()).head(objectKey ?? ""),
    ).not.toBeNull();
    await drafts.remove(principal, created[1]!.id);
    expect(
      await env.DB.prepare(
        `SELECT status FROM attachment_uploads ORDER BY filename`,
      ).all(),
    ).toMatchObject({
      results: [{ status: "consumed" }, { status: "consumed" }],
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM message_attachments WHERE file_id = (
           SELECT id FROM attachment_files WHERE object_key = ?
         )`,
      )
        .bind(objectKey)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM attachment_files WHERE object_key = ?",
      )
        .bind(objectKey)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await createAttachmentStore(fullEnv()).head(objectKey ?? ""),
    ).toBeNull();
  });
});
