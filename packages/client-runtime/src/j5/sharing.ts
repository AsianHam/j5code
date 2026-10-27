import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  type ConnectionAccess,
  J5_ACCESS_WS_METHODS,
  type PersonLevel,
  higherLevel,
  highestLevel,
  levelReaches,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

/**
 * What one connection is on its server; it only shapes what a client shows, since the server
 * checks every request. `null` means no answer yet, or a server from before people: nothing is
 * withheld then, so a composer does not flicker to read-only, and upstream's permissions decide.
 */
export type KnownConnectionAccess = ConnectionAccess | null;

/** The level the person holds at server scope, if any. */
export const serverLevelOf = (access: KnownConnectionAccess): PersonLevel | null =>
  access?.kind === "person"
    ? highestLevel(
        access.levels.flatMap((held) => (held.scope.kind === "server" ? [held.level] : [])),
      )
    : null;

/**
 * Whether the connection reaches the whole server: a person with a level at server scope, or a
 * session that is no person's. Someone who does not is shown only what their levels cover, and
 * none of the server's own pages (People and access AC23, AC25).
 */
export const reachesServer = (access: KnownConnectionAccess): boolean =>
  access === null || access.kind === "service" || serverLevelOf(access) !== null;

/** Whether the connection's person owns the server. A server that cannot say is treated as upstream's. */
export const isOwnerAccess = (access: KnownConnectionAccess): boolean =>
  access === null || access.kind === "service" || (access.kind === "person" && access.owner);

/**
 * The level a connection holds over one thread. A person who writes to the whole server holds
 * their server level everywhere, so only someone else's level is asked of the server, which works
 * out what covers the thread: the thread itself, a thread above it, its project or the server.
 */
export const threadLevelFor = (
  access: KnownConnectionAccess,
  streamed: PersonLevel | null,
): PersonLevel | null => {
  if (access === null) return null;
  if (access.kind === "service") return "owner";
  if (access.kind === "unknown") return null;
  return access.wide ? serverLevelOf(access) : streamed;
};

/**
 * The level a connection holds over a project, from the project itself or the server. Every
 * thread in the project is held at least at this level, a thread being started there included,
 * which the server does not know yet. A level on one of the project's threads does not reach the
 * project.
 */
export const projectLevelFor = (
  access: KnownConnectionAccess,
  projectId: string,
): PersonLevel | null => {
  if (access === null) return null;
  if (access.kind === "service") return "owner";
  if (access.kind === "unknown") return null;
  return highestLevel(
    access.levels.flatMap((held) =>
      held.scope.kind === "server" ||
      (held.scope.kind === "project" && held.scope.projectId === projectId)
        ? [held.level]
        : [],
    ),
  );
};

/**
 * The level a connection holds over a thread in a project: the thread's own, as the server last
 * sent it, and never less than the project's. The server's answer for a thread is sent again only
 * when people or levels change, so one given for a draft's id, before its thread existed, would
 * otherwise hold the thread back once it does.
 */
export const threadLevelInProject = (input: {
  readonly access: KnownConnectionAccess;
  readonly threadLevel: PersonLevel | null;
  readonly projectId: string | null;
}): PersonLevel | null =>
  higherLevel(
    input.threadLevel,
    input.projectId === null ? null : projectLevelFor(input.access, input.projectId),
  );

/** Whether the level a connection holds over a thread lets it write there; see `KnownConnectionAccess`. */
export const sharingAllowsOperate = (input: {
  readonly access: KnownConnectionAccess;
  readonly level: PersonLevel | null;
}): boolean => input.access === null || levelReaches(input.level, "collaborator");

/**
 * Whether a connection may start something new on its server: a thread, or a fork, in a project,
 * which the project's level decides (People and access AC14), or, given no project, a project of
 * its own, which only a level at server scope reaches (AC19). A level on one thread starts nothing.
 */
export const sharingAllowsStart = (
  access: KnownConnectionAccess,
  projectId: string | null,
): boolean =>
  sharingAllowsOperate({
    access,
    level:
      projectId !== null
        ? projectLevelFor(access, projectId)
        : access?.kind === "service"
          ? "owner"
          : serverLevelOf(access),
  });

const asksThreadLevel = (access: KnownConnectionAccess) =>
  access?.kind === "person" && !access.wide;

// The connection's latest answer, kept per socket so a request can be held back on what it says
// without waiting for it. A level that changes without a new session, such as a scope added,
// updates it each time the query below is read again.
interface ConnectionAccessAnswer {
  access: KnownConnectionAccess;
  readonly ask: Effect.Effect<KnownConnectionAccess>;
}
const answers = new WeakMap<RpcSession, ConnectionAccessAnswer>();

const askConnectionAccess = (answer: { access: KnownConnectionAccess }) =>
  request(J5_ACCESS_WS_METHODS.getConnectionAccess, {}).pipe(
    Effect.tap((access) =>
      Effect.sync(() => {
        answer.access = access;
      }),
    ),
  );

const connectionAccessAnswer = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return null;
  const known = answers.get(session.value);
  if (known !== undefined) return known;
  const answer: ConnectionAccessAnswer = {
    access: null,
    ask: yield* Effect.cached(
      Effect.suspend(() => askConnectionAccess(answer)).pipe(
        // A server that cannot answer is held to nothing here; upstream's permissions decide.
        Effect.catchCause(() => Effect.succeed(null)),
        Effect.provideService(EnvironmentSupervisor, supervisor),
      ),
    ),
  };
  answers.set(session.value, answer);
  return answer;
});

/**
 * What the server says of the environment's connection, asked again each time: a scope can be
 * added without the connection changing. The answer is kept for `connectionIsKnownNarrow`.
 */
const readConnectionAccess = Effect.gen(function* () {
  const answer = yield* connectionAccessAnswer;
  if (answer === null) return null;
  return yield* askConnectionAccess(answer);
});

/**
 * Whether the connection is already known to reach less than the whole server. It never waits:
 * the question is asked in the background the first time, and until it is answered the
 * connection's first requests go out and the server refuses what is not its to read.
 */
export const connectionIsKnownNarrow = Effect.gen(function* () {
  const answer = yield* connectionAccessAnswer;
  if (answer === null) return false;
  if (answer.access === null) yield* Effect.forkDetach(answer.ask);
  return !reachesServer(answer.access);
});

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId | null) =>
  JSON.stringify([environmentId, threadId]);

/**
 * Environment-scoped atoms for what this connection is on each server; web and mobile each build
 * one. `rereadOn` is the server's signal that people or levels changed, so a scope added while
 * the connection stays open is shown; without it the answer is read once per connection.
 */
export function createSharingEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly rereadOn?: (target: {
      readonly environmentId: EnvironmentId;
    }) => Atom.Atom<unknown> | undefined;
  } = {},
) {
  const connectionAccessQuery = createEnvironmentQueryAtomFamily(runtime, {
    label: "j5:access:connection",
    staleTimeMs: options.rereadOn === undefined ? Number.MAX_SAFE_INTEGER : 0,
    execute: (_input: Record<string, never>) => readConnectionAccess,
    ...(options.rereadOn === undefined ? {} : { refreshTrigger: options.rereadOn }),
  });
  // Opened only for a person who does not write to the whole server; the server sends the level
  // again whenever it changes.
  const threadLevelStream = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "j5:access:thread-level",
    tag: J5_ACCESS_WS_METHODS.subscribeThreadLevel,
  });

  /** `null` until the server has answered for this connection. */
  const connectionAccess = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): KnownConnectionAccess =>
      Option.getOrNull(AsyncResult.value(get(connectionAccessQuery({ environmentId, input: {} })))),
    ).pipe(Atom.withLabel(`j5:access:connection-value:${environmentId}`)),
  );

  const threadLevel = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId | null];
    return Atom.make((get): PersonLevel | null => {
      const access = get(connectionAccess(environmentId));
      // A view with no thread on the server, such as a draft, is covered by nothing narrower.
      const streamed =
        threadId === null || !asksThreadLevel(access)
          ? null
          : (Option.getOrNull(
              AsyncResult.value(get(threadLevelStream({ environmentId, input: { threadId } }))),
            )?.level ?? null);
      return threadLevelFor(access, streamed);
    }).pipe(Atom.withLabel(`j5:access:thread-level:${key}`));
  });

  const threadOperable = Atom.family((key: string) => {
    const [environmentId] = JSON.parse(key) as [EnvironmentId, ThreadId | null];
    return Atom.make((get) =>
      sharingAllowsOperate({
        access: get(connectionAccess(environmentId)),
        level: get(threadLevel(key)),
      }),
    ).pipe(Atom.withLabel(`j5:access:thread-operable:${key}`));
  });

  /**
   * Whether the connection is known to reach less than the whole server; false until the server
   * has said. Mobile's screens still call such a person a guest.
   */
  const isNarrow = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => !reachesServer(get(connectionAccess(environmentId)))).pipe(
      Atom.withLabel(`j5:access:narrow:${environmentId}`),
    ),
  );

  return {
    connectionAccessQuery,
    connectionAccess,
    isNarrow,
    /** Reads the connection's access again, after this client changed it (claim, leave, rename). */
    refreshConnectionAccess: (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
      registry.refresh(connectionAccessQuery({ environmentId, input: {} })),
    /**
     * The same answer for code that is not rendering, such as a menu built when it is opened.
     * `permitted` is upstream's own server-wide answer. It reads what the thread's view already
     * holds, and asks nothing.
     */
    readCanOperateThread: (
      registry: AtomRegistry.AtomRegistry,
      input: {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId | null;
        readonly permitted: boolean;
      },
    ): boolean =>
      input.permitted &&
      registry.get(threadOperable(threadKey(input.environmentId, input.threadId))),
    /** The level the connection holds over a thread; `null` for none or not yet known. */
    threadLevel: (environmentId: EnvironmentId, threadId: ThreadId | null) =>
      threadLevel(threadKey(environmentId, threadId)),
    /** Whether the connection's level lets it write to the thread; upstream's permission is separate. */
    threadOperable: (environmentId: EnvironmentId, threadId: ThreadId | null) =>
      threadOperable(threadKey(environmentId, threadId)),
  };
}
