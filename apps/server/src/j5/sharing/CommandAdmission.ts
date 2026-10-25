import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  OrchestrationV2DispatchCommandError,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectId,
  ScheduledTaskError,
  type ScheduledTaskMutationResult,
  type ScheduledTaskUpsertInput,
  type ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import { type PersonLevel, levelReaches } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { CrewSeatArchiveGuard } from "../a2a/crewSeatArchiveGuard.ts";
import { claimPersonQueuedEdit, releaseQueuedEditClaim } from "../a2a/queuedEdits.ts";
import {
  PersonAccess,
  type PersonAccessStorageError,
  type SessionIdentity,
  type SessionReach,
  isWide,
  reachPersonId,
} from "./PersonAccess.ts";
import { recordScheduler, storedPrompt } from "./scheduledRuns.ts";
import { SharedConversation } from "./SharedConversation.ts";

/**
 * What a person's client may send as a command or a thread launch (People and access AC13, AC14),
 * checked before upstream's handler runs. `ws.ts` wraps both requests with this one call (FORK.md
 * case 78). Once a command is admitted, a shared conversation takes it in: a person's message gains
 * its author's line (`SharedConversation`).
 *
 * For everyone who is not an Owner, archiving and deleting a thread is refused, for now: upstream
 * keeps unarchiving in Settings, which is for Owners. For a person whose scope is narrower than
 * the server, every command is checked against the scope its thread or project is in: a
 * Collaborator writes within their scope, starts a thread only in a project they reach, and forks
 * or merges back only within such a project. A Viewer sends nothing (AC13). A command type
 * without a row below is refused to a narrowed person, so one upstream adds later is closed to
 * them until it is listed here.
 *
 * A Crew seat is never archived or deleted alone (Crews AC16), checked here too.
 */

/** Where a command's target is: the thread it names, or the project of a thread it names. */
type CommandScope =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "projectOfThread"; readonly threadId: ThreadId };

type CommandOf<K extends OrchestrationV2Command["type"]> = Extract<
  OrchestrationV2Command,
  { readonly type: K }
>;

const onThread = (command: { readonly threadId: ThreadId }): CommandScope => ({
  kind: "thread",
  threadId: command.threadId,
});
const onParent = (command: { readonly parentThreadId: ThreadId }): CommandScope => ({
  kind: "thread",
  threadId: command.parentThreadId,
});

/**
 * Every command a narrowed Collaborator may send, by type, with where its target is. Keyed by
 * type so that a command upstream renames or removes fails to compile here.
 */
export const NARROWED_COMMAND_SCOPES: {
  readonly [K in OrchestrationV2Command["type"]]?: (command: CommandOf<K>) => CommandScope;
} = {
  // Starting a thread needs the project (AC14): a Collaborator on one thread starts none.
  "thread.create": (command) => ({ kind: "project", projectId: command.projectId }),
  // A fork is a thread of its own and outside the source thread's scope.
  "thread.fork": (command) => ({ kind: "projectOfThread", threadId: command.sourceThreadId }),
  "thread.merge_back": (command) => ({
    kind: "projectOfThread",
    threadId: command.sourceThreadId,
  }),
  "thread.settle": onThread,
  "thread.auto-settle": onThread,
  "thread.unsettle": onThread,
  "thread.snooze": onThread,
  "thread.unsnooze": onThread,
  "thread.auto-settle.set": onThread,
  "thread.pin": onThread,
  "thread.unpin": onThread,
  "thread.pin.reorder": onThread,
  "thread.active.reorder": onThread,
  "thread.visit": onThread,
  "thread.mark-unread": onThread,
  "thread.metadata.update": onThread,
  "thread.pull-request.link": onThread,
  "thread.pull-request.unlink": onThread,
  "thread.pull-request-link.sync": onThread,
  "thread.pull-request.watch": onThread,
  "thread.pull-request.sync": onThread,
  "thread.title.regeneration.complete": onThread,
  "thread.runtime-mode.set": onThread,
  "thread.interaction-mode.set": onThread,
  "thread.model-selection.set": onThread,
  "provider-session.detach": onThread,
  "provider.switch": onThread,
  "message.dispatch": onThread,
  "prepared-run.release": onThread,
  "prepared-run.progress": onThread,
  "prepared-run.fail": onThread,
  "prepared-run.retry": onThread,
  "notification.delivery.accept": onThread,
  "subagent.stop": onThread,
  "run.interrupt": onThread,
  "queued-message.promote-to-steer": onThread,
  "queue.resume": onThread,
  "queued-run.reorder": onThread,
  "queued-run.cancel": onThread,
  "queued-run.edit": onThread,
  "runtime-request.respond": onThread,
  "thread.user-input.dismiss": onThread,
  "checkpoint.rollback": onThread,
  "delegated_task.request": onParent,
  "delegated_task.wake-policy": onParent,
  "delegated_task.completion-delivery.acknowledge": onParent,
  "delegated_task.completion-delivery.dispose": onParent,
  "thread.created.record": onParent,
};

/** Commands only an Owner sends, for now (AC14). */
const OWNER_ONLY_COMMANDS: ReadonlySet<OrchestrationV2Command["type"]> = new Set([
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
]);

const refused = (message: string) =>
  new EnvironmentAuthorizationError({
    message,
    ...authScopeRequiredResponse(AuthOrchestrationOperateScope),
  });

const NOT_SHARED = "This is not shared with you on this server.";
const OWNERS_ONLY =
  "Only an Owner of this server archives or deletes a thread, for now. Ask an Owner to do it.";

export interface CommandAdmission {
  readonly admit: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<
    OrchestrationV2Command,
    EnvironmentAuthorizationError | OrchestrationV2DispatchCommandError
  >;
  /**
   * A person's command, admitted and then handed to upstream's `dispatch`. `ws.ts` wraps upstream's
   * dispatch with this (FORK.md case 78).
   */
  readonly dispatchCommand: <A, E, R>(
    command: OrchestrationV2Command,
    dispatch: (command: OrchestrationV2Command) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError | OrchestrationV2DispatchCommandError, R>;
  readonly admitLaunch: (
    input: OrchestrationV2ThreadLaunchInput,
  ) => Effect.Effect<OrchestrationV2ThreadLaunchInput, EnvironmentAuthorizationError>;
  /**
   * A person's save of a scheduled task, with who scheduled it recorded: whoever creates it, and
   * whoever changes its prompt (`scheduledRuns`). `ws.ts` wraps upstream's upsert with this
   * (FORK.md case 78).
   */
  readonly upsertScheduledTask: <E, R>(
    input: ScheduledTaskUpsertInput,
    upsert: (input: ScheduledTaskUpsertInput) => Effect.Effect<ScheduledTaskMutationResult, E, R>,
  ) => Effect.Effect<ScheduledTaskMutationResult, E | ScheduledTaskError, R>;
}

/**
 * Built once per socket, with whose the socket is read when it opens: a change to that renews the
 * session, which closes the socket (`Access`). A wide session's commands then cost nothing more;
 * a narrowed one's read the level at each command's scope.
 */
export const makeCommandAdmission = (
  crewSeatArchiveGuard: CrewSeatArchiveGuard,
  session: SessionIdentity,
): Effect.Effect<
  CommandAdmission,
  never,
  PersonAccess | SharedConversation | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const access = yield* PersonAccess;
    const conversation = yield* SharedConversation;
    const reach = yield* access.sessionReach(session).pipe(
      Effect.catch((cause) =>
        Effect.logError("J5 could not read whose a socket is; holding its commands to nothing", {
          cause,
        }).pipe(Effect.as({ kind: "unknown" } as SessionReach)),
      ),
    );
    const refuseUnreadable = (cause: PersonAccessStorageError) =>
      Effect.logError("J5 could not read what a person reaches; refusing their command", {
        cause,
      }).pipe(Effect.andThen(Effect.fail(refused("Could not read what is shared with you."))));

    /** The level the person holds at a command's target, or `null` when they reach none of it. */
    const levelAt = (personId: Parameters<typeof access.threadLevel>[0], scope: CommandScope) =>
      Effect.gen(function* () {
        switch (scope.kind) {
          case "thread":
            return yield* access.threadLevel(personId, scope.threadId);
          case "project":
            return yield* access.projectLevel(personId, scope.projectId);
          case "projectOfThread": {
            const projectId = yield* access.threadProject(scope.threadId);
            return projectId === null ? null : yield* access.projectLevel(personId, projectId);
          }
        }
      });

    const requireLevel = (
      scope: CommandScope,
      level: PersonLevel,
    ): Effect.Effect<void, EnvironmentAuthorizationError> =>
      Effect.gen(function* () {
        if (isWide(reach)) return;
        if (reach.kind !== "person") return yield* refused(NOT_SHARED);
        const held = yield* levelAt(reach.person.personId, scope);
        if (!levelReaches(held, level)) return yield* refused(NOT_SHARED);
      }).pipe(Effect.catchTags({ PersonAccessStorageError: refuseUnreadable }));

    const checked: CommandAdmission["admit"] = Effect.fn("j5.sharing.commandAdmission.checked")(
      function* (command) {
        if (OWNER_ONLY_COMMANDS.has(command.type)) {
          const owner =
            reach.kind === "service" ||
            (reach.kind === "person" && levelReaches(reach.serverLevel, "owner"));
          if (!owner) return yield* refused(OWNERS_ONLY);
          yield* crewSeatArchiveGuard(command).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2DispatchCommandError({
                  commandId: command.commandId,
                  commandType: command.type,
                  message: cause.message,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          return command;
        }
        if (isWide(reach)) return command;
        const scopeOf = NARROWED_COMMAND_SCOPES[command.type] as
          | ((command: OrchestrationV2Command) => CommandScope)
          | undefined;
        if (scopeOf === undefined) return yield* refused(NOT_SHARED);
        yield* requireLevel(scopeOf(command), "collaborator");
        return command;
      },
    );

    const person = reachPersonId(reach);
    const admit: CommandAdmission["admit"] = (command) =>
      checked(command).pipe(
        Effect.flatMap((admitted) => conversation.admit(person, admitted)),
        Effect.withSpan("j5.sharing.commandAdmission.admit"),
      );

    // A person's edit of a queued agent message is recorded in the ledger under their name
    // (`queuedEdits.ts`). A failure to claim it names no one and does not stop the edit.
    const claimEdit = (command: OrchestrationV2Command) =>
      person === null || command.type !== "queued-run.edit"
        ? Effect.succeed(false)
        : claimPersonQueuedEdit(command, person).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catch((cause) =>
              Effect.logError("J5 could not record who edited a queued message", { cause }).pipe(
                Effect.as(false),
              ),
            ),
          );
    const releaseEdit = (command: OrchestrationV2Command) =>
      releaseQueuedEditClaim(command.commandId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catch((cause) =>
          Effect.logError("J5 could not release a refused queued edit's claim", { cause }),
        ),
      );
    const dispatchCommand: CommandAdmission["dispatchCommand"] = (command, dispatch) =>
      Effect.gen(function* () {
        const admitted = yield* admit(command);
        const claimed = yield* claimEdit(admitted);
        return yield* dispatch(admitted).pipe(
          Effect.tapError(() => (claimed ? releaseEdit(admitted) : Effect.void)),
        );
      });

    const admitLaunch: CommandAdmission["admitLaunch"] = Effect.fn(
      "j5.sharing.commandAdmission.admitLaunch",
    )(function* (input) {
      // Launching into a thread that exists writes to it; otherwise it starts one in a project.
      const scope: CommandScope =
        input.reuseExistingThread === true && input.threadId !== undefined
          ? { kind: "thread", threadId: input.threadId }
          : { kind: "project", projectId: input.projectId };
      yield* requireLevel(scope, "collaborator");
      return yield* conversation.admitLaunch(person, input);
    });

    const upsertScheduledTask: CommandAdmission["upsertScheduledTask"] = (input, upsert) => {
      if (person === null) return upsert(input);
      // The task the save addresses, as upstream's service resolves it; a new one has no prompt.
      const taskId =
        input.id ??
        (input.commandId === undefined ? undefined : `scheduled-task:${input.commandId}`);
      // Recorded after upstream saves, so a failure to record is told to the person: the task is
      // saved, and its runs name no one until its prompt is saved again.
      const notRecorded = (cause: unknown) =>
        Effect.logError("J5 could not record who scheduled a task", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new ScheduledTaskError({
                message:
                  "The task was saved, but who scheduled it could not be recorded. Save it again.",
              }),
            ),
          ),
        );
      return Effect.gen(function* () {
        const before =
          taskId === undefined
            ? null
            : yield* storedPrompt(taskId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.catch(notRecorded),
              );
        const saved = yield* upsert(input);
        yield* recordScheduler(person, saved.task, before).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch(notRecorded),
        );
        return saved;
      });
    };

    return { admit, dispatchCommand, admitLaunch, upsertScheduledTask };
  });
