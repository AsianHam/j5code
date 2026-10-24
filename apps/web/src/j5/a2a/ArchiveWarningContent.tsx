import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { InboxIcon, SendIcon } from "lucide-react";

import { RelativeAge } from "../RelativeAge";
import { Badge } from "../../components/ui/badge";

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

const seatConsequences = (seat: ArchiveWarningCrewSeat) =>
  [
    seat.runningTurn ? "running turn" : null,
    seat.openAsks > 0 ? `${seat.openAsks} open ask${seat.openAsks === 1 ? "" : "s"}` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

/** The seats of one Crew with what ends for each; shared by the Captain's dialog and the Fleet page. */
export function ArchiveWarningCrewSeats({ crew }: { readonly crew: ArchiveWarningCrew }) {
  return (
    <ul className="mt-1 space-y-1">
      {crew.seats.map((seat) => {
        const consequences = seatConsequences(seat);
        return (
          <li key={seat.seat} className="flex items-baseline gap-2 text-sm">
            <span className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
              {seat.seat}
            </span>
            <ArchiveWarningParticipantName participant={seat.participant} />
            {consequences === "" ? null : (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{consequences}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const urgencyPresentation = {
  blocking: { label: "Blocking", variant: "destructive" as const },
  soon: { label: "Soon", variant: "warning" as const },
  fyi: { label: "FYI", variant: "secondary" as const },
  none: { label: "No urgency", variant: "secondary" as const },
};

function ArchiveWarningParticipantName({
  participant,
}: {
  readonly participant: ArchiveWarningParticipant;
}) {
  return participant.tooltipParticipantId === null ? (
    <span className="font-medium text-foreground">{participant.displayName}</span>
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className="italic" />}>
        {participant.displayName}
      </TooltipTrigger>
      <TooltipPopup>{participant.tooltipParticipantId}</TooltipPopup>
    </Tooltip>
  );
}

function ArchiveWarningRowView({ row }: { readonly row: ArchiveWarningRow }) {
  const urgency = urgencyPresentation[row.urgency ?? "none"];
  const isInbound = row.direction === "inbound";
  const DirectionIcon = isInbound ? InboxIcon : SendIcon;
  return (
    <li className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Badge size="sm" variant={urgency.variant}>
          <span className="uppercase tracking-wide">{urgency.label}</span>
        </Badge>
        <span className="inline-flex shrink-0 items-center gap-1">
          <DirectionIcon aria-hidden className="size-3" />
          {isInbound ? "From" : "To"}
        </span>
        <ArchiveWarningParticipantName participant={row.participant} />
        <time className="ml-auto shrink-0 tabular-nums" dateTime={row.openedAt}>
          open <RelativeAge timestamp={row.openedAt} fallback="couldn't check age" />
        </time>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <p className="mt-1 line-clamp-3 break-words text-sm leading-snug text-foreground" />
          }
        >
          {row.intent}
        </TooltipTrigger>
        <TooltipPopup className="max-w-96 break-words">{row.intent}</TooltipPopup>
      </Tooltip>
    </li>
  );
}

export function ArchiveWarningContent({ payload }: { readonly payload: ArchiveWarningPayload }) {
  const askCount = payload.openAsks.length;
  const crews = payload.crews?.state === "known" ? payload.crews.crews : [];
  const askHeader = `${askCount} open ask${askCount === 1 ? "" : "s"} will be terminated (${
    askCount === 1 ? "counterparty is" : "counterparties are"
  } notified)`;
  return (
    <div className="space-y-3 text-left">
      {payload.factsUnavailable ? <p>Couldn't check open asks or the placement subtree.</p> : null}
      {payload.placement.state === "unknown" && !payload.factsUnavailable ? (
        <p>Placement subtree: couldn't check.</p>
      ) : null}
      {payload.crews?.state === "unknown" && !payload.factsUnavailable ? (
        <p>Crews it commands: couldn't check.</p>
      ) : null}
      {crews.length > 0 ? (
        <section aria-label="Crews retired first">
          <p className="mb-2 font-medium text-foreground">
            A Captain is never archived alone. {crews.length === 1 ? "This Crew" : "These Crews"}{" "}
            {crews.length === 1 ? "retires" : "retire"} with it, every seat together:
          </p>
          <ol className="space-y-2">
            {crews.map((crew) => (
              <li
                key={crew.crewInstanceId}
                className="rounded-md border border-border/70 bg-muted/30 px-3 py-2"
              >
                <p className="text-sm font-medium text-foreground">
                  Crew · {crew.crewName}{" "}
                  <span className="font-normal text-muted-foreground">
                    ({crew.seats.length} {crew.seats.length === 1 ? "seat" : "seats"})
                  </span>
                </p>
                <ArchiveWarningCrewSeats crew={crew} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {payload.placement.state === "known" ? (
        <p>
          {payload.placement.participants.length} agent
          {payload.placement.participants.length === 1 ? "" : "s"} placed under{" "}
          {payload.threadTitle} keep{payload.placement.participants.length === 1 ? "s" : ""}{" "}
          running:{" "}
          {payload.placement.participants.map((participant, index) => (
            <span key={`${participant.displayName}-${index}`}>
              {index > 0 ? ", " : null}
              <ArchiveWarningParticipantName participant={participant} />
            </span>
          ))}
          .
        </p>
      ) : null}
      {askCount > 0 ? (
        <section aria-label="Open asks will be terminated and counterparties notified">
          <p className="mb-2 font-medium text-foreground">{askHeader}</p>
          <ol className="space-y-2">
            {payload.openAsks.map((row, index) => (
              <ArchiveWarningRowView key={`${row.direction}-${row.openedAt}-${index}`} row={row} />
            ))}
          </ol>
        </section>
      ) : null}
      <p className="border-t border-border/60 pt-3 text-muted-foreground">
        Worktrees, branches, and pull requests remain. Cleanup is a separate action.
      </p>
    </div>
  );
}
