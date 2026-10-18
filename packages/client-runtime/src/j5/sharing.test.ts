import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, J5_ARTIFACT_WS_METHODS, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type ConnectionAccess,
  type HeldPersonLevel,
  J5_ACCESS_WS_METHODS,
  J5_CLIENT_READ_WS_METHODS,
  type PersonLevel,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createSharingEnvironmentAtoms,
  draftLevelFor,
  reachesServer,
  sharingAllowsOperate,
  threadLevelFor,
} from "./sharing.ts";
import { createJ5EnvironmentAtoms } from "./state.ts";

const person = (
  levels: ReadonlyArray<HeldPersonLevel>,
  options: { readonly wide?: boolean; readonly owner?: boolean } = {},
): ConnectionAccess => ({
  kind: "person",
  personId: "human:person",
  name: "Priya",
  firstOwner: false,
  levels,
  wide: options.wide ?? false,
  owner: options.owner ?? false,
  retiredLinks: null,
});

const OWNER = person([{ scope: { kind: "server" }, level: "owner" }], { wide: true, owner: true });
const SERVER_VIEWER = person([{ scope: { kind: "server" }, level: "viewer" }]);

describe("what a connection may do with a thread", () => {
  it("withholds nothing while the server has not answered", () => {
    // A composer must not flicker to read-only while the answer is on its way.
    expect(sharingAllowsOperate({ access: null, level: null })).toBe(true);
  });

  it("gives someone who writes to the whole server their server level on every thread", () => {
    expect(threadLevelFor(OWNER, null)).toBe("owner");
  });

  it("takes the server's word for anyone else, a server-scope Viewer included", () => {
    // A Viewer at server scope may be a Collaborator on one thread; only the server knows which.
    expect(threadLevelFor(SERVER_VIEWER, "collaborator")).toBe("collaborator");
    expect(sharingAllowsOperate({ access: SERVER_VIEWER, level: "viewer" })).toBe(false);
    expect(sharingAllowsOperate({ access: SERVER_VIEWER, level: "collaborator" })).toBe(true);
  });

  it("keeps a device the server cannot place from writing anywhere", () => {
    expect(threadLevelFor({ kind: "unknown" }, null)).toBe(null);
    expect(sharingAllowsOperate({ access: { kind: "unknown" }, level: null })).toBe(false);
  });

  it("counts only a level at server scope as reaching the server", () => {
    expect(reachesServer(SERVER_VIEWER)).toBe(true);
    expect(
      reachesServer(
        person([
          { scope: { kind: "project", projectId: ProjectId.make("p") }, level: "collaborator" },
        ]),
      ),
    ).toBe(false);
    expect(reachesServer({ kind: "service" })).toBe(true);
  });
});

const MEMBER_SERVER = EnvironmentId.make("own-server");
const SHARED_SERVER = EnvironmentId.make("shared-server");
const VIEWED = ThreadId.make("thread:viewed");
const JOINED = ThreadId.make("thread:joined");

const NARROW = person([
  { scope: { kind: "thread", threadId: VIEWED }, level: "viewer" },
  { scope: { kind: "thread", threadId: JOINED }, level: "collaborator" },
]);

/** Two connected environments: one this person owns, one where they hold two threads. */
const environments = Effect.fn(function* (
  // How a server answers "what is this connection?"; by default with what it is there.
  answer: (access: ConnectionAccess) => Effect.Effect<ConnectionAccess> = Effect.succeed,
) {
  const viewedLevel = yield* SubscriptionRef.make<PersonLevel | null>("viewer");
  const asked: Array<string> = [];
  const fleetReads: Array<EnvironmentId> = [];
  const otherReads: Array<string> = [];
  const supervisor = Effect.fn(function* (environmentId: EnvironmentId, access: ConnectionAccess) {
    const target = new BearerConnectionTarget({
      environmentId,
      label: environmentId,
      connectionId: environmentId,
    });
    const prepared: PreparedConnection = {
      environmentId,
      label: environmentId,
      httpBaseUrl: `https://${environmentId}.test`,
      socketUrl: `wss://${environmentId}.test/ws`,
      target,
      httpAuthorization: { _tag: "Bearer", token: environmentId },
    };
    return EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        generation: 1,
      }),
      prepared: yield* SubscriptionRef.make(Option.some(prepared)),
      session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some({
          client: {
            [J5_CLIENT_READ_WS_METHODS.readFleet]: () => {
              fleetReads.push(environmentId);
              return Effect.succeed({ projects: [] });
            },
            [J5_CLIENT_READ_WS_METHODS.readOpenInboxCount]: () => {
              otherReads.push(`${environmentId}:inbox`);
              return Effect.succeed({ personId: "human:local-operator", count: 0 });
            },
            [J5_CLIENT_READ_WS_METHODS.listCrewProposals]: () => {
              otherReads.push(`${environmentId}:crew`);
              return Effect.succeed({ proposals: [] });
            },
            [J5_ARTIFACT_WS_METHODS.listArtifacts]: () => {
              otherReads.push(`${environmentId}:artifacts`);
              return Effect.succeed({ entries: [] });
            },
            [J5_ACCESS_WS_METHODS.getConnectionAccess]: () => {
              asked.push(`${environmentId}:connection`);
              return answer(access);
            },
            [J5_ACCESS_WS_METHODS.subscribeThreadLevel]: (input: { threadId: ThreadId }) => {
              asked.push(`${environmentId}:${input.threadId}`);
              return input.threadId === VIEWED
                ? SubscriptionRef.changes(viewedLevel).pipe(Stream.map((level) => ({ level })))
                : Stream.make({ level: "collaborator" as const }).pipe(Stream.concat(Stream.never));
            },
          },
        } as unknown as RpcSession),
      ),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  });
  const supervisors = new Map([
    [MEMBER_SERVER, yield* supervisor(MEMBER_SERVER, OWNER)],
    [SHARED_SERVER, yield* supervisor(SHARED_SERVER, NARROW)],
  ]);
  const layer = Layer.mock(EnvironmentRegistry)({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    run: (id, effect) =>
      effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisors.get(id)!)),
    followStream: (id, stream) =>
      stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisors.get(id)!)),
  });
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  return { layer, registry, viewedLevel, asked, fleetReads, otherReads };
});

/** Waits for the atom to hold a value that passes; one that never arrives fails the test by timeout. */
const settlesWhere = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  passes: (value: A) => boolean,
) =>
  AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(passes),
    Stream.runHead,
    Effect.map(Option.isSome),
  );

/** Waits for the atom to hold `expected`; a value that never arrives fails the test by timeout. */
const settlesAt = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, expected: A) =>
  AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter((value) => value === expected),
    Stream.runHead,
    Effect.map(Option.isSome),
  );

describe("what a connection may do with a thread it is starting", () => {
  const PROJECT = ProjectId.make("project:shared");

  it("lets a project's Collaborator write to a new thread in it", () => {
    const access = person([
      { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
    ]);
    expect(sharingAllowsOperate({ access, level: draftLevelFor(access, PROJECT) })).toBe(true);
  });

  it("does not let them write to one in another project", () => {
    const access = person([
      { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
    ]);
    expect(sharingAllowsOperate({ access, level: draftLevelFor(access, "project:other") })).toBe(
      false,
    );
  });

  it("does not let a thread's Collaborator start another thread in its project", () => {
    const access = person([
      { scope: { kind: "thread", threadId: ThreadId.make("thread:one") }, level: "collaborator" },
    ]);
    expect(draftLevelFor(access, PROJECT)).toBeNull();
  });

  it("gives a server's Viewer their server level, and the highest of the two", () => {
    const access = person([
      { scope: { kind: "server" }, level: "viewer" },
      { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
    ]);
    expect(draftLevelFor(SERVER_VIEWER, PROJECT)).toBe("viewer");
    expect(draftLevelFor(access, PROJECT)).toBe("collaborator");
  });
});

describe("a connection that holds two threads of a server", () => {
  it.effect("reads one thread and writes to another on the same server", () =>
    Effect.gen(function* () {
      const { layer, registry, viewedLevel, asked } = yield* environments();
      const sharing = createSharingEnvironmentAtoms(Atom.runtime(layer));
      const viewed = sharing.threadOperable(SHARED_SERVER, VIEWED);
      const joined = sharing.threadOperable(SHARED_SERVER, JOINED);
      const draft = sharing.threadOperable(SHARED_SERVER, null);
      const own = sharing.threadOperable(MEMBER_SERVER, VIEWED);
      for (const atom of [viewed, joined, draft, own]) yield* AtomRegistry.mount(registry, atom);

      expect(yield* settlesAt(registry, sharing.isNarrow(SHARED_SERVER), true)).toBe(true);
      expect(yield* settlesAt(registry, joined, true)).toBe(true);
      expect(registry.get(viewed)).toBe(false);
      expect(registry.get(draft)).toBe(false);

      // An Owner raises the first thread to Collaborator while the person has it open.
      yield* SubscriptionRef.set(viewedLevel, "collaborator");
      expect(yield* settlesAt(registry, viewed, true)).toBe(true);
      yield* SubscriptionRef.set(viewedLevel, null);
      expect(yield* settlesAt(registry, viewed, false)).toBe(true);

      // On the server the person owns nothing is withheld, and no thread is asked about.
      expect(
        yield* settlesWhere(registry, sharing.connectionAccess(MEMBER_SERVER), (a) => a !== null),
      ).toBe(true);
      expect(registry.get(own)).toBe(true);
      expect(registry.get(own)).toBe(true);
      expect(asked.filter((entry) => entry.startsWith(MEMBER_SERVER))).toEqual([
        `${MEMBER_SERVER}:connection`,
      ]);
    }),
  );

  it.effect("is offered a thread's actions only where it holds Collaborator", () =>
    Effect.gen(function* () {
      const { layer, registry } = yield* environments();
      const sharing = createSharingEnvironmentAtoms(Atom.runtime(layer));
      // The open thread's view holds these; the read asks nothing of its own.
      const viewed = sharing.threadOperable(SHARED_SERVER, VIEWED);
      const joined = sharing.threadOperable(SHARED_SERVER, JOINED);
      const own = sharing.threadOperable(MEMBER_SERVER, VIEWED);
      for (const atom of [viewed, joined, own]) yield* AtomRegistry.mount(registry, atom);
      expect(yield* settlesAt(registry, joined, true)).toBe(true);
      expect(
        yield* settlesWhere(registry, sharing.connectionAccess(MEMBER_SERVER), (a) => a !== null),
      ).toBe(true);
      const read = (environmentId: EnvironmentId, threadId: ThreadId, permitted: boolean) =>
        sharing.readCanOperateThread(registry, { environmentId, threadId, permitted });

      // An Owner gets upstream's answer, whichever it is.
      expect(read(MEMBER_SERVER, VIEWED, true)).toBe(true);
      expect(read(MEMBER_SERVER, VIEWED, false)).toBe(false);
      // A Viewer of the thread gets no; a Collaborator on that thread, yes.
      expect(read(SHARED_SERVER, VIEWED, true)).toBe(false);
      expect(read(SHARED_SERVER, JOINED, true)).toBe(true);
      // Nobody gets more than upstream's permission allows.
      expect(read(SHARED_SERVER, JOINED, false)).toBe(false);
    }),
  );

  it.effect("sends none of the server's own reads once the server has said what it holds", () =>
    Effect.gen(function* () {
      const { layer, registry, fleetReads } = yield* environments();
      const runtime = Atom.runtime(layer);
      const sharing = createSharingEnvironmentAtoms(runtime);
      const atoms = createJ5EnvironmentAtoms(runtime);
      yield* AtomRegistry.mount(registry, sharing.isNarrow(SHARED_SERVER));
      expect(yield* settlesAt(registry, sharing.isNarrow(SHARED_SERVER), true)).toBe(true);

      const own = atoms.fleet({ environmentId: MEMBER_SERVER, input: {} });
      const shared = atoms.fleet({ environmentId: SHARED_SERVER, input: {} });
      yield* AtomRegistry.mount(registry, own);
      yield* AtomRegistry.mount(registry, shared);
      yield* AtomRegistry.getResult(registry, own);
      const refused = yield* AtomRegistry.getResult(registry, shared).pipe(Effect.flip);
      expect(refused).toMatchObject({ message: "This is not shared with you on this server." });
      expect(AsyncResult.isFailure(registry.get(shared))).toBe(true);
      expect(fleetReads).toEqual([MEMBER_SERVER]);
    }),
  );

  it.effect("still asks for what its scope gives it: artifacts, its inbox and Crew requests", () =>
    Effect.gen(function* () {
      const { layer, registry, fleetReads, otherReads } = yield* environments();
      const runtime = Atom.runtime(layer);
      const sharing = createSharingEnvironmentAtoms(runtime);
      const atoms = createJ5EnvironmentAtoms(runtime);
      yield* AtomRegistry.mount(registry, sharing.isNarrow(SHARED_SERVER));
      expect(yield* settlesAt(registry, sharing.isNarrow(SHARED_SERVER), true)).toBe(true);

      const listed = yield* Effect.promise(() =>
        atoms.listArtifacts.run(registry, {
          environmentId: SHARED_SERVER,
          input: { projectId: ProjectId.make("project-shared") },
        }),
      );
      expect(AsyncResult.isSuccess(listed)).toBe(true);

      const refused = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
        AtomRegistry.mount(registry, atom).pipe(
          Effect.andThen(Effect.exit(AtomRegistry.getResult(registry, atom))),
          Effect.map((exit) => exit._tag === "Failure"),
        );
      expect(yield* refused(atoms.openCount({ environmentId: SHARED_SERVER, input: {} }))).toBe(
        false,
      );
      expect(yield* refused(atoms.crewProposals({ environmentId: SHARED_SERVER, input: {} }))).toBe(
        false,
      );
      expect(yield* refused(atoms.fleet({ environmentId: SHARED_SERVER, input: {} }))).toBe(true);
      expect(otherReads).toEqual([
        `${SHARED_SERVER}:artifacts`,
        `${SHARED_SERVER}:inbox`,
        `${SHARED_SERVER}:crew`,
      ]);
      expect(fleetReads).toEqual([]);
    }),
  );
});

describe("an Owner's connection", () => {
  it.effect("reads at once while the server has not answered what it is", () =>
    Effect.gen(function* () {
      // The server never answers the question: nothing may wait on it.
      const { layer, registry, fleetReads, asked } = yield* environments(() => Effect.never);
      const atoms = createJ5EnvironmentAtoms(Atom.runtime(layer));
      const own = atoms.fleet({ environmentId: MEMBER_SERVER, input: {} });
      yield* AtomRegistry.mount(registry, own);
      expect((yield* AtomRegistry.getResult(registry, own)).projects).toEqual([]);
      expect(fleetReads).toEqual([MEMBER_SERVER]);
      // Asked once, in the background, however many reads follow.
      registry.refresh(own);
      yield* AtomRegistry.getResult(registry, own);
      expect(asked).toEqual([`${MEMBER_SERVER}:connection`]);
    }),
  );

  it.effect("reads, and may write to its threads, when the server cannot answer", () =>
    Effect.gen(function* () {
      // A server from before people has no such request; upstream's permissions decide there.
      const { layer, registry, fleetReads } = yield* environments(() =>
        Effect.die(new Error("Unknown request tag: j5.access.getConnectionAccess")),
      );
      const runtime = Atom.runtime(layer);
      const sharing = createSharingEnvironmentAtoms(runtime);
      const own = createJ5EnvironmentAtoms(runtime).fleet({
        environmentId: MEMBER_SERVER,
        input: {},
      });
      const operable = sharing.threadOperable(MEMBER_SERVER, VIEWED);
      yield* AtomRegistry.mount(registry, own);
      yield* AtomRegistry.mount(registry, operable);
      yield* AtomRegistry.getResult(registry, own);
      expect(fleetReads).toEqual([MEMBER_SERVER]);
      yield* Effect.exit(
        AtomRegistry.getResult(
          registry,
          sharing.connectionAccessQuery({ environmentId: MEMBER_SERVER, input: {} }),
        ),
      );
      expect(registry.get(sharing.isNarrow(MEMBER_SERVER))).toBe(false);
      expect(registry.get(operable)).toBe(true);
    }),
  );
});
