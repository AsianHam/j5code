import { useAtomValue } from "@effect/atom-react";
import type { FleetDerivedFacts } from "@t3tools/client-runtime/j5/fleetFacts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import type { FleetAgent, FleetAgentFacts, FleetRuntimeFact } from "@t3tools/contracts/j5";
import { useId, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
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
  fleetAgo,
  fleetProblemLabel,
} from "./fleetPresentation";

const incompleteDeliveryReason =
  "Delivery problems may be missing because an environment is unavailable or does not provide complete delivery facts.";

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

type TimedLabelProps = {
  readonly at: string | null | undefined;
  readonly label?: (now: number | undefined, timestampFormat: TimestampFormat) => string;
  readonly showAbsolute?: boolean | undefined;
};

function FleetTimeLabel({
  at,
  label,
  showAbsolute,
  now,
}: TimedLabelProps & { readonly now?: number }) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const absolute = fleetTime(at, undefined, timestampFormat);
  return (
    <FleetFactHint reason={at == null ? undefined : absolute}>
      <time dateTime={at ?? undefined}>
        {label?.(now, timestampFormat) ?? fleetAgo(at, now, timestampFormat)}
      </time>
      {showAbsolute && now !== undefined && at != null ? ` (${absolute})` : null}
    </FleetFactHint>
  );
}

function FleetLiveTimeLabel(props: TimedLabelProps) {
  const minute = useNowMinute();
  return <FleetTimeLabel {...props} now={Date.parse(`${minute}:00Z`)} />;
}

function FleetTimestamp({ live, ...props }: TimedLabelProps & { readonly live: boolean }) {
  return live ? <FleetLiveTimeLabel {...props} /> : <FleetTimeLabel {...props} />;
}

function FleetRuntimeLabel({
  runtime,
  live,
  showAbsolute,
}: {
  readonly runtime: FleetRuntimeFact;
  readonly live: boolean;
  readonly showAbsolute?: boolean | undefined;
}) {
  if (
    runtime.state !== "known" ||
    runtime.settled ||
    (runtime.status !== "idle" && runtime.status !== "waiting-to-start")
  ) {
    return <>{fleetStatusLabel(runtime)}</>;
  }
  return (
    <FleetTimestamp
      at={runtime.since}
      live={live}
      showAbsolute={showAbsolute}
      label={(now, timestampFormat) =>
        runtime.status === "waiting-to-start" && runtime.since !== null
          ? `Waiting to start · ${now === undefined ? `since ${fleetTime(runtime.since, undefined, timestampFormat)}` : `${fleetMinutes(runtime.since, now)}m`}`
          : fleetStatusLabel(runtime, now, timestampFormat)
      }
    />
  );
}

export function FleetSourceReadout() {
  const sources = useAtomValue(fleetSourcesAtom);
  const live = useAtomValue(fleetEnvironmentLivenessAtom);
  return (
    <div className="my-3 space-y-1 text-xs text-muted-foreground">
      {sources.sources.map((source) => (
        <p key={source.environmentId}>
          {source.environmentLabel} · ledger read{" "}
          {source.data?.asOf === undefined ? (
            <FleetFactHint reason="This environment does not report its Fleet read time.">
              ?
            </FleetFactHint>
          ) : (
            <FleetTimestamp
              at={source.data.asOf}
              live={live.get(source.environmentId) === true}
              showAbsolute
            />
          )}
          {live.get(source.environmentId) === true
            ? " · runtime live"
            : " · stale — current facts unavailable"}
        </p>
      ))}
    </div>
  );
}

function AskDetails({
  asks,
  live,
  asOf,
  showAbsolute,
  plain = false,
  now,
}: {
  readonly asks: FleetAgentFacts["asks"];
  readonly live: boolean;
  readonly asOf: string | undefined;
  readonly showAbsolute?: boolean | undefined;
  readonly plain?: boolean;
  readonly now?: number | undefined;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
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
              {!live
                ? `${asOf === undefined ? "age ?" : `${fleetMinutes(ask.openedAt, Date.parse(asOf))}m at last read`} · `
                : null}
              opened{" "}
              {plain ? (
                fleetAgo(ask.openedAt, now, timestampFormat)
              ) : (
                <FleetTimestamp at={ask.openedAt} live={live} showAbsolute={showAbsolute} />
              )}
              {!live ? " (stale)" : null}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

type AskTooltipProps = {
  readonly asks: FleetAgentFacts["asks"];
  readonly live: boolean;
  readonly asOf: string | undefined;
};

function FleetAskTooltipContent({ now, ...props }: AskTooltipProps & { readonly now?: number }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-right text-xs tabular-nums" />}>
        Owes {props.asks.owed.length} · Awaiting {props.asks.awaited.length}
      </TooltipTrigger>
      <TooltipPopup>
        <AskDetails {...props} plain now={now} />
      </TooltipPopup>
    </Tooltip>
  );
}

function FleetLiveAskTooltip(props: AskTooltipProps) {
  const minute = useNowMinute();
  return <FleetAskTooltipContent {...props} now={Date.parse(`${minute}:00Z`)} />;
}

function FleetAskTooltip(props: AskTooltipProps) {
  return props.live ? <FleetLiveAskTooltip {...props} /> : <FleetAskTooltipContent {...props} />;
}

export function FleetFactDetails({
  environmentId,
  agent,
  title,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: FleetAgent;
  readonly title: string;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <div className="px-3 pb-2 text-xs">
      <Button
        aria-label={`Facts for ${title}`}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((expanded) => !expanded)}
        variant="ghost"
        size="xs"
      >
        Facts
      </Button>
      <div id={contentId} hidden={!open}>
        {open ? <FleetFactDetailContent environmentId={environmentId} agent={agent} /> : null}
      </div>
    </div>
  );
}

function FleetFactDetailContent({
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
  return (
    <div className="mt-2 space-y-2">
      {!live ? <p>Showing the last measured facts; this environment is unavailable.</p> : null}
      <p>
        Status:{" "}
        {runtime === undefined ? (
          "The live Fleet read has not provided this fact."
        ) : runtime.state === "unknown" ? (
          runtime.reason
        ) : (
          <FleetRuntimeLabel runtime={runtime} live={live} showAbsolute />
        )}
      </p>
      <p>
        Environment read:{" "}
        {asOf === undefined ? (
          "This environment does not report its Fleet read time."
        ) : (
          <FleetTimestamp at={asOf} live={live} showAbsolute />
        )}
      </p>
      <p>
        Provenance:{" "}
        {agent.outsideSpawner !== undefined
          ? `Spawned by ${agent.outsideSpawner.name ?? agent.outsideSpawner.participantId}`
          : agent.origin === "unknown"
            ? "This environment has no recorded provenance for this agent."
            : agent.origin === "agent"
              ? "Spawned by an agent."
              : "Unrecorded."}
      </p>
      {facts?.asks === undefined ? (
        <p>This environment does not provide owed and awaited Exchange details.</p>
      ) : (
        <AskDetails asks={facts.asks} live={live} asOf={asOf} showAbsolute />
      )}
      <p>
        Last activity:{" "}
        {activity === undefined ? (
          "The live Fleet read has not provided this fact."
        ) : activity.state === "unknown" ? (
          activity.reason
        ) : (
          <FleetTimestamp
            at={activity.at}
            live={live}
            showAbsolute
            label={(now, timestampFormat) =>
              `${activity.label} ${fleetAgo(activity.at, now, timestampFormat)}`
            }
          />
        )}
      </p>
      <div>
        <p>Problems</p>
        {facts?.problems.map((problem) => (
          <p
            key={
              problem.kind === "delivery-failed"
                ? problem.messageId
                : `${problem.kind}:${problem.runId}`
            }
          >
            <FleetTimestamp
              at={problem.at}
              live={live}
              showAbsolute
              label={(now, timestampFormat) => fleetProblemLabel(problem, now, timestampFormat)}
            />
          </p>
        ))}
        {facts?.asks === undefined ? (
          <p>This environment does not provide delivery problems.</p>
        ) : facts.problemsIncomplete ? (
          <p>{incompleteDeliveryReason}</p>
        ) : null}
        {runtime?.state !== "known" ? (
          <p>{runtime?.reason ?? "Runtime facts are unavailable."}</p>
        ) : null}
        {runtime?.state === "known" &&
        facts?.asks !== undefined &&
        !facts.problemsIncomplete &&
        facts.problems.length === 0 ? (
          <p>No measured problems.</p>
        ) : null}
      </div>
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
              : undefined
        }
      >
        {runtime === undefined ? "?" : <FleetRuntimeLabel runtime={runtime} live={live} />}
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
        <FleetAskTooltip asks={facts.asks} live={live} asOf={asOf} />
      )}
      <FleetFactHint
        className="text-right text-xs text-muted-foreground"
        reason={
          activity?.state === "unknown"
            ? activity.reason
            : activity?.state === "known"
              ? undefined
              : unknownReason
        }
      >
        {activity?.state === "known" ? (
          <FleetTimestamp
            at={activity.at}
            live={live}
            label={(now, timestampFormat) =>
              `${activity.label} ${fleetAgo(activity.at, now, timestampFormat)}`
            }
          />
        ) : (
          "?"
        )}
      </FleetFactHint>
      <FleetProblems facts={facts} ledgerKnown={facts?.asks !== undefined} live={live} />
    </>
  );
}

function FleetProblems({
  facts,
  ledgerKnown,
  live,
}: {
  readonly facts: FleetDerivedFacts | undefined;
  readonly ledgerKnown: boolean;
  readonly live: boolean;
}) {
  const runtimeKnown = facts?.runtime.state === "known";
  if (facts?.problems.length === 0 && !facts.problemsIncomplete && runtimeKnown && ledgerKnown)
    return null;
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
          <FleetTimestamp
            at={problem.at}
            live={live}
            label={(now, timestampFormat) => fleetProblemLabel(problem, now, timestampFormat)}
          />
        </span>
      ))}
      {ledgerKnown && facts?.problemsIncomplete ? (
        <FleetFactHint className="text-muted-foreground" reason={incompleteDeliveryReason}>
          Delivery problems ?
        </FleetFactHint>
      ) : null}
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
