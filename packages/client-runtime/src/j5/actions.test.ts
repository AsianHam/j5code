import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CLIENT_GUARDED_RPC_SCOPES,
  EnvironmentId,
  J5_AGENT_PERSONA_WS_METHODS,
  J5_ARTIFACT_WS_METHODS,
  J5_SKILL_CATALOG_WS_METHODS,
  J5_SKILL_LINK_WS_METHODS,
  ProjectId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import {
  J5ActionError,
  J5_CLIENT_ACTION_WS_METHODS,
  J5_CLIENT_READ_WS_METHODS,
  J5_PLAYBOOK_WS_METHODS,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createCommandPermissions } from "../state/commandPermissions.ts";
import { createJ5EnvironmentAtoms } from "./state.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const granting = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [...scopes],
  permissions: [...scopes],
});

const work = EnvironmentId.make("work");
const home = EnvironmentId.make("home");
const ACTIONS = J5_CLIENT_ACTION_WS_METHODS;

/** Two connected environments whose sockets record every call, or answer as `respond` says. */
const fixture = (
  respond: (environmentId: EnvironmentId, method: string) => Effect.Effect<unknown, J5ActionError>,
) =>
  Effect.gen(function* () {
    const calls: Array<readonly [EnvironmentId, string, unknown]> = [];
    const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
    for (const environmentId of [work, home]) {
      const client = new Proxy(
        {},
        {
          get: (_target, method) => (input: unknown) =>
            Effect.suspend(() => {
              calls.push([environmentId, String(method), input]);
              return respond(environmentId, String(method));
            }),
        },
      );
      supervisors.set(environmentId, {
        target: { environmentId, label: environmentId },
        session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
      } as unknown as EnvironmentSupervisor["Service"]);
    }
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {
        run: <A, E>(id: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
          effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisors.get(id)!)),
      } as unknown as EnvironmentRegistry["Service"]),
    );
    const registry = yield* Effect.acquireRelease(
      Effect.sync(() => AtomRegistry.make()),
      (registry) => Effect.sync(() => registry.dispose()),
    );
    for (const environmentId of [work, home]) registry.mount(sessions(environmentId));
    return { atoms: createJ5EnvironmentAtoms(runtime), calls, registry, runtime };
  });

const failureOf = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;

describe("J5 action commands", () => {
  it.effect("runs on the environment the control names, never another one", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* fixture(() =>
        Effect.succeed({ crewInstanceId: "crew:1", members: [] }),
      );
      registry.set(sessions(home), AsyncResult.success(granting([AuthOrchestrationOperateScope])));
      const input = { crewInstanceId: "crew:1" };
      const stopped = yield* Effect.promise(() =>
        atoms.stopCrew.run(registry, { environmentId: home, input }),
      );
      expect(AsyncResult.isSuccess(stopped)).toBe(true);
      expect(calls).toEqual([[home, ACTIONS.stopCrew, input]]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports availability per environment and refuses to send without the grant", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* fixture(() => Effect.succeed({ deleted: true }));
      registry.set(sessions(work), AsyncResult.success(granting([AuthOrchestrationOperateScope])));
      registry.set(sessions(home), AsyncResult.success(granting([AuthOrchestrationReadScope])));
      const input = { projectId: ProjectId.make("project:1"), name: "release" };
      expect(registry.get(atoms.deletePlaybook.permissionAtom(work))).toBe(true);
      expect(registry.get(atoms.deletePlaybook.permissionAtom(home))).toBe(false);
      const refused = yield* Effect.promise(() =>
        atoms.deletePlaybook.run(registry, { environmentId: home, input }),
      );
      expect(failureOf(refused)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
      expect(calls).toEqual([]);

      // A sheet opened while the session could operate loses its action when the grant narrows.
      registry.set(sessions(work), AsyncResult.success(granting([AuthOrchestrationReadScope])));
      expect(registry.get(atoms.deletePlaybook.permissionAtom(work))).toBe(false);
      const narrowed = yield* Effect.promise(() =>
        atoms.deletePlaybook.run(registry, { environmentId: work, input }),
      );
      expect(failureOf(narrowed)).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("needs access:write for peering, and only read to preview a roster", () =>
    Effect.gen(function* () {
      const { atoms, registry } = yield* fixture(() => Effect.succeed({}));
      registry.set(sessions(work), AsyncResult.success(granting([AuthOrchestrationOperateScope])));
      for (const command of [
        atoms.issuePeerCredential,
        atoms.addPeer,
        atoms.removePeer,
        atoms.listPeerAddresses,
        atoms.probePeer,
      ]) {
        expect(command.requiredScopes()).toEqual([AuthAccessWriteScope]);
        expect(registry.get(command.permissionAtom(work))).toBe(false);
      }
      for (const command of [
        atoms.resolveCrewProposal,
        atoms.stopCrew,
        atoms.archiveCrew,
        atoms.respondCrewRuntimeRequest,
        atoms.answerHumanExchange,
        atoms.deletePlaybook,
        atoms.renamePlaybook,
        atoms.deleteArtifact,
      ]) {
        expect(command.requiredScopes()).toEqual([AuthOrchestrationOperateScope]);
        expect(registry.get(command.permissionAtom(work))).toBe(true);
      }
      registry.set(sessions(work), AsyncResult.success(granting([AuthOrchestrationReadScope])));
      expect(atoms.previewCrewProposal.requiredScopes()).toEqual([]);
      expect(registry.get(atoms.previewCrewProposal.permissionAtom(work))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("shows the server's refusal in its own words", () =>
    Effect.gen(function* () {
      const { atoms, registry } = yield* fixture(() =>
        Effect.fail(
          new J5ActionError({
            code: "CrewProposalNotOpenError",
            message: "Proposal proposal:1 is already approved.",
          }),
        ),
      );
      registry.set(sessions(work), AsyncResult.success(granting([AuthOrchestrationOperateScope])));
      const result = yield* Effect.promise(() =>
        atoms.resolveCrewProposal.run(registry, {
          environmentId: work,
          input: { proposalId: "proposal:1", decision: "decline" },
        }),
      );
      expect(failureOf(result)).toMatchObject({
        code: "CrewProposalNotOpenError",
        message: "Proposal proposal:1 is already approved.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("tells the person to update a server that does not have the action yet", () =>
    Effect.gen(function* () {
      const { atoms, registry } = yield* fixture((_environmentId, method) =>
        method === ACTIONS.archiveCrew
          ? Effect.die(`Unknown request tag: ${method}`)
          : Effect.die("Unknown request tag: something.else"),
      );
      registry.set(sessions(work), AsyncResult.success(granting([AuthOrchestrationOperateScope])));
      const outdated = yield* Effect.promise(() =>
        atoms.archiveCrew.run(registry, {
          environmentId: work,
          input: { crewInstanceId: "crew:1" },
        }),
      );
      expect(failureOf(outdated)).toMatchObject({
        _tag: "EnvironmentRpcUnavailableError",
        environmentId: work,
        message:
          "This action needs a newer server. Update the server hosting this environment, then try again.",
      });
      // Any other defect stays a defect: it is a bug to report, not a server to update.
      const defect = yield* Effect.promise(() =>
        atoms.stopCrew.run(registry, { environmentId: work, input: { crewInstanceId: "crew:1" } }),
      );
      expect(AsyncResult.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("J5 client permission guards", () => {
  it.effect("guard every J5 mutation, and leave J5's reads to the server", () =>
    Effect.gen(function* () {
      const { registry, runtime } = yield* fixture(() => Effect.succeed({}));
      registry.set(sessions(work), AsyncResult.success(granting([AuthOrchestrationReadScope])));
      const guards: Readonly<Record<string, AuthEnvironmentScope>> = CLIENT_GUARDED_RPC_SCOPES;
      // Every J5 method in the guard map, so a newly guarded one is exercised without a list
      // here. The server's `wsRpc.test.ts` proves the map names every method it must.
      const guarded = Object.entries(guards).filter(([method]) => method.startsWith("j5."));
      expect(guarded.length).toBeGreaterThan(Object.keys(ACTIONS).length);
      for (const [method, scope] of guarded) {
        const permissions = createCommandPermissions(runtime, method);
        expect(registry.get(permissions.permissionAtom(work)), method).toBe(false);
        expect(
          (yield* permissions.authorize(registry, work).pipe(Effect.flip)).requiredPermission,
          method,
        ).toBe(scope);
      }
      registry.set(
        sessions(work),
        AsyncResult.success(granting([AuthOrchestrationOperateScope, AuthAccessWriteScope])),
      );
      for (const [method] of guarded) {
        const permissions = createCommandPermissions(runtime, method);
        expect(registry.get(permissions.permissionAtom(work)), method).toBe(true);
        yield* permissions.authorize(registry, work);
      }
      for (const method of [
        J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog,
        J5_AGENT_PERSONA_WS_METHODS.readAgentPersona,
        J5_SKILL_CATALOG_WS_METHODS.getSkillCatalogStatus,
        J5_SKILL_LINK_WS_METHODS.list,
        J5_PLAYBOOK_WS_METHODS.exportPlaybook,
        J5_ARTIFACT_WS_METHODS.subscribeArtifactChanges,
        J5_ARTIFACT_WS_METHODS.listArtifacts,
        ACTIONS.previewCrewProposal,
        ...Object.values(J5_CLIENT_READ_WS_METHODS),
      ]) {
        expect(guards[method], method).toBeUndefined();
      }
    }).pipe(Effect.scoped),
  );
});
