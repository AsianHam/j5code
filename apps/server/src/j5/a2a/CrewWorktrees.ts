import {
  OrchestrationV2ProviderSessionJson,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type TerminalSummary,
  type ThreadId,
} from "@t3tools/contracts";
import {
  CrewSeatWorkspace,
  type CrewArchiveWorktree,
  type CrewArchiveWorktreeEstimate,
  type CrewWorktreeReason,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitManager from "../../git/GitManager.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { storageCleanupPullRequestMerged } from "../../storageCleanup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { isSeatWorktreeCreation } from "./CrewSeatPreparation.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";

const decodeSeatWorkspace = Schema.decodeUnknownOption(Schema.fromJsonString(CrewSeatWorkspace));
const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

/** A seat of a Crew being archived, with the thread whose worktree it may own. */
export interface CrewWorktreeSeat {
  readonly seatName: string;
  readonly threadId: ThreadId;
}

/** A provider session a seat's thread had attached, read before its archive removes the binding. */
export interface CrewSeatSession {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
}

type KeepReason = Exclude<CrewWorktreeReason, "failed">;

interface RecordedWorktree {
  readonly threadId: ThreadId;
  readonly path: string;
  /** The branch as the worktree was created; the thread's current branch is read when it counts. */
  readonly createdBranch: string | null;
}

/** What a check found at one worktree: gone, or a reason to keep it, or free to remove. */
type Verdict =
  | { readonly kind: "gone" }
  | { readonly kind: "keep"; readonly reason: KeepReason }
  | { readonly kind: "remove"; readonly headSha: string };

export interface CrewWorktreesShape {
  /**
   * Records the worktree ThreadLaunch creates for a Crew seat, when the event is the metadata
   * update its first-assignment preparation commits. Worktrees bound any other way, a retried
   * preparation's included, have no row and are never removed. Returns whether a row was written.
   */
  readonly handleStoredEvent: (event: OrchestrationV2StoredEvent) => Effect.Effect<boolean>;
  /**
   * The live provider sessions these seats' threads are attached to, read before the archive
   * commits because it removes the binding that names them. Never fails: unreadable sessions are
   * kept, and the cleanup reports the worktree as in use.
   */
  readonly liveSessions: (
    seats: ReadonlyArray<CrewWorktreeSeat>,
  ) => Effect.Effect<ReadonlyArray<CrewSeatSession>>;
  /**
   * Closes the sessions `liveSessions` found, after the archive commits and before the cleanup
   * looks for sessions, so the cleanup need not race the archive's own detach. A session another
   * thread still uses (Codex shares one) stays open. Never fails: a session that does not close
   * keeps its worktree as in use.
   */
  readonly closeSessions: (sessions: ReadonlyArray<CrewSeatSession>) => Effect.Effect<void>;
  /**
   * The cleanup after a Crew's archive commits: each recorded worktree of an archived seat is
   * removed when clean, merged, unshared and unused, and kept with its reason otherwise. Never
   * fails: one worktree's problem is its outcome, and unreadable records leave the pass empty.
   */
  readonly cleanup: (input: {
    readonly seats: ReadonlyArray<CrewWorktreeSeat>;
  }) => Effect.Effect<ReadonlyArray<CrewArchiveWorktree>>;
  /**
   * What cleanup would do to these Crews' worktrees if it ran now, for the pre-archive warning.
   * Changes nothing and fetches nothing, so it is only an estimate. Never fails.
   */
  readonly estimate: (input: {
    readonly crews: ReadonlyArray<{
      readonly crewInstanceId: string;
      readonly seats: ReadonlyArray<CrewWorktreeSeat>;
    }>;
  }) => Effect.Effect<ReadonlyArray<CrewArchiveWorktreeEstimate>>;
}

export class CrewWorktrees extends Context.Service<CrewWorktrees, CrewWorktreesShape>()(
  "t3/j5/a2a/CrewWorktrees",
) {}

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    CrewWorktrees,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ThreadManagementService;
      const projects = yield* ProjectService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const gitManager = yield* GitManager.GitManager;
      const terminals = yield* TerminalManager.TerminalManager;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const isWindows = yield* HostProcess.isWindows;

      const handleStoredEvent: CrewWorktreesShape["handleStoredEvent"] = Effect.fn(
        "j5.a2a.crewWorktrees.handleStoredEvent",
      )(
        function* (stored) {
          const event = stored.event;
          if (event.type !== "thread.metadata-updated" || event.payload.worktreePath === null)
            return false;
          // Only the worktree the seat's own first-assignment preparation creates. A seat can be
          // pointed at an existing worktree before then (a handoff, a metadata update), and that
          // one was never J5's to remove.
          if (!isSeatWorktreeCreation(stored.commandId)) return false;
          const [context] = yield* sql<{ readonly workspace: string }>`
            SELECT workspace FROM j5_crew_seat_context WHERE thread_id = ${event.threadId}
          `;
          if (context === undefined) return false;
          const workspace = decodeSeatWorkspace(context.workspace);
          if (Option.isNone(workspace) || workspace.value.type !== "worktree") return false;
          // The first path wins: a later update (a branch rename, a person re-pointing the
          // thread) must not move the record off the checkout J5 created.
          const inserted = yield* sql<{ readonly thread_id: string }>`
            INSERT INTO j5_crew_worktree (thread_id, project_id, path, branch, created_at)
            VALUES (
              ${event.threadId}, ${event.payload.projectId}, ${event.payload.worktreePath},
              ${event.payload.branch}, ${DateTime.formatIso(event.occurredAt)}
            )
            ON CONFLICT (thread_id) DO NOTHING
            RETURNING thread_id
          `;
          return inserted.length > 0;
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Crew worktree record skipped", { cause }).pipe(Effect.as(false)),
        ),
      );

      const liveSessions: CrewWorktreesShape["liveSessions"] = Effect.fn(
        "j5.a2a.crewWorktrees.liveSessions",
      )(
        function* (seats) {
          const found: Array<CrewSeatSession> = [];
          for (const seat of seats) {
            const rows = yield* sql<{ readonly provider_session_id: string }>`
              SELECT session.provider_session_id
              FROM orchestration_v2_projection_provider_session_bindings AS binding
              INNER JOIN orchestration_v2_projection_provider_sessions AS session
                ON session.provider_session_id = binding.provider_session_id
              WHERE binding.thread_id = ${seat.threadId}
                AND session.status NOT IN ('stopped', 'error')
            `;
            for (const row of rows)
              found.push({
                threadId: seat.threadId,
                providerSessionId: ProviderSessionId.make(row.provider_session_id),
              });
          }
          return found;
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Crew seat sessions could not be read", { cause }).pipe(
            Effect.as([] as ReadonlyArray<CrewSeatSession>),
          ),
        ),
      );

      const closeSessions: CrewWorktreesShape["closeSessions"] = Effect.fn(
        "j5.a2a.crewWorktrees.closeSessions",
      )(function* (sessions) {
        for (const { threadId, providerSessionId } of sessions) {
          yield* Effect.gen(function* () {
            // Revokes the thread's MCP credential, which the archive's own detach does too and,
            // finding the thread already detached, would then not.
            yield* providerSessions.detach({
              providerSessionId,
              threadId,
              detail: "Thread archived.",
              revokeMcpCredential: true,
            });
            const [others] = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_session_bindings
              WHERE provider_session_id = ${providerSessionId}
            `;
            if (others !== undefined && others.count > 0) return;
            yield* providerSessions.close(providerSessionId);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("J5 Crew seat session did not close", {
                threadId,
                providerSessionId,
                cause,
              }),
            ),
          );
        }
      });

      const readRecord = (threadId: ThreadId) =>
        sql<{
          readonly path: string;
          readonly branch: string | null;
        }>`SELECT path, branch FROM j5_crew_worktree WHERE thread_id = ${threadId}`.pipe(
          Effect.map((rows): RecordedWorktree | null =>
            rows[0] === undefined
              ? null
              : { threadId, path: rows[0].path, createdBranch: rows[0].branch },
          ),
        );

      /** Another unarchived thread bound to this path; `own` are seats about to be archived, which only the estimate has. */
      const sharedWithOthers = (worktreePath: string, own: ReadonlySet<ThreadId>) =>
        projections
          .getThreadWorktreePaths()
          .pipe(
            Effect.map((bound) =>
              bound.some(
                (entry) =>
                  path.resolve(entry.worktreePath) === worktreePath && !own.has(entry.threadId),
              ),
            ),
          );

      const pathKey = (target: string) => {
        const resolved = path.resolve(target);
        return isWindows ? resolved.toLowerCase() : resolved;
      };

      /**
       * Some project's root is this worktree or a folder of it. A project opened at a seat's
       * worktree has threads with no worktree path, so the thread bindings cannot see it. This is
       * storage cleanup's own guard, which keeps its helper private.
       */
      const containsProjectRoot = Effect.fnUntraced(function* (worktreePath: string) {
        const key = pathKey(worktreePath);
        const within = (target: string) => {
          const relative = path.relative(key, pathKey(target));
          return (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          );
        };
        for (const project of yield* projects.listShells()) {
          const root = path.resolve(project.workspaceRoot);
          if (within(root)) return true;
          const real = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
          if (within(real)) return true;
        }
        return false;
      });

      /**
       * A terminal still starting or running in the worktree or a folder of it. The terminal
       * manager has no list call, so this takes the snapshot a subscription opens with and lets go.
       */
      const terminalOpenIn = Effect.fnUntraced(function* (worktreePath: string) {
        let open: ReadonlyArray<TerminalSummary> = [];
        const unsubscribe = yield* terminals.subscribeMetadata((event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") open = event.terminals;
          }),
        );
        unsubscribe();
        return open.some((terminal) => {
          if (terminal.status !== "starting" && terminal.status !== "running") return false;
          const cwd = path.resolve(terminal.cwd);
          return (
            (terminal.worktreePath !== null &&
              path.resolve(terminal.worktreePath) === worktreePath) ||
            cwd === worktreePath ||
            cwd.startsWith(`${worktreePath}${path.sep}`)
          );
        });
      });

      /** A provider session still open in the worktree or a folder of it. */
      const sessionOpenIn = Effect.fnUntraced(function* (worktreePath: string) {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_provider_sessions
          WHERE status != 'stopped'
        `;
        for (const row of rows) {
          const session = yield* decodeSession(row.payload_json);
          const cwd = path.resolve(session.cwd);
          const inside = cwd === worktreePath || cwd.startsWith(`${worktreePath}${path.sep}`);
          // A stored session can stay ready after its runtime was released; only a live one holds it.
          if (inside && (yield* providerSessions.isLive(session.id))) return true;
        }
        return false;
      });

      /** Tracked changes, and untracked files git does not ignore. Ignored files never block. */
      const hasBlockingChanges = Effect.fnUntraced(function* (worktreePath: string) {
        const status = yield* git.execute({
          operation: "CrewWorktrees.localChanges",
          cwd: worktreePath,
          args: [
            "status",
            "--porcelain=v1",
            "-z",
            "--ignore-submodules=none",
            "--untracked-files=all",
          ],
          maxOutputBytes: 64 * 1024,
        });
        return status.stdoutTruncated || status.stdout.split("\0").some((record) => record !== "");
      });

      /**
       * Merged into the project's default branch as last fetched, or named by a merged pull
       * request as exactly this commit, which is how a squash or rebase merge shows.
       */
      const mergeKeepReason = Effect.fnUntraced(function* (input: {
        readonly worktreePath: string;
        readonly repositoryRoot: string;
        readonly branch: string | null;
        readonly refresh: boolean;
        readonly fetched: Set<string>;
      }) {
        const remote = yield* git.resolvePrimaryRemoteName(input.repositoryRoot);
        const defaultBranch = yield* git.resolveDefaultBranchName(input.repositoryRoot, remote);
        if (defaultBranch === null) return "unverified" as const;
        const fetchKey = `${input.repositoryRoot}\0${remote}\0${defaultBranch}`;
        if (input.refresh && !input.fetched.has(fetchKey)) {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.repositoryRoot,
            remoteName: remote,
            remoteBranch: defaultBranch,
          });
          input.fetched.add(fetchKey);
        }
        const head = yield* git.resolveCommit({ cwd: input.worktreePath, revision: "HEAD" });
        const base = yield* git.resolveCommit({
          cwd: input.worktreePath,
          revision: `refs/remotes/${remote}/${defaultBranch}`,
        });
        const ancestor = yield* git.execute({
          operation: "CrewWorktrees.integrated",
          cwd: input.worktreePath,
          args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
          allowNonZeroExit: true,
        });
        if (ancestor.exitCode === 0) return null;
        if (ancestor.exitCode !== 1) return "unverified" as const;
        if (input.branch === null) return "unmerged_commits" as const;
        const pullRequest = yield* gitManager.branchPullRequest(
          { cwd: input.worktreePath, branch: input.branch },
          { refresh: input.refresh },
        );
        return storageCleanupPullRequestMerged(pullRequest, {
          branch: input.branch,
          defaultBranch,
          headSha: head.commitSha,
          integrated: false,
        })
          ? null
          : ("unmerged_commits" as const);
      });

      interface CheckContext {
        readonly own: ReadonlySet<ThreadId>;
        readonly refresh: boolean;
        readonly fetched: Set<string>;
        /** False for the look right before a removal: the first look already decided it, and the commit is compared instead. */
        readonly checkMerged: boolean;
      }

      const threadFacts = (threadId: ThreadId) =>
        threads.getThreadRecords(threadId, []).pipe(
          Effect.map(({ thread }) => thread),
          Effect.result,
        );

      /** Everything that can keep a worktree, cheapest first. Throws nothing: a failed check keeps it. */
      const check = Effect.fnUntraced(function* (
        record: RecordedWorktree,
        branch: string | null,
        repositoryRoot: string,
        context: CheckContext,
      ) {
        const worktreePath = path.resolve(record.path);
        if (!(yield* fs.exists(worktreePath))) return { kind: "gone" } satisfies Verdict;
        // A linked worktree's `.git` is a file; a directory is a whole checkout, never ours to remove.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
          return { kind: "keep", reason: "unverified" } satisfies Verdict;
        if (
          (yield* sharedWithOthers(worktreePath, context.own)) ||
          (yield* containsProjectRoot(worktreePath))
        )
          return { kind: "keep", reason: "shared" } satisfies Verdict;
        if ((yield* sessionOpenIn(worktreePath)) || (yield* terminalOpenIn(worktreePath)))
          return { kind: "keep", reason: "in_use" } satisfies Verdict;
        if (yield* hasBlockingChanges(worktreePath))
          return { kind: "keep", reason: "uncommitted_changes" } satisfies Verdict;
        const unmerged = context.checkMerged
          ? yield* mergeKeepReason({
              worktreePath,
              repositoryRoot,
              branch,
              refresh: context.refresh,
              fetched: context.fetched,
            })
          : null;
        if (unmerged !== null) return { kind: "keep", reason: unmerged } satisfies Verdict;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        return { kind: "remove", headSha: head.commitSha } satisfies Verdict;
      });

      const verdictOf = (
        record: RecordedWorktree,
        branch: string | null,
        repositoryRoot: string,
        context: CheckContext,
      ) =>
        check(record, branch, repositoryRoot, context).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Crew worktree check could not finish", {
              threadId: record.threadId,
              cause,
            }).pipe(Effect.as({ kind: "keep", reason: "unverified" } satisfies Verdict)),
          ),
        );

      const repositoryRootOf = (projectId: Parameters<ProjectService["Service"]["getById"]>[0]) =>
        projects
          .getById(projectId)
          .pipe(
            Effect.map((project) => Option.getOrNull(Option.map(project, (p) => p.workspaceRoot))),
          );

      const remove = Effect.fnUntraced(function* (
        record: RecordedWorktree,
        branch: string | null,
        repositoryRoot: string,
        context: CheckContext,
      ) {
        const worktreePath = path.resolve(record.path);
        // Under the workspace lease storage cleanup and a thread's own repair use, and read
        // again right before the removal: a session, a second thread, an edit or a commit that
        // arrived since the first look cancels it.
        return yield* withWorkspaceLease(
          worktreePath,
          Effect.gen(function* () {
            const first = yield* verdictOf(record, branch, repositoryRoot, context);
            if (first.kind !== "remove") return first;
            const again = yield* verdictOf(record, branch, repositoryRoot, {
              ...context,
              refresh: false,
              checkMerged: false,
            });
            if (again.kind !== "remove" || again.headSha !== first.headSha)
              return again.kind === "remove"
                ? ({ kind: "keep", reason: "unverified" } satisfies Verdict)
                : again;
            yield* git.removeWorktree({ cwd: repositoryRoot, path: worktreePath });
            yield* gitManager.invalidateStatus(repositoryRoot);
            return first;
          }),
        );
      });

      const cleanup: CrewWorktreesShape["cleanup"] = Effect.fn("j5.a2a.crewWorktrees.cleanup")(
        function* ({ seats }) {
          // No seat is exempt: a seat that was unarchived since the archive committed is bound to
          // its worktree again, and that is what must keep the worktree.
          const context: CheckContext = {
            own: new Set(),
            refresh: true,
            fetched: new Set(),
            checkMerged: true,
          };
          const results: Array<CrewArchiveWorktree> = [];
          for (const seat of seats) {
            const record = yield* readRecord(seat.threadId);
            if (record === null) continue;
            const thread = yield* threadFacts(seat.threadId);
            // Only a thread that is archived has let go of its worktree.
            if (thread._tag === "Failure" || thread.success.archivedAt === null) continue;
            // The branch is read now: the seat may have renamed it since the worktree was created.
            const branch = thread.success.branch ?? record.createdBranch;
            const outcome = (
              result: Pick<CrewArchiveWorktree, "outcome" | "reason">,
            ): CrewArchiveWorktree => ({ path: record.path, branch, ...result });
            const repositoryRoot = yield* repositoryRootOf(thread.success.projectId).pipe(
              Effect.orElseSucceed(() => null),
            );
            if (repositoryRoot === null) {
              results.push(outcome({ outcome: "kept", reason: "unverified" }));
              continue;
            }
            const done = yield* remove(record, branch, repositoryRoot, context).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 Crew worktree removal failed", {
                  threadId: seat.threadId,
                  cause,
                }).pipe(Effect.as("failed" as const)),
              ),
            );
            if (done === "failed") results.push(outcome({ outcome: "failed", reason: "failed" }));
            else if (done.kind === "keep")
              results.push(outcome({ outcome: "kept", reason: done.reason }));
            else if (done.kind === "remove") {
              yield* Effect.logInfo("J5 Crew worktree removed after archive", {
                threadId: seat.threadId,
              });
              results.push(outcome({ outcome: "removed", reason: null }));
            }
          }
          return results;
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Crew worktree cleanup skipped", { cause }).pipe(
            Effect.as([] as ReadonlyArray<CrewArchiveWorktree>),
          ),
        ),
      );

      const estimate: CrewWorktreesShape["estimate"] = Effect.fn("j5.a2a.crewWorktrees.estimate")(
        function* ({ crews }) {
          const results: Array<CrewArchiveWorktreeEstimate> = [];
          for (const crew of crews) {
            const context: CheckContext = {
              own: new Set(crew.seats.map((seat) => seat.threadId)),
              refresh: false,
              fetched: new Set(),
              checkMerged: true,
            };
            for (const seat of crew.seats) {
              const record = yield* readRecord(seat.threadId);
              if (record === null) continue;
              const thread = yield* threadFacts(seat.threadId);
              if (thread._tag === "Failure") continue;
              const branch = thread.success.branch ?? record.createdBranch;
              const repositoryRoot = yield* repositoryRootOf(thread.success.projectId).pipe(
                Effect.orElseSucceed(() => null),
              );
              const verdict: Verdict =
                repositoryRoot === null
                  ? { kind: "keep", reason: "unverified" }
                  : yield* verdictOf(record, branch, repositoryRoot, context);
              if (verdict.kind === "gone") continue;
              results.push({
                crewInstanceId: crew.crewInstanceId,
                seat: seat.seatName,
                path: record.path,
                branch,
                verdict: verdict.kind === "remove" ? "remove" : "keep",
                reason: verdict.kind === "keep" ? verdict.reason : null,
              });
            }
          }
          return results;
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Crew worktree estimate skipped", { cause }).pipe(
            Effect.as([] as ReadonlyArray<CrewArchiveWorktreeEstimate>),
          ),
        ),
      );

      if (daemon) {
        // From the event store's current high-water mark: a launch that finished while the server
        // was down is simply not recorded, and a worktree with no row is never removed.
        const runDaemon = Effect.gen(function* () {
          let afterSequence = yield* readEventStoreHighWater("J5 Crew worktree recorder");
          return yield* Effect.forever(
            Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
              Stream.runForEach((event) =>
                handleStoredEvent(event).pipe(
                  Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 Crew worktree recorder stream failed; resuming", {
                  cause,
                }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
              ),
            ),
          );
        });
        yield* Effect.forkScoped(runDaemon);
      }

      return CrewWorktrees.of({
        handleStoredEvent,
        liveSessions,
        closeSessions,
        cleanup,
        estimate,
      });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
