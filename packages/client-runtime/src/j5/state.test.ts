import { expect, it } from "@effect/vitest";
import { EnvironmentId, J5_ARTIFACT_WS_METHODS, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  J5ActionError,
  J5_CLIENT_READ_WS_METHODS,
  J5_PLAYBOOK_WS_METHODS,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
  type NetworkStatus,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { createJ5EnvironmentAtoms } from "./state.ts";

const READS = J5_CLIENT_READ_WS_METHODS;
const alphaId = EnvironmentId.make("alpha");
const bravoId = EnvironmentId.make("bravo");

/**
 * Two connected environments. Each socket answers the fleet read with its own name and how often
 * it was asked; `alpha` is a server from before the playbook reads existed.
 */
const fixture = Effect.gen(function* () {
  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  const revisions = new Map<EnvironmentId, SubscriptionRef.SubscriptionRef<number>>();
  const calls: Array<readonly [EnvironmentId, string, unknown]> = [];
  for (const environmentId of [alphaId, bravoId]) {
    const revision = yield* SubscriptionRef.make(0);
    revisions.set(environmentId, revision);
    const answer =
      <A, E = never>(method: string, respond: () => Effect.Effect<A, E>) =>
      (input: unknown) =>
        Effect.suspend(() => {
          calls.push([environmentId, method, input]);
          return respond();
        });
    const fleetReads = () =>
      calls.filter(([id, method]) => id === environmentId && method === READS.readFleet);
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.of({
        target: new BearerConnectionTarget({
          environmentId,
          label: environmentId,
          connectionId: environmentId,
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connected",
          generation: 1,
        }),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
          Option.some({
            client: {
              [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: () => SubscriptionRef.changes(revision),
              [J5_PLAYBOOK_WS_METHODS.listThreadRuns]: answer(
                J5_PLAYBOOK_WS_METHODS.listThreadRuns,
                () =>
                  environmentId === alphaId
                    ? Effect.die(`Unknown request tag: ${J5_PLAYBOOK_WS_METHODS.listThreadRuns}`)
                    : Effect.succeed({ runs: [] }),
              ),
              [J5_PLAYBOOK_WS_METHODS.listRuns]: answer(J5_PLAYBOOK_WS_METHODS.listRuns, () =>
                Effect.die("Unknown request tag: something.else"),
              ),
              [J5_ARTIFACT_WS_METHODS.listArtifacts]: answer(
                J5_ARTIFACT_WS_METHODS.listArtifacts,
                () => Effect.die(`Unknown request tag: ${J5_ARTIFACT_WS_METHODS.listArtifacts}`),
              ),
              [READS.readFleet]: answer(READS.readFleet, () =>
                Effect.succeed({
                  projects: [
                    {
                      id: "project:shared",
                      title: `${environmentId} read ${fleetReads().length}`,
                      agents: [],
                      crews: [],
                    },
                  ],
                }),
              ),
              [READS.listCrewProposals]: answer(READS.listCrewProposals, () =>
                Effect.succeed({ proposals: [] }),
              ),
              [READS.listPeers]: answer(READS.listPeers, () =>
                Effect.fail(
                  new J5ActionError({ code: "SqlError", message: "Listing peers failed." }),
                ),
              ),
            },
          } as unknown as RpcSession),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
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
  const atoms = createJ5EnvironmentAtoms(Atom.runtime(layer));
  /** Mounts a query and waits for it to settle either way. */
  const settle = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    AtomRegistry.mount(registry, atom).pipe(
      Effect.andThen(Effect.exit(AtomRegistry.getResult(registry, atom))),
    );
  return { atoms, calls, registry, revisions, settle, supervisors };
});

it.effect(
  "reads each environment over its own socket, shares a read, and reads again on reconnect",
  () =>
    Effect.gen(function* () {
      const { atoms, calls, registry, revisions, supervisors } = yield* fixture;
      const alpha = atoms.fleet({ environmentId: alphaId, input: {} });
      const bravo = atoms.fleet({ environmentId: bravoId, input: {} });
      yield* AtomRegistry.mount(registry, alpha);
      yield* AtomRegistry.mount(registry, bravo);
      const first = yield* AtomRegistry.getResult(registry, alpha);
      const second = yield* AtomRegistry.getResult(registry, bravo);
      expect(first.projects[0]?.title).toBe("alpha read 1");
      expect(second.projects[0]?.title).toBe("bravo read 1");
      yield* AtomRegistry.getResult(registry, atoms.fleet({ environmentId: alphaId, input: {} }));
      expect(calls).toEqual([
        [alphaId, READS.readFleet, {}],
        [bravoId, READS.readFleet, {}],
      ]);

      const alphaChanges = atoms.playbookChanges({ environmentId: alphaId, input: {} });
      const bravoChanges = atoms.playbookChanges({ environmentId: bravoId, input: {} });
      expect(atoms.playbookChanges({ environmentId: alphaId, input: {} })).toBe(alphaChanges);
      yield* AtomRegistry.mount(registry, alphaChanges);
      yield* AtomRegistry.mount(registry, bravoChanges);
      expect(yield* AtomRegistry.getResult(registry, alphaChanges)).toBe(0);
      expect(yield* AtomRegistry.getResult(registry, bravoChanges)).toBe(0);
      yield* SubscriptionRef.set(revisions.get(alphaId)!, 1);
      const changed = yield* AtomRegistry.toStream(registry, alphaChanges).pipe(
        Stream.filter((result) => AsyncResult.isSuccess(result) && result.value === 1),
        Stream.runHead,
      );
      expect(Option.isSome(changed)).toBe(true);
      expect(yield* AtomRegistry.getResult(registry, bravoChanges)).toBe(0);

      yield* SubscriptionRef.update(supervisors.get(alphaId)!.state, (state) => ({
        ...state,
        generation: 2,
      }));
      const refreshed = yield* AtomRegistry.toStream(registry, alpha).pipe(
        Stream.filter(
          (result) =>
            AsyncResult.isSuccess(result) && result.value.projects[0]?.title === "alpha read 2",
        ),
        Stream.runHead,
      );
      expect(Option.isSome(refreshed)).toBe(true);
      expect(calls.filter(([id]) => id === bravoId)).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("hands a list read's rows to its view, and a refusal in the server's own words", () =>
  Effect.gen(function* () {
    const { atoms, settle } = yield* fixture;
    expect(yield* settle(atoms.crewProposals({ environmentId: bravoId, input: {} }))).toEqual(
      Exit.succeed([]),
    );
    const refused = yield* settle(atoms.peers({ environmentId: bravoId, input: {} }));
    expect(Exit.isFailure(refused) && Cause.squash(refused.cause)).toMatchObject({
      code: "SqlError",
      message: "Listing peers failed.",
    });
  }).pipe(Effect.scoped),
);

it.effect("tells the person to update a server that does not have the read yet", () =>
  Effect.gen(function* () {
    const { atoms, registry, settle } = yield* fixture;
    const input = { threadId: ThreadId.make("thread:playbooks") };
    const outdated = yield* settle(atoms.playbooks({ environmentId: alphaId, input }));
    expect(Exit.isFailure(outdated) && Cause.squash(outdated.cause)).toMatchObject({
      _tag: "EnvironmentRpcUnavailableError",
      environmentId: alphaId,
      message:
        "This view needs a newer server. Update the server hosting this environment, then try again.",
    });
    expect(yield* settle(atoms.playbooks({ environmentId: bravoId, input }))).toEqual(
      Exit.succeed({ runs: [] }),
    );
    // Any other defect stays a defect: it is a bug to report, not a server to update.
    const defect = yield* settle(atoms.playbookRuns({ environmentId: bravoId, input: {} }));
    expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);
    // The reads a caller makes once go the same way.
    const once = yield* Effect.promise(() =>
      atoms.listArtifacts.run(registry, {
        environmentId: bravoId,
        input: { projectId: ProjectId.make("project:shared") },
      }),
    );
    expect(AsyncResult.isFailure(once) && Cause.squash(once.cause)).toMatchObject({
      _tag: "EnvironmentRpcUnavailableError",
      environmentId: bravoId,
    });
  }).pipe(Effect.scoped),
);
