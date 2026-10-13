import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";

import {
  crewApprovalReadPlan,
  inboxBadgeCount,
  mergeCrewRuntimeRequestSources,
  toPendingApproval,
} from "./crewRuntimeRequests.logic";

const envA = EnvironmentId.make("env:a");
const envB = EnvironmentId.make("env:b");
const seatThread = ThreadId.make("thread:builder");

const item = (requestId: string, threadId = seatThread): CrewRuntimeRequestItem => ({
  threadId,
  requestId: RuntimeRequestId.make(requestId),
  crewInstanceId: "crew:1",
  crewName: "Release Crew",
  projectId: "project:1",
  seat: "builder",
  threadTitle: "builder",
  createdAt: "2026-09-24T12:00:00.000Z",
  requestKind: "command",
  detail: "Run the tests?",
});

const sources = (
  byEnvironment: ReadonlyArray<[EnvironmentId, ReadonlyArray<CrewRuntimeRequestItem>]>,
) =>
  ({
    isReady: true,
    sources: byEnvironment.map(([environmentId, data]) => ({ environmentId, data })),
  }) as never;

const shell = (
  environmentId: EnvironmentId,
  id: string,
  hasPendingApprovals: boolean,
  archivedAt: string | null = null,
) => ({ environmentId, id: ThreadId.make(id), hasPendingApprovals, archivedAt });

describe("Crew seat approvals in the Inbox", () => {
  it("tags each approval with the environment that must answer it", () => {
    const merged = mergeCrewRuntimeRequestSources(
      sources([
        [envA, [item("a1"), item("a2")]],
        // The same local thread id on another environment is a different thread.
        [envB, [item("a9")]],
      ]),
    );
    expect(merged.map((request) => [request.environmentId, request.requestId])).toEqual([
      [envA, "a1"],
      [envA, "a2"],
      [envB, "a9"],
    ]);
  });

  it("hands the composer's approval UI a live approval with only the fields it has", () => {
    expect(toPendingApproval(item("a1"))).toEqual({
      requestId: "a1",
      requestKind: "command",
      createdAt: "2026-09-24T12:00:00.000Z",
      detail: "Run the tests?",
      responseCapability: "live",
    });
    const options = [{ decision: "accept" as const, label: "Allow", warning: "For good." }];
    expect(
      toPendingApproval({ ...item("a2"), requestKind: "permission", appName: "CI", options }),
    ).toMatchObject({ requestKind: "permission", appName: "CI", options });
  });

  it("reads only environments with a thread waiting on an approval", () => {
    expect(crewApprovalReadPlan([])).toEqual({ key: "", environmentIds: [] });
    // Nothing pending anywhere, or only on an archived thread: no environment is read.
    const idle = crewApprovalReadPlan([
      shell(envA, "thread:1", false),
      shell(envB, "thread:2", true, "2026-09-24T12:00:00.000Z"),
    ]);
    expect(idle).toEqual({ key: "", environmentIds: [] });

    const pending = crewApprovalReadPlan([
      shell(envB, "thread:2", true),
      shell(envA, "thread:1", false),
      shell(envB, "thread:3", true),
    ]);
    expect(pending.environmentIds).toEqual([envB]);

    // The key moves when any thread's flag turns on or off, even within an environment already
    // read, and holds still when unrelated shells change.
    const oneCleared = crewApprovalReadPlan([
      shell(envB, "thread:2", true),
      shell(envA, "thread:1", false),
      shell(envB, "thread:3", false),
    ]);
    expect(oneCleared.environmentIds).toEqual([envB]);
    expect(oneCleared.key).not.toBe(pending.key);
    expect(
      crewApprovalReadPlan([shell(envB, "thread:3", true), shell(envB, "thread:2", true)]).key,
    ).toBe(pending.key);
  });

  it("counts seat approvals on the bell, up while waiting and back down once answered", () => {
    expect(inboxBadgeCount(2, 0, 0)).toBe(2);
    expect(inboxBadgeCount(2, 1, 3)).toBe(6);
    expect(inboxBadgeCount(2, 1, 1)).toBe(4);
    // Asks unread, Crew items read: still counted; nothing at all reads as no badge.
    expect(inboxBadgeCount(null, 0, 1)).toBe(1);
    expect(inboxBadgeCount(null, 0, 0)).toBeNull();
  });
});
