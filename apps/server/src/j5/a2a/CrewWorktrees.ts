import {
  OrchestrationV2ProviderSessionJson,
  ProjectId,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  CrewSeatWorkspace,
  CrewWorktreeCleanupEntry,
  type CrewArchiveWorktree,
  type CrewArchiveWorktreeEstimate,
  type CrewWorktreeCleanupItem,
  type CrewWorktreeReason,
} from "@t3tools/contracts/j5";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest and id; no Crypto service is wired into this layer.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
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
import type { SqlError } from "effect/sql/SqlError";

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
import { ReadChanges } from "./ReadChanges.ts";

const decodeSeatWorkspace = Schema.decodeUnknownOption(Schema.fromJsonString(CrewSeatWorkspace));

/** What the recheck compares a worktree against: its commit and its uncommitted work when the archive kept it. */
const StoredCleanupEntry = Schema.Struct({
  ...CrewWorktreeCleanupEntry.fields,
  headSha: Schema.String,
  statusDigest: Schema.String,
});
type StoredCleanupEntry = typeof StoredCleanupEntry.Type;
const StoredCleanupEntries = Schema.fromJsonString(Schema.Array(StoredCleanupEntry));
const decodeEntries = Schema.decodeUnknownEffect(StoredCleanupEntries);
const encodeEntries = Schema.encodeEffect(StoredCleanupEntries);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

class CrewWorktreeCleanupNotFoundError extends Data.TaggedError(
  "CrewWorktreeCleanupNotFoundError",
)<{ readonly itemId: string }> {
  override get message(): string {
    return `There is no worktree cleanup item ${this.itemId}.`;
  }
}

class CrewWorktreeCleanupAnsweredError extends Data.TaggedError(
  "CrewWorktreeCleanupAnsweredError",
)<{ readonly itemId: string }> {
  override get message(): string {
    return "This worktree cleanup was already answered.";
  }
}

class CrewWorktreeCleanupPathError extends Data.TaggedError("CrewWorktreeCleanupPathError")<{
  readonly path: string;
}> {
  override get message(): string {
    return `${this.path} is not one of this cleanup's worktrees.`;
  }
}

export type CrewWorktreeCleanupError =
  | CrewWorktreeCleanupNotFoundError
  | CrewWorktreeCleanupAnsweredError
  | CrewWorktreeCleanupPathError;
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
  /** Only a recheck against a stored baseline says this. */
  | { readonly kind: "changed" }
  | { readonly kind: "remove"; readonly headSha: string };

/** What a person's answer did with one worktree. */
type CleanupResult = Pick<StoredCleanupEntry, "outcome" | "reason" | "detail">;

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
    /**
     * Given, the worktrees kept for unfinished work (uncommitted changes, unmerged commits) are
     * also filed as one Inbox approval for this archive of the Crew, unless it already has one.
     */
    readonly crew?: {
      readonly crewInstanceId: string;
      /** The Crew's archive stamp: the same archive run again files nothing, a later one files its own. */
      readonly archivedAt: string;
      readonly crewName: string;
      readonly projectId: string;
      readonly captainThreadId: ThreadId;
    };
  }) => Effect.Effect<ReadonlyArray<CrewArchiveWorktree>>;
  /** The cleanup approvals, open or decided, newest first. */
  readonly listCleanups: (
    status: "open" | "decided",
  ) => Effect.Effect<ReadonlyArray<CrewWorktreeCleanupItem>, SqlError>;
  /**
   * The Crew came back (its Captain was unarchived): an open approval for its earlier archive no
   * longer has anything to decide, so it is dropped. An answered one stays as the record.
   */
  readonly withdrawCleanup: (crewInstanceId: string) => Effect.Effect<void>;
  /**
   * A person's answer: removes the listed worktrees of the item, keeps the rest, and records what
   * happened to each. Each is checked again first, against what the archive measured, and one
   * that changed is skipped. The first answer wins; the item keeps branches either way.
   */
  readonly answerCleanup: (input: {
    readonly itemId: string;
    readonly removePaths: ReadonlyArray<string>;
  }) => Effect.Effect<CrewWorktreeCleanupItem, CrewWorktreeCleanupError | SqlError>;
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
      const changes = yield* ReadChanges;
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
      const localChanges = (worktreePath: string) =>
        git.execute({
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

      const hasBlockingChanges = Effect.fnUntraced(function* (worktreePath: string) {
        const status = yield* localChanges(worktreePath);
        return status.stdoutTruncated || status.stdout.split("\0").some((record) => record !== "");
      });

      const digestOf = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

      /**
       * What the worktree holds uncommitted, by content, since status lists only names and codes:
       * the index tree is part of it so a changed staged blob shows. Cut-off status, a nested
       * repository, or an index with no tree (unmerged) cannot be compared, so it never matches
       * again and the worktree is kept.
       */
      const snapshotOf = Effect.fnUntraced(function* (worktreePath: string) {
        const status = yield* localChanges(worktreePath);
        const unmatched = () => `unverifiable:${NodeCrypto.randomUUID()}`;
        if (status.stdoutTruncated) return { status, digest: unmatched() };
        // A deleted file has no content to read; its status code already says so.
        const paths = status.stdout
          .split("\0")
          .filter((record) => /^[ MTADRCU?!]{2} /.test(record) && !record.slice(0, 2).includes("D"))
          .map((record) => record.slice(3));
        if (paths.some((changed) => changed.endsWith("/"))) return { status, digest: unmatched() };
        const [index, hashed] = yield* Effect.all([
          git.execute({
            operation: "CrewWorktrees.index",
            cwd: worktreePath,
            args: ["write-tree"],
            allowNonZeroExit: true,
          }),
          paths.length === 0
            ? Effect.succeed({ exitCode: 0, stdout: "", stdoutTruncated: false })
            : git.execute({
                operation: "CrewWorktrees.contents",
                cwd: worktreePath,
                args: ["hash-object", "--", ...paths],
                allowNonZeroExit: true,
              }),
        ]);
        return {
          status,
          digest:
            index.exitCode === 0 && hashed.exitCode === 0 && !hashed.stdoutTruncated
              ? digestOf(`${status.stdout}\n${hashed.stdout}\n${index.stdout}`)
              : unmatched(),
        };
      });

      /**
       * HEAD is on the branch the approval says removal keeps. A seat that detached or switched
       * branches and then committed has commits only the reflog would hold once the worktree goes.
       */
      const branchHoldsHead = Effect.fnUntraced(function* (
        worktreePath: string,
        branch: string | null,
      ) {
        if (branch === null) return false;
        const held = yield* git.execute({
          operation: "CrewWorktrees.branchHoldsHead",
          cwd: worktreePath,
          args: ["merge-base", "--is-ancestor", "HEAD", `refs/heads/${branch}`],
          allowNonZeroExit: true,
        });
        return held.exitCode === 0;
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
        /** Given, the worktree is approved for removal as it was measured: it may only be unchanged since. */
        readonly baseline?: Pick<StoredCleanupEntry, "headSha" | "statusDigest">;
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
        if (context.baseline !== undefined) {
          if (!(yield* branchHoldsHead(worktreePath, branch)))
            return { kind: "keep", reason: "unverified" } satisfies Verdict;
          const [head, snapshot] = yield* Effect.all([
            git.resolveCommit({ cwd: worktreePath, revision: "HEAD" }),
            snapshotOf(worktreePath),
          ]);
          return head.commitSha === context.baseline.headSha &&
            snapshot.digest === context.baseline.statusDigest
            ? ({ kind: "remove", headSha: head.commitSha } satisfies Verdict)
            : ({ kind: "changed" } satisfies Verdict);
        }
        // What is kept for unfinished work is offered for removal while its branch stays, so
        // work the branch does not hold is never offered.
        const unfinished = (reason: "uncommitted_changes" | "unmerged_commits") =>
          branchHoldsHead(worktreePath, branch).pipe(
            Effect.map((held): Verdict => ({ kind: "keep", reason: held ? reason : "unverified" })),
          );
        if (yield* hasBlockingChanges(worktreePath))
          return yield* unfinished("uncommitted_changes");
        const unmerged = context.checkMerged
          ? yield* mergeKeepReason({
              worktreePath,
              repositoryRoot,
              branch,
              refresh: context.refresh,
              fetched: context.fetched,
            })
          : null;
        if (unmerged === "unmerged_commits") return yield* unfinished(unmerged);
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
            // An approved worktree has the uncommitted changes the person agreed to discard.
            yield* git.removeWorktree({
              cwd: repositoryRoot,
              path: worktreePath,
              force: context.baseline !== undefined,
            });
            yield* gitManager.invalidateStatus(repositoryRoot);
            return first;
          }),
        );
      });

      interface UnfinishedWorktree {
        readonly threadId: ThreadId;
        readonly threadTitle: string;
        readonly path: string;
        readonly branch: string | null;
        readonly repositoryRoot: string;
      }

      /** Measured once, as the archive keeps the worktree; the recheck compares against the commit and status taken here. */
      const measure = Effect.fnUntraced(function* (worktree: UnfinishedWorktree) {
        const worktreePath = path.resolve(worktree.path);
        const [{ status, digest }, head] = yield* Effect.all([
          snapshotOf(worktreePath),
          git.resolveCommit({ cwd: worktreePath, revision: "HEAD" }),
        ]);
        const commitsAhead = yield* Effect.gen(function* () {
          const remote = yield* git.resolvePrimaryRemoteName(worktree.repositoryRoot);
          const defaultBranch = yield* git.resolveDefaultBranchName(
            worktree.repositoryRoot,
            remote,
          );
          if (defaultBranch === null) return null;
          const counted = yield* git.execute({
            operation: "CrewWorktrees.commitsAhead",
            cwd: worktreePath,
            args: ["rev-list", "--count", `refs/remotes/${remote}/${defaultBranch}..HEAD`],
          });
          return Number.parseInt(counted.stdout.trim(), 10);
        }).pipe(Effect.catchCause(() => Effect.succeed(null)));
        const pullRequestUrl =
          worktree.branch === null
            ? null
            : yield* gitManager
                .branchPullRequest({ cwd: worktreePath, branch: worktree.branch })
                .pipe(
                  Effect.map((pullRequest) => pullRequest?.url ?? null),
                  Effect.catchCause(() => Effect.succeed(null)),
                );
        return {
          threadId: worktree.threadId,
          threadTitle: worktree.threadTitle,
          path: worktree.path,
          branch: worktree.branch,
          uncommittedFiles: status.stdout
            .split("\0")
            .filter((record) => /^[ MTADRCU?!]{2} /.test(record)).length,
          commitsAhead: Number.isNaN(commitsAhead) ? null : commitsAhead,
          pullRequestUrl,
          outcome: null,
          reason: null,
          detail: null,
          headSha: head.commitSha,
          statusDigest: digest,
        } satisfies StoredCleanupEntry;
      });

      /** One approval per archive of a Crew, answered or not, so the same archive run again files nothing. */
      const fileCleanup = Effect.fnUntraced(function* (
        crew: NonNullable<Parameters<CrewWorktreesShape["cleanup"]>[0]["crew"]>,
        unfinished: ReadonlyArray<UnfinishedWorktree>,
      ) {
        const entries = yield* Effect.forEach(unfinished, measure);
        const filed = yield* sql<{ readonly id: string }>`
          INSERT INTO j5_crew_worktree_cleanup (
            id, crew_instance_id, crew_name, project_id, captain_thread_id, archived_at, filed_at,
            entries_json
          )
          VALUES (
            ${NodeCrypto.randomUUID()}, ${crew.crewInstanceId}, ${crew.crewName}, ${crew.projectId},
            ${crew.captainThreadId}, ${crew.archivedAt}, ${DateTime.formatIso(yield* DateTime.now)},
            ${yield* encodeEntries(entries)}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
        if (filed.length > 0) yield* changes.notify("inbox");
      });

      const withdrawCleanup: CrewWorktreesShape["withdrawCleanup"] = Effect.fn(
        "j5.a2a.crewWorktrees.withdrawCleanup",
      )(
        function* (crewInstanceId) {
          const withdrawn = yield* sql<{ readonly id: string }>`
            DELETE FROM j5_crew_worktree_cleanup
            WHERE crew_instance_id = ${crewInstanceId} AND decided_at IS NULL
            RETURNING id
          `;
          if (withdrawn.length > 0) yield* changes.notify("inbox");
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Crew worktree cleanup approval not withdrawn", { cause }),
        ),
      );

      const cleanup: CrewWorktreesShape["cleanup"] = Effect.fn("j5.a2a.crewWorktrees.cleanup")(
        function* ({ seats, crew }) {
          // No seat is exempt: a seat that was unarchived since the archive committed is bound to
          // its worktree again, and that is what must keep the worktree.
          const context: CheckContext = {
            own: new Set(),
            refresh: true,
            fetched: new Set(),
            checkMerged: true,
          };
          const results: Array<CrewArchiveWorktree> = [];
          const unfinished: Array<UnfinishedWorktree> = [];
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
            else if (done.kind === "keep") {
              results.push(outcome({ outcome: "kept", reason: done.reason }));
              // Shared, in use and unverified worktrees are not unfinished work: nothing to approve.
              if (done.reason === "uncommitted_changes" || done.reason === "unmerged_commits")
                unfinished.push({
                  threadId: seat.threadId,
                  threadTitle: thread.success.title,
                  path: record.path,
                  branch,
                  repositoryRoot,
                });
            } else if (done.kind === "remove") {
              yield* Effect.logInfo("J5 Crew worktree removed after archive", {
                threadId: seat.threadId,
              });
              results.push(outcome({ outcome: "removed", reason: null }));
            }
          }
          if (crew !== undefined && unfinished.length > 0)
            yield* fileCleanup(crew, unfinished).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 Crew worktree cleanup approval not filed", { cause }),
              ),
            );
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

      interface CleanupRow {
        readonly id: string;
        readonly crew_instance_id: string;
        readonly crew_name: string;
        readonly project_id: string;
        readonly captain_thread_id: string;
        readonly filed_at: string;
        readonly decided_at: string | null;
        readonly entries_json: string;
      }

      /** What a client sees: the entries without the baseline the recheck keeps to itself. */
      const projectCleanup = (
        row: CleanupRow,
        entries: ReadonlyArray<StoredCleanupEntry>,
      ): CrewWorktreeCleanupItem => ({
        id: row.id,
        crewInstanceId: row.crew_instance_id,
        crewName: row.crew_name,
        projectId: row.project_id,
        captainThreadId: ThreadId.make(row.captain_thread_id),
        filedAt: row.filed_at,
        status: row.decided_at === null ? "open" : "decided",
        decidedAt: row.decided_at,
        entries: entries.map(
          ({ headSha: _headSha, statusDigest: _statusDigest, ...entry }) => entry,
        ),
      });

      const listCleanups: CrewWorktreesShape["listCleanups"] = Effect.fn(
        "j5.a2a.crewWorktrees.listCleanups",
      )(function* (status) {
        const rows = yield* sql<CleanupRow>`
            SELECT * FROM j5_crew_worktree_cleanup
            WHERE (decided_at IS NULL) = (${status} = 'open')
            ORDER BY COALESCE(decided_at, filed_at) DESC
          `;
        return yield* Effect.forEach(rows, (row) =>
          decodeEntries(row.entries_json).pipe(
            Effect.map((entries) => projectCleanup(row, entries)),
            Effect.orDie,
          ),
        );
      });

      const skippedFor = (reason: KeepReason): CleanupResult => ({
        outcome: "skipped",
        reason: reason === "shared" || reason === "in_use" ? reason : "unverified",
        detail: null,
      });

      /** Checked again and removed under the same lease and re-read as the archive's own removal. */
      const removeApproved = Effect.fnUntraced(function* (
        projectId: string,
        entry: StoredCleanupEntry,
      ) {
        const repositoryRoot = yield* repositoryRootOf(ProjectId.make(projectId)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (repositoryRoot === null) return skippedFor("unverified");
        const done = yield* remove(
          { threadId: entry.threadId, path: entry.path, createdBranch: entry.branch },
          entry.branch,
          repositoryRoot,
          {
            own: new Set(),
            refresh: false,
            fetched: new Set(),
            checkMerged: false,
            baseline: entry,
          },
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Crew worktree removal failed", {
              threadId: entry.threadId,
              cause,
            }).pipe(
              Effect.as({
                kind: "failed" as const,
                detail: errorText(Cause.squash(cause)),
              }),
            ),
          ),
        );
        switch (done.kind) {
          case "failed":
            return {
              outcome: "failed",
              reason: null,
              detail: done.detail,
            } satisfies CleanupResult;
          case "remove":
            return { outcome: "removed", reason: null, detail: null } satisfies CleanupResult;
          case "gone":
            return { outcome: "skipped", reason: "gone", detail: null } satisfies CleanupResult;
          case "changed":
            return { outcome: "skipped", reason: "changed", detail: null } satisfies CleanupResult;
          case "keep":
            return skippedFor(done.reason);
        }
      });

      const answerCleanup: CrewWorktreesShape["answerCleanup"] = Effect.fn(
        "j5.a2a.crewWorktrees.answerCleanup",
      )(function* ({ itemId, removePaths }) {
        const [row] = yield* sql<CleanupRow>`
            SELECT * FROM j5_crew_worktree_cleanup WHERE id = ${itemId}
          `;
        if (row === undefined) return yield* new CrewWorktreeCleanupNotFoundError({ itemId });
        if (row.decided_at !== null) return yield* new CrewWorktreeCleanupAnsweredError({ itemId });
        const entries = yield* decodeEntries(row.entries_json).pipe(Effect.orDie);
        for (const removePath of removePaths)
          if (!entries.some((entry) => entry.path === removePath))
            return yield* new CrewWorktreeCleanupPathError({ path: removePath });
        // The claim comes before any removal, so a second answer meanwhile is refused.
        const decidedAt = DateTime.formatIso(yield* DateTime.now);
        const claimed = yield* sql<{ readonly id: string }>`
            UPDATE j5_crew_worktree_cleanup SET decided_at = ${decidedAt}
            WHERE id = ${itemId} AND decided_at IS NULL
            RETURNING id
          `;
        if (claimed.length === 0) return yield* new CrewWorktreeCleanupAnsweredError({ itemId });
        const approved = new Set(removePaths);
        const decided: Array<StoredCleanupEntry> = [];
        for (const entry of entries)
          decided.push({
            ...entry,
            ...(approved.has(entry.path)
              ? yield* removeApproved(row.project_id, entry)
              : ({ outcome: "kept", reason: null, detail: null } satisfies CleanupResult)),
          });
        yield* sql`
            UPDATE j5_crew_worktree_cleanup
            SET entries_json = ${yield* encodeEntries(decided).pipe(Effect.orDie)}
            WHERE id = ${itemId}
          `;
        yield* changes.notify("inbox");
        return projectCleanup({ ...row, decided_at: decidedAt }, decided);
      });

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
        withdrawCleanup,
        listCleanups,
        answerCleanup,
      });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
