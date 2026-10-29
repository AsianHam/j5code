import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  FLEET_DISPATCH_THRESHOLD_MS,
  type FleetAgentFacts,
  type FleetRuntimeFact,
  type FleetActivityFact,
  type FleetProblem,
  type FleetResponse,
} from "@t3tools/contracts/j5";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import type { J5ReadSources } from "./readSources.ts";

const iso = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

export const fleetAgentKey = (environmentId: string, participantId: string) =>
  `${environmentId.length}:${environmentId}${participantId}`;

/** Remote alarms are current only when both independently read environments are readable. */
export const mergeFleetDeliveryFacts = (
  sources: J5ReadSources<FleetResponse>,
  live: ReadonlyMap<string, boolean>,
) => {
  const readable = (source: J5ReadSources<FleetResponse>["sources"][number]) =>
    source.connected &&
    source.status === "ready" &&
    source.data !== null &&
    live.get(source.environmentId) === true;
  const readableReceivers = new Set<string>();
  const remoteAlarms = new Map<
    string,
    NonNullable<FleetResponse["remoteDeliveryAlarms"]>[number][]
  >();
  for (const source of sources.sources) {
    if (!readable(source) || source.data?.remoteDeliveryAlarms === undefined) continue;
    readableReceivers.add(source.environmentId);
    for (const alarm of source.data.remoteDeliveryAlarms) {
      const key = fleetAgentKey(alarm.originEnvironmentId, alarm.senderId);
      const alarms = remoteAlarms.get(key) ?? [];
      alarms.push(alarm);
      remoteAlarms.set(key, alarms);
    }
  }
  const unique = <A>(values: ReadonlyArray<A>, key: (value: A) => string) => [
    ...new Map(values.map((value) => [key(value), value])).values(),
  ];
  const origins = new Map<
    string,
    {
      readable: boolean;
      ledger: FleetAgentFacts | undefined;
      incomplete: boolean;
    }
  >();
  for (const source of sources.sources) {
    for (const project of source.data?.projects ?? []) {
      for (const agent of project.agents) {
        const key = fleetAgentKey(source.environmentId, agent.participantId);
        const previous = origins.get(key);
        const left = previous?.ledger;
        const right = agent.facts;
        const ledger =
          left === undefined
            ? right
            : right === undefined
              ? left
              : {
                  asks: {
                    owed: unique([...left.asks.owed, ...right.asks.owed], (ask) => ask.exchangeId),
                    awaited: unique(
                      [...left.asks.awaited, ...right.asks.awaited],
                      (ask) => ask.exchangeId,
                    ),
                  },
                  problems: unique([...left.problems, ...right.problems], (problem) =>
                    JSON.stringify([
                      problem.kind,
                      problem.kind === "delivery-failed" ? problem.messageId : problem.runId,
                    ]),
                  ),
                  deliveryEnvironmentIds: [
                    ...new Set([
                      ...(left.deliveryEnvironmentIds ?? []),
                      ...(right.deliveryEnvironmentIds ?? []),
                    ]),
                  ],
                };
        origins.set(key, {
          readable: readable(source),
          ledger,
          incomplete: previous?.incomplete === true || right?.deliveryEnvironmentIds === undefined,
        });
      }
    }
  }
  const result = new Map<
    string,
    { readonly ledger: FleetAgentFacts | undefined; readonly problemsIncomplete: boolean }
  >();
  for (const [key, origin] of origins) {
    const { ledger } = origin;
    const destinations = ledger?.deliveryEnvironmentIds ?? [];
    const openExchanges = new Set(
      [...(ledger?.asks.owed ?? []), ...(ledger?.asks.awaited ?? [])].map((ask) => ask.exchangeId),
    );
    const remoteProblems = origin.readable
      ? (remoteAlarms.get(key) ?? []).map((alarm) => ({
          ...alarm.problem,
          // The origin owns the Exchange; its closure can precede the receiver's mirror.
          exchangeOpen:
            alarm.problem.exchangeOpen &&
            alarm.problem.exchangeId != null &&
            openExchanges.has(alarm.problem.exchangeId),
        }))
      : [];
    result.set(key, {
      ledger:
        ledger === undefined || remoteProblems.length === 0
          ? ledger
          : {
              ...ledger,
              problems: [...ledger.problems, ...remoteProblems],
            },
      problemsIncomplete:
        !origin.readable ||
        origin.incomplete ||
        destinations.some((environmentId) => !readableReceivers.has(environmentId)),
    });
  }
  return result;
};

export interface FleetDerivedFacts {
  readonly runtime: FleetRuntimeFact;
  readonly asks: FleetAgentFacts["asks"] | undefined;
  readonly lastActivity: FleetActivityFact;
  readonly problems: ReadonlyArray<FleetProblem>;
  readonly problemsIncomplete: boolean;
}

export interface FleetProblemSummary {
  readonly agentsWithProblems: number;
  readonly unmeasuredAgents: number;
  readonly incompleteSources: boolean;
  readonly hasReadableSource: boolean;
}

/** Keys identify environment + participant, so repeated project placements count once. */
export const summarizeFleetProblems = (
  facts: ReadonlyMap<string, FleetDerivedFacts>,
  liveRows: ReadonlyMap<string, boolean>,
  sourceCoverage: "complete" | "partial" | "unavailable",
): FleetProblemSummary => {
  let agentsWithProblems = 0;
  let unmeasuredAgents = 0;
  let incompleteSources = sourceCoverage !== "complete";
  for (const [key, live] of liveRows) {
    if (!live) {
      incompleteSources = true;
      continue;
    }
    const row = facts.get(key);
    if (row?.asks === undefined || row.problemsIncomplete) incompleteSources = true;
    if (row === undefined || row.runtime.state === "unknown" || row.asks === undefined)
      unmeasuredAgents++;
    if (
      row?.problems.some(
        (problem) =>
          problem.kind === "failed-run" ||
          problem.kind === "dispatch-overdue" ||
          (problem.kind === "delivery-failed" && problem.exchangeOpen),
      )
    )
      agentsWithProblems++;
  }
  return {
    agentsWithProblems,
    unmeasuredAgents,
    incompleteSources,
    hasReadableSource: sourceCoverage !== "unavailable",
  };
};

export const deriveFleetFacts = (input: {
  readonly shell: OrchestrationV2ThreadShell | undefined;
  readonly ledger: FleetAgentFacts | undefined;
  readonly pendingSubagentRequest?: "approval" | "user_input" | null | undefined;
  readonly now: number;
  readonly problemsIncomplete?: boolean | undefined;
}): { readonly facts: FleetDerivedFacts; readonly nextDeadline?: number } => {
  const { shell } = input;
  const problems = [...(input.ledger?.problems ?? [])];
  const asks = input.ledger?.asks;
  const problemsIncomplete =
    input.problemsIncomplete ?? input.ledger?.deliveryEnvironmentIds === undefined;
  if (shell === undefined) {
    const unknown = {
      state: "unknown" as const,
      reason: "This environment has no readable thread shell.",
    };
    return {
      facts: { runtime: unknown, lastActivity: unknown, asks, problems, problemsIncomplete },
    };
  }
  const missingRunTimes =
    shell.latestRunId !== null &&
    (shell.latestRunRequestedAt === undefined ||
      shell.latestRunStartedAt === undefined ||
      shell.latestRunCompletedAt === undefined);
  const requestedAt = iso(shell.latestRunRequestedAt);
  const startedAt = iso(shell.latestRunStartedAt);
  const completedAt = iso(shell.latestRunCompletedAt);
  const otherRunInProgress =
    (shell.activeRunId !== null && shell.activeRunId !== shell.latestRunId) ||
    shell.activityRunStatus === "running" ||
    shell.activityRunStatus === "waiting";
  const undispatched =
    shell.latestRunId !== null &&
    !otherRunInProgress &&
    requestedAt !== null &&
    startedAt === null &&
    (shell.status === "queued" || shell.status === "preparing" || shell.status === "starting");
  const dueIn = undispatched
    ? Date.parse(requestedAt) + FLEET_DISPATCH_THRESHOLD_MS - input.now
    : null;
  if (!missingRunTimes && shell.status === "failed" && shell.latestRunId !== null) {
    problems.push({
      kind: "failed-run",
      runId: shell.latestRunId,
      at: completedAt,
    });
  }
  if (!missingRunTimes && dueIn !== null && dueIn <= 0) {
    problems.push({ kind: "dispatch-overdue", runId: shell.latestRunId!, at: requestedAt! });
  }
  const candidates: Array<{ readonly label: string; readonly at: string }> = [
    { label: "Agent created", at: iso(shell.createdAt)! },
  ];
  if (requestedAt !== null) candidates.push({ label: "Turn requested", at: requestedAt });
  if (startedAt !== null) candidates.push({ label: "Turn started", at: startedAt });
  if (completedAt !== null) candidates.push({ label: "Turn ended", at: completedAt });
  const receivedAt = iso(shell.latestUserMessageAt);
  if (receivedAt !== null) candidates.push({ label: "Message received", at: receivedAt });
  if (shell.pendingRuntimeRequest !== null)
    candidates.push({
      label:
        shell.pendingRuntimeRequest.kind === "user_input"
          ? "Input requested"
          : shell.pendingRuntimeRequest.kind === "auth_refresh"
            ? "Authentication requested"
            : "Approval requested",
      at: iso(shell.pendingRuntimeRequest.createdAt)!,
    });
  for (const ask of input.ledger?.asks.awaited ?? [])
    candidates.push({ label: "Ask opened", at: ask.openedAt });
  for (const problem of input.ledger?.problems ?? [])
    if (problem.kind === "delivery-failed")
      candidates.push({ label: "Delivery failed", at: problem.at });
  const latest = candidates.reduce((left, right) =>
    Date.parse(right.at) >= Date.parse(left.at) ? right : left,
  );
  const lastActivity: FleetActivityFact = missingRunTimes
    ? { state: "unknown", reason: "This environment does not report run timestamps." }
    : input.ledger === undefined
      ? {
          state: "unknown",
          reason: "This environment does not report Exchange or delivery activity.",
        }
      : { state: "known", ...latest };
  const activity = shell.activityRunStatus ?? shell.status;
  const approval =
    input.pendingSubagentRequest === "approval" ||
    (shell.pendingRuntimeRequest !== null &&
      shell.pendingRuntimeRequest.kind !== "user_input" &&
      shell.pendingRuntimeRequest.kind !== "auth_refresh");
  const needsInput =
    input.pendingSubagentRequest === "user_input" ||
    shell.pendingRuntimeRequest?.kind === "user_input";
  const status = undispatched
    ? "waiting-to-start"
    : approval
      ? "approval"
      : needsInput
        ? "input"
        : shell.pendingRuntimeRequest?.kind === "auth_refresh"
          ? "waiting"
          : activity === "running"
            ? "working"
            : activity === "waiting"
              ? "waiting"
              : activity === "preparing" || activity === "starting" || shell.status === "queued"
                ? "waiting"
                : shell.status === "failed"
                  ? "failed"
                  : backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])
                    ? "waiting"
                    : "idle";
  const unknownRuntimeReason = missingRunTimes
    ? "This environment does not report run timestamps."
    : otherRunInProgress &&
        shell.activityRunStatus == null &&
        shell.status !== "running" &&
        shell.status !== "waiting"
      ? "This environment does not report the active run's status."
      : status === "idle" && shell.latestRunId !== null && completedAt === null
        ? "The latest run has no measured completion time."
        : null;
  const runtime: FleetRuntimeFact =
    unknownRuntimeReason !== null
      ? { state: "unknown", reason: unknownRuntimeReason }
      : {
          state: "known",
          status,
          since: undispatched
            ? requestedAt
            : status === "idle"
              ? shell.latestRunId === null
                ? iso(shell.createdAt)
                : completedAt
              : iso(shell.activityRunStartedAt),
          settled:
            status === "idle" &&
            (shell.settledOverride === "settled" ||
              (shell.settledOverride !== "active" && shell.settledAt !== null)),
        };
  return {
    facts: { runtime, asks, lastActivity, problems, problemsIncomplete },
    ...(!missingRunTimes && dueIn !== null && dueIn > 0 ? { nextDeadline: input.now + dueIn } : {}),
  };
};

export interface FleetFactRow {
  readonly key: string;
  readonly shell: OrchestrationV2ThreadShell | undefined;
  readonly ledger: FleetAgentFacts | undefined;
  readonly live: boolean;
  readonly pendingSubagentRequest?: "approval" | "user_input" | null | undefined;
  readonly problemsIncomplete?: boolean | undefined;
}

const uniqueFacts = <A>(values: ReadonlyArray<A>, key: (value: A) => string): ReadonlyArray<A> => [
  ...new Map(values.map((value) => [key(value), value])).values(),
];

const mergeAgentFacts = (left: FleetDerivedFacts, right: FleetDerivedFacts): FleetDerivedFacts => ({
  problemsIncomplete: left.problemsIncomplete || right.problemsIncomplete,
  runtime: left.runtime.state === "known" ? left.runtime : right.runtime,
  lastActivity:
    left.lastActivity.state === "known" &&
    (right.lastActivity.state === "unknown" ||
      Date.parse(left.lastActivity.at) >= Date.parse(right.lastActivity.at))
      ? left.lastActivity
      : right.lastActivity,
  asks:
    left.asks === undefined || right.asks === undefined
      ? undefined
      : {
          owed: uniqueFacts([...left.asks.owed, ...right.asks.owed], (ask) => ask.exchangeId),
          awaited: uniqueFacts(
            [...left.asks.awaited, ...right.asks.awaited],
            (ask) => ask.exchangeId,
          ),
        },
  problems: uniqueFacts([...left.problems, ...right.problems], (problem) =>
    JSON.stringify([
      problem.kind,
      problem.kind === "delivery-failed" ? problem.messageId : problem.runId,
    ]),
  ),
});

/** Shared by every consumer in one registry. Only a future dispatch boundary schedules work. */
export const createFleetFactsAtom = (rows: Atom.Atom<ReadonlyArray<FleetFactRow>>) =>
  Atom.make((get) => {
    // @effect-diagnostics-next-line globalDate:off - This Atom runs outside an Effect runtime and shares one presentation deadline.
    const now = Date.now();
    const previous = Option.getOrUndefined(get.self<ReadonlyMap<string, FleetDerivedFacts>>());
    const facts = new Map<string, FleetDerivedFacts>();
    let nextDeadline: number | undefined;
    for (const row of get(rows)) {
      if (!row.live) {
        const cached = previous?.get(row.key);
        const frozen =
          cached === undefined || cached.problemsIncomplete
            ? cached
            : { ...cached, problemsIncomplete: true };
        const unknown = {
          state: "unknown" as const,
          reason: "This environment is unavailable; runtime and activity are not current.",
        };
        const stale = frozen ?? {
          ...deriveFleetFacts({
            shell: undefined,
            ledger: row.ledger,
            problemsIncomplete: true,
            now,
          }).facts,
          runtime: unknown,
          lastActivity: unknown,
        };
        const existing = facts.get(row.key);
        facts.set(row.key, existing === undefined ? stale : mergeAgentFacts(existing, stale));
        continue;
      }
      const result = deriveFleetFacts({
        shell: row.shell,
        ledger: row.ledger,
        pendingSubagentRequest: row.pendingSubagentRequest,
        problemsIncomplete: row.problemsIncomplete,
        now,
      });
      const existing = facts.get(row.key);
      facts.set(
        row.key,
        existing === undefined ? result.facts : mergeAgentFacts(existing, result.facts),
      );
      if (result.nextDeadline !== undefined) {
        nextDeadline = Math.min(nextDeadline ?? result.nextDeadline, result.nextDeadline);
      }
    }
    for (const [key, value] of facts) {
      const cached = previous?.get(key);
      if (cached !== undefined && Equal.equals(cached, value)) facts.set(key, cached);
    }
    if (nextDeadline !== undefined) {
      // @effect-diagnostics-next-line globalTimers:off - Atom lifecycle owns this one deadline, outside an Effect runtime.
      const timer = setTimeout(() => get.refreshSelf(), nextDeadline - now);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return facts;
  });
