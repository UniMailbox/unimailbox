import { describe, expect, it } from "vitest";
import {
  ADMINISTRATOR_PERMISSIONS,
  MEMBER_PERMISSIONS,
} from "@unimailbox/contracts";
import { assertPermission } from "../../src/modules/administration";

describe("administration permission boundary", () => {
  it("requires the exact declared permission", () => {
    // MVP administrator (issue #15): only the 5 keys listed in blueprint §3.3.
    // Re-arm the broader assertions once M2/M5 introduce the rest.
    const admin = {
      userId: "admin",
      email: "admin@example.com",
      permissions: new Set(ADMINISTRATOR_PERMISSIONS),
    };

    expect(() => assertPermission(admin, "message.read")).not.toThrow();
    expect(() => assertPermission(admin, "settings.manage")).not.toThrow();
    expect(() => assertPermission(admin, "user.manage")).toThrowError(
      /user.manage/,
    );
    expect(() => assertPermission(admin, "message.read_all")).toThrowError(
      /message.read_all/,
    );
    expect(() => assertPermission(admin, "attachment.read")).toThrowError(
      /attachment.read/,
    );
  });

  it("denies every permission to the absent member role in M1", () => {
    // The `member` role is not seeded in M1; MEMBER_PERMISSIONS is intentionally
    // empty (issue #16, restored in M2 via issue #23). Verify the runtime
    // boundary holds even if a principal were built from the constant.
    const phantomMember = {
      userId: "user",
      email: "member@example.com",
      permissions: new Set(MEMBER_PERMISSIONS),
    };

    expect(MEMBER_PERMISSIONS).toEqual([]);
    expect(() => assertPermission(phantomMember, "message.read")).toThrowError(
      /message.read/,
    );
    expect(() =>
      assertPermission(phantomMember, "settings.read"),
    ).toThrowError(/settings\.read/);
  });
});
