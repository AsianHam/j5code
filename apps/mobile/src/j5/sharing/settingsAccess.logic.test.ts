import { describe, expect, it } from "vite-plus/test";

import { settingsPageShown } from "./settingsAccess.logic";

describe("which Settings pages someone who owns no connected server sees", () => {
  it("shows the pages about the device itself", () => {
    for (const page of [
      "Settings",
      "SettingsAppearance",
      "SettingsEnvironments",
      "SettingsAbout",
    ]) {
      expect(settingsPageShown(page, false), page).toBe(true);
    }
  });

  it("withholds a server's pages, and any Settings page not listed as the device's", () => {
    for (const page of ["SettingsProviderAccounts", "SettingsScheduledTasks", "SettingsAgents"]) {
      expect(settingsPageShown(page, false), page).toBe(false);
    }
    expect(settingsPageShown("SettingsSomethingNew", false)).toBe(false);
  });

  it("withholds nothing from an Owner, or while the servers are still answering", () => {
    expect(settingsPageShown("SettingsProviderAccounts", true)).toBe(true);
    expect(settingsPageShown("SettingsProviderAccounts", "loading")).toBe(true);
  });

  it("leaves screens outside Settings alone", () => {
    expect(settingsPageShown("Thread", false)).toBe(true);
  });
});
