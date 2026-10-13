import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CLIENT_GUARDED_RPC_SCOPES,
  J5_AGENT_PERSONA_WS_METHODS,
  J5_ARTIFACT_WS_METHODS,
  J5_SKILL_CATALOG_WS_METHODS,
  J5_SKILL_LINK_WS_METHODS,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { J5_CLIENT_ACTION_WS_METHODS, J5_PLAYBOOK_WS_METHODS } from "@t3tools/contracts/j5";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { makeClientActionRpcHandlers } from "./a2a/clientActionRpc.ts";
import { ClientActionsService } from "./a2a/ClientActionsService.ts";
import { CrewProposalNotOpenError } from "./a2a/CrewProposalService.ts";
import { CrewRuntimeRequestConflictError } from "./a2a/CrewRuntimeRequestService.ts";
import { CrewStopNotFoundError, CrewStopOperationError } from "./a2a/CrewStopService.ts";
import { ArchiveCrewPartialFailureError } from "./a2a/ArchiveCrewService.ts";
import { A2AExchangeNotOpenError } from "./a2a/SendService.ts";
import { ExchangeId, LedgerMessageId } from "./a2a/contracts.ts";
import {
  PeerAdminOperationError,
  PeerAdminService,
  PeerCredentialLinkModeError,
} from "./a2a/PeerAdminService.ts";
import { PeerUnreachableError } from "./a2a/PeerRegistryService.ts";
import { ArtifactDeletion, ArtifactProjectUnavailableError } from "./artifacts/ArtifactDeletion.ts";
import { makeArtifactRpcHandlers } from "./artifacts/artifactRpc.ts";
import { J5_RPC_SCOPES } from "./wsRpcScopes.ts";

const ACTIONS = J5_CLIENT_ACTION_WS_METHODS;
const tested = [
  ...Object.values(ACTIONS),
  J5_ARTIFACT_WS_METHODS.deleteArtifact,
  J5_PLAYBOOK_WS_METHODS.deletePlaybook,
  J5_PLAYBOOK_WS_METHODS.renamePlaybook,
] as const;
type Tested = (typeof tested)[number];
type Untested = Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, Tested>;
/**
 * Methods the server requires operate scope for that back queries. The client guard wraps
 * commands only, so these stay out of it and the server alone refuses them.
 */
const UNGUARDED_QUERIES = [
  J5_AGENT_PERSONA_WS_METHODS.listAgentPersonaImportFiles,
  J5_AGENT_PERSONA_WS_METHODS.readAgentPersonaImportFiles,
  J5_SKILL_CATALOG_WS_METHODS.getSkillCatalogStatus,
  J5_SKILL_LINK_WS_METHODS.preview,
  J5_SKILL_LINK_WS_METHODS.list,
  J5_SKILL_LINK_WS_METHODS.inspect,
  J5_SKILL_LINK_WS_METHODS.deletePreview,
] as const satisfies ReadonlyArray<keyof typeof J5_RPC_SCOPES>;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Untested => !(tested as ReadonlyArray<string>).includes(tag),
  ),
);

const projectId = ProjectId.make("project:rpc");
const threadId = ThreadId.make("thread:builder");
const requestId = RuntimeRequestId.make("req:1");
const preview = { proposalId: "proposal:1", approvalToken: "runtime-token", seats: [] };
const proposal = {
  id: "proposal:1",
  projectId: "project:gate",
  captainParticipantId: "agent:j5:a2a:thread:captain",
  captainThreadId: ThreadId.make("thread:captain"),
  crewInstanceId: null,
  kind: "roster" as const,
  status: "approved" as const,
  brief: "Fix the flaky login test.",
  displayName: "Login Fix Crew",
  requestedSeats: [],
  approvedSeats: [],
  createdAt: "2026-09-09T16:00:00.000Z",
  resolvedAt: null,
  reportedAt: null,
  playbook: null,
};
const credential = {
  environmentId: "environment-work",
  credential: "issued-token",
  sessionId: "auth-session:issued",
  subject: "peer:environment-home",
  expiresAt: "2036-09-16T00:00:00.000Z",
};

/** A client on a session holding `scopes`, with `handled` naming every call that reached a service. */
const clientFor = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const handled: Array<string> = [];
    const reached = <A>(name: string, value: A) =>
      Effect.sync(() => {
        handled.push(name);
        return value;
      });
    const services = Layer.mergeAll(
      Layer.mock(ClientActionsService)({
        previewCrewProposal: () => reached("preview", preview),
        resolveCrewProposal: (input) =>
          input.proposalId === "proposal:1"
            ? reached("resolve", { proposal, crewInstanceId: "crew:1" })
            : Effect.fail(
                new CrewProposalNotOpenError({ proposalId: input.proposalId, status: "declined" }),
              ),
        stopCrew: ({ crewInstanceId }) =>
          crewInstanceId === "crew:1"
            ? reached("stop", { crewInstanceId, members: [] })
            : crewInstanceId === "crew:broken"
              ? Effect.fail(
                  new CrewStopOperationError({
                    phase: "reading the crew",
                    seatName: null,
                    cause: new Error("disk on fire at /var/secret"),
                  }),
                )
              : Effect.fail(new CrewStopNotFoundError({ crewInstanceId })),
        archiveCrew: ({ crewInstanceId }) =>
          crewInstanceId === "crew:1"
            ? reached("archive", { crewInstanceId, status: "archived" as const, members: [] })
            : Effect.fail(
                new ArchiveCrewPartialFailureError({
                  crewInstanceId,
                  archivedSeats: ["builder"],
                  failedSeat: "critic",
                  cause: new Error("store refused"),
                }),
              ),
        respondCrewRuntimeRequest: (input) =>
          input.requestId === requestId
            ? reached("respond", { threadId: input.threadId, requestId: input.requestId })
            : Effect.fail(new CrewRuntimeRequestConflictError({ detail: "already resolved" })),
        answerHumanExchange: (input) =>
          input.exchangeId === "ask:1"
            ? reached("answer", {
                result: {
                  messageId: LedgerMessageId.make("message:answer"),
                  exchangeId: ExchangeId.make(input.exchangeId),
                  exchangeState: "closed" as const,
                  joinedExistingExchange: false,
                  durableAtSeq: 1,
                },
              })
            : Effect.fail(new A2AExchangeNotOpenError({ exchangeId: input.exchangeId })),
      }),
      Layer.mock(PeerAdminService)({
        issueCredential: (input) =>
          input.environmentId === "environment-home"
            ? reached("issue", credential)
            : input.environmentId === "environment-laptop"
              ? Effect.fail(
                  new PeerCredentialLinkModeError({
                    label: "Laptop",
                    linkMode: "store",
                    store: false,
                  }),
                )
              : Effect.fail(
                  new PeerAdminOperationError({ operation: "issue", cause: new Error("no disk") }),
                ),
        add: (input) =>
          Effect.fail(new PeerUnreachableError({ origin: input.origin, reason: "ECONNREFUSED" })),
        remove: () => reached("remove", { removed: true, revokedSessions: 1 }),
        addresses: reached("addresses", { origins: ["http://10.0.0.5:3773"] }),
        probe: ({ origin }) =>
          reached(`probe ${origin}`, {
            outcome: "reached" as const,
            origin,
            environmentId: "environment-vm",
            label: "Work VM",
          }),
      }),
      Layer.mock(ArtifactDeletion)({
        delete: (input) =>
          input.path === "plan.md"
            ? reached("delete artifact", undefined)
            : Effect.fail(new ArtifactProjectUnavailableError({ projectId: input.projectId })),
      }),
    );
    const handlers = group
      .toLayer(
        Effect.gen(function* () {
          const artifacts = makeArtifactRpcHandlers({
            projects: { getById: () => Effect.die("unused") },
            artifacts: {
              watch: () => Effect.die("unused") as never,
              list: () => Effect.die("unused"),
            },
            deletion: yield* ArtifactDeletion,
          });
          return {
            ...(yield* makeClientActionRpcHandlers()),
            [J5_ARTIFACT_WS_METHODS.deleteArtifact]:
              artifacts[J5_ARTIFACT_WS_METHODS.deleteArtifact],
            [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: () =>
              reached("delete playbook", { deleted: true }),
            [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: () =>
              reached("rename playbook", { renamed: true }),
          };
        }),
      )
      .pipe(Layer.provide(services));
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
    );
    return { client, handled };
  });

const operator = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
const answer = { personId: "human:local", message: "Yes", clientRequestId: "reply:1" };

/** How a call ended: served, or refused for want of a scope. */
const outcome = <A, E extends { readonly _tag: string }>(call: Effect.Effect<A, E>) =>
  call.pipe(
    Effect.match({
      onSuccess: () => ({ served: true as const }),
      onFailure: (error) => ({
        served: false as const,
        tag: error._tag,
        requiredPermission:
          "requiredPermission" in error ? String(error.requiredPermission) : undefined,
      }),
    }),
  );

/** One valid call of each method, for the scope checks. A method missing here is a type error. */
const callEach = (client: Effect.Success<ReturnType<typeof clientFor>>["client"]) =>
  ({
    [ACTIONS.previewCrewProposal]: outcome(
      client[ACTIONS.previewCrewProposal]({ proposalId: "proposal:1" }),
    ),
    [ACTIONS.resolveCrewProposal]: outcome(
      client[ACTIONS.resolveCrewProposal]({
        proposalId: "proposal:1",
        decision: "decline",
      }),
    ),
    [ACTIONS.stopCrew]: outcome(client[ACTIONS.stopCrew]({ crewInstanceId: "crew:1" })),
    [ACTIONS.archiveCrew]: outcome(client[ACTIONS.archiveCrew]({ crewInstanceId: "crew:1" })),
    [ACTIONS.respondCrewRuntimeRequest]: outcome(
      client[ACTIONS.respondCrewRuntimeRequest]({
        threadId,
        requestId,
        decision: "accept",
      }),
    ),
    [ACTIONS.answerHumanExchange]: outcome(
      client[ACTIONS.answerHumanExchange]({
        ...answer,
        exchangeId: "ask:1",
      }),
    ),
    [ACTIONS.issuePeerCredential]: outcome(
      client[ACTIONS.issuePeerCredential]({
        environmentId: "environment-home",
      }),
    ),
    [ACTIONS.addPeer]: outcome(
      client[ACTIONS.addPeer]({
        origin: "https://dark.example",
        credential: "token",
      }),
    ),
    [ACTIONS.removePeer]: outcome(
      client[ACTIONS.removePeer]({ environmentId: "environment-home" }),
    ),
    [ACTIONS.listPeerAddresses]: outcome(client[ACTIONS.listPeerAddresses]({})),
    [ACTIONS.probePeer]: outcome(client[ACTIONS.probePeer]({ origin: "https://vm.example:3773" })),
    [J5_ARTIFACT_WS_METHODS.deleteArtifact]: outcome(
      client[J5_ARTIFACT_WS_METHODS.deleteArtifact]({
        projectId,
        path: "plan.md",
      }),
    ),
    [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: outcome(
      client[J5_PLAYBOOK_WS_METHODS.deletePlaybook]({
        projectId,
        name: "release",
      }),
    ),
    [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: outcome(
      client[J5_PLAYBOOK_WS_METHODS.renamePlaybook]({
        projectId,
        name: "release",
        title: "Release",
      }),
    ),
  }) satisfies Record<Tested, unknown>;

describe("J5 client action RPC scopes", () => {
  it("guards every J5 method that needs more than read on the client, with the server's scope", () => {
    const guarded: Readonly<Record<string, AuthEnvironmentScope>> = CLIENT_GUARDED_RPC_SCOPES;
    for (const [method, scope] of Object.entries(J5_RPC_SCOPES)) {
      // A read needs no guard, whichever read scope it carries: the peer list is `access:read`.
      const unguarded =
        scope === AuthOrchestrationReadScope ||
        scope === AuthAccessReadScope ||
        (UNGUARDED_QUERIES as ReadonlyArray<string>).includes(method);
      assert.equal(guarded[method], unguarded ? undefined : scope, method);
    }
    // The allowlist names only methods it is needed for.
    for (const method of UNGUARDED_QUERIES) {
      assert.equal(J5_RPC_SCOPES[method], AuthOrchestrationOperateScope, method);
    }
    // The preview only reads, so a read-only session sees the roster it cannot approve.
    assert.equal(J5_RPC_SCOPES[ACTIONS.previewCrewProposal], AuthOrchestrationReadScope);
    for (const method of [
      ACTIONS.issuePeerCredential,
      ACTIONS.addPeer,
      ACTIONS.removePeer,
      ACTIONS.listPeerAddresses,
      ACTIONS.probePeer,
    ]) {
      assert.equal(J5_RPC_SCOPES[method], AuthAccessWriteScope, method);
    }
  });

  it.effect("refuses a read-only session every mutation before its service is reached", () =>
    Effect.gen(function* () {
      const { client, handled } = yield* clientFor([
        AuthOrchestrationReadScope,
        AuthAccessReadScope,
      ]);
      const calls = callEach(client);
      for (const [method, call] of Object.entries(calls)) {
        assert.deepStrictEqual(
          yield* call,
          method === ACTIONS.previewCrewProposal
            ? { served: true }
            : {
                served: false,
                tag: "EnvironmentAuthorizationError",
                requiredPermission: method.startsWith("j5.peers.")
                  ? AuthAccessWriteScope
                  : AuthOrchestrationOperateScope,
              },
          method,
        );
      }
      assert.deepStrictEqual(handled, ["preview"]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps peering apart from operating: each scope reaches only its own methods", () =>
    Effect.gen(function* () {
      const operating = yield* clientFor(operator);
      const refusedPeering = yield* operating.client[ACTIONS.removePeer]({
        environmentId: "environment-home",
      }).pipe(Effect.flip);
      assert.deepInclude(refusedPeering, { requiredPermission: AuthAccessWriteScope });
      assert.deepStrictEqual(operating.handled, []);

      const peering = yield* clientFor([AuthAccessWriteScope]);
      assert.deepStrictEqual(
        yield* peering.client[ACTIONS.removePeer]({ environmentId: "environment-home" }),
        { removed: true, revokedSessions: 1 },
      );
      const refusedOperating = yield* peering.client[ACTIONS.stopCrew]({
        crewInstanceId: "crew:1",
      }).pipe(Effect.flip);
      assert.deepInclude(refusedOperating, { requiredPermission: AuthOrchestrationOperateScope });
      assert.deepStrictEqual(peering.handled, ["remove"]);
    }).pipe(Effect.scoped),
  );
});

describe("J5 client action RPC handlers", () => {
  it.effect("answers an operator with what each service returned", () =>
    Effect.gen(function* () {
      const { client, handled } = yield* clientFor(operator);
      assert.deepStrictEqual(
        yield* client[ACTIONS.resolveCrewProposal]({
          proposalId: "proposal:1",
          decision: "approve",
          approvalToken: "runtime-token",
        }),
        { proposal, crewInstanceId: "crew:1" },
      );
      assert.deepStrictEqual(yield* client[ACTIONS.stopCrew]({ crewInstanceId: "crew:1" }), {
        crewInstanceId: "crew:1",
        members: [],
      });
      assert.equal(
        (yield* client[ACTIONS.archiveCrew]({ crewInstanceId: "crew:1" })).status,
        "archived",
      );
      assert.deepStrictEqual(
        yield* client[ACTIONS.respondCrewRuntimeRequest]({
          threadId,
          requestId,
          decision: "accept",
        }),
        { threadId, requestId },
      );
      assert.equal(
        (yield* client[ACTIONS.answerHumanExchange]({ ...answer, exchangeId: "ask:1" })).result
          .exchangeState,
        "closed",
      );
      assert.deepStrictEqual(
        yield* client[J5_ARTIFACT_WS_METHODS.deleteArtifact]({ projectId, path: "plan.md" }),
        { deleted: true },
      );
      assert.deepStrictEqual(handled, [
        "resolve",
        "stop",
        "archive",
        "respond",
        "answer",
        "delete artifact",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("carries a refusal's name and its own words to the client", () =>
    Effect.gen(function* () {
      const { client } = yield* clientFor(operator);
      const refusal = <A, E>(call: Effect.Effect<A, E>) => call.pipe(Effect.flip);
      assert.deepInclude(
        yield* refusal(
          client[ACTIONS.resolveCrewProposal]({ proposalId: "other", decision: "decline" }),
        ),
        { _tag: "J5ActionError", code: "CrewProposalNotOpenError" },
      );
      assert.deepInclude(
        yield* refusal(client[ACTIONS.stopCrew]({ crewInstanceId: "crew:nope" })),
        {
          _tag: "J5ActionError",
          code: "CrewStopNotFoundError",
          message: "Crew crew:nope does not exist.",
        },
      );
      assert.deepInclude(
        yield* refusal(
          client[ACTIONS.respondCrewRuntimeRequest]({
            threadId,
            requestId: RuntimeRequestId.make("req:answered"),
            decision: "accept",
          }),
        ),
        { code: "CrewRuntimeRequestConflictError", message: "already resolved" },
      );
      assert.deepInclude(
        yield* refusal(
          client[ACTIONS.answerHumanExchange]({ ...answer, exchangeId: "ask:closed" }),
        ),
        { _tag: "J5ActionError", code: "A2AExchangeNotOpenError" },
      );
      assert.deepInclude(
        yield* refusal(
          client[J5_ARTIFACT_WS_METHODS.deleteArtifact]({ projectId, path: "missing.md" }),
        ),
        {
          code: "ArtifactProjectUnavailableError",
          message: `Project ${projectId} is not available.`,
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("tells a server-side failure in the action's general words, never its cause", () =>
    Effect.gen(function* () {
      const { client } = yield* clientFor([...operator, AuthAccessWriteScope]);
      assert.deepInclude(
        yield* client[ACTIONS.stopCrew]({ crewInstanceId: "crew:broken" }).pipe(Effect.flip),
        { code: "CrewStopOperationError", message: "Stopping the crew failed." },
      );
      assert.deepInclude(
        yield* client[ACTIONS.archiveCrew]({ crewInstanceId: "crew:half" }).pipe(Effect.flip),
        {
          code: "ArchiveCrewPartialFailureError",
          message:
            "Archiving the crew stopped partway; the seats already retired stay retired. Try again.",
        },
      );
      assert.deepInclude(
        yield* client[ACTIONS.issuePeerCredential]({ environmentId: "environment-new" }).pipe(
          Effect.flip,
        ),
        { code: "Error", message: "Issuing the peer credential failed." },
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "maps peering refusals to the codes the CLI's routes use, and checks reachability",
    () =>
      Effect.gen(function* () {
        const { client, handled } = yield* clientFor([AuthAccessWriteScope]);
        assert.deepStrictEqual(
          yield* client[ACTIONS.issuePeerCredential]({ environmentId: "environment-home" }),
          credential,
        );
        assert.deepInclude(
          yield* client[ACTIONS.issuePeerCredential]({ environmentId: "environment-laptop" }).pipe(
            Effect.flip,
          ),
          {
            code: "peer_link_mode_conflict",
            message:
              "Peer Laptop is recorded here with link mode store, so this server stores its messages until it polls. To change how messages travel, remove the peer and peer again.",
          },
        );
        assert.deepInclude(
          yield* client[ACTIONS.addPeer]({ origin: "https://dark.example", credential: "t" }).pipe(
            Effect.flip,
          ),
          { _tag: "J5ActionError", code: "peer_unreachable" },
        );
        assert.deepStrictEqual(yield* client[ACTIONS.listPeerAddresses]({}), {
          origins: ["http://10.0.0.5:3773"],
        });
        // Malformed input is refused before this server fetches anything.
        for (const origin of [
          "https://vm.example:3773/elsewhere",
          "file:///etc/passwd",
          "not a url",
        ]) {
          const exit = yield* client[ACTIONS.probePeer]({ origin }).pipe(Effect.exit);
          assert.equal(exit._tag, "Failure", origin);
        }
        assert.deepInclude(
          yield* client[ACTIONS.probePeer]({ origin: "https://vm.example:3773" }),
          {
            outcome: "reached",
            environmentId: "environment-vm",
          },
        );
        assert.deepStrictEqual(handled, ["issue", "addresses", "probe https://vm.example:3773"]);
      }).pipe(Effect.scoped),
  );
});
