import { describe, expect, it } from "vite-plus/test";

import {
  classifyCrewSeat,
  crewHasRunningSeat,
  formatCrewStateSummary,
  summarizeCrewState,
  type CrewSeatThread,
} from "./crewState";

const seat = (overrides: Partial<CrewSeatThread> = {}): CrewSeatThread => ({
  runtime: { status: "idle" },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  updatedAt: "2026-09-14T10:00:00.000Z",
  ...overrides,
});

describe("crew state", () => {
  it.each(["running", "waiting"] as const)(
    "shows a %s native question as needs you while retaining Stop crew",
    (status) => {
      const waiting = seat({ runtime: { status }, hasPendingUserInput: true });
      const summary = summarizeCrewState([waiting]);
      expect(classifyCrewSeat(waiting)).toBe("needs-you");
      expect(summary.counts["needs-you"]).toBe(1);
      expect(summary.counts.running).toBe(0);
      expect(formatCrewStateSummary(summary)).toBe("1 needs you");
      expect(crewHasRunningSeat(summary)).toBe(true);
      expect(classifyCrewSeat({ ...waiting, archivedAt: "2026-10-19T12:00:00.000Z" })).toBe(
        "archived",
      );
      expect(classifyCrewSeat({ ...waiting, runtime: { status: "failed" } })).toBe("failed");
    },
  );

  it("classifies each seat from measured facts in precedence order", () => {
    expect(classifyCrewSeat(undefined)).toBe("unknown");
    expect(classifyCrewSeat(seat({ archivedAt: "2026-09-14T09:00:00.000Z" }))).toBe("archived");
    expect(
      classifyCrewSeat(seat({ runtime: { status: "running" }, hasPendingApprovals: true })),
    ).toBe("running");
    // A seat whose last run failed is said so, ahead of anything it may still owe the person.
    expect(
      classifyCrewSeat(seat({ runtime: { status: "failed" }, hasPendingApprovals: true })),
    ).toBe("failed");
    expect(classifyCrewSeat(seat({ hasPendingUserInput: true, settledAt: "x" }))).toBe("needs-you");
    expect(classifyCrewSeat(seat({ settledAt: "2026-09-14T09:30:00.000Z" }))).toBe("settled");
    expect(classifyCrewSeat(seat({ settledOverride: "settled" }))).toBe("settled");
    // A user who reopened a settled seat made it active again.
    expect(classifyCrewSeat(seat({ settledOverride: "active", settledAt: "x" }))).toBe("idle");
    expect(classifyCrewSeat(seat())).toBe("idle");
  });

  it("summarizes a Crew and formats only the states worth saying", () => {
    const summary = summarizeCrewState([
      seat({ runtime: { status: "running" }, updatedAt: "2026-09-14T12:00:00.000Z" }),
      seat({ runtime: { status: "waiting" } }),
      seat({ runtime: { status: "failed" } }),
      seat({ hasPendingApprovals: true }),
      seat({ settledAt: "2026-09-14T09:30:00.000Z" }),
      seat(),
      undefined,
    ]);
    expect(summary.total).toBe(7);
    expect(summary.counts).toEqual({
      running: 2,
      failed: 1,
      "needs-you": 1,
      settled: 1,
      idle: 1,
      archived: 0,
      unknown: 1,
    });
    expect(summary.lastActivityAt).toBe("2026-09-14T12:00:00.000Z");
    expect(formatCrewStateSummary(summary)).toBe(
      "2 running · 1 failed · 1 needs you · 1 settled · 1 unknown",
    );
    expect(formatCrewStateSummary(summarizeCrewState([seat(), seat()]))).toBeNull();
    expect(crewHasRunningSeat(summary)).toBe(true);
    expect(
      crewHasRunningSeat(summarizeCrewState([seat(), seat({ hasPendingApprovals: true })])),
    ).toBe(false);
    expect(formatCrewStateSummary(summarizeCrewState([]))).toBeNull();
  });
});
