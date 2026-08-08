import { describe, expect, it } from "vitest";
import {
  ADMIN_RESOURCE_PERMISSIONS,
  ADMINISTRATOR_PERMISSIONS,
  MEMBER_PERMISSIONS,
  PERMISSION_KEYS,
  adminConsoleEntryResource,
  canOpenAdminConsole,
  type AdminResourceKey,
} from "../src";

describe("administration console permission map", () => {
  it("covers every console resource the web client can route to", () => {
    // The web router derives its `/admin/<segment>` allow-list from this map,
    // so a new console page without an entry here is a routing hole.
    expect(Object.keys(ADMIN_RESOURCE_PERMISSIONS).sort()).toEqual([
      "analytics",
      "attachments",
      "audit-events",
      "domains",
      "messages",
      "provider-connections",
      "roles",
      "settings",
      "signatures",
      "users",
      "webhook-events",
    ]);
  });

  it("only maps to permissions the Worker actually knows", () => {
    for (const permission of Object.values(ADMIN_RESOURCE_PERMISSIONS)) {
      expect(PERMISSION_KEYS).toContain(permission);
    }
  });

  it("lets an administrator open the console on the settings entry", () => {
    // In M1 admin only carries `settings.read` among the console-permission
    // keys listed in ADMIN_RESOURCE_PERMISSIONS (see blueprint §3.3 and
    // issue #14). The other entries (`users`, `messages`, …) light up
    // across M2 (issue #23) and M5 (issue #26).
    expect(canOpenAdminConsole(ADMINISTRATOR_PERMISSIONS)).toBe(true);
    expect(adminConsoleEntryResource(ADMINISTRATOR_PERMISSIONS)).toBe(
      "settings",
    );
  });

  it("has no member role permissions in M1", () => {
    // The member role is absent in M1 (issue #16 / #23). When M2 restores it,
    // re-add the original assertion mirroring the removed test below.
    expect(MEMBER_PERMISSIONS).toEqual([]);
    expect(canOpenAdminConsole(MEMBER_PERMISSIONS)).toBe(false);
    expect(adminConsoleEntryResource(MEMBER_PERMISSIONS)).toBeNull();
  });

  it("grants the console to a principal holding a single console permission", () => {
    const resource: AdminResourceKey = "webhook-events";
    expect(canOpenAdminConsole([ADMIN_RESOURCE_PERMISSIONS[resource]])).toBe(
      true,
    );
  });

  it("denies the console when no permissions are held at all", () => {
    expect(canOpenAdminConsole([])).toBe(false);
    expect(adminConsoleEntryResource([])).toBeNull();
  });
});
