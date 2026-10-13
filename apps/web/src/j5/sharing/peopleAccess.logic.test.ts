import { describe, expect, it } from "vite-plus/test";

import { settingsNavShown } from "./peopleAccess.logic";

const GUEST_PAGES = [
  "/settings/scheduled-tasks",
  "/settings/source-control",
  "/settings/archived",
  "/settings/personas",
  "/settings/skills",
];

describe("the Settings sidebar", () => {
  it("leaves out what a guest cannot use only for a guest on every connected server", () => {
    for (const path of GUEST_PAGES) {
      expect(settingsNavShown({ path, canSeePeople: false, guestEverywhere: true })).toBe(false);
    }
    expect(
      settingsNavShown({ path: "/settings/general", canSeePeople: false, guestEverywhere: true }),
    ).toBe(true);
  });

  it("keeps every page for someone who is a guest on one server and a member of another", () => {
    for (const path of GUEST_PAGES) {
      expect(settingsNavShown({ path, canSeePeople: false, guestEverywhere: false })).toBe(true);
    }
  });

  it("lists People by the primary server's own answer, whatever the person is elsewhere", () => {
    const people = "/settings/people";
    expect(settingsNavShown({ path: people, canSeePeople: true, guestEverywhere: false })).toBe(
      true,
    );
    expect(settingsNavShown({ path: people, canSeePeople: false, guestEverywhere: false })).toBe(
      false,
    );
  });
});
