import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { PreArchiveCrewSeat, PreArchiveFacts } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import type { AtomRegistry } from "effect/reactivity";

import {
  participantIdentitiesFromResponse,
  presentParticipantIdentity,
  type ParticipantIdentities,
} from "./participantIdentity.ts";
import type { createJ5EnvironmentAtoms } from "./state.ts";

export type { PreArchiveFacts, PreArchiveLiveCrew as LiveCrew } from "@t3tools/contracts/j5";

type J5Reads = Pick<
  ReturnType<typeof createJ5EnvironmentAtoms<never, unknown>>,
  "readPreArchiveFacts" | "readParticipantIdentities"
>;

/** Unknown participants stay absent, and so does every one when the read fails. */
export async function readParticipantIdentities(
  j5: Pick<J5Reads, "readParticipantIdentities">,
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): Promise<ParticipantIdentities> {
  if (participantIds.length === 0) return { labels: new Map(), threads: new Map() };
  const result = await j5.readParticipantIdentities.run(registry, {
    environmentId,
    input: { participantIds },
  });
  return result._tag === "Failure"
    ? { labels: new Map(), threads: new Map() }
    : participantIdentitiesFromResponse(environmentId, result.value);
}

export interface ArchivePreflight {
  readonly facts: PreArchiveFacts | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}

/** Facts remain useful without identity labels; literal participant ids are the honest fallback. */
export async function readArchivePreflight(
  j5: J5Reads,
  registry: AtomRegistry.AtomRegistry,
  threadRef: ScopedThreadRef,
): Promise<ArchivePreflight> {
  const result = await j5.readPreArchiveFacts.run(registry, {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  const facts = result.value;
  if (facts.state !== "registered") return { facts, participantLabels: new Map() };
  const ids = Array.from(
    new Set([
      ...facts.openExchanges.map((exchange) => exchange.counterpartyId),
      ...(facts.placementSubtree.state === "known" ? facts.placementSubtree.participantIds : []),
      ...(facts.liveCrews ?? []).flatMap((crew) => crew.seats.map((seat) => seat.participantId)),
    ]),
  );
  const identities = await readParticipantIdentities(j5, registry, threadRef.environmentId, ids);
  return { facts, participantLabels: identities.labels };
}

export type ArchiveWarningUrgency = "blocking" | "soon" | "fyi" | null;

export interface ArchiveWarningParticipant {
  readonly displayName: string;
  /** Present only for the tooltip on an honest unknown-identity fallback. */
  readonly tooltipParticipantId: string | null;
}

export interface ArchiveWarningRow {
  readonly direction: "inbound" | "outbound";
  readonly participant: ArchiveWarningParticipant;
  readonly urgency: ArchiveWarningUrgency;
  readonly intent: string;
  readonly openedAt: string;
}

export type ArchiveWarningPlacement =
  | { readonly state: "none" }
  | { readonly state: "unknown" }
  | { readonly state: "known"; readonly participants: ReadonlyArray<ArchiveWarningParticipant> };

export interface ArchiveWarningCrewSeat {
  readonly seat: string;
  readonly participant: ArchiveWarningParticipant;
  readonly runningTurn: boolean;
  readonly openAsks: number;
}

/** One live Crew the agent commands; it retires as a unit, seat by seat, before the agent does. */
export interface ArchiveWarningCrew {
  readonly crewInstanceId: string;
  readonly crewName: string;
  readonly seats: ReadonlyArray<ArchiveWarningCrewSeat>;
}

export type ArchiveWarningCrews =
  | { readonly state: "unknown" }
  | { readonly state: "known"; readonly crews: ReadonlyArray<ArchiveWarningCrew> };

export interface ArchiveWarningPayload {
  readonly threadTitle: string;
  readonly factsUnavailable: boolean;
  readonly placement: ArchiveWarningPlacement;
  readonly openAsks: ReadonlyArray<ArchiveWarningRow>;
  /** Live Crews the agent commands; absent when the caller has no Crew facts to show. */
  readonly crews?: ArchiveWarningCrews;
}

export interface ArchiveWarning {
  readonly title: string;
  /** Null when the thread is not an agent, so there are no facts to show. */
  readonly payload: ArchiveWarningPayload | null;
  readonly confirmLabel: "Archive" | "Archive anyway";
}

export const archiveWarningSeatConsequences = (seat: ArchiveWarningCrewSeat) =>
  [
    seat.runningTurn ? "running turn" : null,
    seat.openAsks > 0 ? `${seat.openAsks} open ask${seat.openAsks === 1 ? "" : "s"}` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

export const archiveWarningAskHeader = (askCount: number) =>
  `${askCount} open ask${askCount === 1 ? "" : "s"} will be terminated (${
    askCount === 1 ? "counterparty is" : "counterparties are"
  } notified)`;

export const ARCHIVE_WARNING_WORKSPACE_NOTE =
  "Worktrees, branches, and pull requests remain. Cleanup is a separate action.";

/** Agent names can be a whole brief, so one may already end its own sentence. */
export const sentenceEnd = (lastWords: string) => (/[.!?…]$/.test(lastWords.trimEnd()) ? "" : ".");

const displayParticipant = (
  participantId: string,
  labels: ReadonlyMap<string, string>,
): ArchiveWarningParticipant => {
  const presentation = presentParticipantIdentity({
    participantId,
    participantLabels: labels,
    annotateHumanInbox: true,
  });
  return {
    displayName: presentation.label,
    tooltipParticipantId: presentation.tooltipParticipantId,
  };
};

export function needsArchiveWarning(preflight: ArchivePreflight): boolean {
  const { facts } = preflight;
  if (facts === null) return true;
  if (facts.state !== "registered") return false;
  // A failed Crew read warns: it is not "no Crews".
  return (
    facts.openExchanges.length > 0 ||
    facts.placementSubtree.state !== "none" ||
    facts.liveCrews === null ||
    facts.liveCrews.length > 0
  );
}

/** Exact measured facts for the one destructive confirmation; no fact becomes an empty success state. */
export function buildArchiveWarning(input: {
  readonly threadTitle: string;
  readonly preflight: ArchivePreflight;
}): ArchiveWarning {
  const { threadTitle, preflight } = input;
  const { facts, participantLabels } = preflight;
  const title = `Archive ${threadTitle}?`;
  if (facts === null) {
    return {
      title,
      confirmLabel: "Archive",
      payload: {
        threadTitle,
        factsUnavailable: true,
        placement: { state: "unknown" },
        openAsks: [],
        crews: { state: "unknown" },
      },
    };
  }
  if (facts.state !== "registered") {
    return { title, payload: null, confirmLabel: "Archive" };
  }
  const { liveCrews } = facts;
  const crews: ArchiveWarningCrews =
    liveCrews === null
      ? { state: "unknown" }
      : {
          state: "known",
          crews: liveCrews.map((crew) => ({
            crewInstanceId: crew.crewInstanceId,
            crewName: crew.crewName,
            seats: crew.seats.map((seat) => ({
              seat: seat.seat,
              participant: displayParticipant(seat.participantId, participantLabels),
              runningTurn: seat.runningTurn,
              openAsks: seat.openAsks,
            })),
          })),
        };
  const crewsHaveConsequences =
    crews.state === "known" &&
    crews.crews.some((crew) => crew.seats.some((seat) => seat.runningTurn || seat.openAsks > 0));

  // Seats of a commanded Crew retire with it and are listed there; every other agent placed
  // beneath keeps running, since an archive touches one agent.
  const crewSeatIds = new Set(
    (liveCrews ?? []).flatMap((crew) => crew.seats.map((seat) => seat.participantId)),
  );
  const keptRunning =
    facts.placementSubtree.state === "known"
      ? facts.placementSubtree.participantIds.filter(
          (participantId) => !crewSeatIds.has(participantId),
        )
      : [];
  const placement: ArchiveWarningPlacement =
    facts.placementSubtree.state === "known"
      ? keptRunning.length === 0
        ? { state: "none" }
        : {
            state: "known",
            participants: keptRunning.map((participantId) =>
              displayParticipant(participantId, participantLabels),
            ),
          }
      : facts.placementSubtree.state === "unknown"
        ? { state: "unknown" }
        : { state: "none" };
  const openAsks: ReadonlyArray<ArchiveWarningRow> = facts.openExchanges.map((exchange) => ({
    direction: exchange.direction,
    participant: displayParticipant(exchange.counterpartyId, participantLabels),
    urgency: exchange.urgency,
    intent: exchange.intent,
    openedAt: exchange.openedAt,
  }));
  return {
    title,
    payload: { threadTitle, factsUnavailable: false, placement, openAsks, crews },
    confirmLabel: openAsks.length > 0 || crewsHaveConsequences ? "Archive anyway" : "Archive",
  };
}

/**
 * Preflight and the one warning; the caller owns the mutation. A seat is refused with the way out
 * (Crews AC16). A Captain's live Crews are listed (AC17) and the server's lifecycle cascade
 * retires them on commit from any door, so nothing here runs after confirmation.
 */
export async function archiveWithPreflight<Result>(input: {
  readonly threadTitle: string;
  readonly readPreflight: () => Promise<ArchivePreflight>;
  readonly refuseCrewSeat: (crewSeat: PreArchiveCrewSeat) => void;
  readonly confirm: (warning: ArchiveWarning) => Promise<boolean>;
  /** Preserves the existing plain archive preference when no J5 warning is warranted. */
  readonly confirmCleanArchive?: () => Promise<boolean>;
  readonly archive: () => Promise<Result>;
}): Promise<Result | undefined> {
  let preflight: ArchivePreflight;
  try {
    preflight = await input.readPreflight();
  } catch {
    preflight = { facts: null, participantLabels: new Map() };
  }
  const crewSeat = preflight.facts?.state === "registered" ? preflight.facts.crewSeat : null;
  if (crewSeat !== null) {
    input.refuseCrewSeat(crewSeat);
    return undefined;
  }
  if (needsArchiveWarning(preflight)) {
    const confirmed = await input.confirm(
      buildArchiveWarning({ threadTitle: input.threadTitle, preflight }),
    );
    if (!confirmed) return undefined;
  } else if (input.confirmCleanArchive && !(await input.confirmCleanArchive())) {
    return undefined;
  }
  return input.archive();
}
