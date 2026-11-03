import {
  threadRuntimeIsActive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";

/** The seat facts a Crew summary reads; every field is something the client already holds. */
export interface CrewSeatThread {
  readonly notStarted?: boolean;
  readonly runtime?: Pick<ThreadRuntimeSummary, "status"> | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly archivedAt: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: string | null;
  readonly updatedAt: string;
}

export type CrewSeatState =
  | "running"
  | "failed"
  | "needs-you"
  | "settled"
  | "not-started"
  | "idle"
  | "archived"
  | "unknown";

export interface CrewStateSummary {
  readonly counts: Readonly<Record<CrewSeatState, number>>;
  readonly total: number;
  readonly hasActiveTurn: boolean;
  /** The newest measured activity across the seats the client knows about. */
  readonly lastActivityAt: string | null;
}

/**
 * Precedence: a run in flight beats a failed last run, which beats a pending approval, which beats
 * settlement. A pending native question needs attention even though its turn remains active. A
 * failed last run reads as failed, never as idle, so a dead seat stays visible. Nothing here is
 * inferred from silence.
 */
export const classifyCrewSeat = (thread: CrewSeatThread | undefined): CrewSeatState => {
  if (thread === undefined) return "unknown";
  if (thread.archivedAt !== null) return "archived";
  if (threadRuntimeIsActive(thread.runtime) && thread.hasPendingUserInput) return "needs-you";
  if (threadRuntimeIsActive(thread.runtime)) return "running";
  if (thread.runtime?.status === "failed") return "failed";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs-you";
  if (
    thread.settledOverride === "settled" ||
    (thread.settledOverride !== "active" && thread.settledAt != null)
  )
    return "settled";
  return thread.notStarted === true ? "not-started" : "idle";
};

/**
 * How a Crew seat's last run ended, for its row when upstream's status pill has nothing to say: that
 * pill shows only live states and an unseen completion, so a seat read "Idle" once its end was seen.
 * Only Crew seats get it; a solo agent's row keeps upstream's quiet "Idle".
 */
export const seatRunLabel = (status: ThreadRuntimeSummary["status"] | undefined) =>
  status === "failed"
    ? "Failed"
    : status === "interrupted" || status === "cancelled"
      ? "Interrupted"
      : status === "completed"
        ? "Completed"
        : null;

/**
 * The row label for a Crew seat the status pill is quiet about. A seat whose first start failed
 * ran and ended, so how that run ended outranks "Not started", which is only for a seat still
 * waiting for its first assignment.
 */
export const seatQuietLabel = (seat: {
  readonly notStarted?: boolean | undefined;
  readonly runtime?: Pick<ThreadRuntimeSummary, "status"> | null | undefined;
}) => seatRunLabel(seat.runtime?.status) ?? (seat.notStarted === true ? "Not started" : "Idle");

/** "What is the state of this Crew?" answered from its seats, no Playbook required. */
export const summarizeCrewState = (
  threads: ReadonlyArray<CrewSeatThread | undefined>,
): CrewStateSummary => {
  const counts: Record<CrewSeatState, number> = {
    running: 0,
    failed: 0,
    "needs-you": 0,
    settled: 0,
    "not-started": 0,
    idle: 0,
    archived: 0,
    unknown: 0,
  };
  let lastActivityAt: string | null = null;
  let hasActiveTurn = false;
  for (const thread of threads) {
    counts[classifyCrewSeat(thread)] += 1;
    if (thread !== undefined && thread.archivedAt === null && threadRuntimeIsActive(thread.runtime))
      hasActiveTurn = true;
    if (thread !== undefined && (lastActivityAt === null || thread.updatedAt > lastActivityAt))
      lastActivityAt = thread.updatedAt;
  }
  return { counts, total: threads.length, hasActiveTurn, lastActivityAt };
};

const LABELS: ReadonlyArray<readonly [CrewSeatState, string]> = [
  ["running", "running"],
  ["failed", "failed"],
  ["needs-you", "needs you"],
  ["settled", "settled"],
  ["not-started", "not started"],
  ["unknown", "unknown"],
];

/** A Stop crew control is offered only while a seat has a turn to interrupt. */
export const crewHasRunningSeat = (summary: CrewStateSummary) => summary.hasActiveTurn;

/** "2 running · 1 failed · 1 needs you"; idle and archived seats are the quiet default and stay unsaid. */
export const formatCrewStateSummary = (summary: CrewStateSummary): string | null => {
  const parts = LABELS.flatMap(([state, label]) =>
    summary.counts[state] === 0 ? [] : [`${summary.counts[state]} ${label}`],
  );
  return parts.length === 0 ? null : parts.join(" · ");
};
