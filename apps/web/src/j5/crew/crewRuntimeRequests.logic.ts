import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CrewRuntimeRequestItem,
  CrewRuntimeRequestsResponse,
  NativeQuestionInboxItem,
} from "@t3tools/contracts/j5";

import type { PendingApproval } from "../../session-logic";

export type ScopedCrewRuntimeRequest = CrewRuntimeRequestItem & {
  readonly environmentId: EnvironmentId;
};

/** Every environment's seat approvals, each tagged with the environment that must answer it. */
export const mergeCrewRuntimeRequestSources = (
  sources: J5ReadSources<CrewRuntimeRequestsResponse>,
): ReadonlyArray<ScopedCrewRuntimeRequest> =>
  sources.sources.flatMap((source) =>
    (source.data?.requests ?? []).map((request) => ({
      ...request,
      environmentId: source.environmentId,
    })),
  );

export type ScopedNativeQuestionInboxItem = NativeQuestionInboxItem & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
};

export const mergeNativeQuestionInboxSources = (
  sources: J5ReadSources<CrewRuntimeRequestsResponse>,
): ReadonlyArray<ScopedNativeQuestionInboxItem> =>
  sources.sources
    .flatMap((source) =>
      (source.data?.questions ?? []).map((question) => ({
        ...question,
        environmentId: source.environmentId,
        environmentLabel: source.environmentLabel,
        connected: source.connected,
      })),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

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
  /** Changes when pending request flags or the raw summary change; empty when none is pending. */
  readonly key: string;
  /** The environments with a pending request worth checking for Inbox items. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

/**
 * Which environments the Inbox reads for seat approvals and placed agents' native questions.
 * Any pending flag or raw summary starts the read, even on a person-created thread: the server
 * alone decides placement. Auth refresh and tool-call summaries can trigger an empty read.
 */
export const crewApprovalReadPlan = (
  shells: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "id" | "hasPendingApprovals" | "hasPendingUserInput" | "archivedAt"
    > & { readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest"> }
  >,
): CrewApprovalReadPlan => {
  const pending = shells
    .filter(
      (shell) =>
        (shell.hasPendingApprovals ||
          shell.hasPendingUserInput ||
          shell.source?.pendingRuntimeRequest != null) &&
        shell.archivedAt === null,
    )
    .map((shell) => ({
      environmentId: shell.environmentId,
      entry: `${shell.environmentId}/${shell.id}/${shell.hasPendingApprovals}/${shell.hasPendingUserInput}/${shell.source?.pendingRuntimeRequest?.id ?? ""}`,
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
