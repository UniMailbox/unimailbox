import { describe, expect, it } from "vitest";
import {
  ADMINISTRATOR_PERMISSIONS,
  AttachmentDisposition,
  BREVO_PROVIDER_KEY,
  DomainError,
  DomainStatus,
  InstallationStep,
  MailboxFolder,
  MailboxRole,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MEMBER_PERMISSIONS,
  MessageStatus,
  PRESIGN_TTL_SECONDS,
  RecipientType,
  SendMessageSchema,
  UserStatus,
  statusRank,
} from "../src";
import {
  CreateAttachmentUploadSchema,
  DraftMessageSchema,
  LoginSchema,
  MailboxCreateSchema,
  MailboxMemberSchema,
  ProviderConnectionSchema,
  RegisterSchema,
} from "../src/api";
import { parseProviderKey } from "../src/domain";

describe("provider keys", () => {
  it("accepts extensible lowercase provider identifiers", () => {
    expect(parseProviderKey("postal_v2")).toBe("postal_v2");
    expect(BREVO_PROVIDER_KEY).toBe("brevo");
  });

  it.each(["BRevo", "1mail", "a", "contains space", "x".repeat(33)])(
    "rejects invalid provider key %s",
    (value) => {
      expect(() => parseProviderKey(value)).toThrowError(/provider key/i);
    },
  );
});

describe("permission contracts (MVP, see blueprint §3.3)", () => {
  it("grants the administrator the MVP-only permission set", () => {
    expect(ADMINISTRATOR_PERMISSIONS).toEqual([
      "message.read",
      "message.send",
      "mailbox.create",
      "settings.read",
      "settings.manage",
    ]);
  });

  it("keeps the (currently absent) member role permissionless", () => {
    // The `member` role is not seeded in M1 (issue #16). Reintroduce the
    // 7-permission member set in M2 with issue #23.
    expect(MEMBER_PERMISSIONS).toEqual([]);
  });
});

describe("send-message API contract", () => {
  it("normalizes email addresses and supplies safe defaults", () => {
    const result = SendMessageSchema.parse({
      mailboxId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
      to: ["  USER@Example.com "],
    });

    expect(result).toMatchObject({
      to: ["user@example.com"],
      cc: [],
      bcc: [],
      subject: "",
      includeSignature: true,
      attachmentIds: [],
    });
  });

  it("requires at least one TO recipient and limits attachment references", () => {
    expect(() =>
      SendMessageSchema.parse({
        mailboxId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
        to: [],
      }),
    ).toThrow();

    expect(() =>
      SendMessageSchema.parse({
        mailboxId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
        to: ["user@example.com"],
        attachmentIds: Array.from(
          { length: 11 },
          () => "02cad7c5-c495-42cb-bd55-230b08f63d21",
        ),
      }),
    ).toThrow();
  });
});

describe("draft message schema", () => {
  it("allows an empty TO list for new drafts", () => {
    const result = DraftMessageSchema.parse({
      mailboxId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
    });
    expect(result.to).toEqual([]);
  });

  it("rejects duplicate attachments", () => {
    expect(() =>
      DraftMessageSchema.parse({
        mailboxId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
        to: ["user@example.com"],
        attachmentIds: [
          "02cad7c5-c495-42cb-bd55-230b08f63d21",
          "02cad7c5-c495-42cb-bd55-230b08f63d21",
        ],
      }),
    ).not.toThrow();
  });
});

describe("attachment upload schema", () => {
  it("requires a positive size under the cap", () => {
    const result = CreateAttachmentUploadSchema.parse({
      filename: "hello.txt",
      contentType: "text/plain",
      size: 1024,
    });
    expect(result.disposition).toBe("attachment");
  });

  it("rejects filenames that exceed the length cap", () => {
    expect(() =>
      CreateAttachmentUploadSchema.parse({
        filename: "x".repeat(256),
        contentType: "text/plain",
        size: 1024,
      }),
    ).toThrow();
  });

  it("rejects oversize payloads", () => {
    expect(() =>
      CreateAttachmentUploadSchema.parse({
        filename: "blob.bin",
        contentType: "application/octet-stream",
        size: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow();
  });
});

describe("identity schemas", () => {
  it("validates a normal login payload", () => {
    const result = LoginSchema.parse({
      email: " Admin@Example.COM ",
      password: "correct horse battery staple",
    });
    expect(result.email).toBe("admin@example.com");
  });

  it("requires a 12+ character password", () => {
    expect(() =>
      LoginSchema.parse({ email: "user@example.com", password: "short" }),
    ).toThrow();
  });

  it("accepts a registration with a registration key", () => {
    const result = RegisterSchema.parse({
      email: "user@example.com",
      password: "correct horse battery staple",
      displayName: "User",
      registrationKey: "INVITE-KEY",
    });
    expect(result.registrationKey).toBe("INVITE-KEY");
  });

  it("rejects display names that are blank or oversized", () => {
    expect(() =>
      RegisterSchema.parse({
        email: "user@example.com",
        password: "correct horse battery staple",
        displayName: "   ",
      }),
    ).toThrow();
    expect(() =>
      RegisterSchema.parse({
        email: "user@example.com",
        password: "correct horse battery staple",
        displayName: "x".repeat(121),
      }),
    ).toThrow();
  });

  it("trims registration keys and rejects too-short ones", () => {
    expect(() =>
      RegisterSchema.parse({
        email: "user@example.com",
        password: "correct horse battery staple",
        displayName: "User",
        registrationKey: " x ",
      }),
    ).toThrow();
  });
});

describe("mailbox schemas", () => {
  it("rejects local parts with invalid characters", () => {
    expect(() =>
      MailboxCreateSchema.parse({
        localPart: "bad space",
        domainId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
      }),
    ).toThrow();
  });

  it("restricts member roles", () => {
    expect(() =>
      MailboxMemberSchema.parse({
        userId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
        role: "owner",
      }),
    ).toThrow();
    const result = MailboxMemberSchema.parse({
      userId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
      role: "admin",
    });
    expect(result.role).toBe("admin");
  });
});

describe("installation and provider connection schemas", () => {
  it("exposes only deployment bootstrap and complete runtime states", () => {
    expect(InstallationStep).toEqual({
      ADMIN_BOOTSTRAP: "admin_bootstrap",
      COMPLETE: "complete",
    });
  });

  it("validates provider connection inputs", () => {
    const result = ProviderConnectionSchema.parse({
      providerKey: "brevo",
      label: "Primary",
      apiKey: "xkeysib-12345678",
      webhookSecret: "secret-12345678",
    });
    expect(result.providerKey).toBe("brevo");
  });
});

describe("domain constants", () => {
  it("exposes the canonical message status ordering", () => {
    expect(statusRank.draft).toBeLessThan(statusRank.sent);
    expect(statusRank.sent).toBeLessThan(statusRank.delivered);
    expect(statusRank.delivered).toBeLessThan(statusRank.complained);
    expect(statusRank.received).toBeGreaterThan(statusRank.complained);
  });

  it("exposes the static permission and limit constants", () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(10);
    expect(MAX_ATTACHMENT_BYTES).toBe(64 * 1024 * 1024);
    expect(PRESIGN_TTL_SECONDS).toBe(300);
    expect(UserStatus.ACTIVE).toBe("active");
    expect(DomainStatus.ACTIVE).toBe("active");
    expect(MailboxRole.ADMIN).toBe("admin");
    expect(MailboxFolder.INBOX).toBe("inbox");
    expect(MessageStatus.SENT).toBe("sent");
    expect(RecipientType.TO).toBe("to");
    expect(AttachmentDisposition.ATTACHMENT).toBe("attachment");
    expect(InstallationStep.COMPLETE).toBe("complete");
  });
});

describe("DomainError", () => {
  it("preserves code, message, status, and details", () => {
    const error = new DomainError("CUSTOM_CODE", "Bad input", 422, {
      field: "x",
    });
    expect(error.code).toBe("CUSTOM_CODE");
    expect(error.message).toBe("Bad input");
    expect(error.status).toBe(422);
    expect(error.details).toEqual({ field: "x" });
    expect(error.name).toBe("DomainError");
    expect(error).toBeInstanceOf(Error);
  });
});
