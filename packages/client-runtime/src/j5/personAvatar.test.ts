import { describe, expect, it } from "vite-plus/test";

import { initialsOf, presentPersonAvatar } from "./personAvatar.ts";

describe("presentPersonAvatar", () => {
  it("gives the same name the same colour, whatever its case and spacing", () => {
    expect(presentPersonAvatar("Priya")).toEqual(presentPersonAvatar("  priya "));
    expect(presentPersonAvatar("Priya")?.color).not.toBe("gray");
  });

  it("keeps the colour web has always drawn for a name", () => {
    // Web's palette is the project icon colours in contract order, gray aside.
    expect(presentPersonAvatar("Priya")?.color).toBe("sky");
    expect(presentPersonAvatar("Test owner")?.color).toBe("yellow");
  });

  it("draws nothing for someone without a name", () => {
    expect(presentPersonAvatar(null)).toBeNull();
  });
});

describe("initialsOf", () => {
  it("takes the first and last words' first letters", () => {
    expect(initialsOf("Priya Natarajan Rao")).toBe("PR");
    expect(initialsOf("priya")).toBe("P");
    expect(initialsOf("   ")).toBe("?");
  });
});
