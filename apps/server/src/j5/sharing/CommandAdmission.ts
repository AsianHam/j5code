import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  OrchestrationV2DispatchCommandError,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectId,
  type ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import { type PersonLevel, levelReaches } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import type { CrewSeatArchiveGuard } from "../a2a/crewSeatArchiveGuard.ts";
import {
  PersonAccess,
  type PersonAccessStorageError,
  type SessionIdentity,
  type SessionReach,
  isWide,
  reachPersonId,
} from "./PersonAccess.ts";
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
  readonly admitLaunch: (
    input: OrchestrationV2ThreadLaunchInput,
  ) => Effect.Effect<OrchestrationV2ThreadLaunchInput, EnvironmentAuthorizationError>;
}

/**
 * Built once per socket, with whose the socket is read when it opens: a change to that renews the
 * session, which closes the socket (`Access`). A wide session's commands then cost nothing more;
 * a narrowed one's read the level at each command's scope.
 */
export const makeCommandAdmission = (
  crewSeatArchiveGuard: CrewSeatArchiveGuard,
  session: SessionIdentity,
): Effect.Effect<CommandAdmission, never, PersonAccess | SharedConversation> =>
  Effect.gen(function* () {
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

    return { admit, admitLaunch };
  });
