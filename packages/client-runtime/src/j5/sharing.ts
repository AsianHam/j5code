import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  type ConnectionAccess,
  type HeldPersonLevel,
  J5_ACCESS_WS_METHODS,
  J5_PEOPLE_WS_METHODS,
  J5_SHARED_CONVERSATION_WS_METHODS,
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
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

/**
 * What one connection is on its server; it only shapes what a client shows, since the server
 * checks every request. `null` means no answer yet, or a server from before people: nothing is
 * withheld then, so a composer does not flicker to read-only, and upstream's permissions decide.
 */
export type KnownConnectionAccess = ConnectionAccess | null;

/** The level the person holds at server scope, if any. */
const serverLevelOf = (access: KnownConnectionAccess): PersonLevel | null =>
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

/**
 * Which server, if any, is asked "What should people and agents on <server> call you?" now:
 * a device the server cannot place (People and access AC5), or the first owner with no name yet
 * (AC6). One server at a time, in the order they are listed. Neither can be put off: each is
 * asked before the device uses that server.
 */
export function serverToAskNameFor<Id>(
  servers: ReadonlyArray<{ readonly id: Id; readonly access: KnownConnectionAccess }>,
): { readonly id: Id; readonly kind: "claim" | "first-owner" } | null {
  for (const server of servers) {
    if (server.access?.kind === "unknown") return { id: server.id, kind: "claim" };
    if (
      server.access?.kind === "person" &&
      server.access.firstOwner &&
      server.access.name === null
    ) {
      return { id: server.id, kind: "first-owner" };
    }
  }
  return null;
}

/** The level a person is offered by, in the list of people a device could be: their highest. */
export const offeredLevel = (levels: ReadonlyArray<HeldPersonLevel>): PersonLevel | null =>
  highestLevel(levels.map((held) => held.level));

const LEVEL_LABELS: Record<PersonLevel, string> = {
  viewer: "Viewer",
  collaborator: "Collaborator",
  owner: "Owner",
};
export const levelLabel = (level: PersonLevel) => LEVEL_LABELS[level];

/** What a person is told when a name is not one the server will take, before it is sent. */
export const NAME_NOT_USABLE =
  "Use a name of one line, up to 80 characters, with no invisible characters, no square or angle brackets, and no level in parentheses such as (owner).";
/** What a person is told when the name they chose is someone else's on this server. */
export const NAME_IN_USE = "That name is already in use on this server. Choose another.";

/** Whether a refusal is the server's "that name is someone else's", by the refusal's stable name. */
export const nameIsInUse = (error: unknown) =>
  (error as { readonly code?: unknown } | null)?.code === "PersonNameTakenError";

/**
 * Whether upstream's "Permissions have changed / pair again" notice is for a connection. One J5
 * places as a person, or as a device it will ask about, has its permissions renewed when that
 * person's level changes, so pairing again never applies to it. The notice is held back until the
 * server answers; a server that cannot answer (from before people) keeps upstream's notice.
 */
export function permissionNoticeApplies(
  answer: AsyncResult.AsyncResult<KnownConnectionAccess, unknown>,
): boolean {
  if (answer._tag === "Initial") return false;
  const access = Option.getOrNull(AsyncResult.value(answer));
  return access?.kind !== "person" && access?.kind !== "unknown";
}

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

  /** Who sent each message of a thread and who answered each prompt (Shared conversations). */
  const threadAuthors = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:j5-shared-conversation:authors",
    tag: J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors,
    staleTimeMs: 0,
  });
  const threadAuthorsChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:j5-shared-conversation:authors-changes",
    tag: J5_SHARED_CONVERSATION_WS_METHODS.subscribeThreadAuthorsChanges,
  });
  /** Who reaches one thread or project, for anyone who reaches it (People and access AC26). */
  const scopePeople = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:j5-people:scope",
    tag: J5_PEOPLE_WS_METHODS.listScopePeople,
    staleTimeMs: 0,
  });
  const scopePeopleChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:j5-people:scope-changes",
    tag: J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges,
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
    threadAuthors,
    threadAuthorsChanges,
    scopePeople,
    scopePeopleChanges,
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

/**
 * Whether the person owns a connected server, or `"loading"` until a server says so or all have
 * answered. An empty catalog is a client still starting (its own server is added after the first
 * read). While loading, Settings lists what it lists anyone.
 */
export function ownerSomewhereState(input: {
  readonly catalogReady: boolean;
  /** Each server's answer; `null` for one still being asked. */
  readonly answers: ReadonlyArray<"owner" | "other" | null>;
}): boolean | "loading" {
  if (!input.catalogReady || input.answers.length === 0) return "loading";
  if (input.answers.includes("owner")) return true;
  return input.answers.includes(null) ? "loading" : false;
}

/**
 * What an Owner-only Settings page says, in its place, to someone who reaches it by a link or its
 * address and owns no connected server. Someone who writes nowhere has no agent to ask.
 */
export function ownerOnlySettingsNotice(input: {
  readonly serverName: string | null;
  readonly writesSomewhere: boolean;
}): { readonly title: string; readonly body: string } {
  const server = input.serverName ?? "this server";
  return {
    title: "Coming soon",
    body: input.writesSomewhere
      ? `Only an Owner of ${server} can change this here for now. Ask an Owner, or ask an agent on a thread you can write to.`
      : `Only an Owner of ${server} can change this here for now. Ask an Owner.`,
  };
}

/** What J5's Personas and Playbooks pages say to someone who owns no connected server. */
export const LIBRARY_FOR_OWNERS = "Personas and Playbooks are managed by a server's Owners.";

/**
 * What this person is across every connected server, for the pages that list servers (People and
 * access AC23, AC27): web and mobile each build one from their catalog and sharing atoms.
 */
export function createSharingOwnershipAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<{
    readonly isReady: boolean;
    readonly entries: ReadonlyMap<EnvironmentId, unknown>;
  }>;
  readonly sharing: Pick<
    ReturnType<typeof createSharingEnvironmentAtoms>,
    "connectionAccess" | "connectionAccessQuery"
  >;
}) {
  const { catalogValueAtom, sharing } = input;
  const environmentIdsWhere = (label: string, test: (access: KnownConnectionAccess) => boolean) =>
    Atom.make((get) => {
      const ids = new Set<EnvironmentId>();
      for (const id of get(catalogValueAtom).entries.keys()) {
        if (test(get(sharing.connectionAccess(id)))) ids.add(id);
      }
      return ids as ReadonlySet<EnvironmentId>;
    }).pipe(Atom.withLabel(label));

  return {
    /** Known to reach less than the whole server: nothing is left out before a server answers. */
    narrowEnvironmentIds: environmentIdsWhere(
      "j5:access:narrow-environments",
      (access) => access !== null && !reachesServer(access),
    ),
    /** Owned, or not yet answered: a server is not taken from its Owner while it answers. */
    ownedEnvironmentIds: environmentIdsWhere("j5:access:owned-environments", isOwnerAccess),
    /** Whether the person owns a connected server, or `"loading"`; see `ownerSomewhereState`. */
    ownerSomewhere: Atom.make((get) => {
      const catalog = get(catalogValueAtom);
      return ownerSomewhereState({
        catalogReady: catalog.isReady,
        // A server that cannot answer, one from before people, settles with no answer and holds
        // this client to nothing, as `isOwnerAccess` does; only one still being asked is unknown.
        answers: [...catalog.entries.keys()].map((environmentId) => {
          const result = get(sharing.connectionAccessQuery({ environmentId, input: {} }));
          if (result._tag === "Initial") return null;
          return isOwnerAccess(Option.getOrNull(AsyncResult.value(result))) ? "owner" : "other";
        }),
      });
    }).pipe(Atom.withLabel("j5:access:owner-somewhere")),
    /**
     * Writes to something: a Collaborator's or Owner's level anywhere, or a session that is no
     * person's, so has an agent to ask. Before a server has answered nothing is assumed.
     */
    writesSomewhere: Atom.make((get) => {
      for (const id of get(catalogValueAtom).entries.keys()) {
        const access = get(sharing.connectionAccess(id));
        if (access?.kind === "service") return true;
        if (
          access?.kind === "person" &&
          access.levels.some((held) => levelReaches(held.level, "collaborator"))
        ) {
          return true;
        }
      }
      return false;
    }).pipe(Atom.withLabel("j5:access:writes-somewhere")),
  };
}
