import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CrewWorktreeCleanupEntry,
  CrewWorktreeCleanupItem,
  CrewWorktreeCleanupListResponse,
} from "@t3tools/contracts/j5";

export type ScopedWorktreeCleanup = CrewWorktreeCleanupItem & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly sourceReady: boolean;
};

export const worktreeCleanupKey = (item: Pick<ScopedWorktreeCleanup, "environmentId" | "id">) =>
  JSON.stringify([item.environmentId, item.id]);

/** Open ones oldest first, like asks of one urgency; decided ones newest first. */
export function mergeWorktreeCleanupSources(
  sources: J5ReadSources<typeof CrewWorktreeCleanupListResponse.Type>,
): ReadonlyArray<ScopedWorktreeCleanup> {
  return sources.sources
    .flatMap((source) =>
      (source.data?.items ?? []).map((item) => ({
        ...item,
        environmentId: source.environmentId,
        environmentLabel: source.environmentLabel,
        connected: source.connected,
        sourceReady: source.status === "ready",
      })),
    )
    .toSorted((left, right) =>
      left.status === "open"
        ? left.filedAt.localeCompare(right.filedAt)
        : (right.decidedAt ?? "").localeCompare(left.decidedAt ?? ""),
    );
}

/** Five rows show before "Show N more". */
const WORKTREE_CLEANUP_VISIBLE_ROWS = 5;

/** Uncommitted work first, then commits only; the more of each, the nearer the top. */
export const orderCleanupRows = (entries: ReadonlyArray<CrewWorktreeCleanupEntry>) =>
  entries.toSorted(
    (left, right) =>
      right.uncommittedFiles - left.uncommittedFiles ||
      (right.commitsAhead ?? 0) - (left.commitsAhead ?? 0),
  );

export const sliceCleanupRows = <Row>(rows: ReadonlyArray<Row>, showAll: boolean) => ({
  shown: showAll ? rows : rows.slice(0, WORKTREE_CLEANUP_VISIBLE_ROWS),
  hidden: showAll ? 0 : Math.max(0, rows.length - WORKTREE_CLEANUP_VISIBLE_ROWS),
});

export const toggleCleanupPath = (selected: ReadonlySet<string>, path: string) => {
  const next = new Set(selected);
  if (!next.delete(path)) next.add(path);
  return next;
};

/** What the person picked that the item still lists, in the item's order. */
export const pickedCleanupPaths = (
  selected: ReadonlySet<string>,
  entries: ReadonlyArray<CrewWorktreeCleanupEntry>,
) => entries.map((entry) => entry.path).filter((path) => selected.has(path));

export const cleanupButtons = (
  selected: ReadonlySet<string>,
  entries: ReadonlyArray<CrewWorktreeCleanupEntry>,
) => {
  const picked = pickedCleanupPaths(selected, entries).length;
  return {
    removeLabel: `Remove selected (${picked})`,
    removeDisabled: picked === 0,
    selectAllDisabled: picked === entries.length,
  };
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const uncommittedFilesLabel = (count: number) =>
  plural(count, "uncommitted file", "uncommitted files");

/** Null commits means the default branch could not be compared. */
export const commitsAheadLabel = (count: number | null) =>
  count === null
    ? "commits not compared"
    : `${count} ${count === 1 ? "commit" : "commits"} not on the default branch`;

export const cleanupTitle = (item: Pick<ScopedWorktreeCleanup, "crewName" | "entries">) =>
  `${plural(item.entries.length, "worktree", "worktrees")} from "${item.crewName}" still ${item.entries.length === 1 ? "holds" : "hold"} unfinished work`;

type SkipReason = NonNullable<CrewWorktreeCleanupEntry["reason"]>;

const skipReasonText: Record<SkipReason, string> = {
  changed: "Changed since this was filed",
  shared: "Another thread uses it",
  in_use: "A session is open in it",
  gone: "Already gone",
  unverified: "Couldn't be checked",
};

const OUTCOME_GROUPS = [
  { outcome: "removed", label: "Removed" },
  { outcome: "kept", label: "Kept" },
  { outcome: "skipped", label: "Skipped" },
  { outcome: "failed", label: "Failed" },
] as const;

/** Why a decided worktree is where it is: nothing for removed, the git error for a failure. */
export const outcomeReason = (entry: CrewWorktreeCleanupEntry): string | null => {
  switch (entry.outcome) {
    case "kept":
      return "Not picked";
    case "skipped":
      return entry.reason === null ? null : skipReasonText[entry.reason];
    case "failed":
      return entry.detail;
    default:
      return null;
  }
};

/** The decided item's worktrees by outcome, in the mockup's order, leaving out empty groups. */
export const groupCleanupOutcomes = (entries: ReadonlyArray<CrewWorktreeCleanupEntry>) =>
  OUTCOME_GROUPS.flatMap((group) => {
    const rows = entries.filter((entry) => entry.outcome === group.outcome);
    return rows.length === 0 ? [] : [{ ...group, rows }];
  });

const outcomeCounts = (entries: ReadonlyArray<CrewWorktreeCleanupEntry>) =>
  groupCleanupOutcomes(entries).map((group) => ({
    label: group.outcome,
    count: group.rows.length,
  }));

/** The shelf's one line: "1 removed · 3 kept · 3 skipped · 1 failed". */
export const outcomeSummary = (entries: ReadonlyArray<CrewWorktreeCleanupEntry>) =>
  outcomeCounts(entries)
    .map(({ label, count }) => `${count} ${label}`)
    .join(" · ");

/** Whether every worktree went as asked: a skip or a failure is what to look at. */
export const cleanupNeedsAttention = (entries: ReadonlyArray<CrewWorktreeCleanupEntry>) =>
  entries.some((entry) => entry.outcome === "skipped" || entry.outcome === "failed");

/** The pull request's number when its link names one, else a plain "Pull request". */
export const pullRequestLabel = (url: string) => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number === undefined ? "Pull request" : `PR #${number}`;
};

export const answeredAgeLabel = (elapsed: string) =>
  elapsed === "just now" ? "answered just now" : elapsed ? `answered ${elapsed} ago` : "answered";

export const ANSWERED_ALREADY = "This worktree cleanup was already answered.";

/**
 * What a failed answer means for the item. A refused second answer says so in the server's own
 * words and shows the decided item; anything else is the message to show, and the item stays open.
 */
export const answerFailure = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Could not answer the worktree cleanup.";
  const alreadyAnswered =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "CrewWorktreeCleanupAnsweredError";
  return { message: alreadyAnswered ? ANSWERED_ALREADY : message, alreadyAnswered };
};

const countOf = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** The Inbox's count line: worktree cleanups are approvals of their own, not questions. */
export const inboxSummary = (input: {
  readonly questions: number;
  readonly complete: boolean;
  readonly agentRequests: number;
  readonly worktreeCleanups: number;
}) =>
  [
    `${countOf(input.questions, "question", "questions")} ${input.complete ? "open" : "loaded"}`,
    input.agentRequests === 0
      ? null
      : countOf(input.agentRequests, "agent request", "agent requests"),
    input.worktreeCleanups === 0
      ? null
      : countOf(input.worktreeCleanups, "worktree cleanup", "worktree cleanups"),
  ]
    .filter((part) => part !== null)
    .join(" · ");
