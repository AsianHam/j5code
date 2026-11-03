import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  presentCrewNotice,
  type CrewNoticeMessage,
  type CrewNoticePresentation,
} from "@t3tools/client-runtime/j5/crew-notices";

import { crewGateTitle, crewNoticeLines, type CrewNoticeLine } from "./crewNotices.logic";

export interface CrewNoticeRenderInput {
  readonly message: CrewNoticeMessage & {
    readonly createdAt: string;
  };
  readonly timestampLabel?: string | undefined;
  readonly participantLabels?: ReadonlyMap<string, string> | undefined;
  /** The thread the timeline shows; seats open on its environment. */
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly markdownCwd?: string | undefined;
}

/** A declined request as the Captain received it: what was asked for, and who declined it. */
function CrewDeclinedCard(props: {
  readonly notice: Extract<CrewNoticePresentation, { kind: "gate" }>;
  readonly input: CrewNoticeRenderInput;
}) {
  const { notice, input } = props;
  return (
    <section
      className="max-w-[88%] rounded-lg border border-border/70 bg-muted/25 px-3.5 py-2.5"
      data-j5-crew-renderer="gate"
      data-j5-crew-decision={notice.decision}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <UsersIcon className="size-3.5 shrink-0" aria-hidden />
          {crewGateTitle(notice)}
        </span>
        {notice.crewName !== null ? (
          <span className="font-medium text-foreground">{notice.crewName}</span>
        ) : null}
        {notice.decidedBy !== null ? (
          <span className="text-muted-foreground">· by {notice.decidedBy}</span>
        ) : null}
        <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-2xs font-semibold text-warning-foreground">
          Declined
        </span>
        {input.timestampLabel ? (
          <time
            className="ms-auto tabular-nums text-muted-foreground"
            dateTime={input.message.createdAt}
          >
            {input.timestampLabel}
          </time>
        ) : null}
      </div>
      {notice.requestedSeats.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Requested:{" "}
          {notice.requestedSeats.map((seat) => `${seat.seat} (${seat.agentId})`).join(", ")}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        The Captain can revise the request and propose again.
      </p>
    </section>
  );
}

/**
 * The seats a notice says need the person, one line each. A line opens its seat's thread; a seat
 * whose thread was never created is named without a link.
 */
function CrewNoticeLines(props: {
  readonly lines: ReadonlyArray<CrewNoticeLine>;
  readonly input: CrewNoticeRenderInput;
}) {
  const navigate = useNavigate();
  const environmentId = props.input.threadRef?.environmentId;
  return (
    <ul className="flex max-w-[88%] flex-col text-xs" data-j5-crew-renderer="lines">
      {props.lines.map((line, index) => {
        const content = (
          <>
            <span
              aria-hidden
              className={cn(
                "mt-1.5 size-1.5 shrink-0 self-start rounded-full",
                line.tone === "bad" ? "bg-destructive" : "bg-warning",
              )}
            />
            {line.crewName === null ? null : <span className="shrink-0">{line.crewName}</span>}
            <span className="shrink-0 font-medium">{line.seat}</span>
            <span className="min-w-0 break-words">{line.reason}</span>
          </>
        );
        const className = cn(
          "flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left",
          line.tone === "bad" ? "text-destructive-foreground" : "text-warning-foreground",
        );
        const threadId = line.threadId;
        // A folded notice can carry one seat twice (it failed, was messaged, failed again).
        return (
          // oxlint-disable-next-line react/no-array-index-key -- a folded notice can repeat a seat with the same reason, so no field is unique.
          <li key={`${line.threadId ?? line.seat}:${index}`}>
            {threadId === null || environmentId === undefined ? (
              <div className={className}>{content}</div>
            ) : (
              <button
                type="button"
                className={cn(
                  className,
                  "outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                )}
                onClick={() => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(environmentId, ThreadId.make(threadId)),
                    ),
                  });
                }}
              >
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Null for anything that is not a Crew notice; the caller then falls through to its own rendering.
 * A notice with no lines never reaches here: the timeline's entries leave it out.
 */
export function renderCrewNotice(input: CrewNoticeRenderInput): ReactNode {
  const notice = presentCrewNotice(input.message);
  if (notice === null) return null;
  if (notice.kind === "gate" && notice.decision === "declined")
    return <CrewDeclinedCard notice={notice} input={input} />;
  return <CrewNoticeLines lines={crewNoticeLines(notice)} input={input} />;
}
