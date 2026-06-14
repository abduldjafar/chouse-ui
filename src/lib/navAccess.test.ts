import { describe, it, expect } from "vitest";
import { RBAC_PERMISSIONS } from "@/stores";
import {
  ADMIN_TAB_PERMISSIONS,
  ADMIN_ACCESS_PERMISSIONS,
  MONITORING_ACCESS_PERMISSIONS,
  EXPLORER_ACCESS_PERMISSIONS,
} from "./navAccess";

describe("navAccess — admin", () => {
  it("ADMIN_ACCESS_PERMISSIONS covers every admin tab's permission", () => {
    // Guards the original bug: the page/nav access list must include the
    // unlocking permission of every tab, or a user with only that tab's
    // permission gets bounced from /admin.
    for (const perms of Object.values(ADMIN_TAB_PERMISSIONS)) {
      for (const perm of perms) {
        expect(ADMIN_ACCESS_PERMISSIONS).toContain(perm);
      }
    }
  });

  it("includes the previously-missing tab permissions", () => {
    expect(ADMIN_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.SSO_VIEW);
    expect(ADMIN_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.CONNECTIONS_VIEW);
    expect(ADMIN_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.DATA_ACCESS_VIEW);
    expect(ADMIN_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.CH_USERS_VIEW);
    expect(ADMIN_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.CH_ROLES_VIEW);
    expect(ADMIN_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.AI_MODELS_VIEW);
  });

  it("has no duplicate permissions", () => {
    expect(new Set(ADMIN_ACCESS_PERMISSIONS).size).toBe(ADMIN_ACCESS_PERMISSIONS.length);
  });
});

describe("navAccess — monitoring & explorer", () => {
  it("monitoring list is non-empty and includes core viewers", () => {
    expect(MONITORING_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.LIVE_QUERIES_VIEW);
    expect(MONITORING_ACCESS_PERMISSIONS).toContain(RBAC_PERMISSIONS.ERRORS_VIEW);
  });

  it("explorer list includes database and table view", () => {
    expect(EXPLORER_ACCESS_PERMISSIONS).toEqual([
      RBAC_PERMISSIONS.DB_VIEW,
      RBAC_PERMISSIONS.TABLE_VIEW,
    ]);
  });
});
