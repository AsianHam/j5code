import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  SpawnWorkspaceService,
  layerFromReceiptStore,
  namedBaseRefs,
  resolveSpawnWorkspace,
  type SpawnWorkspaceChoice,
} from "./spawnWorkspace.ts";

const projectId = ProjectId.make("project:spawn-pin");

const driverLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "spawn-pin-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Upstream's workflow service reads through the driver, so the real driver stands in for it. */
const workflowOverDriver = Layer.effect(
  GitWorkflowService,
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return GitWorkflowService.of({
      listRefs: driver.listRefs,
      listLocalBranchNames: driver.listLocalBranchNames,
      fetchRemote: driver.fetchRemote,
      remoteExists: driver.remoteExists,
      remoteBranchExists: driver.remoteBranchExists,
      resolveRemoteTrackingCommit: driver.resolveRemoteTrackingCommit,
      hasCommit: ({ cwd, refName }: { readonly cwd: string; readonly refName: string }) =>
        driver.resolveCommit({ cwd, revision: refName }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      invalidateLocalStatus: () => Effect.void,
    } as unknown as GitWorkflowService["Service"]);
  }),
);

const inScratch = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | Scope.Scope | GitVcsDriver.GitVcsDriver
  >,
) => Effect.scoped(effect).pipe(Effect.provide(driverLayer));

/** Runs one command in a repository and returns its trimmed output. */
const sh = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "spawnWorkspacePin.test",
      cwd,
      args,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    return result.stdout.trim();
  });

const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "spawn-pin-repo-" });
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  yield* sh(root, "init", "--bare", "--initial-branch=main", origin);
  yield* sh(root, "clone", origin, work);
  yield* sh(work, "checkout", "-b", "main");
  yield* sh(work, "commit", "--allow-empty", "-m", "first");
  yield* sh(work, "push", "origin", "main");
  yield* sh(work, "branch", "release");
  const layer = layerFromReceiptStore.pipe(
    Layer.provide(
      Layer.mergeAll(
        workflowOverDriver,
        Layer.mock(ProjectService)({
          getById: (id) => Effect.succeedSome({ id, workspaceRoot: work } as never),
        }),
        Layer.mock(CommandReceiptStoreV2)({}),
        Layer.mock(ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService)({}),
      ),
    ),
    Layer.provideMerge(driverLayer),
  );
  return { work, other, origin, root, layer };
});

/** What a Crew seat's base resolves to in the repository as it is now. */
const resolveBase = (choice: Extract<SpawnWorkspaceChoice, { readonly type: "worktree" }>) =>
  Effect.gen(function* () {
    const workspace = yield* SpawnWorkspaceService;
    const checkout = yield* workspace.inspect({
      projectId,
      worktreePath: null,
      existingWorktreePaths: [],
      checkBranches: false,
      baseRefs: namedBaseRefs([choice]),
      pinBases: true,
    });
    return resolveSpawnWorkspace(checkout, choice);
  });

it.effect("a pin survives its branch being renamed, moved or deleted while the commit exists", () =>
  inScratch(
    Effect.gen(function* () {
      const { work, layer } = yield* scenario;
      const releaseCommit = yield* sh(work, "rev-parse", "release");
      yield* Effect.gen(function* () {
        const pinned = Result.getOrThrow(
          yield* resolveBase({ type: "worktree", baseRef: "release" }),
        );
        assert.equal(pinned.type === "worktree" && pinned.baseCommit, releaseCommit);
        const choice = { type: "worktree" as const, baseRef: "release", baseCommit: releaseCommit };

        // Moved: the branch name now means another commit, and the pin does not follow it.
        yield* sh(work, "commit", "--allow-empty", "-m", "second");
        yield* sh(work, "branch", "-f", "release", "HEAD");
        const moved = Result.getOrThrow(yield* resolveBase(choice));
        assert.equal(moved.type === "worktree" && moved.baseCommit, releaseCommit);

        // Renamed, then deleted: the name is gone but the commit is still in the repository.
        yield* sh(work, "branch", "-m", "release", "renamed");
        yield* sh(work, "branch", "-D", "renamed");
        const renamed = Result.getOrThrow(yield* resolveBase(choice));
        assert.equal(renamed.type === "worktree" && renamed.baseCommit, releaseCommit);

        // A base with no pin, such as one submitted by name, is refused rather than guessed.
        const stale = yield* resolveBase({ type: "worktree", baseRef: "release" });
        assert.isTrue(Result.isFailure(stale));
        assert.include(
          Result.isFailure(stale) ? stale.failure.detail : "",
          "'release' doesn't resolve",
        );

        // A commit that is truly gone fails naming the revision.
        const missing = yield* resolveBase({ ...choice, baseCommit: "0".repeat(40) });
        assert.isTrue(Result.isFailure(missing));
        assert.include(
          Result.isFailure(missing) ? missing.failure.detail : "",
          "Base commit 00000000 (from 'release') is no longer in this repository.",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect(
  "from origin, the pin is origin's fetched tip, and only a fresh choice reads it again",
  () =>
    inScratch(
      Effect.gen(function* () {
        const { work, other, origin, root, layer } = yield* scenario;
        const localTip = yield* sh(work, "rev-parse", "main");
        yield* sh(root, "clone", origin, other);
        yield* sh(other, "checkout", "main");
        yield* sh(other, "commit", "--allow-empty", "-m", "ahead on origin");
        yield* sh(other, "push", "origin", "main");
        const originTip = yield* sh(other, "rev-parse", "HEAD");
        yield* Effect.gen(function* () {
          const local = Result.getOrThrow(
            yield* resolveBase({ type: "worktree", baseRef: "main" }),
          );
          assert.equal(local.type === "worktree" && local.baseCommit, localTip);
          const choice = { type: "worktree" as const, baseRef: "main", startFromOrigin: true };
          const fromOrigin = Result.getOrThrow(yield* resolveBase(choice));
          assert.equal(fromOrigin.type === "worktree" && fromOrigin.baseCommit, originTip);

          // Origin moves again; the saved commit is used as it is, with no fetch to advance it.
          yield* sh(other, "commit", "--allow-empty", "-m", "further");
          yield* sh(other, "push", "origin", "main");
          const kept = Result.getOrThrow(yield* resolveBase({ ...choice, baseCommit: originTip }));
          assert.equal(kept.type === "worktree" && kept.baseCommit, originTip);
          assert.equal(yield* sh(work, "rev-parse", "refs/remotes/origin/main"), originTip);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("a local-only branch with origin present falls back to the local ref", () =>
  inScratch(
    Effect.gen(function* () {
      const { work, layer } = yield* scenario;
      yield* sh(work, "commit", "--allow-empty", "-m", "local only");
      yield* sh(work, "branch", "local-only", "HEAD");
      const localTip = yield* sh(work, "rev-parse", "local-only");
      yield* Effect.gen(function* () {
        const resolved = Result.getOrThrow(
          yield* resolveBase({ type: "worktree", baseRef: "local-only", startFromOrigin: true }),
        );
        assert.equal(resolved.type === "worktree" && resolved.baseCommit, localTip);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an unreachable origin refuses only the seat that started from it", () =>
  inScratch(
    Effect.gen(function* () {
      const { work, origin, layer } = yield* scenario;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(origin, { recursive: true });
      const releaseCommit = yield* sh(work, "rev-parse", "release");
      yield* Effect.gen(function* () {
        const workspace = yield* SpawnWorkspaceService;
        const choices: ReadonlyArray<SpawnWorkspaceChoice> = [
          { type: "worktree", baseRef: "release" },
          { type: "worktree", baseRef: "main", startFromOrigin: true },
        ];
        const checkout = yield* workspace.inspect({
          projectId,
          worktreePath: null,
          existingWorktreePaths: [],
          checkBranches: false,
          baseRefs: namedBaseRefs(choices),
          pinBases: true,
        });
        assert.isTrue(checkout.readable);
        const [local, fromOrigin] = choices.map((choice) =>
          resolveSpawnWorkspace(checkout, choice),
        );
        const pinned = Result.getOrThrow(local!);
        assert.equal(pinned.type === "worktree" && pinned.baseCommit, releaseCommit);
        assert.isTrue(Result.isFailure(fromOrigin!));
        const failure = Result.isFailure(fromOrigin!) ? fromOrigin.failure : undefined;
        assert.include(failure?.detail, "Base 'main' was chosen from origin");
        assert.include(failure?.nextStep, "local branch");
      }).pipe(Effect.provide(layer));
    }),
  ),
);
