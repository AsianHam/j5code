import {
  isProviderWorkspaceSnapshotCurrent,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import { resolveProviderSkillPaths } from "./skillPaths.ts";

const MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16;

/** A failed scan keeps the cwd's last inventory and `checkedAt`, and records why. */
export function retainFailedWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: Pick<ServerProvider, "checkedAt" | "message">,
): ServerProvider {
  const previous = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  return {
    ...provider,
    workspaceSnapshots: [
      ...(provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd !== cwd),
      {
        ...previous,
        cwd,
        checkedAt: previous?.checkedAt ?? scopedSnapshot.checkedAt,
        slashCommands: previous?.slashCommands ?? [],
        skills: previous?.skills ?? [],
        refreshError: scopedSnapshot.message || "Workspace discovery failed.",
      },
    ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER),
  };
}

// Upstream's `refreshWorkspaceSnapshot` (TTL, `fresh`, latest claim writes, detached scan that
// callers wait on) plus J5's failure retention, link-target resolution and `force`: a rescan of
// one cwd that supersedes a pending one without `fresh`'s machine refresh or dropping other
// instances' snapshots, for callers that already refresh every affected instance.
export const makeSkillWorkspaceRefresh = Effect.fn("j5.skills.makeWorkspaceRefresh")(function* ({
  instanceRegistry,
  providersRef,
  updateProviders,
  refreshInstance,
  upsertProviderWorkspaceSnapshot,
  dropProviderWorkspaceSnapshot,
  serviceScope,
}: {
  readonly instanceRegistry: ProviderInstanceRegistry["Service"];
  readonly providersRef: Ref.Ref<ReadonlyArray<ServerProvider>>;
  readonly updateProviders: (
    update: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshInstance: (instanceId: ProviderInstanceId) => Effect.Effect<unknown>;
  readonly upsertProviderWorkspaceSnapshot: (
    provider: ServerProvider,
    cwd: string,
    scopedSnapshot: ProviderWorkspaceSnapshot,
  ) => ServerProvider;
  readonly dropProviderWorkspaceSnapshot: (provider: ServerProvider, cwd: string) => ServerProvider;
  readonly serviceScope: Scope.Scope;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRefreshesRef = yield* Ref.make<
    ReadonlyMap<ProviderInstance, ReadonlyMap<string, Deferred.Deferred<void>>>
  >(new Map());
  const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly fresh?: boolean;
    readonly force?: boolean;
  }) {
    const replace = input.fresh === true || input.force === true;
    if (input.fresh) {
      yield* updateProviders((providers) =>
        providers.map((candidate) =>
          candidate.instanceId === input.instanceId
            ? candidate
            : dropProviderWorkspaceSnapshot(candidate, input.cwd),
        ),
      );
    }
    const providers = yield* Ref.get(providersRef);
    const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
    const workspaceSnapshotOf = (candidate: ServerProvider | undefined) =>
      candidate?.workspaceSnapshots?.find((s) => s.cwd === input.cwd);
    const scannedFrom = workspaceSnapshotOf(provider);
    const now = yield* DateTime.now;
    if (
      !provider ||
      !provider.enabled ||
      (!replace &&
        scannedFrom &&
        !scannedFrom.refreshError &&
        !scannedFrom.slashCommandsPending &&
        isProviderWorkspaceSnapshotCurrent(scannedFrom, DateTime.toEpochMillis(now)))
    ) {
      return providers;
    }
    const scannedAt = DateTime.formatIso(now);
    const instance = yield* instanceRegistry.getInstance(input.instanceId);
    if (!instance?.snapshotForCwd) return providers;
    const snapshotForCwd = instance.snapshotForCwd;
    const request = yield* Deferred.make<void>();
    const refreshMachineSnapshot = input.fresh
      ? (instance.invalidateCaches ?? Effect.void).pipe(
          Effect.andThen(refreshInstance(input.instanceId)),
        )
      : Effect.void;
    const runScan = refreshMachineSnapshot.pipe(
      Effect.andThen(
        snapshotForCwd(input.cwd).pipe(
          Effect.flatMap((snapshot) =>
            resolveProviderSkillPaths(snapshot.skills).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.map((skills): ProviderWorkspaceSnapshot => ({ ...snapshot, skills })),
            ),
          ),
          // Upstream lets a failed scan fail this effect. J5 records it on the cwd instead,
          // so Settings → Skills can say discovery failed while keeping the last inventory.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void,
          ),
        ),
      ),
      // A returned snapshot is a real inventory even while the provider's health check reports
      // an error.
      Effect.flatMap((scopedSnapshot) =>
        instanceRegistry.getInstance(input.instanceId).pipe(
          Effect.flatMap((currentInstance) => {
            if (currentInstance !== instance) return Ref.get(providersRef);
            // A first scan that failed left no commands for a pending scan to keep.
            const withoutFailedPlaceholder = (candidate: ServerProvider) =>
              scannedFrom?.refreshError && scannedFrom.slashCommands.length === 0
                ? dropProviderWorkspaceSnapshot(candidate, input.cwd)
                : candidate;
            return updateProviders((currentProviders) => {
              // Read ownership inside the update so a newer claim cannot race publication.
              if (Ref.getUnsafe(workspaceRefreshesRef).get(instance)?.get(input.cwd) !== request) {
                return currentProviders;
              }
              return currentProviders.map((candidate) =>
                candidate.instanceId !== input.instanceId ||
                !Equal.equals(workspaceSnapshotOf(candidate), scannedFrom)
                  ? candidate
                  : scopedSnapshot === undefined
                    ? retainFailedWorkspaceSnapshot(candidate, input.cwd, {
                        checkedAt: scannedAt,
                        message: "Workspace discovery failed.",
                      })
                    : upsertProviderWorkspaceSnapshot(
                        withoutFailedPlaceholder(candidate),
                        input.cwd,
                        {
                          ...scopedSnapshot,
                          checkedAt: scannedAt,
                          // Unless the driver reports its own command discovery,
                          // commands come from the health check. A failed check
                          // leaves them unknown, so keep the last ones and retry.
                          slashCommandsPending:
                            scopedSnapshot.slashCommandsPending ??
                            scopedSnapshot.status === "error",
                        },
                      ),
              );
            });
          }),
        ),
      ),
      Effect.ensuring(
        Ref.update(workspaceRefreshesRef, (refreshes) => {
          if (refreshes.get(instance)?.get(input.cwd) !== request) return refreshes;
          const next = new Map(refreshes);
          const current = new Map(next.get(instance));
          current.delete(input.cwd);
          if (current.size) next.set(instance, current);
          else next.delete(instance);
          return next;
        }).pipe(Effect.andThen(Deferred.succeed(request, undefined))),
      ),
    );
    // The claim and the fork happen together, so the request is always completed. The scan is
    // detached so a disconnecting owner cannot cancel the result its waiters depend on.
    const claim = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const inFlight = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
          const current = refreshes.get(instance);
          const running = current?.get(input.cwd);
          if (!replace && running) return [running, refreshes] as const;
          const next = new Map(refreshes);
          next.set(instance, new Map(current).set(input.cwd, request));
          return [undefined, next] as const;
        });
        if (inFlight) return { inFlight } as const;
        return {
          // Starting now attaches the scan's `ensuring` before anything can close the scope.
          scan: yield* Effect.forkIn(runScan, serviceScope, { startImmediately: true }),
        } as const;
      }),
    );
    // Wait for the running scan: on-demand clients get its result only in this reply.
    if ("inFlight" in claim) {
      return yield* Deferred.await(claim.inFlight).pipe(Effect.andThen(Ref.get(providersRef)));
    }
    return yield* Fiber.join(claim.scan);
  });

  return {
    refreshWorkspaceSnapshot,
    getPendingWorkspaceCwds: (instanceId: ProviderInstanceId) =>
      instanceRegistry
        .getInstance(instanceId)
        .pipe(
          Effect.flatMap((instance) =>
            Ref.get(workspaceRefreshesRef).pipe(
              Effect.map((pending) => (instance ? [...(pending.get(instance)?.keys() ?? [])] : [])),
            ),
          ),
        ),
  };
});
