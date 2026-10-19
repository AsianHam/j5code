import { describe, expect, it, vi } from "vite-plus/test";
import type { FleetDerivedFacts } from "@t3tools/client-runtime/j5/fleetFacts";
import type { FleetRuntimeFact } from "@t3tools/contracts/j5";
import {
  fleetCrewSummary,
  fleetAgentKey,
  fleetMinutes,
  fleetTime,
  fleetProblemLabel,
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
});

describe("Fleet presentation", () => {
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

  it("keeps prior-day dates explicit without advancing stale timestamps at midnight", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
      const prior = "2026-10-18T10:00:00.000Z";
      const idle = { ...runtime("idle"), since: prior };
      const label = fleetStatusLabel(idle);
      expect(label).toContain("18th October 2026");
      expect(fleetTime(prior)).toContain("18th October 2026");
      expect(
        fleetProblemLabel({
          kind: "delivery-failed",
          messageId: "m",
          receiverId: "a",
          receiverName: "Agent",
          at: prior,
          reason: "offline",
          exchangeOpen: false,
        }),
      ).toContain("18th October 2026");
      vi.advanceTimersByTime(3 * 86_400_000);
      expect(fleetStatusLabel(idle)).toBe(label);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
