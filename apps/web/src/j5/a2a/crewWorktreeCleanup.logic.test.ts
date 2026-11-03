import { ThreadId } from "@t3tools/contracts";
import type { CrewWorktreeCleanupEntry } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  ANSWERED_ALREADY,
  answerFailure,
  cleanupButtons,
  groupCleanupOutcomes,
  inboxSummary,
  orderCleanupRows,
  outcomeReason,
  outcomeSummary,
  pickedCleanupPaths,
  pullRequestLabel,
  sliceCleanupRows,
  toggleCleanupPath,
} from "./crewWorktreeCleanup.logic";

const entry = (
  name: string,
  overrides: Partial<CrewWorktreeCleanupEntry> = {},
): CrewWorktreeCleanupEntry => ({
  threadId: ThreadId.make(`thread:${name}`),
  threadTitle: name,
  path: `/wt/${name}`,
  branch: `j5/${name}`,
  uncommittedFiles: 0,
  commitsAhead: 0,
  pullRequestUrl: null,
  outcome: null,
  reason: null,
  detail: null,
  ...overrides,
});

describe("the worktree cleanup item's list", () => {
  it("puts uncommitted work first, then commits only, and keeps five rows before Show more", () => {
    const rows = orderCleanupRows([
      entry("review", { commitsAhead: 1 }),
      entry("tests", { uncommittedFiles: 7 }),
      entry("replay", { uncommittedFiles: 12, commitsAhead: 5 }),
      entry("docs", { commitsAhead: 3 }),
      entry("adapter", { uncommittedFiles: 4, commitsAhead: 2 }),
      entry("spike", { uncommittedFiles: 3, commitsAhead: 8 }),
      entry("proto", { uncommittedFiles: 2 }),
      entry("flaky", { commitsAhead: 1 }),
    ]);
    expect(rows.map((row) => row.threadTitle)).toEqual([
      "replay",
      "tests",
      "adapter",
      "spike",
      "proto",
      "docs",
      "review",
      "flaky",
    ]);
    const collapsed = sliceCleanupRows(rows, false);
    expect(collapsed.shown).toHaveLength(5);
    expect(collapsed.hidden).toBe(3);
    expect(sliceCleanupRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    expect(sliceCleanupRows(rows.slice(0, 5), false).hidden).toBe(0);
  });
});

describe("picking worktrees to remove", () => {
  const entries = [entry("a"), entry("b"), entry("c")];

  it("starts with nothing picked: Remove is disabled at 0 and Select all is not", () => {
    expect(cleanupButtons(new Set(), entries)).toEqual({
      removeLabel: "Remove selected (0)",
      removeDisabled: true,
      selectAllDisabled: false,
    });
  });

  it("counts the picks, and disables Select all once every row is picked", () => {
    const picked = toggleCleanupPath(toggleCleanupPath(new Set(), "/wt/a"), "/wt/c");
    expect(cleanupButtons(picked, entries)).toMatchObject({
      removeLabel: "Remove selected (2)",
      removeDisabled: false,
      selectAllDisabled: false,
    });
    const all = new Set(entries.map((row) => row.path));
    expect(cleanupButtons(all, entries)).toMatchObject({
      removeLabel: "Remove selected (3)",
      selectAllDisabled: true,
    });
    expect(toggleCleanupPath(picked, "/wt/a").has("/wt/a")).toBe(false);
  });

  it("sends only picks the item still lists, in its order", () => {
    const picked = new Set(["/wt/c", "/wt/gone", "/wt/a"]);
    expect(pickedCleanupPaths(picked, entries)).toEqual(["/wt/a", "/wt/c"]);
    expect(cleanupButtons(picked, entries).removeLabel).toBe("Remove selected (2)");
  });
});

describe("the decided item", () => {
  const decided = [
    entry("done", { outcome: "removed" }),
    entry("later", { outcome: "kept" }),
    entry("busy", { outcome: "skipped", reason: "in_use" }),
    entry("changed", { outcome: "skipped", reason: "changed" }),
    entry("locked", { outcome: "failed", detail: "git worktree remove failed" }),
  ];

  it("groups by outcome in the order removed, kept, skipped, failed", () => {
    expect(
      groupCleanupOutcomes(decided).map((group) => [
        group.label,
        group.rows.map((row) => row.threadTitle),
      ]),
    ).toEqual([
      ["Removed", ["done"]],
      ["Kept", ["later"]],
      ["Skipped", ["busy", "changed"]],
      ["Failed", ["locked"]],
    ]);
    expect(groupCleanupOutcomes(decided.slice(0, 1)).map((group) => group.label)).toEqual([
      "Removed",
    ]);
    expect(outcomeSummary(decided)).toBe("1 removed · 1 kept · 2 skipped · 1 failed");
  });

  it("gives each row its reason: not picked, why it was skipped, git's own text", () => {
    expect(decided.map(outcomeReason)).toEqual([
      null,
      "Not picked",
      "A session is open in it",
      "Changed since this was filed",
      "git worktree remove failed",
    ]);
  });
});

describe("a refused answer", () => {
  it("says it was already answered in the server's words, and shows the decided item", () => {
    const refusal = Object.assign(new Error("This worktree cleanup was already answered."), {
      code: "CrewWorktreeCleanupAnsweredError",
    });
    expect(answerFailure(refusal)).toEqual({ message: ANSWERED_ALREADY, alreadyAnswered: true });
    expect(ANSWERED_ALREADY).toBe("This worktree cleanup was already answered.");
  });

  it("keeps any other failure open with its own message", () => {
    expect(
      answerFailure(
        Object.assign(new Error("Owners only."), { code: "EnvironmentAuthorizationError" }),
      ),
    ).toEqual({ message: "Owners only.", alreadyAnswered: false });
    expect(answerFailure("boom")).toEqual({
      message: "Could not answer the worktree cleanup.",
      alreadyAnswered: false,
    });
  });
});

it("names a pull request by its number when the link has one", () => {
  expect(pullRequestLabel("https://github.com/Jacksondr5/j5code/pull/815")).toBe("PR #815");
  expect(pullRequestLabel("https://example.test/mr/7")).toBe("Pull request");
});

describe("inboxSummary", () => {
  it("counts worktree cleanups apart from questions", () => {
    expect(
      inboxSummary({ questions: 2, complete: true, agentRequests: 0, worktreeCleanups: 0 }),
    ).toBe("2 questions open");
    expect(
      inboxSummary({ questions: 1, complete: false, agentRequests: 3, worktreeCleanups: 1 }),
    ).toBe("1 question loaded · 3 agent requests · 1 worktree cleanup");
    expect(
      inboxSummary({ questions: 0, complete: true, agentRequests: 1, worktreeCleanups: 2 }),
    ).toBe("0 questions open · 1 agent request · 2 worktree cleanups");
  });
});
