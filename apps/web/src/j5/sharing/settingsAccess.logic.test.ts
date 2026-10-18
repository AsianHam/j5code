import { describe, expect, it } from "vite-plus/test";

import { settingsNavItems, settingsPageShown } from "./settingsAccess.logic";

const UPSTREAM = [
  { to: "/settings/general" },
  { to: "/settings/appearance" },
  { to: "/settings/snap-shot" },
  { to: "/settings/providers" },
  { to: "/settings/people" },
];
const LICENSES = { to: "/settings/open-source-licenses" };

describe("Settings for someone who owns no connected server", () => {
  it("lists only the pages about their own device, People, and the licenses", () => {
    expect(settingsNavItems(UPSTREAM, false, LICENSES).map((item) => item.to)).toEqual([
      "/settings/appearance",
      "/settings/snap-shot",
      "/settings/people",
      "/settings/open-source-licenses",
    ]);
  });

  it("does not show a page upstream adds later", () => {
    expect(settingsPageShown({ path: "/settings/brand-new", ownerSomewhere: false })).toBe(false);
    expect(settingsPageShown({ path: "/settings/appearance", ownerSomewhere: false })).toBe(true);
  });
});

describe("Settings for an Owner", () => {
  it("lists every page upstream lists, and shows every page", () => {
    expect(settingsNavItems(UPSTREAM, true, LICENSES)).toBe(UPSTREAM);
    expect(settingsPageShown({ path: "/settings/brand-new", ownerSomewhere: true })).toBe(true);
  });
});
