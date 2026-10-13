import type { ScopedThreadRef } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";

import { toastManager } from "../../components/ui/toast";
import { readArchivePreflight, type ArchivePreflight } from "./archiveFlowClient";
import { presentParticipantIdentity } from "./ParticipantIdentity";
import {
  ArchiveWarningContent,
  type ArchiveWarningCrews,
  type ArchiveWarningParticipant,
  type ArchiveWarningPlacement,
  type ArchiveWarningPayload,
  type ArchiveWarningRow,
} from "./ArchiveWarningContent";

export interface ArchiveWarningConfirmation {
  readonly message: string;
  readonly content: ReactNode;
  readonly confirmLabel: "Archive" | "Archive anyway";
}

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
export function formatArchiveWarning(input: {
  readonly threadTitle: string;
  readonly preflight: ArchivePreflight;
}): ArchiveWarningConfirmation {
  const { threadTitle, preflight } = input;
  const { facts, participantLabels } = preflight;
  const title = `Archive ${threadTitle}?`;
  if (facts === null) {
    return {
      message: title,
      confirmLabel: "Archive",
      content: createElement(ArchiveWarningContent, {
        payload: {
          threadTitle,
          factsUnavailable: true,
          placement: { state: "unknown" },
          openAsks: [],
          crews: { state: "unknown" },
        },
      }),
    };
  }
  if (facts.state !== "registered") {
    return { message: title, content: null, confirmLabel: "Archive" };
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
  const payload: ArchiveWarningPayload = {
    threadTitle,
    factsUnavailable: false,
    placement,
    openAsks,
    crews,
  };
  return {
    message: title,
    content: createElement(ArchiveWarningContent, { payload }),
    confirmLabel: openAsks.length > 0 || crewsHaveConsequences ? "Archive anyway" : "Archive",
  };
}

/**
 * The action menu owns archive mutation; this J5 delegate owns preflight and the one warning.
 * Two Crew rules ride on it. A seat is never archived one by one (Crews AC16): the seat's archive
 * is refused here with the way out, as `archive_agent` refuses it for agents. A Captain is never
 * archived alone (AC17): the dialog shows the live Crews it commands, and once the archive
 * commits the server's lifecycle cascade retires them as units, whichever door the archive came
 * through, so nothing here has to run after the confirmation. Upstream's Undo stays on every
 * door: the Captain's unarchive brings back the Crews that retired with it (#312).
 */
export async function archiveWithPreflight<Result>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
  readonly confirm: (confirmation: ArchiveWarningConfirmation) => Promise<boolean>;
  /** Preserves the existing plain archive preference when no J5 warning is warranted. */
  readonly confirmCleanArchive?: () => Promise<boolean>;
  readonly archive: () => Promise<Result>;
}): Promise<Result | undefined> {
  let preflight: ArchivePreflight;
  try {
    preflight = await readArchivePreflight(input.threadRef);
  } catch {
    preflight = { facts: null, participantLabels: new Map() };
  }
  const crewSeat = preflight.facts?.state === "registered" ? preflight.facts.crewSeat : null;
  if (crewSeat !== null) {
    toastManager.add({
      type: "warning",
      title: `${input.threadTitle} is seat ${crewSeat.seat} of Crew ${crewSeat.crewName}`,
      description:
        "Crew members are never archived one by one. Retire the whole Crew with Archive crew on the Fleet page, or message the member instead.",
    });
    return undefined;
  }
  if (needsArchiveWarning(preflight)) {
    const confirmed = await input.confirm(
      formatArchiveWarning({ threadTitle: input.threadTitle, preflight }),
    );
    if (!confirmed) return undefined;
  } else if (input.confirmCleanArchive && !(await input.confirmCleanArchive())) {
    return undefined;
  }
  return input.archive();
}
