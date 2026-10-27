import { describe, expect, it } from "vite-plus/test";

import { sentenceEnd } from "./ArchiveWarningContent";

describe("sentenceEnd", () => {
  it("closes a sentence after a plain name", () => {
    expect(sentenceEnd("Release agent")).toBe(".");
  });

  it("adds nothing after a name that already ends a sentence", () => {
    for (const name of [
      "Review the PR, then stop.",
      "Ship it!",
      "Ready?",
      "Investigate the…",
      "Investigate the...",
      "Done. ",
    ]) {
      expect(sentenceEnd(name)).toBe("");
    }
  });
});
