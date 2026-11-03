import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { GitManager } from "../../git/GitManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreV2,
} from "../../orchestration-v2/ProjectionStore.ts";
import * as ContextHandoffService from "../../orchestration-v2/ContextHandoffService.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import * as RunExecutionService from "../../orchestration-v2/RunExecutionService.ts";
import * as RuntimePolicy from "../../orchestration-v2/RuntimePolicy.ts";
import * as ProviderAuthService from "../../provider/ProviderAuthService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnStart from "../../orchestration-v2/ProviderTurnStartService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { CrewWorktrees, manualLayer } from "./CrewWorktrees.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";

const projectId = ProjectId.make("project:crew-worktrees");

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "crew-worktrees-" })),
  Layer.provideMerge(NodeServices.layer),
);

interface SeatThread {
  archivedAt: DateTime.Utc | null;
  branch: string | null;
}

/**
 * A real repository with a real default branch fetched from a real remote, real worktrees, and
 * the real git driver. Only what J5 reads from elsewhere is given: the threads, the other threads
 * bound to a path, the registered projects, the open terminals and provider sessions, and what
 * the host says about pull requests.
 */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* runJ5A2AMigrations();

  const root = yield* fs.makeTempDirectoryScoped({ prefix: "crew-worktrees-" });
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  // Two folders below the worktrees directory, where upstream's repair treats a path as managed.
  const worktreesDir = path.join(root, "worktrees");
  yield* fs.makeDirectory(path.join(worktreesDir, "repo"), { recursive: true });
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "crew-worktrees-test", cwd, args });
  yield* fs.makeDirectory(repo);
  yield* run(repo, ["init", "-b", "main"]);
  yield* run(repo, ["config", "user.email", "crew@example.test"]);
  yield* run(repo, ["config", "user.name", "Crew test"]);
  yield* fs.writeFileString(path.join(repo, "tracked.txt"), "original\n");
  yield* fs.writeFileString(path.join(repo, ".gitignore"), ".env\n");
  yield* run(repo, ["add", "."]);
  yield* run(repo, ["commit", "-m", "initial"]);
  yield* run(root, ["clone", "--bare", repo, origin]);
  yield* run(repo, ["remote", "add", "origin", origin]);
  yield* run(repo, ["fetch", "origin"]);
  yield* run(repo, ["remote", "set-head", "origin", "main"]);

  const threads = new Map<ThreadId, SeatThread>();
  let otherBoundPaths: Array<{ threadId: ThreadId; worktreePath: string }> = [];
  let sessionLive = true;
  let closeFails = false;
  const sessionCalls: Array<string> = [];
  let otherProjectRoots: Array<string> = [];
  let openTerminals: Array<Pick<TerminalSummary, "cwd" | "worktreePath" | "status">> = [];
  let pullRequest: unknown = null;
  let pullRequestFails = false;
  const pullRequestLookups: Array<string> = [];
  const invalidated: Array<string> = [];

  const layer = manualLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, sql),
        Layer.mock(ThreadManagementService)({
          getThreadRecords: ((threadId: ThreadId) => {
            const seat = threads.get(threadId);
            return seat === undefined
              ? Effect.die(`unknown thread ${threadId}`)
              : Effect.succeed({ thread: { id: threadId, projectId, ...seat } });
          }) as never,
        }),
        Layer.mock(ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: repo } as never),
          listShells: () =>
            Effect.succeed(
              [repo, ...otherProjectRoots].map((workspaceRoot) => ({ workspaceRoot }) as never),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: (listener) =>
            listener({
              type: "snapshot",
              terminals: openTerminals.map((terminal) => ({ ...terminal }) as TerminalSummary),
            }).pipe(Effect.as(() => {})),
        }),
        Layer.mock(ProjectionStoreV2)({
          getThreadWorktreePaths: () =>
            Effect.succeed([
              // Archived seats are not here: the store lists only unarchived threads.
              ...[...threads].flatMap(([threadId, seat]) =>
                seat.archivedAt === null && bound.has(threadId)
                  ? [{ threadId, worktreePath: bound.get(threadId)! }]
                  : [],
              ),
              ...otherBoundPaths,
            ]),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(sessionLive),
          // A detach alone leaves the session open, as it does for a session shared across threads.
          detach: ({ providerSessionId, threadId }) =>
            Effect.sync(() => void sessionCalls.push(`detach:${providerSessionId}:${threadId}`)),
          close: (providerSessionId) =>
            Effect.suspend(() => {
              sessionCalls.push(`close:${providerSessionId}`);
              if (closeFails) return Effect.die("the runtime would not stop");
              sessionLive = false;
              return Effect.void;
            }),
        }),
        // Only the daemon reads the event store, and this is the layer without it.
        Layer.mock(EventSinkV2)({}),
        Layer.succeed(GitVcsDriver.GitVcsDriver, git),
        Layer.mock(GitManager)({
          branchPullRequest: ({ branch }) => {
            pullRequestLookups.push(branch);
            return pullRequestFails
              ? Effect.die("the host is unreachable")
              : Effect.succeed(pullRequest as never);
          },
          invalidateStatus: (cwd) => Effect.sync(() => void invalidated.push(cwd)),
        }),
      ),
    ),
  );
  const bound = new Map<ThreadId, string>();
  const service = yield* Effect.service(CrewWorktrees).pipe(Effect.provide(layer));

  let eventSequence = 0;
  // The command upstream's launch gives the update when the seat's own preparation creates the worktree.
  const preparationCommand = CommandId.make("command:j5:crew-seat-prepare:run:one:workspace");
  const metadataUpdated = (
    threadId: ThreadId,
    branch: string | null,
    worktreePath: string,
    commandId: CommandId | null = preparationCommand,
  ) =>
    ({
      sequence: ++eventSequence,
      commandId,
      event: {
        id: EventId.make(`event:crew-worktrees:${eventSequence}`),
        threadId,
        type: "thread.metadata-updated",
        occurredAt: DateTime.makeUnsafe("2026-10-27T12:00:00.000Z"),
        payload: { id: threadId, projectId, branch, worktreePath },
      },
    }) as unknown as OrchestrationV2StoredEvent;

  /**
   * A seat on a new worktree as ThreadLaunch leaves it: the worktree on a branch, the thread
   * bound to it, and the record the metadata update writes. `record: false` is a worktree from
   * before the record existed.
   */
  const seat = Effect.fn("test.seat")(function* (
    name: string,
    options: {
      readonly record?: boolean;
      readonly workspace?: string;
      readonly archived?: boolean;
    } = {},
  ) {
    const threadId = ThreadId.make(`thread:crew-worktrees:${name}`);
    const worktree = path.join(worktreesDir, "repo", name);
    const branch = `j5/${name}`;
    yield* run(repo, ["worktree", "add", "-b", branch, worktree]);
    threads.set(threadId, {
      archivedAt:
        options.archived === false ? null : DateTime.makeUnsafe("2026-10-27T13:00:00.000Z"),
      branch,
    });
    bound.set(threadId, worktree);
    yield* sql`
      INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace)
      VALUES (${threadId}, '', ${options.workspace ?? '{"type":"worktree","baseRef":"main"}'})
    `;
    if (options.record !== false)
      yield* service.handleStoredEvent(metadataUpdated(threadId, branch, worktree));
    return { name, threadId, worktree, branch, seatName: name };
  });

  const setSession = (cwd: string | null, live = true) => {
    sessionLive = live;
    return sql`DELETE FROM orchestration_v2_projection_provider_sessions`.pipe(
      Effect.andThen(
        cwd === null
          ? Effect.void
          : sql`
              INSERT INTO orchestration_v2_projection_provider_sessions
                (provider_session_id, thread_id, provider, status, updated_at, payload_json)
              VALUES ('session:one', NULL, 'codex', 'ready', '2026-10-27T12:00:00.000Z', ${JSON.stringify(
                {
                  id: "session:one",
                  driver: "codex",
                  providerInstanceId: "codex",
                  status: "ready",
                  cwd,
                  model: null,
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: "2026-10-27T12:00:00.000Z",
                  updatedAt: "2026-10-27T12:00:00.000Z",
                  lastError: null,
                },
              )})
            `,
      ),
    );
  };

  return {
    fs,
    path,
    git,
    sql,
    repo,
    origin,
    root,
    worktreesDir,
    layer,
    service,
    run,
    seat,
    threads,
    metadataUpdated,
    invalidated,
    pullRequestLookups,
    bound,
    setProjectRoots: (roots: typeof otherProjectRoots) => (otherProjectRoots = roots),
    setTerminals: (terminals: typeof openTerminals) => (openTerminals = terminals),
    setOtherBoundPaths: (paths: typeof otherBoundPaths) => (otherBoundPaths = paths),
    sessionCalls,
    failClose: () => {
      closeFails = true;
    },
    /** A live session open in `cwd`, attached to each of these threads. */
    attachSession: Effect.fn("test.attachSession")(function* (
      cwd: string,
      threadIds: ReadonlyArray<ThreadId>,
    ) {
      yield* setSession(cwd);
      yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
      for (const threadId of threadIds)
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_session_bindings
            (provider_session_id, thread_id)
          VALUES ('session:one', ${threadId})
        `;
    }),
    /** What committing a thread's archive does to its binding. */
    detachBinding: (threadId: ThreadId) =>
      sql`
        DELETE FROM orchestration_v2_projection_provider_session_bindings
        WHERE thread_id = ${threadId}
      `,
    setSession,
    setPullRequest: (next: unknown) => {
      pullRequest = next;
    },
    failPullRequest: () => {
      pullRequestFails = true;
    },
  };
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | GitVcsDriver.GitVcsDriver
    | SqlClient.SqlClient
    | import("effect/Scope").Scope
  >,
) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(gitLayer, NodeSqliteClient.layer({ filename: ":memory:" }))),
    Effect.scoped,
  );

const cleanup = (
  f: Effect.Success<typeof fixture>,
  seats: ReadonlyArray<{ readonly seatName: string; readonly threadId: ThreadId }>,
) => f.service.cleanup({ seats });

it.effect(
  "removes a clean worktree whose work reached the default branch and keeps its branch",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const merged = yield* f.seat("merged");
        const result = yield* cleanup(f, [merged]);
        assert.deepStrictEqual(result, [
          { path: merged.worktree, branch: merged.branch, outcome: "removed", reason: null },
        ]);
        assert.isFalse(yield* f.fs.exists(merged.worktree));
        // The branch stays, and so does the row, so the seat can come back and be archived again.
        yield* f.run(f.repo, ["rev-parse", "--verify", `refs/heads/${merged.branch}`]);
        assert.lengthOf(yield* f.sql`SELECT * FROM j5_crew_worktree`, 1);
        assert.deepStrictEqual(f.invalidated, [f.repo]);
      }),
    ),
);

it.effect(
  "keeps a worktree with uncommitted changes, tracked or untracked, but not ignored ones",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const edited = yield* f.seat("edited");
        const untracked = yield* f.seat("untracked");
        const ignored = yield* f.seat("ignored");
        yield* f.fs.writeFileString(f.path.join(edited.worktree, "tracked.txt"), "edited\n");
        yield* f.fs.writeFileString(f.path.join(untracked.worktree, "new.txt"), "new\n");
        yield* f.fs.writeFileString(f.path.join(ignored.worktree, ".env"), "SECRET=1\n");
        const result = yield* cleanup(f, [edited, untracked, ignored]);
        assert.deepStrictEqual(
          result.map((entry) => [entry.outcome, entry.reason]),
          [
            ["kept", "uncommitted_changes"],
            ["kept", "uncommitted_changes"],
            ["removed", null],
          ],
        );
        assert.isTrue(yield* f.fs.exists(edited.worktree));
        assert.isTrue(yield* f.fs.exists(untracked.worktree));
        assert.isFalse(yield* f.fs.exists(ignored.worktree));
      }),
    ),
);

it.effect("keeps a worktree with committed work the default branch does not have", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const ahead = yield* f.seat("ahead");
      yield* f.fs.writeFileString(f.path.join(ahead.worktree, "tracked.txt"), "committed\n");
      yield* f.run(ahead.worktree, ["commit", "-am", "work"]);
      const result = yield* cleanup(f, [ahead]);
      assert.deepStrictEqual(
        result.map((entry) => [entry.outcome, entry.reason]),
        [["kept", "unmerged_commits"]],
      );
      assert.isTrue(yield* f.fs.exists(ahead.worktree));
    }),
  ),
);

it.effect(
  "removes a squash-merged worktree when a merged pull request names its exact commit",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const squashed = yield* f.seat("squashed");
        yield* f.fs.writeFileString(f.path.join(squashed.worktree, "tracked.txt"), "squashed\n");
        yield* f.run(squashed.worktree, ["commit", "-am", "work"]);
        // The seat renamed its branch after the worktree was created; the pull request is under
        // the name the thread has now.
        yield* f.run(squashed.worktree, ["branch", "-m", "j5/squashed", "feature/squashed"]);
        f.threads.get(squashed.threadId)!.branch = "feature/squashed";
        const head = (yield* f.run(squashed.worktree, ["rev-parse", "HEAD"])).stdout.trim();
        f.setPullRequest({
          state: "merged",
          headRef: "feature/squashed",
          baseRef: "main",
          headSha: head,
        });
        const result = yield* cleanup(f, [squashed]);
        assert.deepStrictEqual(result, [
          { path: squashed.worktree, branch: "feature/squashed", outcome: "removed", reason: null },
        ]);
        assert.deepStrictEqual(f.pullRequestLookups, ["feature/squashed"]);
        assert.isFalse(yield* f.fs.exists(squashed.worktree));
      }),
    ),
);

it.effect("keeps a worktree whose pull request merged a different commit", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const later = yield* f.seat("later");
      yield* f.fs.writeFileString(f.path.join(later.worktree, "tracked.txt"), "one\n");
      yield* f.run(later.worktree, ["commit", "-am", "merged part"]);
      const merged = (yield* f.run(later.worktree, ["rev-parse", "HEAD"])).stdout.trim();
      yield* f.fs.writeFileString(f.path.join(later.worktree, "tracked.txt"), "two\n");
      yield* f.run(later.worktree, ["commit", "-am", "after the merge"]);
      f.setPullRequest({
        state: "merged",
        headRef: later.branch,
        baseRef: "main",
        headSha: merged,
      });
      const result = yield* cleanup(f, [later]);
      assert.deepStrictEqual(
        result.map((entry) => [entry.outcome, entry.reason]),
        [["kept", "unmerged_commits"]],
      );
    }),
  ),
);

it.effect("keeps a worktree another unarchived thread is bound to", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const shared = yield* f.seat("shared");
      const alone = yield* f.seat("alone");
      f.setOtherBoundPaths([
        { threadId: ThreadId.make("thread:crew-worktrees:other"), worktreePath: shared.worktree },
      ]);
      const result = yield* cleanup(f, [shared, alone]);
      assert.deepStrictEqual(
        result.map((entry) => [entry.outcome, entry.reason]),
        [
          ["kept", "shared"],
          ["removed", null],
        ],
      );
      assert.isTrue(yield* f.fs.exists(shared.worktree));
    }),
  ),
);

it.effect("keeps a worktree a seat was unarchived into after the archive committed", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const archived = yield* f.seat("archived");
      const returned = yield* f.seat("returned", { archived: false });
      f.bound.set(returned.threadId, archived.worktree);
      const result = yield* cleanup(f, [archived, returned]);
      assert.deepStrictEqual(
        result.map((entry) => [entry.outcome, entry.reason]),
        [["kept", "shared"]],
      );
      assert.isTrue(yield* f.fs.exists(archived.worktree));
    }),
  ),
);

it.effect("keeps a worktree that is a project's root, or holds one", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const opened = yield* f.seat("opened");
      const holder = yield* f.seat("holder");
      const free = yield* f.seat("free");
      f.setProjectRoots([opened.worktree, f.path.join(holder.worktree, "packages", "app")]);
      const result = yield* cleanup(f, [opened, holder, free]);
      assert.deepStrictEqual(
        result.map((entry) => [entry.outcome, entry.reason]),
        [
          ["kept", "shared"],
          ["kept", "shared"],
          ["removed", null],
        ],
      );
      assert.isTrue(yield* f.fs.exists(opened.worktree));
      assert.isTrue(yield* f.fs.exists(holder.worktree));
      assert.isFalse(yield* f.fs.exists(free.worktree));
    }),
  ),
);

it.effect("keeps a worktree a terminal is open in, but not one that has exited", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const bound = yield* f.seat("bound-terminal");
      const nested = yield* f.seat("nested-terminal");
      const exited = yield* f.seat("exited-terminal");
      const elsewhere = yield* f.seat("elsewhere-terminal");
      f.setTerminals([
        { cwd: f.root, worktreePath: bound.worktree, status: "running" },
        { cwd: f.path.join(nested.worktree, "packages"), worktreePath: null, status: "starting" },
        { cwd: exited.worktree, worktreePath: exited.worktree, status: "exited" },
        { cwd: f.root, worktreePath: null, status: "running" },
      ]);
      const result = yield* cleanup(f, [bound, nested, exited, elsewhere]);
      assert.deepStrictEqual(
        result.map((entry) => [entry.outcome, entry.reason]),
        [
          ["kept", "in_use"],
          ["kept", "in_use"],
          ["removed", null],
          ["removed", null],
        ],
      );
    }),
  ),
);

it.effect(
  "closes a seat's session when the Crew archives, so its clean, merged worktree goes",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const working = yield* f.seat("working");
        const idle = yield* f.seat("idle-seat");
        yield* f.attachSession(working.worktree, [working.threadId]);
        // Read before the archive commits, which is what removes the binding naming it.
        assert.deepStrictEqual(yield* f.service.liveSessions([working, idle]), [
          { threadId: working.threadId, providerSessionId: ProviderSessionId.make("session:one") },
        ]);
        const sessions = yield* f.service.liveSessions([working, idle]);
        yield* f.detachBinding(working.threadId);
        yield* f.service.closeSessions(sessions);
        assert.deepStrictEqual(f.sessionCalls, [
          `detach:session:one:${working.threadId}`,
          "close:session:one",
        ]);
        assert.deepStrictEqual(
          (yield* cleanup(f, [working])).map((entry) => [entry.outcome, entry.reason]),
          [["removed", null]],
        );
        assert.isFalse(yield* f.fs.exists(working.worktree));
      }),
    ),
);

it.effect("lets a seat's session go but leaves one another thread is attached to open", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const archived = yield* f.seat("archived-seat");
      const other = ThreadId.make("thread:crew-worktrees:other-thread");
      yield* f.attachSession(archived.worktree, [archived.threadId, other]);
      const sessions = yield* f.service.liveSessions([archived]);
      yield* f.detachBinding(archived.threadId);
      yield* f.service.closeSessions(sessions);
      assert.deepStrictEqual(f.sessionCalls, [`detach:session:one:${archived.threadId}`]);
      assert.deepStrictEqual(
        (yield* cleanup(f, [archived])).map((entry) => [entry.outcome, entry.reason]),
        [["kept", "in_use"]],
      );
    }),
  ),
);

it.effect("a session that will not close keeps the worktree as in use and fails nothing", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const stuck = yield* f.seat("stuck");
      yield* f.attachSession(stuck.worktree, [stuck.threadId]);
      f.failClose();
      const sessions = yield* f.service.liveSessions([stuck]);
      yield* f.detachBinding(stuck.threadId);
      yield* f.service.closeSessions(sessions);
      assert.include(f.sessionCalls, "close:session:one");
      assert.deepStrictEqual(
        (yield* cleanup(f, [stuck])).map((entry) => [entry.outcome, entry.reason]),
        [["kept", "in_use"]],
      );
      assert.isTrue(yield* f.fs.exists(stuck.worktree));
    }),
  ),
);

it.effect("keeps a worktree a live provider session is open in, or in a folder of it", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const busy = yield* f.seat("busy");
      const nested = yield* f.seat("nested");
      const idle = yield* f.seat("idle");
      yield* f.setSession(busy.worktree);
      assert.deepStrictEqual(
        (yield* cleanup(f, [busy])).map((entry) => [entry.outcome, entry.reason]),
        [["kept", "in_use"]],
      );
      yield* f.fs.makeDirectory(f.path.join(nested.worktree, "packages"));
      yield* f.setSession(f.path.join(nested.worktree, "packages"));
      assert.deepStrictEqual(
        (yield* cleanup(f, [nested])).map((entry) => [entry.outcome, entry.reason]),
        [["kept", "in_use"]],
      );
      // A stored session whose runtime was released holds nothing.
      yield* f.setSession(idle.worktree, false);
      assert.deepStrictEqual(
        (yield* cleanup(f, [idle])).map((entry) => [entry.outcome, entry.reason]),
        [["removed", null]],
      );
      assert.isTrue(yield* f.fs.exists(busy.worktree));
    }),
  ),
);

it.effect("never removes a worktree from before the record existed", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const old = yield* f.seat("old", { record: false });
      assert.deepStrictEqual(yield* cleanup(f, [old]), []);
      assert.isTrue(yield* f.fs.exists(old.worktree));
    }),
  ),
);

it.effect("reports a removal git refuses, and leaves the worktree as it was", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const locked = yield* f.seat("locked");
      yield* f.run(f.repo, ["worktree", "lock", locked.worktree]);
      const result = yield* cleanup(f, [locked]);
      assert.deepStrictEqual(result, [
        { path: locked.worktree, branch: locked.branch, outcome: "failed", reason: "failed" },
      ]);
      assert.isTrue(yield* f.fs.exists(locked.worktree));
    }),
  ),
);

it.effect("keeps a worktree it could not check as unverified", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const unreachable = yield* f.seat("unreachable");
      const ahead = yield* f.seat("ahead");
      yield* f.fs.writeFileString(f.path.join(ahead.worktree, "tracked.txt"), "committed\n");
      yield* f.run(ahead.worktree, ["commit", "-am", "work"]);
      // The default branch cannot be fetched.
      yield* f.run(f.repo, ["remote", "set-url", "origin", f.path.join(f.root, "gone.git")]);
      assert.deepStrictEqual(
        (yield* cleanup(f, [unreachable])).map((entry) => [entry.outcome, entry.reason]),
        [["kept", "unverified"]],
      );
      // The host cannot say whether the pull request merged.
      yield* f.run(f.repo, ["remote", "set-url", "origin", f.origin]);
      f.failPullRequest();
      assert.deepStrictEqual(
        (yield* cleanup(f, [ahead])).map((entry) => [entry.outcome, entry.reason]),
        [["kept", "unverified"]],
      );
      assert.isTrue(yield* f.fs.exists(unreachable.worktree));
    }),
  ),
);

it.effect("leaves a seat whose thread is not archived alone", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const live = yield* f.seat("live", { archived: false });
      assert.deepStrictEqual(yield* cleanup(f, [live]), []);
      assert.isTrue(yield* f.fs.exists(live.worktree));
    }),
  ),
);

it.effect("estimates what the archive would do without changing anything", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const clean = yield* f.seat("clean", { archived: false });
      const dirty = yield* f.seat("dirty", { archived: false });
      yield* f.fs.writeFileString(f.path.join(dirty.worktree, "tracked.txt"), "edited\n");
      // Both seats are bound to their own worktree and are the Crew's own, so neither is shared.
      const estimate = yield* f.service.estimate({
        crews: [{ crewInstanceId: "crew:one", seats: [clean, dirty] }],
      });
      assert.deepStrictEqual(
        estimate.map((entry) => [entry.seat, entry.verdict, entry.reason, entry.crewInstanceId]),
        [
          ["clean", "remove", null, "crew:one"],
          ["dirty", "keep", "uncommitted_changes", "crew:one"],
        ],
      );
      assert.isTrue(yield* f.fs.exists(clean.worktree));
      assert.deepStrictEqual(f.invalidated, []);
    }),
  ),
);

it.effect("estimates the same keeps the removal would make for a project root or a terminal", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const opened = yield* f.seat("opened", { archived: false });
      const typing = yield* f.seat("typing", { archived: false });
      f.setProjectRoots([opened.worktree]);
      f.setTerminals([{ cwd: typing.worktree, worktreePath: null, status: "running" }]);
      const estimate = yield* f.service.estimate({
        crews: [{ crewInstanceId: "crew:one", seats: [opened, typing] }],
      });
      assert.deepStrictEqual(
        estimate.map((entry) => [entry.seat, entry.verdict, entry.reason]),
        [
          ["opened", "keep", "shared"],
          ["typing", "keep", "in_use"],
        ],
      );
    }),
  ),
);

it.effect("records only the first worktree path of a seat on a new worktree", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.seat("first");
      const sharedSeat = yield* f.seat("shared-seat", {
        record: false,
        workspace: '{"type":"shared"}',
      });
      const existingSeat = yield* f.seat("existing-seat", {
        record: false,
        workspace: '{"type":"existing_worktree","worktreePath":"/somewhere"}',
      });
      const unrelated = ThreadId.make("thread:crew-worktrees:not-a-seat");
      f.threads.set(unrelated, { archivedAt: null, branch: "main" });
      assert.isFalse(
        yield* f.service.handleStoredEvent(f.metadataUpdated(sharedSeat.threadId, "main", f.repo)),
      );
      assert.isFalse(
        yield* f.service.handleStoredEvent(
          f.metadataUpdated(existingSeat.threadId, "x", "/somewhere"),
        ),
      );
      assert.isFalse(
        yield* f.service.handleStoredEvent(f.metadataUpdated(unrelated, "main", f.repo)),
      );
      // A rename or a re-pointing later does not move the record off the checkout J5 created.
      assert.isFalse(
        yield* f.service.handleStoredEvent(
          f.metadataUpdated(first.threadId, "renamed", "/elsewhere"),
        ),
      );
      assert.deepStrictEqual(
        (yield* f.sql<{ readonly thread_id: string; readonly path: string }>`
          SELECT thread_id, path FROM j5_crew_worktree
        `).map((row) => [row.thread_id, row.path]),
        [[first.threadId, first.worktree]],
      );
    }),
  ),
);

it.effect("does not record a worktree a handoff or a metadata update bound to a waiting seat", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const waiting = yield* f.seat("waiting", { record: false });
      const existing = f.path.join(f.worktreesDir, "repo", "someone-elses");
      // Before its first assignment the seat is pointed at a worktree that already existed.
      assert.isFalse(
        yield* f.service.handleStoredEvent(
          f.metadataUpdated(
            waiting.threadId,
            "someone-elses",
            existing,
            CommandId.make("command:handoff:waiting"),
          ),
        ),
      );
      assert.isFalse(
        yield* f.service.handleStoredEvent(
          f.metadataUpdated(waiting.threadId, null, existing, null),
        ),
      );
      assert.lengthOf(yield* f.sql`SELECT * FROM j5_crew_worktree`, 0);
      // The preparation's own update, arriving afterwards, is still recorded.
      assert.isTrue(
        yield* f.service.handleStoredEvent(
          f.metadataUpdated(waiting.threadId, waiting.branch, waiting.worktree),
        ),
      );
      assert.deepStrictEqual(
        (yield* f.sql<{ readonly path: string }>`SELECT path FROM j5_crew_worktree`).map(
          (row) => row.path,
        ),
        [waiting.worktree],
      );
    }),
  ),
);

it.effect(
  "lets the thread's next turn recreate a worktree archiving removed, from its kept branch",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const returning = yield* f.seat("returning");
        const [removed] = yield* cleanup(f, [returning]);
        assert.equal(removed?.outcome, "removed");
        assert.isFalse(yield* f.fs.exists(returning.worktree));

        // Unarchived or forked, the thread still names the same branch and path; its next turn
        // starts through upstream's own repair, which J5 does not touch. The turn stops right
        // after the repair, as upstream's own test for it does.
        const runId = RunId.make("run:crew-worktrees:returning");
        const rootNodeId = NodeId.make("node:crew-worktrees:returning");
        const attemptId = RunAttemptId.make("attempt:crew-worktrees:returning");
        const providerThreadId = ProviderThreadId.make("provider-thread:crew-worktrees:returning");
        const messageId = MessageId.make("message:crew-worktrees:returning");
        const scopeId = CheckpointScopeId.make("scope:crew-worktrees:returning");
        const projection = {
          thread: {
            id: returning.threadId,
            projectId,
            branch: returning.branch,
            worktreePath: returning.worktree,
          },
          runs: [
            {
              id: runId,
              status: "starting",
              rootNodeId,
              activeAttemptId: attemptId,
              providerThreadId,
              userMessageId: messageId,
              ordinal: 2,
            },
          ],
          nodes: [{ id: rootNodeId, checkpointScopeId: scopeId }],
          attempts: [{ id: attemptId }],
          providerThreads: [
            {
              id: providerThreadId,
              providerSessionId: ProviderSessionId.make("session:crew-worktrees:returning"),
            },
          ],
          messages: [{ id: messageId, text: "Continue", attachments: [], role: "user" }],
          checkpointScopes: [{ id: scopeId }],
          contextHandoffs: [],
          contextTransfers: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const startLayer = ProviderTurnStart.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
              Layer.mock(EventSink.EventSinkV2)({}),
              IdAllocator.layer,
              Layer.succeed(Path.Path, f.path),
              Layer.succeed(FileSystem.FileSystem, f.fs),
              Layer.mock(GitWorkflowService)({
                pruneWorktrees: (input) => f.git.pruneWorktrees(input),
                listLocalBranchNames: (cwd) => f.git.listLocalBranchNames(cwd),
                createWorktree: (input) => f.git.createWorktree(input),
              }),
              Layer.mock(ProjectService)({
                getById: () => Effect.succeedSome({ workspaceRoot: f.repo } as never),
              }),
              Layer.mock(ProjectionStoreV2)({
                getThreadRecords: () => Effect.succeed(projection),
                getTurnStartContext: () =>
                  Effect.succeed({ ...projection, hasConversation: true } as never),
                getRuntimeRecoveryProjection: () =>
                  Effect.fail(
                    new ProjectionStoreReadError({
                      threadId: returning.threadId,
                      cause: "stop after the repair",
                    }),
                  ),
              }),
              Layer.mock(ServerConfig.ServerConfig)({
                worktreesDir: f.worktreesDir,
              } as ServerConfig.ServerConfig["Service"]),
              ServerSettings.layerTest(),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
              Layer.mock(ProviderAuthService.ProviderAuthService)({
                tryHandlePromptCommand: () => Effect.succeed(false),
              }),
              Layer.mock(RunExecutionService.RunExecutionServiceV2)({}),
              Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
            ),
          ),
        );
        const stopped = yield* Effect.gen(function* () {
          const starter = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
          return yield* starter.start({ threadId: returning.threadId, runId }).pipe(Effect.flip);
        }).pipe(Effect.provide(startLayer));
        assert.equal(stopped._tag, "ProviderTurnStartError");
        assert.isTrue(yield* f.fs.exists(returning.worktree));
        assert.equal(
          (yield* f.run(returning.worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(),
          returning.branch,
        );
      }),
    ),
);
