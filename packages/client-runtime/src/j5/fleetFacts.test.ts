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
import { createFleetFactsAtom, deriveFleetFacts, type FleetFactRow } from "./fleetFacts.ts";

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
