import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import {
  ThreadLaunchService,
  type ThreadLaunchInput,
} from "../../../orchestration-v2/ThreadLaunchService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { layerFromReceiptStore } from "../spawnWorkspace.ts";
import { layerMemory } from "../../../persistence/Sqlite.ts";
import * as RequestReplayService from "../RequestReplayService.ts";

export interface FakeCheckout {
  readonly isRepo: boolean;
  /** The branch checked out where the caller works. */
  readonly refName: string | null;
  /** Other local branches; `refName` and the worktrees' branches are local too. */
  readonly localBranchNames?: ReadonlyArray<string>;
  /** Worktrees beside the main checkout at `/repo`, each on its branch. */
  readonly worktrees?: ReadonlyArray<{ readonly path: string; readonly branch: string }>;
  /** Refs git can't resolve; every other ref exists. */
  readonly missingRefs?: ReadonlyArray<string>;
}

/** A project that is not a git repository; only a shared choice can resolve there. */
export const noRepository: FakeCheckout = { isRepo: false, refName: null };

const fakeRefs = (checkout: FakeCheckout, workspaceRoot: string) => {
  const worktrees = checkout.worktrees ?? [];
  const names = [
    ...new Set([
      ...(checkout.refName === null ? [] : [checkout.refName]),
      ...(checkout.localBranchNames ?? []),
      ...worktrees.map((worktree) => worktree.branch),
    ]),
  ];
  return names.map((name) => ({
    name,
    current: name === checkout.refName,
    isDefault: false,
    worktreePath:
      worktrees.find((worktree) => worktree.branch === name)?.path ??
      (name === checkout.refName ? workspaceRoot : null),
  }));
};

/**
 * The workspace service over fake git, a recording ThreadLaunch, and receipts for the command ids
 * `accepted` reports. ThreadManagementService still comes from the test, so a shared brief lands
 * in the same dispatch log as the test's other commands.
 */
export const fakeSpawnWorkspaceLayer = (options: {
  readonly checkout: FakeCheckout;
  readonly replay?: Layer.Layer<RequestReplayService.RequestReplayService>;
  /**
   * When given, git reads this instead, as an agent's shell leaves it. The direct reads see it as
   * it is now, and a checkout's status does once invalidated; `listRefs` keeps serving the
   * snapshot from its first read, as upstream's cache does within its refresh coalescing window.
   */
  readonly liveCheckout?: Ref.Ref<FakeCheckout>;
  readonly workspaceRoot?: string;
  readonly launches?: Ref.Ref<ReadonlyArray<ThreadLaunchInput>>;
  readonly launch?: (input: ThreadLaunchInput) => Effect.Effect<void>;
  readonly accepted?: Effect.Effect<ReadonlyArray<CommandId>>;
}) => {
  let cachedCheckout: FakeCheckout | undefined;
  const cachedStatus = new Map<string, string | null>();
  const root = options.workspaceRoot ?? "/repo";
  const current =
    options.liveCheckout === undefined
      ? Effect.succeed(options.checkout)
      : Ref.get(options.liveCheckout);
  return layerFromReceiptStore.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService)({
          getById: (id) =>
            Effect.succeedSome({ id, workspaceRoot: options.workspaceRoot ?? "/repo" } as never),
        }),
        Layer.mock(GitWorkflowService)({
          listRefs: Effect.fn("j5.a2a.spawnWorkspaceFakes.listRefs")(function* (input) {
            void input;
            const checkout = cachedCheckout ?? (cachedCheckout = yield* current);
            const refs = checkout.isRepo
              ? fakeRefs(checkout, options.workspaceRoot ?? "/repo")
              : [];
            return {
              refs,
              isRepo: checkout.isRepo,
              hasPrimaryRemote: false,
              nextCursor: null,
              totalCount: refs.length,
            };
          }),
          hasCommit: ({ refName }) =>
            current.pipe(Effect.map((checkout) => !(checkout.missingRefs ?? []).includes(refName))),
          // A checkout's status is cached per path until invalidated, as upstream's is, so only a
          // read that invalidates first sees a branch switched since the last one.
          invalidateLocalStatus: (cwd) => Effect.sync(() => void cachedStatus.delete(cwd)),
          localStatus: Effect.fn("j5.a2a.spawnWorkspaceFakes.localStatus")(function* ({ cwd }) {
            const cached = cachedStatus.get(cwd);
            if (cached !== undefined) return { isRepo: true, refName: cached } as never;
            const checkout = yield* current;
            const branch =
              cwd === root
                ? checkout.refName
                : checkout.worktrees?.find((worktree) => worktree.path === cwd)?.branch;
            if (branch === undefined) return yield* Effect.die(new Error(`no checkout at ${cwd}`));
            cachedStatus.set(cwd, branch);
            return { isRepo: true, refName: branch } as never;
          }),
          listLocalBranchNames: () =>
            current.pipe(Effect.map((checkout) => fakeRefs(checkout, root).map((ref) => ref.name))),
        }),
        Layer.mock(ThreadLaunchService)({
          launch: Effect.fn("j5.a2a.spawnWorkspaceFakes.launch")(function* (input) {
            if (options.launches) yield* Ref.update(options.launches, (all) => [...all, input]);
            if (options.launch) yield* options.launch(input);
            return {
              threadId: input.threadId as ThreadId,
              projection: {} as never,
              resumed: false,
            };
          }),
        }),
        Layer.mock(CommandReceiptStoreV2)({
          getByCommandId: (commandId) =>
            (options.accepted ?? Effect.succeed([])).pipe(
              Effect.map((accepted) =>
                accepted.includes(commandId)
                  ? Option.some({
                      commandId,
                      threadId: "thread:receipt" as ThreadId,
                      commandType: "thread.create",
                      acceptedAt: DateTime.makeUnsafe(0),
                      resultSequence: 1,
                      status: "accepted" as const,
                      error: null,
                    })
                  : Option.none(),
              ),
            ),
        }),
      ),
    ),
    Layer.merge(options.replay ?? RequestReplayService.layer.pipe(Layer.provide(layerMemory))),
  );
};
