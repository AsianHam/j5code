/**
 * Mobile's Settings pages about the device itself, shown to everyone (People and access AC28):
 * its look and input, its saved servers and notifications, and About. Every other Settings page
 * is an Owner's, so a page upstream adds later is shown to Owners only until someone decides
 * otherwise, as on web.
 */
const PAGES_FOR_EVERYONE: ReadonlySet<string> = new Set([
  "Settings",
  "SettingsOrganization",
  "SettingsProjectGrouping",
  "SettingsAppearance",
  "SettingsFollowUp",
  "SettingsNavigation",
  "SettingsKeyboard",
  "SettingsMicrophone",
  "SettingsNotifications",
  "SettingsEnvironments",
  "SettingsEnvironmentDetail",
  "SettingsEnvironmentNew",
  "SettingsAuth",
  "SettingsWaitlist",
  "SettingsAbout",
  "SettingsClientStorage",
  "SettingsDiagnostics",
  "SettingsOpenSourceLicenses",
  "SettingsOpenSourceLicense",
  "SettingsLegal",
]);

/**
 * Whether a screen is shown, by its route name. Only an answer withholds one: while servers are
 * still answering, an Owner's page stays, and the server refuses what is not theirs to read.
 */
export const settingsPageShown = (routeName: string, ownerSomewhere: boolean | "loading") =>
  ownerSomewhere !== false ||
  !routeName.startsWith("Settings") ||
  PAGES_FOR_EVERYONE.has(routeName);
