import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { CircleAlertIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  crewApprovalSummary,
  crewDeclinedSummary,
  crewNoticeLines,
  presentCrewContext,
  presentCrewNotice,
  type CrewNoticeLine,
  type CrewNoticeMessage,
  type CrewNoticePresentation,
} from "@t3tools/client-runtime/j5/crew-notices";

import {
  J5NoticeActions,
  J5NoticeDetailText,
  J5NoticeLine,
  J5OpenThread,
} from "../a2a/J5NoticeLine";

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

const seatRef = (input: CrewNoticeRenderInput, threadId: string | null) =>
  threadId === null || !input.threadRef
    ? null
    : scopeThreadRef(input.threadRef.environmentId, ThreadId.make(threadId));

/** One seat that needs the person. A seat whose thread was never created has no link. */
function CrewSeatLine(props: {
  readonly line: CrewNoticeLine;
  readonly input: CrewNoticeRenderInput;
}) {
  const { line, input } = props;
  const threadRef = seatRef(input, line.threadId);
  const summary = [line.crewName, line.seat, line.reason].filter(Boolean).join(" ");
  return (
    <J5NoticeLine
      kind={line.tone === "bad" ? "crew-seat-bad" : "crew-seat-warn"}
      icon={line.tone === "bad" ? CircleAlertIcon : TriangleAlertIcon}
      tone={line.tone}
      summary={summary}
      timestampLabel={input.timestampLabel}
    >
      {line.detail === null && threadRef === null ? null : (
        <>
          {line.detail === null ? null : <J5NoticeDetailText text={line.detail} />}
          {threadRef === null ? null : (
            <J5NoticeActions>
              <J5OpenThread threadRef={threadRef} label="Open seat thread" />
            </J5NoticeActions>
          )}
        </>
      )}
    </J5NoticeLine>
  );
}

function CrewApprovedLine(props: {
  readonly summary: string;
  readonly notice: Extract<CrewNoticePresentation, { kind: "gate" }>;
  readonly input: CrewNoticeRenderInput;
}) {
  const { notice, input } = props;
  return (
    <J5NoticeLine
      kind="crew-approved"
      icon={UsersIcon}
      summary={props.summary}
      timestampLabel={input.timestampLabel}
    >
      {notice.changes === null ? null : (
        <J5NoticeDetailText text={`Changed by the person: ${notice.changes}.`} />
      )}
      <J5NoticeActions>
        {notice.roster.map((seat) => {
          const threadRef = seatRef(input, seat.threadId);
          return threadRef === null ? (
            <span key={seat.threadId}>{seat.seat}</span>
          ) : (
            <J5OpenThread key={seat.threadId} threadRef={threadRef} label={seat.seat} />
          );
        })}
      </J5NoticeActions>
    </J5NoticeLine>
  );
}

/**
 * Null for anything that is not a Crew notice; the caller then falls through to its own rendering.
 * Every Crew notice is a platform notice's one line. Approval summaries remain visible; completed
 * finishes without a warning take no timeline row.
 */
export function renderCrewNotice(input: CrewNoticeRenderInput): ReactNode {
  const context = presentCrewContext(input.message);
  if (context !== null) {
    // What the model read, long and not written for the person, so it opens on request.
    return (
      <J5NoticeLine
        kind={`crew-context-${context.kind}`}
        icon={UsersIcon}
        summary={`${context.title} from J5`}
        timestampLabel={input.timestampLabel}
      >
        <pre
          className="whitespace-pre-wrap break-words text-xs leading-relaxed"
          data-thread-find-text="true"
        >
          {context.text}
        </pre>
      </J5NoticeLine>
    );
  }
  const notice = presentCrewNotice(input.message);
  if (notice === null) return null;
  if (notice.kind === "gate" && notice.decision === "declined") {
    const requested = notice.requestedSeats
      .map((seat) => `${seat.seat} (${seat.agentId})`)
      .join(", ");
    return (
      <J5NoticeLine
        kind="crew-declined"
        icon={UsersIcon}
        summary={crewDeclinedSummary(notice)}
        timestampLabel={input.timestampLabel}
      >
        <J5NoticeDetailText
          text={`${requested.length === 0 ? "" : `Requested: ${requested}\n\n`}The Captain can revise the request and propose again.`}
        />
      </J5NoticeLine>
    );
  }
  const summary = crewApprovalSummary(notice);
  return (
    <div className="flex flex-col items-start gap-1">
      {summary === null || notice.kind !== "gate" ? null : (
        <CrewApprovedLine summary={summary} notice={notice} input={input} />
      )}
      {crewNoticeLines(notice).map((line, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a folded notice can repeat a seat with the same reason, so no field is unique.
        <CrewSeatLine key={`${line.threadId ?? line.seat}:${index}`} line={line} input={input} />
      ))}
    </div>
  );
}
