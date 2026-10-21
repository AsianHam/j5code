import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { RunId, RuntimeRequestId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  FleetResponse,
  FLEET_DISPATCH_THRESHOLD_MS,
  type FleetAgentFacts,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/reactivity";

import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import {
  createFleetFactsAtom,
  deriveFleetFacts,
  summarizeFleetProblems,
  type FleetFactRow,
} from "./fleetFacts.ts";

const decodeFleet = Schema.decodeUnknownSync(FleetResponse);

const at = "2026-10-19T10:00:00.000Z";
const now = Date.parse(at);
const date = DateTime.makeUnsafe(at);
const ledger: FleetAgentFacts = { asks: { owed: [], awaited: [] }, problems: [] };
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
      summarizeFleetProblems(registry.get(facts), new Map([["env:sender", true]]), true)
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
    expect(summarizeFleetProblems(facts, live, false)).toEqual({
      agentsWithProblems: 2,
      unmeasuredAgents: 0,
      incompleteSources: true,
    });
    // Silence and platform notices have no problem fact; absence must not manufacture one.
    expect(
      summarizeFleetProblems(
        new Map([["notice", derive(shell()).facts]]),
        new Map([["notice", true]]),
        true,
      ).agentsWithProblems,
    ).toBe(0);
  });

  it("separates an unrecorded seat's missing runtime from missing source coverage", () => {
    const unrecordedSeat = deriveFleetFacts({ shell: undefined, ledger, now }).facts;
    const facts = new Map([["seat-without-thread", unrecordedSeat]]);
    const live = new Map([["seat-without-thread", true]]);
    expect(summarizeFleetProblems(facts, live, true)).toEqual({
      agentsWithProblems: 0,
      unmeasuredAgents: 1,
      incompleteSources: false,
    });
    facts.set("seat-without-thread", { ...unrecordedSeat, problems: [deliveryProblem(true)] });
    expect(summarizeFleetProblems(facts, live, true).agentsWithProblems).toBe(1);
    facts.set("seat-without-thread", { ...unrecordedSeat, asks: undefined });
    expect(summarizeFleetProblems(facts, live, true)).toEqual({
      agentsWithProblems: 0,
      unmeasuredAgents: 1,
      incompleteSources: true,
    });
    expect(summarizeFleetProblems(new Map(), new Map(), false).incompleteSources).toBe(true);
    live.set("seat-without-thread", false);
    expect(summarizeFleetProblems(facts, live, false).unmeasuredAgents).toBe(0);
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
        true,
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
    expect(
      derive({ ...completed, pendingBackgroundTasks: [{ kind: "command", taskId: "dev-server" }] })
        .facts.runtime,
    ).toMatchObject({ status: "idle", since: at });
    for (const kind of ["subagent", "monitor", "background_task"] as const) {
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
    expect(
      deriveFleetFacts({ shell: shell(), ledger: old.projects[0]!.agents[0]!.facts, now }).facts
        .asks,
    ).toBeUndefined();
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
    { key: "offline:a", shell: shell(), ledger: { ...ledger, problems: [alarm] }, live: true },
    { key: "cached:a", shell: shell(), ledger, live: false },
  ]);
  const facts = createFleetFactsAtom(rows);
  const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
  const stop = registry.subscribe(facts, () => {}, { immediate: true });
  registry.set(
    rows,
    registry.get(rows).map((row) => ({ ...row, live: false })),
  );
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
  expect(stale.runtime).toMatchObject({ state: "known", status: "waiting-to-start" });
  expect(stale.lastActivity.state).toBe("known");
  expect(stale.problems).toEqual([alarm]);
  expect(registry.get(facts).get("cached:a")?.runtime.state).toBe("unknown");
  stop();
  registry.dispose();
});
