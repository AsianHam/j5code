import { describe, expect, it } from "vite-plus/test";

import { isPersonName } from "./sharing.ts";

// People and access AC45: one line of visible characters, with no square or angle brackets.
describe("isPersonName", () => {
  it("takes an ordinary name, parentheses and all", () => {
    expect(isPersonName("Priya K")).toBe(true);
    expect(isPersonName("Sam (QA)")).toBe(true);
    expect(isPersonName("Zoë Ørsted")).toBe(true);
  });

  it("refuses a level in parentheses, which the agent's author line uses", () => {
    for (const name of ["Pat (owner)", "Pat (Collaborator)", "Pat ( viewer )", "Pat （owner）"]) {
      expect(isPersonName(name), name).toBe(false);
    }
    expect(isPersonName("Pat (ownership)")).toBe(true);
  });

  it("refuses brackets, line breaks and characters that draw nothing", () => {
    for (const name of ["[Priya]", "Priya <owner>", "</note>", "Pri\nya", "Pri​ya", "  "]) {
      expect(isPersonName(name), JSON.stringify(name)).toBe(false);
    }
  });
});
