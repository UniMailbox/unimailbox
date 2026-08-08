export type UserId = string;
export type DomainId = string;
export type MailboxId = string;
export type MessageId = string;
export type AttachmentId = string;
export type SessionId = string;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const UserStatus = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const DomainStatus = {
  ACTIVE: "active",
  DISABLED: "disabled",
} as const;
export type DomainStatus = (typeof DomainStatus)[keyof typeof DomainStatus];

export const MailboxRole = {
  VIEWER: "viewer",
  SENDER: "sender",
  ADMIN: "admin",
} as const;
export type MailboxRole = (typeof MailboxRole)[keyof typeof MailboxRole];

export const MailboxFolder = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFTS: "drafts",
  ARCHIVE: "archive",
  TRASH: "trash",
} as const;
export type MailboxFolder = (typeof MailboxFolder)[keyof typeof MailboxFolder];

export const MessageStatus = {
  DRAFT: "draft",
  QUEUED: "queued",
  SENDING: "sending",
  SENT: "sent",
  DELIVERED: "delivered",
  DELAYED: "delayed",
  BOUNCED: "bounced",
  COMPLAINED: "complained",
  FAILED: "failed",
  RECEIVED: "received",
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

export const RecipientType = {
  TO: "to",
  CC: "cc",
  BCC: "bcc",
} as const;
export type RecipientType = (typeof RecipientType)[keyof typeof RecipientType];

export const AttachmentDisposition = {
  ATTACHMENT: "attachment",
  INLINE: "inline",
} as const;
export type AttachmentDisposition =
  (typeof AttachmentDisposition)[keyof typeof AttachmentDisposition];

export type ProviderKey = string & { readonly __brand: "ProviderKey" };
export const BREVO_PROVIDER_KEY = "brevo" as ProviderKey;
export const RESEND_PROVIDER_KEY = "resend" as ProviderKey;

export function parseProviderKey(value: string): ProviderKey {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(value)) {
    throw new DomainError("INVALID_PROVIDER_KEY", "Invalid provider key");
  }
  return value as ProviderKey;
}

export const PERMISSION_KEYS = [
  "message.read",
  "message.read_all",
  "message.send",
  "message.delete",
  "attachment.read",
  "mailbox.create",
  "mailbox.manage",
  "mailbox.share",
  "user.read",
  "user.manage",
  "role.read",
  "role.manage",
  "domain.read",
  "domain.manage",
  "signature.read",
  "signature.manage",
  "settings.read",
  "settings.manage",
  "provider.sync",
  "webhook_event.read",
  "webhook_event.delete",
  "analytics.read",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * MVP role-permission sets — see issue #14 / blueprint §3.3.
 *
 * `PERMISSION_KEYS` retains every permission string (currently 22) so that
 * call sites like `assertPermission(principal, "user.manage")` still
 * type-check during the MVP cut. At runtime only the administrator role is
 * seeded (migrations/0002_seed_permissions.sql, after the M1 trim described
 * in issue #16 / #17); the 5 keys below are the only ones the role grants.
 * Removing the remaining strings from `PERMISSION_KEYS` is deferred to the
 * sub-issues below so the refactor can land one route group at a time.
 *
 * Deferred permission keys and the milestone that re-introduces them:
 *   message.read_all   – re-enable in M2 (shared mailbox, #23) so admin can
 *                        list every message across managed domains
 *   message.delete     – M2 (#23)
 *   attachment.read    – M6 (#27) — depends on the attachment route coming
 *                        back first
 *   mailbox.manage     – M2 (#23)
 *   mailbox.share      – M2 (#23)
 *   user.read          – behind `settings.manage` for M1; reintroduce in M5
 *                        (#26) once the admin user-management screen ships
 *   user.manage        – M5 (#26)
 *   role.read          – M5 (#26)
 *   role.manage        – M5 (#26)
 *   domain.read        – M5 (#26)
 *   domain.manage      – M5 (#26)
 *   signature.read     – M5 (#26)
 *   signature.manage   – M5 (#26)
 *   provider.sync      – M4 (#25) (when a second provider lights up)
 *   webhook_event.read – M4 (#25) (webhook audit becomes meaningful with a
 *                        second provider)
 *   webhook_event.delete – M4 (#25)
 *   analytics.read     – M9 (#30)
 */
export const ADMINISTRATOR_PERMISSIONS: readonly PermissionKey[] = [
  "message.read",
  "message.send",
  "mailbox.create",
  "settings.read",
  "settings.manage",
];
export const MEMBER_PERMISSIONS: readonly PermissionKey[] = [];

export interface Principal {
  userId: UserId;
  email: string;
  permissions: ReadonlySet<PermissionKey>;
}

export const InstallationStep = {
  ADMIN_BOOTSTRAP: "admin_bootstrap",
  COMPLETE: "complete",
} as const;

export type InstallationStep =
  (typeof InstallationStep)[keyof typeof InstallationStep];

export interface InstallationStatus {
  installationVersion: number;
  stateVersion: number;
  currentStep: InstallationStep;
  completedSteps: string[];
  recoverableError?: {
    code: string;
    message: string;
  };
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const PRESIGN_TTL_SECONDS = 300;

export const statusRank: Record<MessageStatus, number> = {
  draft: 0,
  queued: 10,
  sending: 20,
  sent: 30,
  delayed: 40,
  delivered: 50,
  bounced: 60,
  failed: 60,
  complained: 70,
  received: 100,
};

export interface ComposeDraft {
  id: string;
  mailboxId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  parentMessageId?: string;
  includeSignature: boolean;
  attachments: Array<{
    attachmentId: string;
    filename: string;
    size: number;
    uploadState: "pending" | "uploading" | "ready" | "failed";
  }>;
  updatedAt: number;
}
