import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  artifactPanelPath,
  crewGateFooter,
  crewSeatsTitle,
  crewGateTitle,
  presentCrewNotice,
  seatRunStatusLabel,
  type CrewNoticeMessage,
  type CrewNoticePresentation,
} from "./crewNotices.logic";

const TONE_CLASS = {
  good: "bg-success/15 text-success-foreground",
  bad: "bg-destructive/15 text-destructive-foreground",
  warn: "bg-warning/15 text-warning-foreground",
  muted: "border border-border/70 text-muted-foreground",
} as const;

export interface CrewNoticeRenderInput {
  readonly message: CrewNoticeMessage & {
    readonly createdAt: string;
  };
  readonly timestampLabel?: string | undefined;
  readonly participantLabels?: ReadonlyMap<string, string> | undefined;
  /** The thread the timeline shows; seats open on its environment and markdown resolves against it. */
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly markdownCwd?: string | undefined;
}

/**
 * The gate's decision as the Captain received it: what was decided, about which Crew, and the
 * roster seat by seat. Every seat opens its thread; its label names the saved agent, not the thread title.
 */
function CrewGateCard(props: {
  readonly notice: Extract<CrewNoticePresentation, { kind: "gate" }>;
  readonly input: CrewNoticeRenderInput;
}) {
  const { notice, input } = props;
  const navigate = useNavigate();
  const environmentId = input.threadRef?.environmentId;
  const approved = notice.decision === "approved";
  const openSeat = (threadId: string) => {
    if (environmentId === undefined) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(threadId))),
    });
  };
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
        {approved && notice.requestKind === "addition" && notice.crewVersion !== null ? (
          <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
            v{notice.crewVersion}
          </span>
        ) : null}
        {!approved ? (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-2xs font-semibold text-warning-foreground">
            Declined
          </span>
        ) : null}
        {input.timestampLabel ? (
          <time
            className="ms-auto tabular-nums text-muted-foreground"
            dateTime={input.message.createdAt}
          >
            {input.timestampLabel}
          </time>
        ) : null}
      </div>
      {approved && notice.changes !== null ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          You changed the roster: {notice.changes}.
        </p>
      ) : null}
      {approved ? (
        <ul className="mt-2 flex flex-col gap-1">
          {notice.roster.map((seat) => {
            const label = seat.agentId || "Custom seat";
            const failure = notice.failures.find((entry) => entry.seat === seat.seat) ?? null;
            return (
              <li key={seat.seat}>
                <button
                  type="button"
                  disabled={environmentId === undefined}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => openSeat(seat.threadId)}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="flex min-w-0 items-center gap-2">
                          <Badge variant="outline" size="sm" className="shrink-0">
                            {seat.seat}
                          </Badge>
                          {label.toLowerCase() !== seat.seat.toLowerCase() ? (
                            <span className="truncate text-foreground">{label}</span>
                          ) : null}
                        </span>
                      }
                    />
                    <TooltipPopup>{seat.participantId}</TooltipPopup>
                  </Tooltip>
                  {seat.isNew ? (
                    <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-2xs font-semibold text-success-foreground">
                      New
                    </span>
                  ) : null}
                  {seat.start === "failed" ? (
                    <span className="ms-auto shrink-0 rounded-md bg-destructive/15 px-1.5 py-0.5 text-2xs font-semibold text-destructive-foreground">
                      Failed
                    </span>
                  ) : seat.start === "pending" ? (
                    <span className="ms-auto shrink-0 rounded-md bg-warning/15 px-1.5 py-0.5 text-2xs font-semibold text-warning-foreground">
                      Start unconfirmed
                    </span>
                  ) : null}
                </button>
                {failure !== null ? (
                  <p className="ps-1.5 text-xs text-muted-foreground">{failure.detail}</p>
                ) : null}
              </li>
            );
          })}
          {notice.notCreated.map((seat) => (
            <li key={seat.seat}>
              <div className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-sm">
                <Badge variant="outline" size="sm" className="shrink-0">
                  {seat.seat}
                </Badge>
                <span className="ms-auto shrink-0 rounded-md bg-destructive/15 px-1.5 py-0.5 text-2xs font-semibold text-destructive-foreground">
                  Not created
                </span>
              </div>
              <p className="ps-1.5 text-xs text-muted-foreground">{seat.detail}</p>
            </li>
          ))}
        </ul>
      ) : notice.requestedSeats.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Requested:{" "}
          {notice.requestedSeats.map((seat) => `${seat.seat} (${seat.agentId})`).join(", ")}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">{crewGateFooter(notice)}</p>
    </section>
  );
}

/**
 * Seats' finishes as the Captain received them: each seat's measured end and where its handoff
 * stands, the handoff opening in the artifacts panel and its text one click away when it rode
 * inline. Several seats share one card when their notices folded into one message.
 */
function CrewSeatsCard(props: {
  readonly notice: Extract<CrewNoticePresentation, { kind: "seats" }>;
  readonly input: CrewNoticeRenderInput;
}) {
  const { notice, input } = props;
  const navigate = useNavigate();
  const threadRef = input.threadRef ?? null;
  const crews = new Set(notice.seats.map((seat) => seat.crewName));
  const openSeat = (threadId: string) => {
    if (threadRef === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(threadRef.environmentId, ThreadId.make(threadId)),
      ),
    });
  };
  return (
    <section
      className="max-w-[88%] rounded-lg border border-border/70 bg-muted/25 px-3.5 py-2.5"
      data-j5-crew-renderer="seats"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <UsersIcon className="size-3.5 shrink-0" aria-hidden />
          {crewSeatsTitle(notice.seats)}
        </span>
        {crews.size === 1 && notice.seats[0]!.crewName !== null ? (
          <span className="font-medium text-foreground">{notice.seats[0]!.crewName}</span>
        ) : null}
        {input.timestampLabel ? (
          <time
            className="ms-auto tabular-nums text-muted-foreground"
            dateTime={input.message.createdAt}
          >
            {input.timestampLabel}
          </time>
        ) : null}
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {notice.seats.map((seat) => {
          const status = seatRunStatusLabel(seat.runStatus);
          const handoff = seat.handoff;
          return (
            <li key={`${seat.participantId}:${seat.runStatus}`} className="flex flex-col gap-1">
              <button
                type="button"
                disabled={threadRef === null}
                className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                onClick={() => openSeat(seat.threadId)}
              >
                <span
                  className={`rounded-md px-1.5 py-0.5 text-2xs font-semibold ${TONE_CLASS[status.tone]}`}
                >
                  {status.label}
                </span>
                <Badge variant="outline" size="sm" className="shrink-0">
                  {seat.seat}
                </Badge>
                {crews.size > 1 && seat.crewName !== null ? (
                  <span className="truncate text-xs text-muted-foreground">{seat.crewName}</span>
                ) : null}
                {handoff.status === "none declared" ? null : (
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-2xs font-semibold ${
                      handoff.status === "written" ? TONE_CLASS.muted : TONE_CLASS.warn
                    }`}
                  >
                    {handoff.status === "written"
                      ? "Handoff written"
                      : handoff.status === "unavailable"
                        ? "Handoff unavailable"
                        : "Handoff missing"}{" "}
                    · {handoff.kind}
                  </span>
                )}
              </button>
              {seat.failure !== null ? (
                <p className="ms-1.5 text-xs text-muted-foreground">{seat.failure}</p>
              ) : null}
              {handoff.status === "unavailable" && handoff.reason !== null ? (
                <p className="ms-1.5 text-xs text-muted-foreground">
                  The handoff can't be read: {handoff.reason}.
                </p>
              ) : null}
              {handoff.status === "written" && handoff.artifactPath !== null ? (
                <div className="ms-1.5 flex flex-col gap-1">
                  <button
                    type="button"
                    disabled={threadRef === null}
                    className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default"
                    onClick={() => {
                      if (threadRef === null) return;
                      useRightPanelStore
                        .getState()
                        .openArtifact(threadRef, artifactPanelPath(handoff.artifactPath!));
                    }}
                  >
                    <FileTextIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{handoff.artifactPath}</span>
                  </button>
                  {handoff.body !== null ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Show handoff
                      </summary>
                      <ChatMarkdown
                        text={handoff.body}
                        cwd={input.markdownCwd}
                        threadRef={threadRef ?? undefined}
                        className="mt-1 text-sm text-foreground"
                        parseRawHtml={false}
                      />
                    </details>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Null for anything that is not a Crew notice; the caller then falls through to its own rendering. */
export function renderCrewNotice(input: CrewNoticeRenderInput): ReactNode {
  const notice = presentCrewNotice(input.message);
  if (notice === null) return null;
  if (notice.kind === "seats") return <CrewSeatsCard notice={notice} input={input} />;
  return <CrewGateCard notice={notice} input={input} />;
}
