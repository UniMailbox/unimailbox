import {
  PERMISSION_KEYS,
  type PermissionKey,
  type Principal,
} from "@unimailbox/contracts";

/**
 * Test-only superset of every permission the worker currently understands.
 *
 * `ADMINISTRATOR_PERMISSIONS` in the contracts package is the MVP-runtime
 * grant (only 5 keys per issue #14 / blueprint §3.3). Production admin
 * principals receive those five; integration tests however exercise admin
 * code paths beyond the MVP surface (e.g. `user.manage`, `message.read_all`),
 * which require the full key set. Use this constant in tests so each one
 * stays explicit about wanting full powers, rather than re-deriving it via
 * `new Set([...PERMISSION_KEYS])` everywhere.
 */
export const TEST_ADMIN_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS;

export function createPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
    email: "member@example.com",
    permissions: new Set(TEST_ADMIN_PERMISSIONS),
    ...overrides,
  };
}

export function fixedClock(iso = "2026-07-27T00:00:00.000Z") {
  return {
    now: () => new Date(iso),
  };
}
