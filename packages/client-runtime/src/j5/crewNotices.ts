/**
 * The platform's Crew notices in a Captain's thread, recognized strictly from their tags: a block
 * the parser does not understand stays raw. It reads every field, including ones the timeline no
 * longer draws, since the strict parse keeps an unreadable block raw and the approval summary reads them.
 */
export interface CrewNoticeMessage {
  readonly role: string;
  readonly text: string;
  readonly createdBy?: string | undefined;
}

export type SeatStart = "waiting" | "started" | "failed" | "pending";

export interface CrewRosterSeat {
  readonly seat: string;
  readonly participantId: string;
  readonly agentId: string;
  readonly threadId: string;
  /** Joined at the version this notice announces (an approved addition). */
  readonly isNew: boolean;
  /** How this seat's first turn went, for the seats this launch report watched; null otherwise. */
  readonly start: SeatStart | null;
}

/** A seat that failed, with the run's recorded error as the report carried it. */
export interface SeatStartFailure {
  readonly seat: string;
  readonly runStatus: string;
  readonly detail: string;
}

export type SeatHandoff =
  | { readonly status: "none declared" }
  | {
      readonly status: "written" | "missing" | "unavailable";
      readonly kind: string;
      /** The logical path the notice names, `artifacts/handoffs/...`. */
      readonly artifactPath: string | null;
      /** The handoff text when the notice carried it inline. */
      readonly body: string | null;
      /** Why an unavailable handoff can never be read, as the notice words it. */
      readonly reason: string | null;
    };

export interface FinishedSeat {
  readonly seat: string;
  readonly crewName: string | null;
  readonly participantId: string;
  readonly threadId: string;
  readonly runStatus: string;
  /** The run's recorded error when it failed, as the notice carried it. */
  readonly failure: string | null;
  readonly handoff: SeatHandoff;
}

export type CrewNoticePresentation =
  | {
      /** One or more seats' finishes, folded into one message when the Captain was mid-turn. */
      readonly kind: "seats";
      readonly seats: ReadonlyArray<FinishedSeat>;
    }
  | {
      /** The gate's decision, posted to the Captain by the platform. */
      readonly kind: "gate";
      readonly proposalId: string;
      readonly requestKind: "roster" | "addition";
      readonly decision: "approved" | "declined";
      /** Who decided, as the server names them in a shared conversation; null anywhere else. */
      readonly decidedBy: string | null;
      readonly crewName: string | null;
      readonly crewInstanceId: string | null;
      readonly crewVersion: number | null;
      readonly roster: ReadonlyArray<CrewRosterSeat>;
      readonly requestedSeats: ReadonlyArray<{ readonly seat: string; readonly agentId: string }>;
      /** What the person changed against the proposal, as the report words it; null when nothing. */
      readonly changes: string | null;
      readonly failures: ReadonlyArray<SeatStartFailure>;
      /** Seats whose first turn had not started when the report's window closed. */
      readonly pendingSeats: ReadonlyArray<string>;
      /** Approved seats whose thread was never created; they are not on the roster. */
      readonly notCreated: ReadonlyArray<{ readonly seat: string; readonly detail: string }>;
    };

const GATE_BLOCK = /^<j5_crew_gate>\n([\s\S]*?)\n<\/j5_crew_gate>/;
const ROSTER_LINE =
  /^- ([^:]+): participant_id=(\S+) persona=(\S*) thread_id=(\S+)(?: start=(started|failed|pending|waiting))?( \(new\))?$/;

// Decode after parsing: provider diagnostics cannot create fields or terminate tagged blocks.
const decodeFailureField = (value: string) =>
  value.replace(/&#(10|13|38|60|62|8232|8233);/g, (_, code: string) =>
    String.fromCharCode(Number(code)),
  );

const field = (block: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim() ?? null;
/** Every line of a repeated field, in order: the report has one `seat_failed` line per seat. */
const fields = (block: string, name: string) =>
  [...block.matchAll(new RegExp(`^${name}: (.*)$`, "gm"))].map((match) => match[1]!.trim());
const seatStart = (value: string | undefined): SeatStart | null =>
  value === "waiting" || value === "started" || value === "failed" || value === "pending"
    ? value
    : null;

const parseGate = (text: string): CrewNoticePresentation | null => {
  const match = GATE_BLOCK.exec(text);
  if (match === null) return null;
  const block = match[1]!;
  const proposalId = field(block, "proposal_id");
  const requestKind = field(block, "kind");
  const decision = field(block, "decision");
  if (
    proposalId === null ||
    (requestKind !== "roster" && requestKind !== "addition") ||
    (decision !== "approved" && decision !== "declined")
  )
    return null;
  const rosterStart = block.indexOf("\nroster:\n");
  const rosterLines =
    rosterStart === -1
      ? []
      : block
          .slice(rosterStart + "\nroster:\n".length)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
  const roster: Array<CrewRosterSeat> = [];
  for (const line of rosterLines) {
    const seat = ROSTER_LINE.exec(line);
    // A roster line this parser does not understand means the block is not one it understands:
    // the message stays raw rather than rendering as an approved card with seats missing.
    if (seat === null) return null;
    roster.push({
      seat: seat[1]!,
      participantId: seat[2]!,
      agentId: seat[3]!,
      threadId: seat[4]!,
      isNew: seat[6] !== undefined,
      start: seatStart(seat[5]),
    });
  }
  // `seat_failed: <seat> | <run status> | <error>`; the error may itself contain the separator.
  // The server always writes an error ("no error detail was recorded" when there is none,
  // `formatRunFailure`), so a failed seat is never dropped here for an empty one.
  const failures = fields(block, "seat_failed").flatMap((entry) => {
    const [seat, runStatus, ...rest] = entry.split(" | ");
    return seat === undefined || runStatus === undefined || rest.length === 0
      ? []
      : [{ seat, runStatus, detail: decodeFailureField(rest.join(" | ")) }];
  });
  // `seat_not_created: <seat> | <error>`, the same escaping as a failure's error.
  const notCreated = fields(block, "seat_not_created").flatMap((entry) => {
    const [seat, ...rest] = entry.split(" | ");
    return seat === undefined || rest.length === 0
      ? []
      : [{ seat, detail: decodeFailureField(rest.join(" | ")) }];
  });
  const changes = field(block, "changes");
  const requestedSeats = (field(block, "requested_seats") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      return separator <= 0
        ? []
        : [{ seat: entry.slice(0, separator), agentId: entry.slice(separator + 1) }];
    });
  const version = field(block, "crew_version");
  return {
    kind: "gate",
    proposalId,
    requestKind,
    decision,
    decidedBy: field(block, "decided_by"),
    crewName: field(block, "crew_name"),
    crewInstanceId: field(block, "crew_instance_id"),
    crewVersion: version === null || !/^\d+$/.test(version) ? null : Number(version),
    roster,
    requestedSeats,
    changes: changes === null || changes === "none" ? null : changes,
    failures,
    pendingSeats: fields(block, "seat_pending"),
    notCreated,
  };
};

const SEAT_OPEN = "<j5_seat_finished>";
const SEAT_BLOCK = /^<j5_seat_finished>\n([\s\S]*?)\n<\/j5_seat_finished>([\s\S]*)$/;
const HANDOFF_BODY = /<handoff_body>\n([\s\S]*?)\n<\/handoff_body>/;
const HANDOFF_FIELD = /^(written|missing|unavailable) \((.+)\)$/;

const parseSeatSection = (section: string): FinishedSeat | null => {
  const match = SEAT_BLOCK.exec(section);
  if (match === null) return null;
  const block = match[1]!;
  const seat = field(block, "seat");
  const participantId = field(block, "participant_id");
  const threadId = field(block, "thread_id");
  const runStatus = field(block, "run_status");
  const handoffField = field(block, "handoff");
  if (seat === null || participantId === null || threadId === null || runStatus === null)
    return null;
  let handoff: SeatHandoff;
  if (handoffField === null || handoffField === "none declared") {
    handoff = { status: "none declared" };
  } else {
    const parsed = HANDOFF_FIELD.exec(handoffField);
    if (parsed === null) return null;
    const bodyMatch = HANDOFF_BODY.exec(match[2]!);
    handoff = {
      status: parsed[1] as "written" | "missing" | "unavailable",
      kind: parsed[2]!,
      artifactPath: field(block, "artifact"),
      reason: field(block, "handoff_reason"),
      body:
        bodyMatch === null
          ? null
          : bodyMatch[1]!
              .replace(/<\\\/handoff_body>/g, "</handoff_body>")
              .replace(/<\\j5_seat_finished>/g, "<j5_seat_finished>"),
    };
  }
  return {
    seat,
    crewName: field(block, "crew"),
    participantId,
    threadId,
    runStatus,
    failure: field(block, "failure") === null ? null : decodeFailureField(field(block, "failure")!),
    handoff,
  };
};

const parseSeats = (text: string): CrewNoticePresentation | null => {
  if (!text.startsWith(SEAT_OPEN)) return null;
  const seats = text
    .split(SEAT_OPEN)
    .slice(1)
    .map((part) => parseSeatSection(`${SEAT_OPEN}${part}`.trim()));
  return seats.length === 0 || seats.some((seat) => seat === null)
    ? null
    : { kind: "seats", seats: seats as ReadonlyArray<FinishedSeat> };
};

/**
 * What the platform told a Crew member with an assignment, kept in the member's own thread: the
 * text the model read, in the tag the server wrote it in. Strictly recognized from that tag.
 */
export interface CrewContextNotice {
  readonly kind: "introduction" | "roster-changed";
  readonly title: string;
  /** The context without its wrapper, as the model read it. */
  readonly text: string;
}

const CONTEXT_OPEN = "<j5_crew_delivery_context>\n";
const CONTEXT_CLOSE = "\n</j5_crew_delivery_context>";
const ROSTER_CHANGED_OPEN = "<j5_crew_roster_changed>";

export const presentCrewContext = (message: CrewNoticeMessage): CrewContextNotice | null => {
  if (message.role !== "user" || message.createdBy !== "system") return null;
  const { text } = message;
  if (!text.startsWith(CONTEXT_OPEN) || !text.endsWith(CONTEXT_CLOSE)) return null;
  const body = text
    .slice(CONTEXT_OPEN.length, text.length - CONTEXT_CLOSE.length)
    .replaceAll("<\\/j5_crew_delivery_context>", "</j5_crew_delivery_context>");
  if (body.trim() === "") return null;
  return body.startsWith(ROSTER_CHANGED_OPEN)
    ? { kind: "roster-changed", title: "Roster changed", text: body }
    : { kind: "introduction", title: "Introduction", text: body };
};

/** Null for anything that is not a Crew notice; the ordinary renderer then owns the message. */
export const presentCrewNotice = (message: CrewNoticeMessage): CrewNoticePresentation | null => {
  if (message.role !== "user") return null;
  if (message.createdBy === "system") return parseGate(message.text) ?? parseSeats(message.text);
  return null;
};

/** The seats a gate card names, so the timeline can resolve their labels in its one identity read. */
export const participantIdsForCrewNotice = (message: CrewNoticeMessage): ReadonlyArray<string> => {
  const notice = presentCrewNotice(message);
  if (notice?.kind === "gate") return notice.roster.map((seat) => seat.participantId);
  if (notice?.kind === "seats") return notice.seats.map((seat) => seat.participantId);
  return [];
};

/** One seat a Crew notice says needs the person. */
export interface CrewNoticeLine {
  readonly seat: string;
  /** Named only when one notice speaks for several Crews, where a seat name alone is ambiguous. */
  readonly crewName: string | null;
  /** Null when the seat's thread was never created: the line names it and doesn't link. */
  readonly threadId: string | null;
  readonly reason: string;
  /** The error or fact behind the reason, for the line to open to. */
  readonly detail: string | null;
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
      detail: null,
      tone: "warn",
    };
  if (handoff.status === "unavailable")
    return {
      seat: seat.seat,
      crewName,
      threadId: seat.threadId,
      reason: `finished · ${handoff.kind} can't be read`,
      detail: handoff.reason,
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
        reason: "couldn't start",
        detail: failure.detail,
        tone: "bad" as const,
      })),
      ...notice.notCreated.map((seat) => ({
        seat: seat.seat,
        crewName: null,
        threadId: null,
        reason: "was never created",
        detail: seat.detail,
        tone: "bad" as const,
      })),
      ...notice.pendingSeats.map((seat) => ({
        seat,
        crewName: null,
        threadId: threadOf(seat),
        reason: "hasn't confirmed it started",
        detail: null,
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
        reason: ended,
        detail: seat.failure,
        tone: "bad",
      },
    ];
  });
};

/**
 * The stored launch report records the approved members, including ones never created. The
 * approver is named when the notice carries one, which only a shared conversation's does.
 */
export const crewApprovalSummary = (notice: CrewNoticePresentation): string | null => {
  if (notice.kind !== "gate" || notice.decision !== "approved" || notice.requestKind !== "roster")
    return null;
  const count = notice.roster.length + notice.notCreated.length;
  const by = notice.decidedBy ? ` · by ${notice.decidedBy}` : "";
  return `Crew approved · ${count} ${count === 1 ? "member" : "members"}${by}`;
};

/** A declined request's one line. */
export const crewDeclinedSummary = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) =>
  `Crew ${notice.crewName === null ? "" : `${notice.crewName} `}· ${notice.requestKind === "roster" ? "roster" : "seat"} declined${notice.decidedBy === null ? "" : ` by ${notice.decidedBy}`}`;

/** The notice's own line, beside the lines of the seats in it; null when it has none. */
export const crewNoticeSummary = (notice: CrewNoticePresentation): string | null =>
  notice.kind === "gate" && notice.decision === "declined"
    ? crewDeclinedSummary(notice)
    : crewApprovalSummary(notice);
