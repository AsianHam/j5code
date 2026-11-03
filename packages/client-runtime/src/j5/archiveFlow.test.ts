import type { CrewArchiveWorktreeEstimate } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWorktreeEstimates,
  sentenceEnd,
  worktreeReasonLabel,
  worktreeShortPath,
} from "./archiveFlow.ts";

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

const estimate = (
  overrides: Partial<CrewArchiveWorktreeEstimate> & Pick<CrewArchiveWorktreeEstimate, "seat">,
): CrewArchiveWorktreeEstimate => ({
  crewInstanceId: "crew:one",
  path: `/wt/${overrides.seat}`,
  branch: `j5/${overrides.seat}`,
  verdict: "remove",
  reason: null,
  ...overrides,
});

describe("archive worktree estimate", () => {
  it("lists what would be removed apart from what stays, with the reason for each keeper", () => {
    const grouped = groupWorktreeEstimates([
      estimate({ seat: "builder" }),
      estimate({ seat: "critic", verdict: "keep", reason: "unmerged_commits" }),
      estimate({ seat: "tester", verdict: "keep", reason: "in_use" }),
    ]);
    expect(grouped.removed.map((worktree) => worktree.seat)).toEqual(["builder"]);
    expect(
      grouped.kept.map((worktree) => [
        worktree.seat,
        worktree.reason === null ? null : worktreeReasonLabel[worktree.reason],
      ]),
    ).toEqual([
      ["critic", "has commits that aren't merged"],
      ["tester", "a session or terminal is open in it"],
    ]);
  });

  it("names a worktree by its last two folders", () => {
    expect(worktreeShortPath("/Users/me/.j5code/worktrees/repo/seat-a/")).toBe("repo/seat-a");
    expect(worktreeShortPath("C:\\work\\wt\\seat-b")).toBe("wt/seat-b");
    expect(worktreeShortPath("/seat")).toBe("seat");
  });
});
