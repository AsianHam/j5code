import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { InboxIcon, SendIcon } from "lucide-react";

import { RelativeAge } from "../RelativeAge";
import { Badge } from "../../components/ui/badge";
import {
  ARCHIVE_WARNING_WORKSPACE_NOTE,
  archiveWarningAskHeader,
  archiveWarningSeatConsequences,
  sentenceEnd,
  type ArchiveWarningCrew,
  type ArchiveWarningParticipant,
  type ArchiveWarningPayload,
  type ArchiveWarningRow,
} from "@t3tools/client-runtime/j5/archive-flow";

/** The seats of one Crew with what ends for each; shared by the Captain's dialog and the Fleet page. */
export function ArchiveWarningCrewSeats({ crew }: { readonly crew: ArchiveWarningCrew }) {
  return (
    <ul className="mt-1 space-y-1">
      {crew.seats.map((seat) => {
        const consequences = archiveWarningSeatConsequences(seat);
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
  const askHeader = archiveWarningAskHeader(askCount);
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
            // oxlint-disable-next-line react/no-array-index-key -- a fixed list read once for the dialog; entries have no id and may repeat.
            <span key={`${participant.displayName}-${index}`}>
              {index > 0 ? ", " : null}
              <ArchiveWarningParticipantName participant={participant} />
            </span>
          ))}
          {sentenceEnd(payload.placement.participants.at(-1)?.displayName ?? "")}
        </p>
      ) : null}
      {askCount > 0 ? (
        <section aria-label="Open asks will be terminated and counterparties notified">
          <p className="mb-2 font-medium text-foreground">{askHeader}</p>
          <ol className="space-y-2">
            {payload.openAsks.map((row, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- a fixed list read once for the dialog; entries have no id and may repeat.
              <ArchiveWarningRowView key={`${row.direction}-${row.openedAt}-${index}`} row={row} />
            ))}
          </ol>
        </section>
      ) : null}
      <p className="border-t border-border/60 pt-3 text-muted-foreground">
        {ARCHIVE_WARNING_WORKSPACE_NOTE}
      </p>
    </div>
  );
}
