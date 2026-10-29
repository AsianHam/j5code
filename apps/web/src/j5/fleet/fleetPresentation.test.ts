import { describe, expect, it, vi } from "vite-plus/test";
import {
  summarizeFleetProblems,
  type FleetDerivedFacts,
} from "@t3tools/client-runtime/j5/fleetFacts";
import type { FleetRuntimeFact } from "@t3tools/contracts/j5";
import {
  fleetCrewSummary,
  fleetAgentKey,
  fleetMinutes,
  fleetTime,
  fleetAgo,
  fleetProblemLabel,
  fleetBadgeLabel,
  fleetProblemNotices,
  fleetSeatState,
  fleetSourceIsLive,
  fleetStatusLabel,
} from "./fleetPresentation";

const at = "2026-10-19T10:00:00.000Z";
const runtime = (
  status: Extract<FleetRuntimeFact, { state: "known" }>["status"],
  settled = false,
): FleetRuntimeFact => ({ state: "known", status, settled, since: at });
const facts = (value: FleetRuntimeFact): FleetDerivedFacts => ({
  runtime: value,
  asks: undefined,
  lastActivity: { state: "unknown", reason: "old server" },
  problems: [],
  problemsIncomplete: false,
});

describe("Fleet presentation", () => {
  it("qualifies zero and positive badge counts when source or agent measurements are missing", () => {
    const complete = {
      agentsWithProblems: 0,
      unmeasuredAgents: 0,
      incompleteSources: false,
      hasReadableSource: true,
    };
    expect(fleetBadgeLabel(complete)).toBe("Open fleet, 0 agents have measured problems.");
    expect(fleetProblemNotices(complete)).toEqual([]);
    const unmeasured = { ...complete, unmeasuredAgents: 1 };
    expect(fleetBadgeLabel(unmeasured)).toContain("1 agent unmeasured.");
    expect(fleetBadgeLabel(unmeasured)).toContain("Counts include current measured problems only.");
    expect(fleetBadgeLabel(unmeasured)).not.toContain("coverage is incomplete");
    const partial = { ...unmeasured, agentsWithProblems: 1, incompleteSources: true };
    expect(fleetBadgeLabel(partial)).toContain("1 agent has measured problems.");
    expect(fleetBadgeLabel(partial)).toContain("Problem coverage is incomplete");
    expect(fleetProblemNotices(partial)).toContain(
      "Counts include current measured problems only.",
    );
  });
  it("distinguishes an unavailable count from a measured zero, including an empty live source", () => {
    const measured = new Map([
      [
        "env:agent",
        {
          ...facts(runtime("failed")),
          asks: { owed: [], awaited: [] },
          problems: [{ kind: "failed-run" as const, runId: "run", at }],
        },
      ],
    ]);
    for (const sourceFacts of [new Map(), measured]) {
      const unavailable = summarizeFleetProblems(
        sourceFacts,
        new Map([["env:agent", false]]),
        "unavailable",
      );
      expect(fleetBadgeLabel(unavailable)).toContain("problem count unavailable");
      expect(fleetBadgeLabel(unavailable)).not.toMatch(/\d/);
      expect(fleetBadgeLabel(unavailable)).toContain("coverage is incomplete");
    }
    const emptyLive = summarizeFleetProblems(new Map(), new Map(), "complete");
    expect(fleetBadgeLabel(emptyLive)).toBe("Open fleet, 0 agents have measured problems.");
    const partialZero = summarizeFleetProblems(new Map(), new Map(), "partial");
    expect(fleetBadgeLabel(partialZero)).toContain("0 agents have measured problems");
    expect(fleetBadgeLabel(partialZero)).toContain("coverage is incomplete");
    const restored = summarizeFleetProblems(measured, new Map([["env:agent", true]]), "partial");
    expect(fleetBadgeLabel(restored)).toContain("1 agent has measured problems");
    expect(fleetBadgeLabel(restored)).toContain("coverage is incomplete");
  });
  it("uses runtime vocabulary and makes old or unavailable measurements explicit", () => {
    for (const [status, label] of [
      ["working", "Working"],
      ["waiting", "Waiting"],
      ["approval", "Approval"],
      ["input", "Input"],
      ["failed", "Failed"],
      ["waiting-to-start", "Waiting to start"],
    ] as const)
      expect(fleetStatusLabel(runtime(status))).toBe(label);
    expect(fleetStatusLabel(runtime("idle"))).toMatch(/^Idle since /);
    expect(fleetStatusLabel(runtime("idle", true))).toBe("Settled");
    expect(fleetStatusLabel({ state: "unknown", reason: "missing runtime" })).toBe("?");
  });

  it("uses relative live times and keeps stale measurements absolute across midnight", () => {
    const now = Date.parse(at);
    const prior = "2026-10-18T10:00:00.000Z";
    const idle = { ...runtime("idle"), since: prior };
    expect(fleetTime(prior, now)).toBe("1d");
    expect(fleetAgo(prior, now)).toBe("1d ago");
    expect(fleetAgo(at, now)).toBe("just now");
    expect(fleetAgo(undefined, now)).toBe("?");
    expect(fleetAgo(prior)).toContain("18th October 2026");
    expect(fleetTime(prior, now + 3 * 86_400_000)).toBe("4d");
    expect(fleetStatusLabel(idle, now)).toBe("Idle 1d");
    expect(fleetStatusLabel(idle, now + 3 * 86_400_000)).toBe("Idle 4d");
    expect(fleetTime(prior)).toContain("18th October 2026");
    expect(fleetTime(undefined, now)).toBe("?");
    expect(fleetTime("invalid", now)).toBe("?");
    expect(fleetTime("invalid")).toBe("?");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const stale = fleetStatusLabel(idle);
      expect(stale).toContain("18th October 2026");
      vi.advanceTimersByTime(3 * 86_400_000);
      expect(fleetStatusLabel(idle)).toBe(stale);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances every problem kind with the supplied clock while preserving missing times", () => {
    const now = Date.parse(at) + 60_000;
    const problems = [
      { kind: "failed-run", runId: "r", at },
      { kind: "dispatch-overdue", runId: "r", at },
      {
        kind: "delivery-failed",
        messageId: "m",
        receiverId: "a",
        receiverName: "Agent",
        at,
        reason: "offline",
        exchangeOpen: false,
      },
    ] as const;
    for (const problem of problems) {
      expect(fleetProblemLabel(problem, now)).toContain("1m ago");
      expect(fleetProblemLabel(problem, now + 60_000)).toContain("2m ago");
      expect(fleetProblemLabel(problem)).toContain("19th October 2026");
    }
    expect(fleetProblemLabel({ kind: "failed-run", runId: "r", at: null }, now)).toBe(
      "Latest run failed · time unavailable",
    );
  });

  it("keeps stale or unknown agents Active and respects background Waiting over a settle mark", () => {
    expect(fleetSeatState(facts(runtime("idle", true)), true)).toBe("settled");
    expect(fleetSeatState(facts(runtime("waiting")), true)).toBe("running");
    expect(fleetSeatState(facts(runtime("failed")), true)).toBe("failed");
    expect(fleetSeatState(facts(runtime("idle", true)), false)).toBe("unknown");
    expect(fleetSeatState(facts({ state: "unknown", reason: "old server" }), true)).toBe("unknown");
    expect(fleetSeatState(undefined, true)).toBe("unknown");
  });

  it("summarizes Crews from the same measured states as their rows", () => {
    const measured = new Map([
      ["waiting", facts(runtime("waiting"))],
      ["settled", facts(runtime("idle", true))],
    ]);
    expect(
      fleetCrewSummary(
        ["waiting", "settled"],
        measured,
        new Map([
          ["waiting", true],
          ["settled", true],
        ]),
      ),
    ).toBe("1 waiting · 1 settled");
    expect(fleetCrewSummary(["waiting", "settled"], measured, new Map())).toBe("2 unknown");
  });

  it("requires both a current ledger and a live shell stream", () => {
    expect(fleetSourceIsLive({ connected: true, status: "ready" }, "live")).toBe(true);
    for (const status of ["offline", "error", "loading", "unsupported"] as const)
      expect(fleetSourceIsLive({ connected: true, status }, "live")).toBe(false);
    expect(fleetSourceIsLive({ connected: false, status: "ready" }, "live")).toBe(false);
    for (const shell of ["cached", "synchronizing", "empty"])
      expect(fleetSourceIsLive({ connected: true, status: "ready" }, shell)).toBe(false);
  });

  it("keeps environment-qualified ids collision-free and freezes ages at a supplied observation", () => {
    expect(fleetAgentKey("a:b", "c")).not.toBe(fleetAgentKey("a", "b:c"));
    expect(fleetAgentKey("first", "agent")).not.toBe(fleetAgentKey("second", "agent"));
    expect(fleetMinutes(at, Date.parse(at) + 299_999)).toBe(4);
    expect(fleetMinutes(at, Date.parse(at) + 300_000)).toBe(5);
  });

  it("labels every measured problem and never invents a failure time or a missing reason", () => {
    expect(fleetProblemLabel({ kind: "failed-run", runId: "r", at: null })).toBe(
      "Latest run failed · time unavailable",
    );
    expect(fleetProblemLabel({ kind: "dispatch-overdue", runId: "r", at })).toMatch(
      /^Run not dispatched · requested /,
    );
    expect(
      fleetProblemLabel({
        kind: "delivery-failed",
        messageId: "m",
        receiverId: "agent:unknown",
        receiverName: null,
        at,
        reason: null,
        exchangeOpen: false,
      }),
    ).toMatch(/^Delivery failed · to agent:unknown · .* · reason unavailable$/);
    expect(
      fleetProblemLabel({
        kind: "delivery-failed",
        messageId: "m",
        receiverId: "agent:known",
        receiverName: "Builder",
        at,
        reason: "Transport unavailable",
        exchangeOpen: true,
      }),
    ).toContain("to Builder");
  });
});
