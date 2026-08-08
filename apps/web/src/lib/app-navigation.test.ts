import { describe, expect, it } from "vitest";
import { ADMINISTRATOR_PERMISSIONS } from "@unimailbox/contracts";
import { createI18nInstance } from "../i18n";
import {
  folderPath,
  getNavigationModel,
  isNavigationGroupActive,
} from "./app-navigation";

describe("authenticated navigation model", () => {
  it("keeps mail folders, settings, and administration as one hierarchy", () => {
    // MVP admin only holds `settings.read` among console-permission keys
    // (blueprint §3.3, issue #14). The admin section therefore exposes the
    // single "settings" leaf until M2/M5 (issues #23 and #26) re-introduce
    // the rest. Re-arm the "users" assertion once those land.
    const groups = getNavigationModel({
      pathname: "/settings/preferences",
      mailboxId: "mailbox-1",
      permissions: [...ADMINISTRATOR_PERMISSIONS],
    });

    expect(groups.map((group) => group.id)).toEqual([
      "workspace",
      "settings",
      "administration",
    ]);
    expect(groups[0]?.children.map((item) => item.id)).toEqual([
      "inbox",
      "sent",
      "drafts",
      "starred",
      "archive",
      "trash",
    ]);
    expect(groups[1]?.children.map((item) => item.id)).toEqual([
      "account",
      "mailboxes",
      "preferences",
    ]);
    expect(groups[2]?.children.map((item) => item.id)).toEqual(["settings"]);
    expect(isNavigationGroupActive(groups[1]!, "/settings/preferences")).toBe(
      true,
    );
  });

  it("prunes administration resources by their read permissions", () => {
    const groups = getNavigationModel({
      pathname: "/admin/users",
      permissions: ["user.read"],
    });
    const administration = groups.find(
      (group) => group.id === "administration",
    );

    expect(administration?.children.map((item) => item.id)).toEqual(["users"]);
    expect(
      getNavigationModel({
        pathname: "/inbox",
        permissions: ["message.read"],
      }).some((group) => group.id === "administration"),
    ).toBe(false);
  });

  it("preserves mailbox-scoped and mailbox-less folder URLs", () => {
    expect(folderPath("inbox", "mailbox-1")).toBe("/inbox/mailbox-1");
    expect(folderPath("archive", "mailbox-1")).toBe("/archive/mailbox-1");
    expect(folderPath("drafts", "mailbox-1")).toBe("/drafts");
    expect(folderPath("starred", "mailbox-1")).toBe("/starred");
  });

  it("resolves shared labels in English and Chinese", () => {
    const model = getNavigationModel({ pathname: "/settings/account" });
    const settings = model.find((group) => group.id === "settings")!;
    const english = createI18nInstance("en");
    const chinese = createI18nInstance("zh-CN");

    expect(english.t(settings.labelKey)).toBe("Settings");
    expect(chinese.t(settings.labelKey)).toBe("设置");
    expect(english.t(settings.children[0]!.labelKey)).toBe("Account security");
    expect(chinese.t(settings.children[0]!.labelKey)).toBe("账户安全");
  });
});
