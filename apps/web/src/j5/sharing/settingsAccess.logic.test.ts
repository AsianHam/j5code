import { describe, expect, it } from "vite-plus/test";

import { settingsNavGroups, settingsPageShown } from "./settingsAccess.logic";

const UPSTREAM = [
  { heading: null, paths: ["/settings/general", "/settings/appearance", "/settings/snap-shot"] },
  { heading: "Agents", paths: ["/settings/providers"] },
  { heading: "Connections", paths: ["/settings/connections", "/settings/people"] },
];
const LICENSES = "/settings/open-source-licenses";

describe("Settings for someone who owns no connected server", () => {
  it("lists only the pages about their own device, People, and the licenses", () => {
    expect(settingsNavGroups(UPSTREAM, false, LICENSES)).toEqual([
      { heading: null, paths: ["/settings/appearance", "/settings/snap-shot"] },
      { heading: "Connections", paths: ["/settings/people"] },
      { heading: null, paths: ["/settings/open-source-licenses"] },
    ]);
  });

  it("does not show a page upstream adds later", () => {
    expect(settingsPageShown({ path: "/settings/brand-new", ownerSomewhere: false })).toBe(false);
    expect(settingsPageShown({ path: "/settings/appearance", ownerSomewhere: false })).toBe(true);
  });
});

describe("Settings for an Owner", () => {
  it("lists every page upstream lists, and shows every page", () => {
    expect(settingsNavGroups(UPSTREAM, true, LICENSES)).toBe(UPSTREAM);
    expect(settingsPageShown({ path: "/settings/brand-new", ownerSomewhere: true })).toBe(true);
  });
});
