import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  FleetResponse,
  FLEET_DISPATCH_THRESHOLD_MS,
  type FleetAgentFacts,
  type FleetDeliveryProblem,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/reactivity";

import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import type { J5ReadSource } from "./readSources.ts";
import {
  createFleetFactsAtom,
  deriveFleetFacts,
  summarizeFleetProblems,
  fleetAgentKey,
  mergeFleetDeliveryFacts,
  type FleetFactRow,
} from "./fleetFacts.ts";

const decodeFleet = Schema.decodeUnknownSync(FleetResponse);

const at = "2026-10-19T10:00:00.000Z";
const now = Date.parse(at);
const date = DateTime.makeUnsafe(at);
const ledger: FleetAgentFacts = {
  asks: { owed: [], awaited: [] },
  problems: [],
  deliveryEnvironmentIds: [],
};
const shell = (changes: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  latestRunId: RunId.make("r"),
  status: "starting",
  latestRunRequestedAt: date,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  activityRunStatus: "starting",
  pendingBackgroundTasks: [],
  ...changes,
});
const derive = (source: OrchestrationV2ThreadShell | undefined, clock = now) =>
  deriveFleetFacts({ shell: source, ledger, now: clock });

afterEach(() => vi.useRealTimers());

const deliveryProblem = (exchangeOpen: boolean) => ({
  kind: "delivery-failed" as const,
  messageId: "message",
  receiverId: "receiver",
  receiverName: null,
  at,
  reason: "transport unavailable",
  exchangeOpen,
});

describe("Fleet problem badge", () => {
  it("keeps alarms from every project placement without duplicating shared asks or badge agents", () => {
    const ask = {
      exchangeId: "shared",
      counterpartyId: "other",
      counterpartyName: null,
      intent: "help",
      openedAt: at,
    };
    const source = shell({
      status: "completed",
      activityRunStatus: null,
      latestRunStartedAt: date,
      latestRunCompletedAt: date,
    });
    const rows = Atom.make<ReadonlyArray<FleetFactRow>>([
      {
        key: "env:sender",
        shell: source,
        ledger: { asks: { owed: [], awaited: [ask] }, problems: [deliveryProblem(true)] },
        live: true,
      },
      {
        key: "env:sender",
        shell: source,
        ledger: { asks: { owed: [], awaited: [ask] }, problems: [] },
        live: true,
      },
    ]);
    const facts = createFleetFactsAtom(rows);
    const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
    const stop = registry.subscribe(facts, () => {}, { immediate: true });
    expect(registry.get(facts).size).toBe(1);
    expect(registry.get(facts).get("env:sender")?.asks?.awaited).toEqual([ask]);
    expect(registry.get(facts).get("env:sender")?.problems).toEqual([deliveryProblem(true)]);
    expect(
      summarizeFleetProblems(registry.get(facts), new Map([["env:sender", true]]), "complete")
        .agentsWithProblems,
    ).toBe(1);
    stop();
    registry.dispose();
  });
  it("counts each live environment+participant once regardless of how many problems it has", () => {
    const failed = derive(shell({ status: "failed", activityRunStatus: null })).facts;
    const mixed = { ...failed, problems: [...failed.problems, deliveryProblem(true)] };
    const facts = new Map([
      ["env-a:sender", mixed],
      ["env-b:sender", failed],
      ["offline:sender", mixed],
      ["plain", { ...failed, problems: [deliveryProblem(false)] }],
      ["closed-exchange", { ...failed, problems: [deliveryProblem(false)] }],
      [
        "open-asks",
        {
          ...derive(shell()).facts,
          asks: {
            owed: [
              {
                exchangeId: "ask",
                counterpartyId: "other",
                counterpartyName: null,
                intent: "help",
                openedAt: at,
              },
            ],
            awaited: [],
          },
        },
      ],
    ]);
    const live = new Map([...facts.keys()].map((key) => [key, key !== "offline:sender"]));
    expect(summarizeFleetProblems(facts, live, "partial")).toEqual({
      agentsWithProblems: 2,
      unmeasuredAgents: 0,
      incompleteSources: true,
      hasReadableSource: true,
    });
    // Silence and platform notices have no problem fact; absence must not manufacture one.
    expect(
      summarizeFleetProblems(
        new Map([["notice", derive(shell()).facts]]),
        new Map([["notice", true]]),
        "complete",
      ).agentsWithProblems,
    ).toBe(0);
  });

  it("separates an unrecorded seat's missing runtime from missing source coverage", () => {
    const unrecordedSeat = deriveFleetFacts({ shell: undefined, ledger, now }).facts;
    const facts = new Map([["seat-without-thread", unrecordedSeat]]);
    const live = new Map([["seat-without-thread", true]]);
    expect(summarizeFleetProblems(facts, live, "complete")).toEqual({
      agentsWithProblems: 0,
      unmeasuredAgents: 1,
      incompleteSources: false,
      hasReadableSource: true,
    });
    facts.set("seat-without-thread", { ...unrecordedSeat, problems: [deliveryProblem(true)] });
    expect(summarizeFleetProblems(facts, live, "complete").agentsWithProblems).toBe(1);
    facts.set("seat-without-thread", { ...unrecordedSeat, asks: undefined });
    expect(summarizeFleetProblems(facts, live, "complete")).toEqual({
      agentsWithProblems: 0,
      unmeasuredAgents: 1,
      incompleteSources: true,
      hasReadableSource: true,
    });
    expect(summarizeFleetProblems(new Map(), new Map(), "unavailable").incompleteSources).toBe(
      true,
    );
    live.set("seat-without-thread", false);
    expect(summarizeFleetProblems(facts, live, "partial").unmeasuredAgents).toBe(0);
  });

  it("updates the badge at the shared deadline, then clears on dispatch, healthy run and Exchange close", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const rows = Atom.make<ReadonlyArray<FleetFactRow>>([
      { key: "env:sender", shell: shell(), ledger, live: true },
    ]);
    const facts = createFleetFactsAtom(rows);
    const badge = Atom.make((get) =>
      summarizeFleetProblems(
        get(facts),
        new Map(get(rows).map((row) => [row.key, row.live])),
        get(rows).some((row) => row.live) ? "complete" : "unavailable",
      ),
    );
    const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
    const rail = registry.subscribe(badge, () => {}, { immediate: true });
    const page = registry.subscribe(facts, () => {}, { immediate: true });
    const count = () => registry.get(badge).agentsWithProblems;
    const update = (source: OrchestrationV2ThreadShell, measured = ledger) =>
      registry.set(rows, [{ key: "env:sender", shell: source, ledger: measured, live: true }]);
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(FLEET_DISPATCH_THRESHOLD_MS - 1);
    expect(count()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
    const started = shell({
      status: "running",
      activityRunStatus: "running",
      latestRunStartedAt: date,
    });
    update(started);
    expect(count()).toBe(0);
    update({ ...started, status: "failed", activityRunStatus: null, latestRunCompletedAt: date });
    expect(count()).toBe(1);
    const healthy = {
      ...started,
      status: "completed" as const,
      activityRunStatus: null,
      latestRunCompletedAt: date,
    };
    update(healthy);
    expect(count()).toBe(0);
    update(healthy, { ...ledger, problems: [deliveryProblem(true)] });
    expect(count()).toBe(1);
    registry.set(
      rows,
      registry.get(rows).map((row) => ({ ...row, live: false })),
    );
    expect(registry.get(facts).get("env:sender")?.problems).toEqual([deliveryProblem(true)]);
    expect(registry.get(badge)).toEqual({
      agentsWithProblems: 0,
      unmeasuredAgents: 0,
      incompleteSources: true,
      hasReadableSource: false,
    });
    update(healthy, { ...ledger, problems: [deliveryProblem(true)] });
    expect(count()).toBe(1);
    update(healthy, { ...ledger, problems: [deliveryProblem(false)] });
    expect(count()).toBe(0);
    expect(registry.get(facts).get("env:sender")?.problems).toEqual([deliveryProblem(false)]);
    rail();
    page();
    registry.dispose();
  });
});

describe("Fleet runtime measurements", () => {
  it("crosses the exact dispatch boundary once and recovers immediately when dispatched", () => {
    const before = derive(shell(), now + FLEET_DISPATCH_THRESHOLD_MS - 1);
    expect(before.facts.runtime).toMatchObject({ status: "waiting-to-start" });
    expect(before.nextDeadline).toBe(now + FLEET_DISPATCH_THRESHOLD_MS);
    expect(before.facts.problems).toEqual([]);
    const due = derive(shell(), now + FLEET_DISPATCH_THRESHOLD_MS);
    expect(due.facts.problems).toEqual([{ kind: "dispatch-overdue", runId: "r", at }]);
    expect(due.nextDeadline).toBeUndefined();
    expect(derive(shell(), now + 900_000).nextDeadline).toBeUndefined();
    const dispatched = derive(
      shell({ status: "running", activityRunStatus: "running", latestRunStartedAt: date }),
      now + 900_000,
    );
    expect(dispatched.facts.runtime).toMatchObject({ status: "working" });
    expect(dispatched.facts.problems).toEqual([]);
  });

  it("preserves raw runtime activity when an older shell omits activityRunStatus", () => {
    const source = shell({
      status: "running",
      activeRunId: RunId.make("r"),
      latestRunStartedAt: date,
      activityRunStatus: undefined,
    });
    expect(derive(source).facts.runtime).toMatchObject({
      state: "known",
      status: "working",
      settled: false,
    });
    expect(derive({ ...source, status: "waiting" }).facts.runtime).toMatchObject({
      status: "waiting",
    });
    expect(derive({ ...source, status: "preparing" }).facts.runtime).toMatchObject({
      status: "waiting",
    });
  });

  it("gives undispatched work precedence over approval, then follows input and background state", () => {
    const pending = {
      id: RuntimeRequestId.make("approval"),
      kind: "command" as const,
      createdAt: date,
    };
    expect(derive(shell({ pendingRuntimeRequest: pending })).facts.runtime).toMatchObject({
      status: "waiting-to-start",
    });
    const started = shell({
      latestRunStartedAt: date,
      activityRunStatus: "running",
      status: "running",
      pendingRuntimeRequest: pending,
    });
    expect(derive(started).facts.runtime).toMatchObject({ status: "approval" });
    expect(
      derive({ ...started, pendingRuntimeRequest: { ...pending, kind: "user_input" } }).facts
        .runtime,
    ).toMatchObject({ status: "input" });
    expect(
      derive(
        shell({
          status: "completed",
          activityRunStatus: null,
          latestRunStartedAt: date,
          latestRunCompletedAt: date,
          pendingBackgroundTasks: [{ kind: "background_task", taskId: "background" }],
          settledAt: date,
        }),
      ).facts.runtime,
    ).toMatchObject({ status: "waiting", settled: false });
    expect(
      derive(
        shell({
          status: "completed",
          activityRunStatus: null,
          latestRunStartedAt: date,
          latestRunCompletedAt: date,
          settledAt: date,
        }),
      ).facts.runtime,
    ).toMatchObject({ status: "idle", since: at, settled: true });
  });

  it("leaves queued follow-ups behind another run Working, Approval or Input without a deadline", () => {
    const queued = shell({
      status: "queued",
      activeRunId: RunId.make("earlier"),
      activityRunStatus: "running",
    });
    const overdueClock = now + FLEET_DISPATCH_THRESHOLD_MS * 2;
    expect(derive(queued, overdueClock)).toMatchObject({
      facts: { runtime: { status: "working" }, problems: [] },
    });
    expect(derive(queued, overdueClock).nextDeadline).toBeUndefined();
    const pending = {
      id: RuntimeRequestId.make("request"),
      kind: "command" as const,
      createdAt: date,
    };
    expect(
      derive({ ...queued, pendingRuntimeRequest: pending }, overdueClock).facts.runtime,
    ).toMatchObject({ status: "approval" });
    expect(
      derive({ ...queued, pendingRuntimeRequest: { ...pending, kind: "user_input" } }, overdueClock)
        .facts.runtime,
    ).toMatchObject({ status: "input" });
    expect(
      derive({ ...queued, activityRunStatus: "waiting", activeRunId: null }, overdueClock),
    ).toMatchObject({ facts: { runtime: { status: "waiting" }, problems: [] } });
    const alone = shell({ status: "queued", activeRunId: null, activityRunStatus: null });
    expect(derive(alone, now + FLEET_DISPATCH_THRESHOLD_MS - 1).facts.problems).toEqual([]);
    expect(derive(alone, now + FLEET_DISPATCH_THRESHOLD_MS).facts.problems).toEqual([
      { kind: "dispatch-overdue", runId: "r", at },
    ]);
  });

  it("lets non-holding commands remain idle and reports holding background work as Waiting", () => {
    const completed = shell({
      status: "completed",
      activityRunStatus: null,
      latestRunStartedAt: date,
      latestRunCompletedAt: date,
    });
    for (const kind of ["command", "monitor"] as const) {
      expect(
        derive({ ...completed, pendingBackgroundTasks: [{ kind, taskId: "dev-server" }] }).facts
          .runtime,
      ).toMatchObject({ status: "idle", since: at });
      expect(
        derive({ ...completed, pendingBackgroundTasks: [{ kind, taskId: "work", awaited: true }] })
          .facts.runtime,
      ).toMatchObject({ status: "waiting", settled: false });
    }
    for (const kind of ["subagent", "background_task"] as const) {
      expect(
        derive({ ...completed, pendingBackgroundTasks: [{ kind, taskId: "work" }] }).facts.runtime,
      ).toMatchObject({ status: "waiting", settled: false });
    }
  });

  it("preserves native child approval and input measurements on the parent row", () => {
    const source = shell({
      status: "running",
      activityRunStatus: "running",
      latestRunStartedAt: date,
    });
    expect(
      deriveFleetFacts({ shell: source, ledger, pendingSubagentRequest: "approval", now }).facts
        .runtime,
    ).toMatchObject({ status: "approval" });
    expect(
      deriveFleetFacts({ shell: source, ledger, pendingSubagentRequest: "user_input", now }).facts
        .runtime,
    ).toMatchObject({ status: "input" });
  });

  it("clears failed-latest-run when a healthy latest run replaces it", () => {
    const failed = shell({
      status: "failed",
      activityRunStatus: null,
      latestRunStartedAt: date,
      latestRunCompletedAt: date,
    });
    expect(
      derive({ ...failed, pendingBackgroundTasks: [{ kind: "monitor", taskId: "watch" }] }).facts
        .runtime,
    ).toMatchObject({ status: "failed" });
    expect(derive(failed).facts.problems).toEqual([{ kind: "failed-run", runId: "r", at }]);
    expect(derive({ ...failed, latestRunCompletedAt: null }).facts.problems).toEqual([
      { kind: "failed-run", runId: "r", at: null },
    ]);
    expect(
      derive({ ...failed, status: "completed", latestRunCompletedAt: null }).facts.runtime,
    ).toMatchObject({
      state: "unknown",
      reason: "The latest run has no measured completion time.",
    });
    expect(derive({ ...failed, status: "completed" }).facts.problems).toEqual([]);
    expect(derive({ ...failed, status: "completed" }).facts.runtime).toMatchObject({
      status: "idle",
    });
  });

  it("measures a steering message without changing the running turn", () => {
    const receivedAt = "2026-10-19T10:10:00.000Z";
    const source = shell({
      status: "running",
      activityRunStatus: "running",
      latestRunStartedAt: date,
      latestVisibleMessage: null,
      latestUserMessageAt: DateTime.makeUnsafe(receivedAt),
    });
    expect(derive(source).facts.lastActivity).toEqual({
      state: "known",
      label: "Message received",
      at: receivedAt,
    });
    expect(derive(source).facts.runtime).toMatchObject({ state: "known", status: "working" });
    const completedAt = "2026-10-19T10:11:00.000Z";
    expect(
      derive({
        ...source,
        status: "completed",
        activityRunStatus: null,
        latestRunCompletedAt: DateTime.makeUnsafe(completedAt),
      }).facts.lastActivity,
    ).toEqual({ state: "known", label: "Turn ended", at: completedAt });
  });

  it("ignores bookkeeping updatedAt and labels the latest measured event", () => {
    const source = shell({
      status: "completed",
      activityRunStatus: null,
      latestRunStartedAt: date,
      latestRunCompletedAt: date,
      updatedAt: DateTime.makeUnsafe(now + 60_000),
      settledAt: DateTime.makeUnsafe(now + 60_000),
    });
    expect(derive(source).facts.lastActivity).toEqual({ state: "known", label: "Turn ended", at });
    expect(derive({ ...source, latestRunCompletedAt: undefined }).facts.lastActivity).toEqual({
      state: "unknown",
      reason: "This environment does not report run timestamps.",
    });
  });

  it("keeps known delivery facts when runtime is missing and leaves old ledger facts absent", () => {
    const alarm = {
      kind: "delivery-failed" as const,
      messageId: "m",
      receiverId: "other",
      receiverName: null,
      at,
      reason: "offline",
      exchangeOpen: true,
    };
    const missing = deriveFleetFacts({
      shell: undefined,
      ledger: { ...ledger, problems: [alarm] },
      now,
    });
    expect(missing.facts.runtime.state).toBe("unknown");
    expect(missing.facts.problems).toEqual([alarm]);
    const old = decodeFleet({
      projects: [
        {
          id: "p",
          title: "P",
          crews: [],
          agents: [
            {
              participantId: "a",
              threadId: "t",
              displayName: null,
              origin: "human",
              placementParentId: null,
              crew: null,
              openAsks: 4,
            },
          ],
        },
      ],
    });
    expect(old.asOf).toBeUndefined();
    expect(old.projects[0]!.agents[0]!.facts).toBeUndefined();
    const source = shell({
      status: "completed",
      activityRunStatus: null,
      latestRunStartedAt: date,
      latestRunCompletedAt: date,
    });
    const partial = deriveFleetFacts({
      shell: source,
      ledger: old.projects[0]!.agents[0]!.facts,
      now,
    }).facts;
    expect(partial.asks).toBeUndefined();
    expect(partial.runtime).toMatchObject({ state: "known", status: "idle" });
    expect(partial.lastActivity).toEqual({
      state: "unknown",
      reason: "This environment does not report Exchange or delivery activity.",
    });
    const later = "2026-10-19T10:01:00.000Z";
    const restored = deriveFleetFacts({
      shell: source,
      ledger: { ...ledger, problems: [{ ...alarm, at: later }] },
      now: Date.parse(later),
    }).facts;
    expect(restored.lastActivity).toEqual({
      state: "known",
      label: "Delivery failed",
      at: later,
    });
  });
});

it("shares one local deadline across consumers, clears stale/removed rows, and never rereads ledger", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const rows = Atom.make<ReadonlyArray<FleetFactRow>>([
    { key: "env-a:a", shell: shell(), ledger, live: true },
    {
      key: "env-b:a",
      shell: shell({ latestRunRequestedAt: DateTime.makeUnsafe(now + 1_000) }),
      ledger,
      live: true,
    },
  ]);
  const facts = createFleetFactsAtom(rows);
  const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
  const callback = vi.fn();
  const first = registry.subscribe(facts, callback, { immediate: true });
  const second = registry.subscribe(facts, callback, { immediate: true });
  vi.advanceTimersByTime(0);
  const timerCount = vi.getTimerCount();
  expect(timerCount).toBe(1);
  const unchanged = registry.get(facts).get("env-a:a");
  registry.set(
    rows,
    registry
      .get(rows)
      .map((row) =>
        row.key === "env-b:a" ? { ...row, shell: { ...row.shell!, title: "Renamed" } } : row,
      ),
  );
  expect(registry.get(facts).get("env-a:a")).toBe(unchanged);
  vi.advanceTimersByTime(FLEET_DISPATCH_THRESHOLD_MS);
  expect(registry.get(facts).get("env-a:a")!.problems).toHaveLength(1);
  expect(registry.get(facts).get("env-b:a")!.problems).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(1);
  registry.set(
    rows,
    registry.get(rows).map((row) => ({ ...row, live: false })),
  );
  vi.advanceTimersByTime(0);
  expect(vi.getTimerCount()).toBe(0);
  registry.set(rows, []);
  expect(registry.get(facts).size).toBe(0);
  first();
  second();
  registry.dispose();
});

it("does not advance offline dispatch facts when unrelated live rows change", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const alarm = {
    kind: "delivery-failed" as const,
    messageId: "m",
    receiverId: "other",
    receiverName: null,
    at,
    reason: "offline",
    exchangeOpen: true,
  };
  const rows = Atom.make<ReadonlyArray<FleetFactRow>>([
    {
      key: "offline:a",
      shell: shell(),
      ledger: { ...ledger, problems: [alarm], deliveryEnvironmentIds: [] },
      live: true,
    },
    { key: "cached:a", shell: shell(), ledger, live: false },
  ]);
  const facts = createFleetFactsAtom(rows);
  const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
  const stop = registry.subscribe(facts, () => {}, { immediate: true });
  const measured = registry.get(facts).get("offline:a")!;
  expect(measured.problemsIncomplete).toBe(false);
  registry.set(
    rows,
    registry.get(rows).map((row) => ({ ...row, live: false })),
  );
  const frozen = registry.get(facts).get("offline:a")!;
  expect(frozen.problemsIncomplete).toBe(true);
  expect(frozen.runtime).toBe(measured.runtime);
  expect(frozen.lastActivity).toBe(measured.lastActivity);
  expect(frozen.asks).toBe(measured.asks);
  expect(frozen.problems).toBe(measured.problems);
  vi.advanceTimersByTime(FLEET_DISPATCH_THRESHOLD_MS * 2);
  registry.set(rows, [
    ...registry.get(rows),
    {
      key: "live:a",
      shell: shell({
        status: "completed",
        activityRunStatus: null,
        latestRunStartedAt: date,
        latestRunCompletedAt: date,
      }),
      ledger,
      live: true,
    },
  ]);
  const stale = registry.get(facts).get("offline:a")!;
  expect(stale).toBe(frozen);
  expect(stale.runtime).toMatchObject({ state: "known", status: "waiting-to-start" });
  expect(stale.lastActivity.state).toBe("known");
  expect(stale.problems).toEqual([alarm]);
  expect(registry.get(facts).get("cached:a")?.runtime.state).toBe("unknown");
  registry.set(
    rows,
    registry.get(rows).map((row) => (row.key === "offline:a" ? { ...row, live: true } : row)),
  );
  expect(registry.get(facts).get("offline:a")?.problemsIncomplete).toBe(false);
  stop();
  registry.dispose();
});

describe("receiving-environment delivery alarm merge", () => {
  const senderId = "agent:shared";
  const ask = (exchangeId: string) => ({
    exchangeId,
    counterpartyId: "agent:receiver",
    counterpartyName: "Receiver",
    intent: "Review",
    openedAt: at,
  });
  const openLedger: FleetAgentFacts = {
    ...ledger,
    asks: { owed: [], awaited: [ask("exchange")] },
    deliveryEnvironmentIds: ["receiver"],
  };
  const problem = {
    kind: "delivery-failed" as const,
    messageId: "received-message",
    exchangeId: "exchange",
    receiverId: "agent:receiver",
    receiverName: "Receiver",
    at,
    reason: "thread unavailable",
    exchangeOpen: true,
  };
  const project = (facts: FleetAgentFacts | undefined, id = "project") => ({
    id,
    title: id,
    crews: [],
    agents: [
      {
        participantId: senderId,
        threadId: "thread",
        displayName: "Sender",
        origin: "human" as const,
        placementParentId: null,
        crew: null,
        openAsks: 0,
        ...(facts === undefined ? {} : { facts }),
      },
    ],
  });
  const source = (id: string, data: FleetResponse): J5ReadSource<FleetResponse> => ({
    environmentId: EnvironmentId.make(id),
    environmentLabel: id,
    connected: true,
    status: "ready",
    data,
    error: null,
    refreshing: false,
  });
  const origin = (facts: FleetAgentFacts | undefined = openLedger, id = "origin") =>
    source(id, { projects: [project(facts)], remoteDeliveryAlarms: [] });
  const receiver = (changes: Partial<FleetDeliveryProblem> = {}) =>
    source("receiver", {
      projects: [],
      remoteDeliveryAlarms: [
        { originEnvironmentId: "origin", senderId, problem: { ...problem, ...changes } },
      ],
    });
  const merge = (...sources: J5ReadSource<FleetResponse>[]) =>
    mergeFleetDeliveryFacts(
      { isReady: true, sources },
      new Map(sources.map((entry) => [entry.environmentId, true])),
    );
  const key = fleetAgentKey("origin", senderId);

  it("attaches remote facts to the origin environment and participant without phantom rows", () => {
    const receiving = source("receiver", {
      projects: [],
      remoteDeliveryAlarms: [
        ...receiver().data!.remoteDeliveryAlarms!,
        {
          originEnvironmentId: "other",
          senderId,
          problem: { ...problem, messageId: "other-message" },
        },
        { originEnvironmentId: "origin", senderId: "agent:elsewhere", problem },
      ],
    });
    const facts = merge(origin(), origin(openLedger, "other"), receiving);
    expect(facts.get(key)?.ledger?.problems).toEqual([problem]);
    expect(facts.get(fleetAgentKey("other", senderId))?.ledger?.problems).toEqual([
      { ...problem, messageId: "other-message" },
    ]);
    expect(facts.get(key)?.problemsIncomplete).toBe(false);
    expect(merge(receiving).size).toBe(0);
    expect(facts.size).toBe(2);
  });

  it("counts a remote alarm only while both Exchange reads say open, preserving closed and plain facts", () => {
    expect(merge(origin(), receiver()).get(key)?.ledger?.problems).toEqual([problem]);
    const closedOrigin = { ...openLedger, asks: ledger.asks };
    expect(merge(origin(closedOrigin), receiver()).get(key)?.ledger?.problems).toEqual([
      { ...problem, exchangeOpen: false },
    ]);
    expect(merge(origin(), receiver({ exchangeOpen: false })).get(key)?.ledger?.problems).toEqual([
      { ...problem, exchangeOpen: false },
    ]);
    expect(merge(origin(), receiver({ exchangeId: null })).get(key)?.ledger?.problems).toEqual([
      { ...problem, exchangeId: null, exchangeOpen: false },
    ]);
  });

  it("attaches a later receiver alarm using the unchanged pending-origin snapshot", () => {
    const pendingOrigin = origin();
    const before = merge(
      pendingOrigin,
      source("receiver", { projects: [], remoteDeliveryAlarms: [] }),
    );
    expect(before.get(key)).toMatchObject({ ledger: { problems: [] }, problemsIncomplete: false });
    const after = merge(pendingOrigin, receiver());
    expect(after.get(key)).toMatchObject({
      ledger: { problems: [problem] },
      problemsIncomplete: false,
    });
    expect(pendingOrigin.data?.projects[0]?.agents[0]?.facts?.problems).toEqual([]);
  });

  it("shows connected plain and closed-Exchange alarms independently of badge coverage dependencies", () => {
    const noOpenDebt = origin({ ...ledger, deliveryEnvironmentIds: [] });
    expect(merge(noOpenDebt, receiver({ exchangeId: null })).get(key)).toMatchObject({
      ledger: { problems: [{ ...problem, exchangeId: null, exchangeOpen: false }] },
      problemsIncomplete: false,
    });
    expect(merge(noOpenDebt, receiver()).get(key)).toMatchObject({
      ledger: { problems: [{ ...problem, exchangeOpen: false }] },
      problemsIncomplete: false,
    });
    expect(
      merge(noOpenDebt, { ...receiver(), connected: false, status: "offline" }).get(key),
    ).toMatchObject({ ledger: { problems: [] }, problemsIncomplete: false });
  });

  it("reports missing, old, disconnected and unreadable relevant receivers as incomplete", () => {
    const unavailable: J5ReadSource<FleetResponse>[] = [
      { ...receiver(), connected: false, status: "offline" },
      { ...receiver(), status: "error", error: "read failed" },
      { ...receiver(), status: "loading" },
      { ...receiver(), status: "unsupported" },
      source("receiver", { projects: [] }),
    ];
    for (const receiving of unavailable) {
      expect(merge(origin(), receiving).get(key)).toMatchObject({
        ledger: { problems: [] },
        problemsIncomplete: true,
      });
    }
    expect(merge(origin()).get(key)?.problemsIncomplete).toBe(true);
    expect(
      merge(origin({ ...ledger, deliveryEnvironmentIds: [] }), ...unavailable).get(key)
        ?.problemsIncomplete,
    ).toBe(false);
    expect(
      merge(origin({ asks: ledger.asks, problems: ledger.problems }), receiver()).get(key)
        ?.problemsIncomplete,
    ).toBe(true);
    const staleOrigin = { ...origin(), connected: false, status: "offline" as const };
    expect(merge(staleOrigin, receiver()).get(key)).toMatchObject({
      ledger: { problems: [] },
      problemsIncomplete: true,
    });
    expect(
      mergeFleetDeliveryFacts(
        { isReady: true, sources: [origin(), receiver()] },
        new Map([
          ["origin", true],
          ["receiver", false],
        ]),
      ).get(key),
    ).toMatchObject({ ledger: { problems: [] }, problemsIncomplete: true });
  });

  it("aggregates repeated placements across projects before merging receiver alarms", () => {
    const first = { ...openLedger, problems: [{ ...problem, messageId: "local-first" }] };
    const second = {
      ...openLedger,
      asks: { owed: [], awaited: [ask("second")] },
      deliveryEnvironmentIds: ["second-receiver"],
    };
    const sending = source("origin", {
      projects: [project(first, "one"), project(second, "two"), project(first, "three")],
      remoteDeliveryAlarms: [],
    });
    const receiving = source("second-receiver", {
      projects: [],
      remoteDeliveryAlarms: [
        {
          originEnvironmentId: "origin",
          senderId,
          problem: { ...problem, messageId: "second-message", exchangeId: "second" },
        },
      ],
    });
    const result = merge(sending, receiver(), receiving).get(key)!;
    expect(result.problemsIncomplete).toBe(false);
    expect(result.ledger?.deliveryEnvironmentIds).toEqual(["receiver", "second-receiver"]);
    expect(result.ledger?.asks.awaited.map((entry) => entry.exchangeId)).toEqual([
      "exchange",
      "second",
    ]);
    expect(
      result.ledger?.problems.map((entry) => entry.kind === "delivery-failed" && entry.messageId),
    ).toEqual(["local-first", "received-message", "second-message"]);
  });

  it("removes a cached receiver alarm from a live origin when receiver coverage is lost", () => {
    const rows = Atom.make<ReadonlyArray<FleetFactRow>>([]);
    const facts = createFleetFactsAtom(rows);
    const registry = AtomRegistry.make();
    const stop = registry.subscribe(facts, () => {}, { immediate: true });
    const update = (receiving: J5ReadSource<FleetResponse>) => {
      const merged = merge(origin(), receiving).get(key)!;
      registry.set(rows, [
        { key, shell: shell({ latestRunId: null, status: "completed" }), live: true, ...merged },
      ]);
    };
    update(receiver());
    expect(registry.get(facts).get(key)?.problems).toEqual([problem]);
    update({ ...receiver(), connected: false, status: "offline" });
    expect(registry.get(facts).get(key)).toMatchObject({ problems: [], problemsIncomplete: true });
    stop();
    registry.dispose();
  });
});
