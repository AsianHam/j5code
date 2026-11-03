import {
  presentCrewNotice,
  type CrewNoticeMessage,
  type CrewNoticePresentation,
  type FinishedSeat,
} from "@t3tools/client-runtime/j5/crew-notices";

export interface CrewNoticeLine {
  readonly seat: string;
  /** Named only when one notice speaks for several Crews, where a seat name alone is ambiguous. */
  readonly crewName: string | null;
  /** Null when the seat's thread was never created: the line names it and doesn't link. */
  readonly threadId: string | null;
  readonly reason: string;
  readonly tone: "bad" | "warn";
}

const handoffLine = (seat: FinishedSeat, crewName: string | null): CrewNoticeLine | null => {
  const handoff = seat.handoff;
  if (handoff.status === "missing")
    return {
      seat: seat.seat,
      crewName,
      threadId: seat.threadId,
      reason: `finished · ${handoff.kind} missing`,
      tone: "warn",
    };
  if (handoff.status === "unavailable")
    return {
      seat: seat.seat,
      crewName,
      threadId: seat.threadId,
      reason: `finished · ${handoff.kind} can't be read${handoff.reason === null ? "" : `: ${handoff.reason}`}`,
      tone: "warn",
    };
  return null;
};

/**
 * What the person would act on in a notice, one line per seat: a seat that didn't start, or a run
 * that didn't end clean. A seat that started or finished cleanly has no line; its row on the Fleet
 * page and the Captain's expander says so.
 */
export const crewNoticeLines = (notice: CrewNoticePresentation): ReadonlyArray<CrewNoticeLine> => {
  if (notice.kind === "gate") {
    if (notice.decision !== "approved") return [];
    const threadOf = (seat: string) =>
      notice.roster.find((entry) => entry.seat === seat)?.threadId ?? null;
    return [
      ...notice.failures.map((failure) => ({
        seat: failure.seat,
        crewName: null,
        threadId: threadOf(failure.seat),
        reason: `couldn't start · ${failure.detail}`,
        tone: "bad" as const,
      })),
      ...notice.notCreated.map((seat) => ({
        seat: seat.seat,
        crewName: null,
        threadId: null,
        reason: `was never created · ${seat.detail}`,
        tone: "bad" as const,
      })),
      ...notice.pendingSeats.map((seat) => ({
        seat,
        crewName: null,
        threadId: threadOf(seat),
        reason: "hasn't confirmed it started",
        tone: "warn" as const,
      })),
    ];
  }
  // Finishes from several Crews fold into one notice when the Captain commands more than one.
  const severalCrews = new Set(notice.seats.map((seat) => seat.crewName)).size > 1;
  return notice.seats.flatMap((seat): ReadonlyArray<CrewNoticeLine> => {
    const crewName = severalCrews ? seat.crewName : null;
    if (seat.runStatus === "completed") {
      const line = handoffLine(seat, crewName);
      return line === null ? [] : [line];
    }
    const ended =
      seat.runStatus === "failed" || seat.runStatus === "errored"
        ? "run failed"
        : `run ${seat.runStatus}`;
    return [
      {
        seat: seat.seat,
        crewName,
        threadId: seat.threadId,
        reason: seat.failure === null ? ended : `${ended} · ${seat.failure}`,
        tone: "bad",
      },
    ];
  });
};

/** An approved gate or a finish with nothing to act on takes no row in the timeline. */
export const isHiddenCrewNotice = (message: CrewNoticeMessage): boolean => {
  const notice = presentCrewNotice(message);
  if (notice === null || (notice.kind === "gate" && notice.decision === "declined")) return false;
  return crewNoticeLines(notice).length === 0;
};

const visibleRows = new WeakMap<object, ReadonlyArray<object>>();

/**
 * The timeline's rows without the hidden Crew notices (FORK.md case 104). It runs on rows already
 * derived, because upstream reads every user message as a turn boundary: dropping a notice before
 * that would merge the Captain turn it started into the one before. The result is the input when
 * nothing is hidden and is cached per input, since the list compares its rows by identity.
 */
export const withoutHiddenCrewNotices = <Row extends { readonly kind: string }>(
  rows: Array<Row>,
): Array<Row> => {
  const cached = visibleRows.get(rows);
  if (cached !== undefined) return cached as Array<Row>;
  const hidden = (row: Row) =>
    row.kind === "message" &&
    "message" in row &&
    isHiddenCrewNotice(row.message as CrewNoticeMessage);
  const visible = rows.some(hidden) ? rows.filter((row) => !hidden(row)) : rows;
  visibleRows.set(rows, visible);
  return visible;
};

/** A declined gate's card title. */
export const crewGateTitle = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) =>
  notice.requestKind === "roster" ? "Crew declined" : "Seat declined";
