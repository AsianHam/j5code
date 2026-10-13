import { describe, expect, it } from "vite-plus/test";

import { nameToShowAgain, promotionSendsName } from "./promote.logic";

describe("raising someone to Collaborate", () => {
  it("confirms a name they gave themselves, changed or not", () => {
    expect(promotionSendsName({ name: "Sam", typed: "Sam", nameSelfGiven: true })).toBe(true);
    expect(promotionSendsName({ name: "Sam", typed: "Sam T.", nameSelfGiven: true })).toBe(true);
  });

  it("sends a name a member gave only when it was changed", () => {
    expect(promotionSendsName({ name: "Sam", typed: " Sam ", nameSelfGiven: false })).toBe(false);
    expect(promotionSendsName({ name: "Sam", typed: "Samir", nameSelfGiven: false })).toBe(true);
  });
});

describe("a person renamed elsewhere while the dialog was open", () => {
  it("is shown under their new name before anything is saved", () => {
    expect(nameToShowAgain({ seen: "Sam", stored: "Samir" })).toBe("Samir");
  });

  it("is saved straight away when the name is as the member saw it, or is not known", () => {
    expect(nameToShowAgain({ seen: "Sam", stored: "Sam" })).toBeNull();
    expect(nameToShowAgain({ seen: "Sam", stored: null })).toBeNull();
  });
});
