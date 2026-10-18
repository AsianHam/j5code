import { describe, expect, it } from "vite-plus/test";

import { ownerSomewhereState, settingsNavItems, settingsPageShown } from "./settingsAccess.logic";

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

describe("whether the person owns a connected server", () => {
  it("is not known until the catalog is read and a server has answered", () => {
    expect(ownerSomewhereState({ catalogReady: false, answers: [] })).toBe("loading");
    expect(ownerSomewhereState({ catalogReady: true, answers: [null] })).toBe("loading");
    expect(ownerSomewhereState({ catalogReady: true, answers: ["other", null] })).toBe("loading");
  });

  it("is settled by one server that says so, whatever the others have answered", () => {
    expect(ownerSomewhereState({ catalogReady: true, answers: [null, "owner"] })).toBe(true);
    expect(ownerSomewhereState({ catalogReady: true, answers: ["other", "other"] })).toBe(false);
  });

  it("waits while the catalog lists no server yet, as it does before the client's own is added", () => {
    expect(ownerSomewhereState({ catalogReady: true, answers: [] })).toBe("loading");
  });
});
