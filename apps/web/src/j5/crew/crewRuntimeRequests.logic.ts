import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";

import type { PendingApproval } from "../../session-logic";

export type ScopedCrewRuntimeRequest = CrewRuntimeRequestItem & {
  readonly environmentId: EnvironmentId;
};

/** Every environment's seat approvals, each tagged with the environment that must answer it. */
export const mergeCrewRuntimeRequestSources = (
  sources: J5ReadSources<ReadonlyArray<CrewRuntimeRequestItem>>,
): ReadonlyArray<ScopedCrewRuntimeRequest> =>
  sources.sources.flatMap((source) =>
    (source.data ?? []).map((request) => ({ ...request, environmentId: source.environmentId })),
  );

/** The composer's approval shape; the server lists only approvals the provider can still take. */
export const toPendingApproval = (request: CrewRuntimeRequestItem): PendingApproval => ({
  requestId: request.requestId,
  requestKind: request.requestKind,
  createdAt: request.createdAt,
  ...(request.detail === undefined ? {} : { detail: request.detail }),
  ...(request.appName === undefined ? {} : { appName: request.appName }),
  ...(request.options === undefined ? {} : { options: request.options }),
  responseCapability: "live",
});

export interface CrewApprovalReadPlan {
  /** Changes whenever a thread's pending approval appears or clears; empty when none is pending. */
  readonly key: string;
  /** The environments worth reading: only those with a thread waiting on an approval. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

/**
 * Which environments the Inbox reads for seat approvals. A seat approval always raises its
 * thread's `hasPendingApprovals`, so an environment with no such thread has nothing to list and
 * costs no request.
 */
export const crewApprovalReadPlan = (
  shells: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "hasPendingApprovals" | "archivedAt">
  >,
): CrewApprovalReadPlan => {
  const pending = shells
    .filter((shell) => shell.hasPendingApprovals && shell.archivedAt === null)
    .map((shell) => ({
      environmentId: shell.environmentId,
      entry: `${shell.environmentId}/${shell.id}`,
    }))
    .toSorted((left, right) => left.entry.localeCompare(right.entry));
  return {
    key: pending.map((shell) => shell.entry).join("\n"),
    environmentIds: [...new Set(pending.map((shell) => shell.environmentId))],
  };
};

/**
 * The bell: open asks, mid-run seat requests, and seat approvals. An unknown ask count still shows
 * the Crew items, since those were read.
 */
export const inboxBadgeCount = (
  openAsks: number | null,
  crewSeatRequests: number,
  crewRuntimeRequests: number,
): number | null => {
  const crew = crewSeatRequests + crewRuntimeRequests;
  return openAsks === null ? (crew > 0 ? crew : null) : openAsks + crew;
};
