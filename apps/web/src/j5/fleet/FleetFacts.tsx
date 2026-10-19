import { useAtomValue } from "@effect/atom-react";
import type { FleetDerivedFacts } from "@t3tools/client-runtime/j5/fleetFacts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FleetAgent, FleetAgentFacts } from "@t3tools/contracts/j5";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNowMinute } from "../../hooks/useNowMinute";
import { fleetSourcesAtom } from "../state";
import {
  fleetFactsAtom,
  fleetLiveRowsAtom,
  fleetAgentFactsAtom,
  fleetLiveAgentAtom,
  fleetEnvironmentLivenessAtom,
  fleetReadTimeAtom,
} from "./fleetState";
import {
  fleetCrewSummary,
  fleetAgentKey,
  fleetStatusLabel,
  fleetMinutes,
  fleetTime,
  fleetProblemLabel,
} from "./fleetPresentation";

export function FleetFactHint({
  reason,
  children,
  className,
}: {
  readonly reason: string | undefined;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  if (reason === undefined) return <span className={className}>{children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{children}</TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}

export function FleetSourceReadout() {
  const sources = useAtomValue(fleetSourcesAtom);
  const live = useAtomValue(fleetEnvironmentLivenessAtom);
  return (
    <div className="my-3 space-y-1 text-xs text-muted-foreground">
      {sources.sources.map((source) => (
        <p key={source.environmentId}>
          {source.environmentLabel} · ledger as of{" "}
          {source.data?.asOf === undefined ? (
            <FleetFactHint reason="This environment does not report its Fleet read time.">
              ?
            </FleetFactHint>
          ) : (
            <FleetFactHint reason={source.data.asOf}>
              <time dateTime={source.data.asOf}>{fleetTime(source.data.asOf)}</time>
            </FleetFactHint>
          )}
          {live.get(source.environmentId) === true
            ? " · runtime live"
            : " · stale — current facts unavailable"}
        </p>
      ))}
    </div>
  );
}

function WaitingMinutes({ since }: { readonly since: string }) {
  const minute = useNowMinute();
  return <>{fleetMinutes(since, Date.parse(`${minute}:00Z`))}m</>;
}

function AskAge({ openedAt }: { readonly openedAt: string }) {
  const minute = useNowMinute();
  return <>{fleetMinutes(openedAt, Date.parse(`${minute}:00Z`))}m ago</>;
}

function AskDetails({
  asks,
  live,
  asOf,
}: {
  readonly asks: FleetAgentFacts["asks"];
  readonly live: boolean;
  readonly asOf: string | undefined;
}) {
  return (
    <div className="space-y-2">
      {(
        [
          ["Owes", asks.owed],
          ["Awaiting", asks.awaited],
        ] as const
      ).map(([label, entries]) => (
        <div key={label}>
          <p>
            {label} {entries.length}
          </p>
          {entries.map((ask) => (
            <p key={ask.exchangeId}>
              <span>
                {ask.counterpartyName ?? ask.counterpartyId}
                {ask.counterpartyName === null ? " (name unavailable)" : ""}
              </span>
              {` · ${ask.intent} · `}
              {live ? (
                <AskAge openedAt={ask.openedAt} />
              ) : (
                `${asOf === undefined ? "age ?" : `${fleetMinutes(ask.openedAt, Date.parse(asOf))}m at last read`} · opened ${fleetTime(ask.openedAt)} (stale)`
              )}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

export function FleetFactCells({
  environmentId,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: FleetAgent;
}) {
  const key = fleetAgentKey(environmentId, agent.participantId);
  const facts = useAtomValue(fleetAgentFactsAtom(key));
  const live = useAtomValue(fleetLiveAgentAtom(key));
  const asOf = useAtomValue(fleetReadTimeAtom(environmentId));
  const runtime = facts?.runtime;
  const activity = facts?.lastActivity;
  const unknownReason = "The live Fleet read has not provided this fact.";
  return (
    <>
      <FleetFactHint
        className="text-xs"
        reason={
          runtime === undefined
            ? unknownReason
            : runtime.state === "unknown"
              ? runtime.reason
              : !live
                ? "Showing the last measured runtime; this environment is unavailable."
                : undefined
        }
      >
        {runtime === undefined ? (
          "?"
        ) : runtime.state === "known" &&
          runtime.status === "waiting-to-start" &&
          runtime.since !== null ? (
          <>
            Waiting to start ·{" "}
            {live ? <WaitingMinutes since={runtime.since} /> : `since ${fleetTime(runtime.since)}`}
          </>
        ) : (
          fleetStatusLabel(runtime)
        )}
        {!live ? <span className="ms-1 text-muted-foreground">(stale)</span> : null}
      </FleetFactHint>
      {facts?.asks === undefined ? (
        <FleetFactHint
          className="text-right text-xs text-muted-foreground"
          reason="This environment does not provide owed and awaited Exchange details."
        >
          ?
        </FleetFactHint>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="text-right text-xs tabular-nums" />}>
            Owes {facts.asks.owed.length} · Awaiting {facts.asks.awaited.length}
          </TooltipTrigger>
          <TooltipPopup>
            <AskDetails asks={facts.asks} live={live} asOf={asOf} />
          </TooltipPopup>
        </Tooltip>
      )}
      <FleetFactHint
        className="text-right text-xs text-muted-foreground"
        reason={
          activity?.state === "unknown"
            ? activity.reason
            : activity?.state === "known"
              ? activity.at
              : unknownReason
        }
      >
        {activity?.state === "known" ? `${activity.label} ${fleetTime(activity.at)}` : "?"}
      </FleetFactHint>
      <FleetProblems facts={facts} ledgerKnown={facts?.asks !== undefined} />
    </>
  );
}

function FleetProblems({
  facts,
  ledgerKnown,
}: {
  readonly facts: FleetDerivedFacts | undefined;
  readonly ledgerKnown: boolean;
}) {
  const runtimeKnown = facts?.runtime.state === "known";
  if (facts?.problems.length === 0 && runtimeKnown && ledgerKnown) return null;
  return (
    <span className="col-span-full flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {facts?.problems.map((problem) => (
        <span
          className="text-destructive"
          key={
            problem.kind === "delivery-failed"
              ? problem.messageId
              : `${problem.kind}:${problem.runId}`
          }
        >
          {fleetProblemLabel(problem)}
        </span>
      ))}
      {!ledgerKnown || !runtimeKnown ? (
        <FleetFactHint
          className="text-muted-foreground"
          reason={
            !ledgerKnown
              ? "This environment does not provide delivery problems."
              : facts?.runtime.state === "unknown"
                ? facts.runtime.reason
                : "Runtime facts are unavailable."
          }
        >
          Problems ?
        </FleetFactHint>
      ) : null}
    </span>
  );
}

export function FleetCrewSummary({
  environmentId,
  agents,
}: {
  readonly environmentId: EnvironmentId;
  readonly agents: ReadonlyArray<FleetAgent>;
}) {
  const facts = useAtomValue(fleetFactsAtom);
  const live = useAtomValue(fleetLiveRowsAtom);
  const summary = fleetCrewSummary(
    agents.map((agent) => fleetAgentKey(environmentId, agent.participantId)),
    facts,
    live,
  );
  return summary === "" ? null : <> · {summary}</>;
}
