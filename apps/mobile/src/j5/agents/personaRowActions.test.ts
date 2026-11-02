import { describe, expect, it } from "vite-plus/test";

import { personaRowActions } from "./personaRowActions";

describe("personaRowActions", () => {
  it("offers only Restore for a removed persona, even an editable one", () => {
    expect(personaRowActions({ removed: true, editable: true }, true)).toEqual(["restore"]);
  });

  it("offers Edit and Details only for an editable persona, and Copy only with another environment", () => {
    expect(personaRowActions({ removed: false, editable: true }, true)).toEqual([
      "edit",
      "details",
      "duplicate",
      "export",
      "copy",
      "remove",
    ]);
    expect(personaRowActions({ removed: false, editable: false }, false)).toEqual([
      "duplicate",
      "export",
      "remove",
    ]);
  });
});
