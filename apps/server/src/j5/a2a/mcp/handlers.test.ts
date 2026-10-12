import { stringify as toYaml } from "yaml";
import { makeAgentPersonaLibrary } from "../../agents/agentPersonaLibrary.ts";
import { resolveAgentPersonaRuntime } from "../../agents/agentPersonaRuntime.ts";
import { BUILT_IN_AGENT_PERSONAS } from "../../agents/agentPersonas.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import {
  McpInvocationContext,
  type McpInvocationScope,
} from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorProjectionError,
  OrchestratorV2,
} from "../../../orchestration-v2/Orchestrator.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { type AgentCrewInstance, AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import {
  ArchiveCrewConfirmationRequiredError,
  ArchiveCrewService,
  type ArchiveCrewInput,
} from "../ArchiveCrewService.ts";
import { CrewStopService } from "../CrewStopService.ts";
import { CrewProposalService, type CrewProposalOutcome } from "../CrewProposalService.ts";
import type { CrewProposal, CrewProposalSeat } from "../AgentCrewProposalService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import {
  A2AHomeNotFoundError,
  A2AHomeRegistrar,
  participantIdForThread,
} from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { PeerDirectory, noneLayer as peerDirectoryNoneLayer } from "../PeerDirectory.ts";
import {
  ParticipantPlacementService,
  PlacementProjectNotFoundError,
  PlacementStorageError,
} from "../PlacementService.ts";
import { A2AHomeMembershipStateError, A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { ThreadRegistration } from "../ThreadRegistration.ts";
import {
  type ClearOwnAskInput,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  LedgerProjectId,
  type ParticipantDirectoryRow,
  type SendMessageInput,
} from "../contracts.ts";
import { PlaybookStore } from "../../playbooks/PlaybookStore.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { fakeSpawnWorkspaceLayer, noRepository } from "../test-support/spawnWorkspaceFakes.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import {
  type J5ListParticipantsInput,
  J5ListParticipantsResult,
  J5Toolkit,
  type J5ArchiveCrewInput,
  type J5SendMessageInput,
  type J5ProposeCrewInput,
  type J5RequestCrewMemberInput,
  type J5SpawnAgentInput,
  type J5StopAgentInput,
} from "./tools.ts";

const decodeJ5ListParticipantsResult = Schema.decodeUnknownEffect(J5ListParticipantsResult);
const hasKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return key in record || Object.values(record).some((item) => hasKey(item, key));
};
const forbiddenCamelCaseKeys = [
  "projectId",
  "participantId",
  "threadId",
  "placementParentId",
  "spawnedByParticipantId",
  "sourceParticipantId",
  "canReceiveMessage",
  "canOpenExchange",
  "acceptsUrgency",
] as const;

const invocation = {
  environmentId: EnvironmentId.make("environment:j5:mcp-handler"),
  threadId: ThreadId.make("thread:j5:mcp-handler"),
  providerSessionId: "provider-session:j5:mcp-handler",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};
/** The scope the handlers see: `invocation` as an agent calling from its own thread. */
const scope: McpInvocationScope = {
  environmentId: invocation.environmentId,
  capabilities: invocation.capabilities,
  issuedAt: invocation.issuedAt,
  requestNamespace: invocation.providerSessionId,
  thread: {
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  },
  client: undefined,
};
/**
 * `ThreadManagementService` with the one lookup the access gate makes before every tool that
 * acts as its caller: the calling thread, in the middle of a turn.
 */
const threadManagementMock = (
  service: Partial<ThreadManagementService["Service"]> = {},
): Layer.Layer<ThreadManagementService> =>
  Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(threadId === invocation.threadId ? liveThreadShell(threadId) : null),
    ...service,
  });

const projectId = ProjectId.make("project:j5:mcp-handler");
const createdAt = DateTime.makeUnsafe("2026-08-30T16:00:00.000Z");

const projection = (threadId: ThreadId): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: `Title ${threadId}`,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
  }) as unknown as OrchestrationV2ThreadProjection;

const missingProjectId = ProjectId.make("project:j5:mcp-directory:gone");
/** The send tool claims attachments into the server's attachment store; none of these tests send one. */
const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "j5-mcp-handlers-",
}).pipe(Layer.provide(NodeServices.layer));
const unusedLifecycleDependencies = Layer.mergeAll(
  Layer.mock(A2AHomeRegistrar)({
    getHomeForThread: (threadId) => Effect.fail(new A2AHomeNotFoundError({ threadId })),
  }),
  Layer.mock(A2ALedger)({
    listProjectLedgers: () =>
      Effect.succeed([
        {
          id: LedgerProjectId.make("ledger:j5:mcp-directory"),
          name: "Directory project",
          createdAt: DateTime.formatIso(createdAt),
        },
      ]),
  }),
  Layer.mock(SpawnCompositionService)({}),
  threadManagementMock({}),
  Layer.mock(OrchestratorMcpService)({}),
  Layer.mock(AgentCrewInstanceService)({
    findMembership: () => Effect.succeed(null),
    listForCaptain: () => Effect.succeed([]),
  }),
  Layer.mock(ArchiveCrewService)({}),
  Layer.mock(CrewStopService)({}),
  Layer.mock(CrewProposalService)({}),
  peerDirectoryNoneLayer,
  Layer.mock(ProjectService)({
    getById: (id) =>
      Effect.succeed(
        id === missingProjectId
          ? Option.none()
          : Option.some({
              id,
              title: "Directory project",
              workspaceRoot: "/tmp/j5-mcp-directory",
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(createdAt),
              updatedAt: DateTime.formatIso(createdAt),
              deletedAt: null,
            }),
      ),
  }),
  serverConfigLayer,
  Layer.mock(ThreadRegistration)({}),
);

it.effect("namespaces mutating-tool idempotency and sender identity from authenticated scope", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(Object.keys(J5Toolkit.tools).sort(), [
      "j5_archive_crew",
      "j5_clear_own_ask",
      "j5_list_participants",
      "j5_list_personas",
      "j5_playbook_back",
      "j5_playbook_cancel",
      "j5_playbook_complete",
      "j5_playbook_current",
      "j5_playbook_list",
      "j5_playbook_next",
      "j5_playbook_read",
      "j5_playbook_reselect",
      "j5_playbook_start",
      "j5_propose_crew",
      "j5_request_crew_member",
      "j5_send_message",
      "j5_spawn_agent",
      "j5_stop_agent",
      "j5_stop_crew",
    ]);
    const sends = yield* Ref.make<ReadonlyArray<SendMessageInput>>([]);
    const clears = yield* Ref.make<ReadonlyArray<ClearOwnAskInput>>([]);
    const participantId = ParticipantId.make("agent:j5:mcp-handler");
    const callerParticipantId = participantIdForThread(invocation.threadId);
    const multiMembershipRecipientId = ParticipantId.make("agent:j5:mcp-multi-membership-target");
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: (input) =>
          input.to === multiMembershipRecipientId
            ? Effect.fail(
                new A2AHomeMembershipStateError({
                  threadId: invocation.threadId,
                  expectedProjectId: "project:j5:mcp-home",
                  expectedParticipantId: callerParticipantId,
                  activeHomes: ["project:j5:mcp-home", "project:j5:mcp-extra"],
                }),
              )
            : Ref.update(sends, (items) => [...items, input]).pipe(
                Effect.as({
                  messageId: LedgerMessageId.make("message:j5:mcp-handler"),
                  exchangeId: null,
                  exchangeState: "none" as const,
                  joinedExistingExchange: false,
                  durableAtSeq: 1,
                }),
              ),
        sendAsMachine: () => Effect.die("unused"),
        clearOwnAsk: (input) =>
          Ref.update(clears, (items) => [...items, input]).pipe(
            Effect.as({
              exchangeId: input.exchangeId,
              closureKind: "sender-cleared" as const,
              closedAt: input.acceptedAt,
              withdrawalQueued: false,
            }),
          ),
        listParticipants: () =>
          Effect.die(new Error("j5_send_message must not resolve the participant directory")),
      }),
    );
    const dependencies = Layer.mergeAll(
      sendService,
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(OrchestratorV2)({}),
      unusedLifecycleDependencies,
      NodeServices.layer,
      SqlitePersistence.layerMemory,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (args: J5SendMessageInput) =>
        toolkit
          .handle("j5_send_message", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      const callClear = (exchangeId: ExchangeId, clientRequestId: string) =>
        toolkit
          .handle("j5_clear_own_ask", {
            exchange_id: exchangeId,
            client_request_id: clientRequestId,
          })
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      const sendArguments = {
        to: participantId,
        message: "Idempotent MCP send",
        client_request_id: "shared-logical-request-1",
      };
      yield* call(sendArguments);
      yield* call(sendArguments);
      yield* call({
        to: participantId,
        message: "Omitted optional MCP fields stay absent.",
      });
      yield* call({
        to: participantId,
        message: "Null optional MCP fields stay absent.",
        client_request_id: null,
        expect_reply: null,
        exchange_id: null,
        intent: null,
        urgency: null,
      });
      const selfSend = yield* call({
        to: callerParticipantId,
        message: "This must be rejected before storage.",
      });
      assert.isTrue(selfSend.isFailure);
      const selfSendMessage = (selfSend.result as unknown as { readonly message: string }).message;
      assert.include(selfSendMessage, callerParticipantId);
      assert.include(selfSendMessage, "j5_list_participants");
      assert.include(selfSendMessage, "schedule_task");
      assert.notInclude(selfSendMessage, "Memo");
      const multiMembership = yield* call({
        to: multiMembershipRecipientId,
        message: "Preserve the sender membership error.",
      });
      assert.isTrue(multiMembership.isFailure);
      assert.deepInclude(multiMembership.result, {
        code: "A2AHomeMembershipStateError",
      });
      const multiMembershipMessage = (
        multiMembership.result as unknown as { readonly message: string }
      ).message;
      assert.include(multiMembershipMessage, "is registered as");
      assert.include(multiMembershipMessage, "but its active membership is");
      const captured = yield* Ref.get(sends);
      assert.lengthOf(captured, 4);
      assert.equal(captured[0]?.commandId, captured[1]?.commandId);
      assert.equal(
        captured[0]?.commandId,
        "command:j5:a2a:mcp:provider-session%3Aj5%3Amcp-handler:send_message:shared-logical-request-1",
      );
      assert.equal(captured[0]?.senderThreadId, invocation.threadId);
      for (const input of captured.slice(2)) {
        assert.notProperty(input, "expectReply");
        assert.notProperty(input, "exchangeId");
        assert.notProperty(input, "intent");
        assert.notProperty(input, "urgency");
      }
      const exchangeId = ExchangeId.make("exchange:j5:mcp-handler:clear");
      yield* callClear(exchangeId, "shared-logical-request-1");
      yield* callClear(exchangeId, "shared-logical-request-1");
      const capturedClears = yield* Ref.get(clears);
      assert.lengthOf(capturedClears, 2);
      assert.equal(capturedClears[0]?.commandId, capturedClears[1]?.commandId);
      assert.equal(
        capturedClears[0]?.commandId,
        "command:j5:a2a:mcp:provider-session%3Aj5%3Amcp-handler:clear_own_ask:shared-logical-request-1",
      );
      assert.notEqual(captured[0]?.commandId, capturedClears[0]?.commandId);
      assert.equal(capturedClears[0]?.senderThreadId, invocation.threadId);
      assert.equal(capturedClears[0]?.exchangeId, exchangeId);
    }).pipe(Effect.provide(layer));
  }),
);
it.effect(
  "checks a steer or restart against the caller's modes and a queued send against nothing",
  () =>
    Effect.gen(function* () {
      const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-send-mode");
      const callerParticipantId = ParticipantId.make("agent:j5:mcp-send-mode-caller");
      const targetParticipantId = ParticipantId.make("agent:j5:mcp-send-mode-target");
      const personParticipantId = ParticipantId.make("human:mcp-send-mode");
      const targetThreadId = ThreadId.make("thread:j5:mcp-send-mode-target");
      const sends = yield* Ref.make<ReadonlyArray<SendMessageInput>>([]);
      const callerRuntimeMode = yield* Ref.make<RuntimeMode>("full-access");
      const row = (
        participant: ParticipantDirectoryRow["participant"],
      ): ParticipantDirectoryRow => ({
        projectId: ledgerProjectId,
        participantId: participant.id,
        participant,
        archived: false,
        canReceiveMessage: participant.kind === "agent",
        canOpenExchange: true,
        acceptsUrgency: participant.kind === "human",
      });
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          A2ASendService,
          A2ASendService.of({
            send: (input) =>
              Ref.update(sends, (items) => [...items, input]).pipe(
                Effect.as({
                  messageId: LedgerMessageId.make("message:j5:mcp-send-mode"),
                  exchangeId: null,
                  exchangeState: "none" as const,
                  joinedExistingExchange: false,
                  durableAtSeq: 1,
                }),
              ),
            sendAsMachine: () => Effect.die("unused"),
            clearOwnAsk: () => Effect.die("unused"),
            listParticipants: () =>
              Effect.succeed([
                row({ kind: "agent", id: callerParticipantId, threadId: invocation.threadId }),
                row({ kind: "agent", id: targetParticipantId, threadId: targetThreadId }),
                row({ kind: "human", id: personParticipantId }),
              ]),
          }),
        ),
        Layer.mock(ParticipantPlacementService)({}),
        Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
        Layer.mock(OrchestratorV2)({}),
        // The target runs in full access; the caller's mode is the variable.
        threadManagementMock({
          getThreadShell: (threadId) =>
            Ref.get(callerRuntimeMode).pipe(
              Effect.map((runtimeMode) =>
                threadId === invocation.threadId
                  ? liveThreadShell(threadId, { runtimeMode })
                  : threadId === targetThreadId
                    ? liveThreadShell(threadId)
                    : null,
              ),
            ),
        }),
        Layer.mock(A2AHomeRegistrar)({
          getHomeForThread: (threadId) => Effect.fail(new A2AHomeNotFoundError({ threadId })),
        }),
        Layer.mock(A2ALedger)({}),
        Layer.mock(SpawnCompositionService)({}),
        Layer.mock(OrchestratorMcpService)({}),
        Layer.mock(AgentCrewInstanceService)({}),
        Layer.mock(ArchiveCrewService)({}),
        Layer.mock(CrewStopService)({}),
        Layer.mock(CrewProposalService)({}),
        peerDirectoryNoneLayer,
        Layer.mock(ProjectService)({}),
        serverConfigLayer,
        Layer.mock(ThreadRegistration)({}),
        NodeServices.layer,
        SqlitePersistence.layerMemory,
      );
      const layer = J5ToolkitHandlersLive.pipe(
        Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
        Layer.provideMerge(dependencies),
      );

      yield* Effect.gen(function* () {
        const toolkit = yield* J5Toolkit;
        const call = (args: J5SendMessageInput) =>
          toolkit
            .handle("j5_send_message", args)
            .pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(McpInvocationContext, scope),
            );
        const message = "Land this the way I asked.";

        assert.isFalse(
          (yield* call({ to: targetParticipantId, message, mode: "steer" })).isFailure,
        );
        assert.isFalse(
          (yield* call({ to: targetParticipantId, message, mode: "queue" })).isFailure,
        );
        assert.deepStrictEqual(
          (yield* Ref.get(sends)).map((send) => send.mode),
          ["steer", undefined],
          "queue is the default and is not recorded",
        );

        const toPerson = yield* call({ to: personParticipantId, message, mode: "steer" });
        assert.isTrue(toPerson.isFailure);
        assert.include(JSON.stringify(toPerson.encodedResult), "reaches only an agent");

        yield* Ref.set(callerRuntimeMode, "approval-required");
        for (const mode of ["steer", "restart"] as const) {
          const refused = yield* call({ to: targetParticipantId, message, mode });
          assert.isTrue(refused.isFailure);
          assert.include(JSON.stringify(refused.encodedResult), "broader permissions than you do");
        }
        // The same narrower caller may still send the message to wait its turn.
        assert.isFalse((yield* call({ to: targetParticipantId, message })).isFailure);
        assert.lengthOf(yield* Ref.get(sends), 3);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("keeps participant listing placement-read-only", () =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-placement-handler");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-placement-caller");
    const forkedParticipantId = ParticipantId.make("agent:j5:mcp-placement-forked");
    const personParticipantId = ParticipantId.make("human:placement-person");
    const displayParentId = ParticipantId.make("agent:j5:mcp-display-parent");
    const forkSourceId = ParticipantId.make("agent:j5:mcp-fork-source");
    const placementWrites = yield* Ref.make(0);
    const callerRow = {
      projectId: ledgerProjectId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const forkedRow = {
      projectId: ledgerProjectId,
      participantId: forkedParticipantId,
      participant: {
        kind: "agent" as const,
        id: forkedParticipantId,
        threadId: ThreadId.make("thread:j5:mcp-placement-forked"),
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const humanRow = {
      projectId: ledgerProjectId,
      participantId: personParticipantId,
      participant: { kind: "human" as const, id: personParticipantId },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: true,
    } satisfies ParticipantDirectoryRow;
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("j5_send_message is outside this placement-handler test"),
        clearOwnAsk: () => Effect.die("j5_clear_own_ask is outside this placement-handler test"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed([callerRow, forkedRow, humanRow]),
      }),
    );
    const placementService = Layer.mock(ParticipantPlacementService)({
      recordCreation: () =>
        Ref.update(placementWrites, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("the read handler must not repair placement")),
        ),
      listParticipants: () =>
        Effect.succeed([
          {
            projectId: ledgerProjectId,
            participantId: callerParticipantId,
            participant: callerRow.participant,
            threadId: invocation.threadId,
            provenance: {
              kind: "spawned-by" as const,
              spawnedByParticipantId: displayParentId,
              source: "j5_spawn" as const,
            },
            placementParentId: displayParentId,
          },
          {
            projectId: ledgerProjectId,
            participantId: forkedParticipantId,
            participant: forkedRow.participant,
            threadId: forkedRow.participant.threadId,
            provenance: {
              kind: "forked-from" as const,
              sourceParticipantId: forkSourceId,
              source: "upstream_lineage" as const,
            },
            placementParentId: callerParticipantId,
          },
        ]),
    });
    const dependencies = Layer.mergeAll(
      sendService,
      placementService,
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(OrchestratorV2)({
        getShellSnapshot: () =>
          Effect.fail(new OrchestratorProjectionError({ threadId: invocation.threadId })),
      }),
      unusedLifecycleDependencies,
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const callList = () =>
        toolkit
          .handle("j5_list_participants", {})
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      const listed = yield* callList();
      const listedRows = (yield* decodeJ5ListParticipantsResult(listed.encodedResult)).participants;
      assert.deepStrictEqual(listedRows[0]?.provenance, {
        kind: "spawned-by",
        spawned_by_participant_id: displayParentId,
        source: "j5_spawn",
      });
      assert.equal(listedRows[0]?.self, true);
      assert.equal(listedRows[0]?.can_receive_message, false);
      assert.equal(listedRows[0]?.can_open_exchange, false);
      assert.equal(listedRows[0]?.placement_parent_id, displayParentId);
      // The caller, then the people, then the project's other agents.
      assert.deepStrictEqual(
        listedRows.map((row) => row.participant_id),
        [callerParticipantId, personParticipantId, forkedParticipantId],
      );
      assert.deepStrictEqual(listedRows[1]?.provenance, { kind: "not-applicable" });
      assert.equal(listedRows[1]?.placement_parent_id, null);
      assert.equal(listedRows[1]?.self, false);
      assert.deepStrictEqual(listedRows[2]?.provenance, {
        kind: "forked-from",
        source_participant_id: forkSourceId,
        source: "upstream_lineage",
      });
      assert.equal(listedRows[2]?.placement_parent_id, callerParticipantId);
      assert.equal(listedRows[2]?.self, false);
      for (const camelCaseKey of forbiddenCamelCaseKeys) {
        assert.isFalse(hasKey(listed.encodedResult, camelCaseKey));
      }
      assert.equal(yield* Ref.get(placementWrites), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("lists active and archived agent titles with one ambient shell snapshot", () =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make("ledger:j5:mcp-directory");
    const activeThreadId = ThreadId.make("thread:j5:mcp-directory:active");
    const archivedThreadId = ThreadId.make("thread:j5:mcp-directory:archived");
    const missingThreadId = ThreadId.make("thread:j5:mcp-directory:missing");
    const activeParticipantId = ParticipantId.make("agent:j5:mcp-directory:active");
    const archivedParticipantId = ParticipantId.make("agent:j5:mcp-directory:archived");
    const missingParticipantId = ParticipantId.make("agent:j5:mcp-directory:missing");
    const humanParticipantId = ParticipantId.make("human:j5:mcp-directory");
    const row = (participant: ParticipantDirectoryRow["participant"]): ParticipantDirectoryRow => ({
      projectId: ledgerProjectId,
      participantId: participant.id,
      participant,
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: participant.kind === "human",
    });
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-directory:caller");
    const otherLedgerProjectId = LedgerProjectId.make("ledger:j5:mcp-directory:other");
    const emptyLedgerProjectId = LedgerProjectId.make("ledger:j5:mcp-directory:empty");
    const elsewhereParticipantId = ParticipantId.make("agent:j5:mcp-directory:elsewhere");
    const elsewhereThreadId = ThreadId.make("thread:j5:mcp-directory:elsewhere");
    const rows = [
      row({ kind: "agent", id: callerParticipantId, threadId: invocation.threadId }),
      row({ kind: "agent", id: activeParticipantId, threadId: activeThreadId }),
      row({ kind: "agent", id: archivedParticipantId, threadId: archivedThreadId }),
      row({ kind: "agent", id: missingParticipantId, threadId: missingThreadId }),
      row({ kind: "human", id: humanParticipantId }),
      // Another project's agent: listed only when that project is named.
      {
        ...row({ kind: "agent", id: elsewhereParticipantId, threadId: elsewhereThreadId }),
        projectId: otherLedgerProjectId,
      },
    ];
    const now = DateTime.makeUnsafe("2026-08-29T12:00:00.000Z");
    const modelSelection = {
      instanceId: invocation.providerInstanceId,
      model: "gpt-5.6-sol",
    } satisfies ModelSelection;
    const projectId = ProjectId.make("project:j5:mcp-directory");
    const shell = (input: {
      readonly id: ThreadId;
      readonly title: string;
      readonly archivedAt: DateTime.Utc | null;
      readonly settled?: boolean;
    }): OrchestrationV2ThreadShell => ({
      createdBy: "agent",
      creationSource: "mcp",
      id: input.id,
      projectId,
      title: input.title,
      providerInstanceId: invocation.providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.id,
      },
      forkedFrom: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      // The settled thread is the one touched last, so it lists first among the agents.
      updatedAt: input.settled === true ? DateTime.add(now, { minutes: 1 }) : now,
      archivedAt: input.archivedAt,
      settledOverride: input.settled === true ? "settled" : null,
      settledAt: input.settled === true ? now : null,
      deletedAt: null,
    });
    const activeShell = shell({
      id: activeThreadId,
      title: "Release reviewer",
      archivedAt: null,
    });
    const archivedShell = shell({
      id: archivedThreadId,
      title: "Archived researcher",
      archivedAt: now,
      settled: true,
    });
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("unused"),
        clearOwnAsk: () => Effect.die("unused"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed(rows),
      }),
    );
    const shellSnapshotCalls = yield* Ref.make(0);
    const orchestrator = Layer.mock(OrchestratorV2)({
      getShellSnapshot: () =>
        Ref.update(shellSnapshotCalls, (calls) => calls + 1).pipe(
          Effect.as({
            schemaVersion: 2,
            snapshotSequence: 1,
            threads: [activeShell],
            archivedThreads: [archivedShell],
          }),
        ),
    });
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sendService,
          orchestrator,
          Layer.mock(ParticipantPlacementService)({
            // A project nobody has worked in yet has no ledger to place anything in.
            listParticipants: (projectId) =>
              projectId === emptyLedgerProjectId
                ? Effect.fail(new PlacementProjectNotFoundError({ projectId }))
                : Effect.succeed([]),
          }),
          Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
          unusedLifecycleDependencies,
          NodeServices.layer,
        ),
      ),
    );

    const call = (input: J5ListParticipantsInput) =>
      Effect.gen(function* () {
        const toolkit = yield* J5Toolkit;
        return yield* toolkit
          .handle("j5_list_participants", input)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      }).pipe(Effect.provide(layer));
    const list = (input: J5ListParticipantsInput) =>
      call(input).pipe(
        Effect.flatMap((response) => decodeJ5ListParticipantsResult(response.encodedResult)),
      );
    const ids = (listing: typeof J5ListParticipantsResult.Type) =>
      listing.participants.map((participant) => participant.participant_id);
    const result = yield* call({});
    const directory = yield* decodeJ5ListParticipantsResult(result.encodedResult);
    assert.equal(yield* Ref.get(shellSnapshotCalls), 1);
    assert.equal(directory.total, 5);
    assert.equal(directory.next_cursor, null);

    assert.deepStrictEqual(directory.participants, [
      {
        project_id: ledgerProjectId,
        project_title: "Directory project",
        participant_id: callerParticipantId,
        participant: { kind: "agent", id: callerParticipantId, thread_id: invocation.threadId },
        self: true,
        archived: false,
        can_receive_message: false,
        can_open_exchange: false,
        accepts_urgency: false,
        thread_id: invocation.threadId,
        provenance: { kind: "unrecorded" },
        placement_parent_id: null,
        display_name: null,
      },
      {
        project_id: ledgerProjectId,
        project_title: "Directory project",
        participant_id: humanParticipantId,
        participant: { kind: "human", id: humanParticipantId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: true,
        thread_id: null,
        provenance: { kind: "not-applicable" },
        placement_parent_id: null,
        display_name: null,
      },
      {
        project_id: ledgerProjectId,
        project_title: "Directory project",
        participant_id: archivedParticipantId,
        participant: { kind: "agent", id: archivedParticipantId, thread_id: archivedThreadId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: false,
        thread_id: archivedThreadId,
        provenance: { kind: "unrecorded" },
        placement_parent_id: null,
        display_name: "Archived researcher",
      },
      {
        project_id: ledgerProjectId,
        project_title: "Directory project",
        participant_id: activeParticipantId,
        participant: { kind: "agent", id: activeParticipantId, thread_id: activeThreadId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: false,
        thread_id: activeThreadId,
        provenance: { kind: "unrecorded" },
        placement_parent_id: null,
        display_name: "Release reviewer",
      },
      {
        project_id: ledgerProjectId,
        project_title: "Directory project",
        participant_id: missingParticipantId,
        participant: { kind: "agent", id: missingParticipantId, thread_id: missingThreadId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: false,
        thread_id: missingThreadId,
        provenance: { kind: "unrecorded" },
        placement_parent_id: null,
        display_name: null,
      },
    ]);
    for (const camelCaseKey of forbiddenCamelCaseKeys) {
      assert.isFalse(hasKey(result.encodedResult, camelCaseKey));
    }

    const firstPage = yield* list({ limit: 2 });
    assert.deepStrictEqual(ids(firstPage), [callerParticipantId, humanParticipantId]);
    assert.equal(firstPage.next_cursor, 2);
    assert.equal(firstPage.total, 5);
    const lastPage = yield* list({ limit: 2, cursor: 4 });
    assert.deepStrictEqual(ids(lastPage), [missingParticipantId]);
    assert.equal(lastPage.next_cursor, null);

    assert.deepStrictEqual(
      ids(yield* list({ name_contains: "RELEASE" })),
      [callerParticipantId, humanParticipantId, activeParticipantId],
      "the name filter ignores case, and keeps the caller and the people",
    );
    assert.deepStrictEqual(ids(yield* list({ settled: true })), [
      callerParticipantId,
      humanParticipantId,
      archivedParticipantId,
    ]);
    assert.deepStrictEqual(ids(yield* list({ settled: false })), [
      callerParticipantId,
      humanParticipantId,
      activeParticipantId,
      missingParticipantId,
    ]);

    const elsewhere = yield* list({ project_id: otherLedgerProjectId });
    assert.deepStrictEqual(
      ids(elsewhere),
      [humanParticipantId, elsewhereParticipantId],
      "another project lists its own agents, and the people",
    );
    assert.deepStrictEqual(
      elsewhere.participants.map((row) => row.project_id),
      [otherLedgerProjectId, otherLedgerProjectId],
      "a person's row carries the project being listed, not the caller's",
    );
    assert.deepStrictEqual(
      ids(yield* list({ project_id: emptyLedgerProjectId })),
      [humanParticipantId],
      "a project with no agents yet lists the people",
    );
    const gone = yield* call({ project_id: LedgerProjectId.make(missingProjectId) });
    assert.isTrue(gone.isFailure);
    assert.include(JSON.stringify(gone.encodedResult), `no project ${missingProjectId}`);
  }),
);

it.effect("returns null display names when the ambient shell snapshot fails", () =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-directory:snapshot-failure");
    const agentParticipantId = ParticipantId.make("agent:j5:mcp-directory:snapshot-failure");
    const humanParticipantId = ParticipantId.make("human:j5:mcp-directory:snapshot-failure");
    const rows: ReadonlyArray<ParticipantDirectoryRow> = [
      {
        projectId: ledgerProjectId,
        participantId: agentParticipantId,
        participant: {
          kind: "agent",
          id: agentParticipantId,
          threadId: invocation.threadId,
        },
        archived: false,
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: false,
      },
      {
        projectId: ledgerProjectId,
        participantId: humanParticipantId,
        participant: { kind: "human", id: humanParticipantId },
        archived: false,
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: true,
      },
    ];
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("unused"),
        clearOwnAsk: () => Effect.die("unused"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed(rows),
      }),
    );
    const shellSnapshotCalls = yield* Ref.make(0);
    const orchestrator = Layer.mock(OrchestratorV2)({
      getShellSnapshot: () =>
        Ref.update(shellSnapshotCalls, (calls) => calls + 1).pipe(
          Effect.andThen(
            Effect.fail(new OrchestratorProjectionError({ threadId: invocation.threadId })),
          ),
        ),
    });
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sendService,
          orchestrator,
          Layer.mock(ParticipantPlacementService)({
            listParticipants: () => Effect.succeed([]),
          }),
          Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
          unusedLifecycleDependencies,
          NodeServices.layer,
        ),
      ),
    );

    const result = yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      return yield* toolkit
        .handle("j5_list_participants", {})
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, scope),
        );
    }).pipe(Effect.provide(layer));
    const directory = yield* decodeJ5ListParticipantsResult(result.encodedResult);

    assert.equal(yield* Ref.get(shellSnapshotCalls), 1);
    assert.deepStrictEqual(
      directory.participants.map(({ display_name }) => display_name),
      [null, null],
    );
  }),
);

it.effect("preflights home before creation and records facts before the one stable brief", () =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-spawn");
    const projectTitle = "Release proof project";
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-spawn-caller");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-spawn-child");
    const failFacts = yield* Ref.make(false);
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const facts = yield* Ref.make<
      ReadonlyArray<{
        readonly homeCommandId: string;
        readonly placementCommandId: string;
        readonly spawnedByParticipantId: ParticipantId;
        readonly threadId: ThreadId;
      }>
    >([]);
    const callerRow = {
      projectId: ledgerProjectId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("j5_send_message is outside this spawn test"),
        clearOwnAsk: () => Effect.die("j5_clear_own_ask is outside this spawn test"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed([callerRow]),
      }),
    );
    const homeService = Layer.mock(A2AHomeRegistrar)({
      getHomeForThread: () =>
        Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
    });
    const ledger = Layer.mock(A2ALedger)({
      readProjectLedger: () =>
        Effect.succeed({
          id: ledgerProjectId,
          name: projectTitle,
          createdAt: DateTime.formatIso(createdAt),
        }),
    });
    const composition = Layer.mock(SpawnCompositionService)({
      recordFacts: (input) =>
        Ref.get(failFacts).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new PlacementStorageError({
                    operation: "record spawn facts",
                    cause: new Error("injected placement failure"),
                  }),
                )
              : Effect.all(
                  [
                    Ref.update(order, (items) => [...items, "facts"]),
                    Ref.update(facts, (items) => [
                      ...items,
                      {
                        homeCommandId: input.homeCommandId,
                        placementCommandId: input.placementCommandId,
                        spawnedByParticipantId:
                          input.provenance.kind === "spawned-by"
                            ? input.provenance.spawnedByParticipantId
                            : callerParticipantId,
                        threadId: input.threadId,
                      },
                    ]),
                  ],
                  { discard: true },
                ).pipe(
                  Effect.as({
                    home: { projectId: ledgerProjectId, participantId: childParticipantId },
                    placement: {
                      projectId: ledgerProjectId,
                      participantId: childParticipantId,
                      provenance: {
                        kind: "spawned-by" as const,
                        spawnedByParticipantId: callerParticipantId,
                        source: "j5_spawn" as const,
                      },
                      placementParentId: callerParticipantId,
                      createdEventSeq: 1,
                      updatedEventSeq: 1,
                    },
                  }),
                ),
          ),
        ),
    });
    const threadManagement = threadManagementMock({
      getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
      dispatch: (command) =>
        command.type === "thread.create" && String(command.commandId).includes("spawn-rejected")
          ? Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "injected rejected creation",
              }),
            )
          : Effect.all(
              [
                Ref.update(commands, (items) => [...items, command]),
                Ref.update(order, (items) => [...items, command.type]),
              ],
              { discard: true },
            ).pipe(Effect.as({ events: [], effects: [] } as never)),
    });
    const orchestrator = Layer.mock(OrchestratorMcpService)({
      capabilities: () =>
        Effect.succeed({
          parentThreadId: invocation.threadId,
          inheritedProviderInstanceId: invocation.providerInstanceId,
          inheritedModel: "gpt-5.6-sol",
          runtimeMode: "full-access",
          interactionMode: "default",
          providers: [
            {
              providerInstanceId: ProviderInstanceId.make("codex-luna"),
              driverKind: ProviderDriverKind.make("codex"),
              displayName: "Codex Luna",
              models: [
                {
                  id: "gpt-5.6-luna",
                  label: "GPT-5.6 Luna",
                  options: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select" as const,
                      options: [
                        { id: "medium", label: "Medium" },
                        { id: "high", label: "High" },
                      ],
                    },
                  ],
                },
                {
                  id: "grok-custom-optionless",
                  label: "Grok Custom Optionless",
                },
              ],
              canRunChildTask: true,
              canRunCrossProviderChildTask: true,
              constraints: [],
            },
          ],
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: true,
            threadManagement: true,
            incrementalThreadRead: true,
            scheduledTasks: true,
            maxBatchThreads: 8,
          },
        }),
    });
    const dependencies = Layer.mergeAll(
      sendService,
      homeService,
      ledger,
      composition,
      threadManagement,
      orchestrator,
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),

      Layer.mock(ThreadRegistration)({
        ensureRegistered: () =>
          Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
      }),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (args: J5SpawnAgentInput) =>
        toolkit
          .handle("j5_spawn_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      const args = {
        workspace: { type: "shared" as const },
        brief: "Prove the post-#18 verb slice and report the result.",
        provider: ProviderInstanceId.make("codex-luna"),
        model: "gpt-5.6-luna",
        reasoning: "high",
        client_request_id: "spawn-peer-1",
      } satisfies J5SpawnAgentInput;
      const first = yield* call(args);
      const replay = yield* call(args);
      assert.isFalse(first.isFailure);
      assert.deepStrictEqual(replay.result, first.result);
      assert.deepStrictEqual(first.result, {
        participant_id: childParticipantId,
        thread_id: (first.result as { readonly thread_id: ThreadId }).thread_id,
        project_id: ledgerProjectId,
        project_title: projectTitle,
        placement: {
          placement_parent_id: callerParticipantId,
          provenance: {
            kind: "spawned-by",
            spawned_by_participant_id: callerParticipantId,
            source: "j5_spawn",
          },
        },
      });
      assert.deepStrictEqual(yield* Ref.get(order), [
        "thread.create",
        "facts",
        "message.dispatch",
        "thread.create",
        "facts",
        "message.dispatch",
      ]);
      const capturedCommands = yield* Ref.get(commands);
      assert.equal(capturedCommands[0]?.commandId, capturedCommands[2]?.commandId);
      assert.equal(capturedCommands[1]?.commandId, capturedCommands[3]?.commandId);
      const capturedFacts = yield* Ref.get(facts);
      assert.deepStrictEqual(capturedFacts[1], capturedFacts[0]);
      const create = capturedCommands[0];
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.notProperty(create, "parentThreadId");
        assert.deepStrictEqual(create.modelSelection, {
          instanceId: ProviderInstanceId.make("codex-luna"),
          model: "gpt-5.6-luna",
          options: [{ id: "reasoningEffort", value: "high" }],
        });
      }
      const firstTurn = capturedCommands[1];
      assert.equal(firstTurn?.type, "message.dispatch");
      if (firstTurn?.type === "message.dispatch") {
        assert.equal(
          firstTurn.text,
          `<j5_spawn_context>\nPlatform-provided identity facts:\nparticipant_id: ${childParticipantId}\nproject_id: ${ledgerProjectId}\nproject_title: ${projectTitle}\nspawned_by: ${callerParticipantId}\nspawner_thread_id: ${invocation.threadId}\n</j5_spawn_context>\n\n<spawner_brief>\n${args.brief}\n</spawner_brief>`,
        );
      }
      const replayTurn = capturedCommands[3];
      assert.equal(replayTurn?.type, "message.dispatch");
      if (firstTurn?.type === "message.dispatch" && replayTurn?.type === "message.dispatch") {
        assert.equal(replayTurn.commandId, firstTurn.commandId);
        assert.equal(replayTurn.messageId, firstTurn.messageId);
        assert.equal(replayTurn.text, firstTurn.text);
      }
      assert.equal(capturedFacts[0]?.spawnedByParticipantId, callerParticipantId);
      const invalidReasoning = yield* call({
        ...args,
        reasoning: "ultra",
        client_request_id: "spawn-invalid-reasoning",
      });
      assert.isTrue(invalidReasoning.isFailure);
      assert.include(
        (invalidReasoning.result as unknown as { readonly message: string }).message,
        "Reasoning ultra is not listed",
      );
      assert.lengthOf(yield* Ref.get(commands), 4);

      const optionless = yield* call({
        ...args,
        model: "grok-custom-optionless",
        client_request_id: "spawn-optionless-model",
      });
      assert.isTrue(optionless.isFailure);
      assert.include(
        (optionless.result as unknown as { readonly message: string }).message,
        "Model grok-custom-optionless on provider codex-luna exposes no reasoning options; j5_spawn_agent requires explicit reasoning selection",
      );
      assert.lengthOf(yield* Ref.get(commands), 4);

      const rejected = yield* call({
        ...args,
        client_request_id: "spawn-rejected-create",
      });
      assert.isTrue(rejected.isFailure);
      assert.include(
        (rejected.result as unknown as { readonly message: string }).message,
        "fresh client_request_id; the rejected key is permanently bound",
      );
      assert.lengthOf(yield* Ref.get(commands), 4);

      yield* Ref.set(failFacts, true);
      const orphaned = yield* call({
        ...args,
        client_request_id: "spawn-facts-fail",
      });
      assert.isTrue(orphaned.isFailure);
      const orphanedMessage = (orphaned.result as unknown as { readonly message: string }).message;
      assert.include(orphanedMessage, "visible orphan without committed home/placement facts");
      assert.include(orphanedMessage, "after A9 lifecycle support lands");
      assert.lengthOf(yield* Ref.get(commands), 5);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses spawn before thread creation when the caller is a Subagent", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make(0);
    const dependencies = Layer.mergeAll(
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: (threadId) => Effect.fail(new A2AHomeNotFoundError({ threadId })),
      }),
      Layer.mock(A2ALedger)({}),
      Layer.mock(A2ASendService)({}),
      Layer.mock(SpawnCompositionService)({}),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(OrchestratorMcpService)({}),
      peerDirectoryNoneLayer,
      threadManagementMock({
        dispatch: () => Ref.update(dispatches, (count) => count + 1).pipe(Effect.as({} as never)),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),

      // Registration answers null for a thread that is never a participant.
      Layer.mock(ThreadRegistration)({ ensureRegistered: () => Effect.succeed(null) }),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const result = yield* toolkit
        .handle("j5_spawn_agent", {
          workspace: { type: "shared" as const },
          brief: "This must never start.",
          provider: ProviderInstanceId.make("codex-luna"),
          model: "gpt-5.6-luna",
          reasoning: "high",
        })
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, scope),
        );
      assert.isTrue(result.isFailure);
      assert.include(
        (result.result as unknown as { readonly message: string }).message,
        "is a Subagent and is not an agent-to-agent participant",
      );
      assert.equal(yield* Ref.get(dispatches), 0);
    }).pipe(Effect.provide(layer));
  }),
);

const personaProvider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ readonly slug: string; readonly options: ReadonlyArray<string> }>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-09T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: models.map((model) => ({
    slug: model.slug,
    name: model.slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          label: "Reasoning",
          type: "select",
          options: model.options.map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
});

const personaCapabilityProvider = (provider: ServerProvider) => ({
  providerInstanceId: provider.instanceId,
  driverKind: provider.driver,
  displayName: String(provider.instanceId),
  models: provider.models.map((model) => ({
    id: model.slug,
    label: model.name,
    options: model.capabilities?.optionDescriptors?.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      type: "select" as const,
      options: descriptor.type === "select" ? descriptor.options : [],
    })),
  })),
  canRunChildTask: true,
  canRunCrossProviderChildTask: true,
  constraints: [],
});

it.effect("spawns a saved agent as a Peer Agent only within its declared routes", () =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-spawn-persona");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-spawn-persona-caller");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-spawn-persona-child");
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const codex = personaProvider("codex", "codex", [
      { slug: "gpt-5.6-terra", options: ["medium", "high"] },
      { slug: "gpt-5.6-sol", options: ["high"] },
    ]);
    const claude = personaProvider("claudeAgent", "claudeAgent", [
      { slug: "claude-opus-5", options: ["high"] },
    ]);
    const callerRow = {
      projectId: ledgerProjectId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([callerRow]) }),
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: () =>
          Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
      }),
      Layer.mock(A2ALedger)({
        readProjectLedger: () =>
          Effect.succeed({
            id: ledgerProjectId,
            name: "Persona",
            createdAt: DateTime.formatIso(createdAt),
          }),
      }),
      Layer.mock(SpawnCompositionService)({
        recordFacts: (input) =>
          Effect.succeed({
            home: { projectId: ledgerProjectId, participantId: childParticipantId },
            placement: {
              projectId: ledgerProjectId,
              participantId: childParticipantId,
              provenance: input.provenance,
              placementParentId:
                input.provenance.kind === "spawned-by"
                  ? input.provenance.spawnedByParticipantId
                  : null,
              createdEventSeq: 1,
              updatedEventSeq: 1,
            },
          }),
      }),
      threadManagementMock({
        getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
        dispatch: (command) =>
          Ref.update(commands, (items) => [...items, command]).pipe(
            Effect.as({ events: [], effects: [] } as never),
          ),
      }),
      Layer.mock(OrchestratorMcpService)({
        capabilities: () =>
          Effect.succeed({
            parentThreadId: invocation.threadId,
            inheritedProviderInstanceId: invocation.providerInstanceId,
            inheritedModel: "gpt-5.6-sol",
            runtimeMode: "full-access",
            interactionMode: "default",
            providers: [personaCapabilityProvider(codex), personaCapabilityProvider(claude)],
            features: {
              appOwnedSubagents: true,
              asyncPolling: true,
              cancellation: true,
              batchThreadCreation: true,
              threadManagement: true,
              incrementalThreadRead: true,
              scheduledTasks: true,
              maxBatchThreads: 8,
            },
          }),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codex, claude]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),
      Layer.mock(ThreadRegistration)({
        ensureRegistered: () =>
          Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
      }),

      ServerConfig.layerTest(process.cwd(), { prefix: "j5-mcp-spawn-persona-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (args: J5SpawnAgentInput) =>
        toolkit
          .handle("j5_spawn_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      const failureMessage = (response: { readonly result: unknown }) =>
        (response.result as { readonly message: string }).message;
      const createdThreads = () =>
        Ref.get(commands).pipe(
          Effect.map((items) =>
            items.flatMap((command) => (command.type === "thread.create" ? [command] : [])),
          ),
        );
      const briefs = () =>
        Ref.get(commands).pipe(
          Effect.map((items) =>
            items.flatMap((command) => (command.type === "message.dispatch" ? [command] : [])),
          ),
        );
      const scout = {
        workspace: { type: "shared" as const },
        brief: "Collect evidence about the auth flow and report back.",
        persona: "scout",
        provider: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        reasoning: "high",
        client_request_id: "spawn-persona-primary",
      } satisfies J5SpawnAgentInput;

      const primary = yield* call(scout);
      assert.isFalse(primary.isFailure, failureMessage(primary));
      const created = yield* createdThreads();
      assert.lengthOf(created, 1);
      const assignment = created[0]!.agentPersonaAssignment;
      assert.isDefined(assignment);
      assert.equal(assignment?.personaId, "scout");
      assert.equal(assignment?.displayName, "Scout");
      assert.equal(assignment?.resolvedRoute, "primary");
      assert.equal(assignment?.resolvedDriver, "codex");
      assert.equal(assignment?.authorityPolicy, "read-only");
      assert.match(assignment?.definitionDigest ?? "", /^[a-f0-9]{64}$/);
      const expectedSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      assert.deepStrictEqual(created[0]!.modelSelection, expectedSelection);
      assert.deepStrictEqual(assignment?.resolvedModelSelection, expectedSelection);
      assert.equal(created[0]!.runtimeMode, "approval-required");
      assert.deepStrictEqual((yield* briefs())[0]!.modelSelection, expectedSelection);

      const fallback = yield* call({
        ...scout,
        provider: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
        client_request_id: "spawn-persona-fallback",
      });
      assert.isFalse(fallback.isFailure, failureMessage(fallback));
      const fallbackCreate = (yield* createdThreads())[1]!;
      assert.equal(fallbackCreate.agentPersonaAssignment?.resolvedRoute, "fallback");
      assert.equal(fallbackCreate.agentPersonaAssignment?.resolvedDriver, "claudeAgent");
      assert.deepStrictEqual(fallbackCreate.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      });

      const plain = yield* call({
        workspace: { type: "shared" as const },
        brief: "No saved agent here.",
        provider: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        reasoning: "high",
        client_request_id: "spawn-persona-plain",
      });
      assert.isFalse(plain.isFailure, failureMessage(plain));
      const plainCreate = (yield* createdThreads())[2]!;
      assert.notProperty(plainCreate, "agentPersonaAssignment");
      assert.equal(plainCreate.runtimeMode, "full-access");

      const commandCount = (yield* Ref.get(commands)).length;
      const outOfRoute = yield* call({
        ...scout,
        reasoning: "medium",
        client_request_id: "spawn-persona-out-of-route",
      });
      assert.isTrue(outOfRoute.isFailure);
      assert.include(failureMessage(outOfRoute), "Agent scout allows only");
      assert.include(failureMessage(outOfRoute), "outside its declared routes");
      assert.include(failureMessage(outOfRoute), "or omit persona");

      const unenforceable = yield* call({
        ...scout,
        persona: "builder",
        provider: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
        client_request_id: "spawn-persona-unenforceable",
      });
      assert.isTrue(unenforceable.isFailure);
      assert.include(
        failureMessage(unenforceable),
        "cannot enforce its workspace-write permissions on claudeAgent",
      );

      const unknown = yield* call({
        ...scout,
        persona: "nobody",
        client_request_id: "spawn-persona-unknown",
      });
      assert.isTrue(unknown.isFailure);
      assert.include(failureMessage(unknown), "Unknown agent nobody");
      assert.lengthOf(yield* Ref.get(commands), commandCount);

      // A persona that declares full access spawns with the ordinary full-access mode.
      const library = yield* makeAgentPersonaLibrary;
      yield* library.importFiles({
        files: [
          {
            name: "operator.yaml",
            content: toYaml({
              ...BUILT_IN_AGENT_PERSONAS.scout,
              id: "operator",
              displayName: "Operator",
              authority: { defaultPolicy: "full-access", allowedPolicies: ["full-access"] },
              modelRoute: BUILT_IN_AGENT_PERSONAS.scout.modelRoute.map((target) => ({ ...target })),
            }),
          },
        ],
        replaceExisting: false,
      });
      const operator = yield* call({
        ...scout,
        persona: "operator",
        client_request_id: "spawn-persona-full-access",
      });
      assert.isFalse(operator.isFailure, failureMessage(operator));
      const operatorCreate = (yield* createdThreads()).at(-1)!;
      assert.equal(operatorCreate.agentPersonaAssignment?.authorityPolicy, "full-access");
      assert.equal(operatorCreate.runtimeMode, "full-access");
      const operatorPolicy = yield* resolveAgentPersonaRuntime(
        {
          agentPersonaAssignment: operatorCreate.agentPersonaAssignment!,
          runtimeMode: operatorCreate.runtimeMode,
        },
        library,
      );
      assert.equal(operatorPolicy.runtimeMode, "full-access");
      assert.notProperty(operatorPolicy, "sandboxPolicy");
      assert.notProperty(operatorPolicy, "approvalPolicy");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("archives a crew only as a unit through its captain with one confirmation", () =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-archive-crew");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-archive-crew-captain");
    const memberParticipantId = ParticipantId.make("agent:j5:mcp-archive-crew-member");
    const archiveCalls = yield* Ref.make<ReadonlyArray<ArchiveCrewInput>>([]);
    const callerRow = {
      projectId: ledgerProjectId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const memberRow = {
      projectId: ledgerProjectId,
      participantId: memberParticipantId,
      participant: {
        kind: "agent" as const,
        id: memberParticipantId,
        threadId: ThreadId.make("thread:j5:mcp-archive-crew-member"),
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const facts = {
      members: [
        {
          seatName: "builder",
          participantId: memberParticipantId,
          threadId: memberRow.participant.threadId,
          alreadyArchived: false,
          neverCreated: false,
          facts: {
            openExchanges: [
              {
                exchangeId: ExchangeId.make("exchange:j5:mcp-archive-crew"),
                direction: "inbound" as const,
                replyObligation: "participant-owes-reply" as const,
                counterpartyId: callerParticipantId,
                intent: "Review the login fix",
                urgency: null,
                openedAt: DateTime.formatIso(createdAt),
              },
            ],
            runningTurn: null,
          },
        },
      ],
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({
        listParticipants: () => Effect.succeed([callerRow, memberRow]),
      }),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(A2ALedger)({}),
      Layer.mock(SpawnCompositionService)({}),
      threadManagementMock({}),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ProviderRegistry)({}),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(AgentCrewInstanceService)({}),
      Layer.mock(CrewProposalService)({}),
      Layer.mock(ArchiveCrewService)({
        archive: (input) =>
          Ref.update(archiveCalls, (items) => [...items, input]).pipe(
            Effect.andThen(
              input.confirmationToken === undefined
                ? Effect.fail(
                    new ArchiveCrewConfirmationRequiredError({
                      facts,
                      confirmationToken: "crew-token",
                    }),
                  )
                : Effect.succeed({
                    status: "archived" as const,
                    members: [
                      {
                        seatName: "builder",
                        participantId: memberParticipantId,
                        result: "archived" as const,
                      },
                    ],
                  }),
            ),
          ),
      }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(CrewStopService)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const message = (response: { readonly result: unknown }) =>
        (response.result as { readonly message: string }).message;
      const run = (args: J5ArchiveCrewInput) =>
        toolkit
          .handle("j5_archive_crew", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      const refused = yield* run({
        crew_instance_id: "crew:j5:test",
        client_request_id: "archive-crew-1",
      });
      assert.isTrue(refused.isFailure);
      const refusal = refused.result as {
        readonly code: string;
        readonly confirmation_token: string;
        readonly members: ReadonlyArray<{
          readonly seat: string;
          readonly participant_id: string;
          readonly already_archived: boolean;
          readonly open_exchanges: ReadonlyArray<{ readonly exchange_id: string }>;
          readonly running_turn: unknown;
        }>;
      };
      assert.equal(refusal.code, "ArchiveCrewConfirmationRequiredError");
      assert.equal(refusal.confirmation_token, "crew-token");
      assert.deepStrictEqual(
        refusal.members.map((member) => [
          member.seat,
          member.participant_id,
          member.already_archived,
          member.open_exchanges.map(({ exchange_id }) => exchange_id),
          member.running_turn,
        ]),
        [["builder", memberParticipantId, false, ["exchange:j5:mcp-archive-crew"], null]],
      );
      assert.include(message(refused), "check with the user");

      const confirmed = yield* run({
        crew_instance_id: "crew:j5:test",
        client_request_id: "archive-crew-1",
        confirmation_token: "crew-token",
      });
      assert.isFalse(confirmed.isFailure, message(confirmed));
      assert.deepStrictEqual(confirmed.result, {
        status: "archived",
        crew_instance_id: "crew:j5:test",
        members: [{ seat: "builder", participant_id: memberParticipantId, result: "archived" }],
      });
      const calls = yield* Ref.get(archiveCalls);
      assert.lengthOf(calls, 2);
      assert.equal(calls[1]?.callerParticipantId, callerParticipantId);
      assert.equal(
        calls[1]?.projectId,
        ledgerProjectId,
        "the Crew is archived in the caller's project",
      );
      assert.equal(calls[1]?.clientRequestKey, "archive-crew-1");
      const ids = calls[1]!.commandIds("builder");
      assert.include(ids.archiveCommandId, "archive-crew-thread");
      assert.include(ids.archiveCommandId, encodeURIComponent("archive-crew-1/seat/builder"));
      assert.notEqual(ids.archiveCommandId, calls[1]!.commandIds("critic").archiveCommandId);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("lists saved agents with purpose, policy, availability, and route", () =>
  Effect.gen(function* () {
    const codex = personaProvider("codex", "codex", [
      { slug: "gpt-5.6-terra", options: ["high"] },
      { slug: "gpt-5.6-sol", options: ["high"] },
    ]);
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({}),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(A2ALedger)({}),
      Layer.mock(SpawnCompositionService)({}),
      threadManagementMock({}),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codex]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),

      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-mcp-list-agents-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const response = yield* toolkit
        .handle("j5_list_personas", {})
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, scope),
        );
      assert.isFalse(response.isFailure);
      const { personas } = response.result as {
        readonly personas: ReadonlyArray<{
          readonly id: string;
          readonly runtime_policy: string;
          readonly availability: string;
          readonly route: string | null;
        }>;
      };
      assert.lengthOf(personas, 11);
      const scout = personas.find((persona) => persona.id === "scout");
      assert.deepStrictEqual(
        [scout?.runtime_policy, scout?.availability, scout?.route],
        ["read-only", "available", "codex · gpt-5.6-terra · high"],
      );
      // Publisher's publish-only policy has no enforceable provider yet, so it cannot start.
      const publisher = personas.find((persona) => persona.id === "publisher");
      assert.deepStrictEqual([publisher?.availability, publisher?.route], ["blocked", null]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("routes crew proposals through a captain that is not itself a crew member", () =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-propose");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-propose-captain");
    const proposals = yield* Ref.make<ReadonlyArray<string>>([]);
    const proposedSeats = yield* Ref.make<ReadonlyArray<CrewProposalSeat>>([]);
    const addedSeats = yield* Ref.make<ReadonlyArray<CrewProposalSeat>>([]);
    const membership = yield* Ref.make<{ crewInstanceId: string; seatName: string } | null>(null);
    const callerRow = {
      projectId: ledgerProjectId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const proposal = (requestKey: string, kind: "roster" | "addition"): CrewProposal => ({
      id: `proposal:${requestKey}`,
      projectId: ledgerProjectId,
      captainParticipantId: callerParticipantId,
      captainThreadId: invocation.threadId,
      crewInstanceId: kind === "addition" ? "crew:1" : null,
      kind,
      status: "open",
      brief: "Fix the flaky login test.",
      displayName: "Login Fix Crew",
      requestedSeats: [
        {
          workspace: { type: "shared" as const },
          seat: "builder",
          agentId: "builder",
          reason: "Implements",
        },
      ],
      approvedSeats: null,
      createdAt: "2026-09-09T16:00:00.000Z",
      resolvedAt: null,
      reportedAt: null,
    });
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([callerRow]) }),
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: () =>
          Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
      }),
      Layer.mock(A2ALedger)({
        readProjectLedger: () =>
          Effect.succeed({
            id: ledgerProjectId,
            name: "Propose",
            createdAt: DateTime.formatIso(createdAt),
          }),
      }),
      Layer.mock(SpawnCompositionService)({}),
      threadManagementMock({
        getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
      }),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ProviderRegistry)({}),
      Layer.mock(AgentCrewInstanceService)({
        findMembership: () => Ref.get(membership),
        listForCaptain: () => Effect.succeed([]),
      }),
      Layer.mock(CrewProposalService)({
        propose: (input) =>
          Ref.update(proposals, (items) => [...items, input.requestKey]).pipe(
            Effect.as({
              proposal: proposal(input.requestKey, "roster"),
              instance: null,
            } satisfies CrewProposalOutcome),
            Effect.tap(() => Ref.set(proposedSeats, input.seats)),
          ),
        requestMember: (input) =>
          Ref.update(proposals, (items) => [...items, input.requestKey]).pipe(
            Effect.tap(() => Ref.update(addedSeats, (seats) => [...seats, input.seat])),
            Effect.as({
              proposal: {
                ...proposal(input.requestKey, "addition"),
                status: "approved" as const,
              },
              instance: {
                id: "crew:1",
                projectId: ledgerProjectId,
                captainParticipantId: callerParticipantId,
                captainThreadId: invocation.threadId,
                displayName: "Login Fix Crew",
                brief: "Fix the flaky login test.",
                version: 2,
                createdAt: "2026-09-09T16:00:00.000Z",
                archivedAt: null,
                members: [
                  {
                    seatName: input.seat.seat,
                    agentId: input.seat.agentId,
                    participantId: ParticipantId.make("agent:j5:a2a:thread:new"),
                    threadId: ThreadId.make("thread:new"),
                    addedVersion: 2,
                    reason: input.seat.reason,
                  },
                ],
              },
            } satisfies CrewProposalOutcome),
          ),
      }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ThreadRegistration)({
        ensureRegistered: () =>
          Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
      }),

      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(PlaybookStore)({}),
      Layer.mock(ProjectService)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
      Layer.provideMerge(dependencies),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const run = <K extends "j5_propose_crew" | "j5_request_crew_member" | "j5_spawn_agent">(
        tool: K,
        args: K extends "j5_propose_crew"
          ? J5ProposeCrewInput
          : K extends "j5_spawn_agent"
            ? J5SpawnAgentInput
            : J5RequestCrewMemberInput,
      ) =>
        toolkit
          .handle(tool, args as never)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, scope),
          );
      const message = (response: { readonly result: unknown }) =>
        (response.result as { readonly message: string }).message;

      const customSelection: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex-custom"),
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      const proposed = yield* run("j5_propose_crew", {
        name: "Login Fix Crew",
        brief: "Fix the flaky login test.",
        seats: [
          {
            workspace: { type: "shared" as const },
            seat: "builder",
            persona: "builder",
            reason: "Implements",
          },
          {
            workspace: { type: "shared" as const },
            seat: "reviewer",
            reason: "Reviews correctness",
            instructions: "Review and report concrete risks.",
            model_selection: customSelection,
            runtime_mode: "approval-required",
          },
          {
            workspace: { type: "shared" as const },
            seat: "researcher",
            reason: "Researches",
            instructions: "Inspect related behavior.",
          },
        ],
        client_request_id: "propose-1",
      });
      assert.isFalse(proposed.isFailure, message(proposed));
      assert.deepStrictEqual(proposed.result, {
        proposal_id: `proposal:${invocation.providerSessionId}:propose-1`,
        status: "open",
        crew_instance_id: null,
        members: [],
      });

      assert.deepStrictEqual(yield* Ref.get(proposedSeats), [
        {
          workspace: { type: "shared" as const },
          seat: "builder",
          agentId: "builder",
          reason: "Implements",
        },
        {
          workspace: { type: "shared" as const },
          seat: "reviewer",
          agentId: null,
          reason: "Reviews correctness",
          instructions: "Review and report concrete risks.",
          modelSelection: customSelection,
          runtimeMode: "approval-required",
        },
        {
          workspace: { type: "shared" as const },
          seat: "researcher",
          agentId: null,
          reason: "Researches",
          instructions: "Inspect related behavior.",
        },
      ]);

      const added = yield* run("j5_request_crew_member", {
        workspace: { type: "shared" as const },
        seat: "security",
        reason: "Security pass",
        instructions: "Review authorization boundaries.",
        model_selection: customSelection,
        runtime_mode: "auto-accept-edits",
        client_request_id: "add-1",
      });
      assert.isFalse(added.isFailure, message(added));
      const addedResult = added.result as unknown as {
        status: string;
        crew_instance_id: string;
        members: unknown[];
      };
      assert.equal(addedResult.status, "approved");
      assert.equal(addedResult.crew_instance_id, "crew:1");
      assert.lengthOf(addedResult.members, 1);
      assert.deepStrictEqual(yield* Ref.get(addedSeats), [
        {
          workspace: { type: "shared" as const },
          seat: "security",
          agentId: null,
          reason: "Security pass",
          instructions: "Review authorization boundaries.",
          modelSelection: customSelection,
          runtimeMode: "auto-accept-edits",
        },
      ]);

      yield* Ref.set(membership, { crewInstanceId: "crew:1", seatName: "builder" });
      const refused = yield* run("j5_propose_crew", {
        name: "Nested",
        brief: "x",
        seats: [
          { workspace: { type: "shared" as const }, seat: "s", persona: "scout", reason: "r" },
        ],
      });
      assert.isTrue(refused.isFailure);
      assert.include(message(refused), "crew members cannot request crews or seats");
      assert.lengthOf(yield* Ref.get(proposals), 2);
      // Nor may a seat spawn a solo Peer Agent: only the Captain grows a Crew, through the gate.
      const spawned = yield* run("j5_spawn_agent", {
        workspace: { type: "shared" as const },
        brief: "Help me",
        provider: "codex",
        model: "gpt-5.6-terra",
        reasoning: "high",
      } as J5SpawnAgentInput);
      assert.isTrue(spawned.isFailure);
      assert.include(message(spawned), "crew members cannot spawn Peer Agents");
      assert.include(message(spawned), "delegate_task");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "stops exactly one agent as upstream's Stop, in any project, within the caller's modes",
  () =>
    Effect.gen(function* () {
      const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-stop");
      const callerParticipantId = ParticipantId.make("agent:j5:mcp-stop-caller");
      const targetParticipantId = ParticipantId.make("agent:j5:mcp-stop-target");
      const siblingParticipantId = ParticipantId.make("agent:j5:mcp-stop-sibling");
      const childParticipantId = ParticipantId.make("agent:j5:mcp-stop-child");
      const targetThreadId = ThreadId.make("thread:j5:mcp-stop-target");
      const siblingThreadId = ThreadId.make("thread:j5:mcp-stop-sibling");
      const childThreadId = ThreadId.make("thread:j5:mcp-stop-child");
      const targetProjectId = ProjectId.make("project:j5:mcp-stop-target");
      const stopped = yield* Ref.make<
        ReadonlyArray<{
          readonly via: "thread.stop" | "stopDelegatedTasks";
          readonly commandId: string;
          readonly threadId: ThreadId;
        }>
      >([]);
      const targetRunning = yield* Ref.make(true);
      const callerRuntimeMode = yield* Ref.make<RuntimeMode>("full-access");
      const targetIsCallersSeat = yield* Ref.make(false);
      const stopLimits = yield* Ref.make<ReadonlyArray<RuntimeMode | undefined>>([]);
      const callerRow = {
        projectId: ledgerProjectId,
        participantId: callerParticipantId,
        participant: {
          kind: "agent" as const,
          id: callerParticipantId,
          threadId: invocation.threadId,
        },
        archived: false,
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: false,
      } satisfies ParticipantDirectoryRow;
      // The target lives in another project: a stop reaches any agent on this server.
      const agentRow = (participantId: ParticipantId, threadId: ThreadId) =>
        ({
          projectId: LedgerProjectId.make("project:j5:mcp-stop-elsewhere"),
          participantId,
          participant: { kind: "agent" as const, id: participantId, threadId },
          archived: false,
          canReceiveMessage: true,
          canOpenExchange: true,
          acceptsUrgency: false,
        }) satisfies ParticipantDirectoryRow;
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          A2ASendService,
          A2ASendService.of({
            send: () => Effect.die("j5_send_message is outside this stop test"),
            clearOwnAsk: () => Effect.die("j5_clear_own_ask is outside this stop test"),
            sendAsMachine: () => Effect.die("unused"),
            listParticipants: () =>
              Effect.succeed([
                callerRow,
                agentRow(targetParticipantId, targetThreadId),
                agentRow(siblingParticipantId, siblingThreadId),
                agentRow(childParticipantId, childThreadId),
              ]),
          }),
        ),
        Layer.mock(ParticipantPlacementService)({
          listParticipants: () => Effect.die("j5_stop_agent finds its target in the directory"),
          listSubtree: () => Effect.die("j5_stop_agent must never resolve placement descendants"),
        }),
        threadManagementMock({
          getThreadShell: (threadId) =>
            Ref.get(callerRuntimeMode).pipe(
              Effect.map((runtimeMode) =>
                threadId === invocation.threadId
                  ? liveThreadShell(threadId, { runtimeMode })
                  : null,
              ),
            ),
          getThreadProjection: (threadId) =>
            Ref.get(targetRunning).pipe(
              Effect.map((running) => ({
                ...projection(threadId),
                thread: {
                  ...projection(threadId).thread,
                  projectId: threadId === targetThreadId ? targetProjectId : projectId,
                },
                runs: running ? [{ status: "running" } as OrchestrationV2Run] : [],
              })),
            ),
          dispatch: (command) =>
            command.type === "thread.stop"
              ? Ref.update(stopped, (items) => [
                  ...items,
                  {
                    via: "thread.stop" as const,
                    commandId: command.commandId,
                    threadId: command.threadId,
                  },
                ]).pipe(
                  // The limit upstream re-checks under the target's lock rides with the Stop.
                  Effect.andThen(
                    Effect.gen(function* () {
                      return yield* DispatchModeLimit;
                    }),
                  ),
                  Effect.tap((limit) =>
                    Ref.update(stopLimits, (items) => [...items, limit?.runtimeMode]),
                  ),
                  Effect.as({ sequence: 1, storedEvents: [] }),
                )
              : Effect.die(`j5_stop_agent must only dispatch thread.stop, not ${command.type}`),
          stopDelegatedTasks: (input) =>
            Ref.update(stopped, (items) => [
              ...items,
              {
                via: "stopDelegatedTasks" as const,
                commandId: input.commandId,
                threadId: input.threadId,
              },
            ]),
          interruptThread: () =>
            Effect.die("j5_stop_agent sends upstream's Stop, not an interrupt"),
        }),
        Layer.mock(A2AHomeRegistrar)({}),
        Layer.mock(A2ALedger)({}),
        Layer.mock(SpawnCompositionService)({}),
        Layer.mock(OrchestratorMcpService)({}),
        peerDirectoryNoneLayer,
        Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
        Layer.mock(AgentCrewInstanceService)({
          findMembership: () =>
            Ref.get(targetIsCallersSeat).pipe(
              Effect.map((seat) =>
                seat ? { crewInstanceId: "crew:stop", seatName: "builder" } : null,
              ),
            ),
          read: () =>
            Effect.succeed({ captainParticipantId: callerParticipantId } as AgentCrewInstance),
          listForCaptain: () => Effect.succeed([]),
        }),
        Layer.mock(ArchiveCrewService)({}),
        Layer.mock(CrewStopService)({}),
        Layer.mock(CrewProposalService)({}),

        Layer.mock(ThreadRegistration)({}),
        NodeServices.layer,
      );
      const layer = J5ToolkitHandlersLive.pipe(
        Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
        Layer.provideMerge(dependencies),
      );

      yield* Effect.gen(function* () {
        const toolkit = yield* J5Toolkit;
        const call = (args: J5StopAgentInput) =>
          toolkit
            .handle("j5_stop_agent", args)
            .pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(McpInvocationContext, scope),
            );
        const args = {
          participant_id: targetParticipantId,
          client_request_id: "stop-one-1",
        } satisfies J5StopAgentInput;
        const first = yield* call(args);
        const replay = yield* call(args);
        assert.equal(first.result, "interrupt_requested");
        assert.deepStrictEqual(replay.result, first.result);
        // An idle target is still stopped: Stop also holds its queue and ends its watches.
        yield* Ref.set(targetRunning, false);
        const idle = yield* call({
          ...args,
          client_request_id: "stop-idle-1",
        });
        assert.equal(idle.result, "already_idle");
        const calls = yield* Ref.get(stopped);
        assert.deepStrictEqual(
          calls.map((call) => call.via),
          [
            "thread.stop",
            "stopDelegatedTasks",
            "thread.stop",
            "stopDelegatedTasks",
            "thread.stop",
            "stopDelegatedTasks",
          ],
        );
        assert.isTrue(calls.every((call) => call.threadId === targetThreadId));
        // A replay reuses the command id, and the delegated-task stops derive theirs from it.
        assert.deepStrictEqual(
          calls.slice(0, 4).map((call) => call.commandId),
          Array.from({ length: 4 }, () => calls[0]!.commandId),
        );
        assert.notEqual(calls[4]?.commandId, calls[0]?.commandId);
        assert.notInclude(
          calls.map((call) => call.threadId),
          siblingThreadId,
        );
        assert.notInclude(
          calls.map((call) => call.threadId),
          childThreadId,
        );

        // The target runs in full access. A caller in a narrower mode may not stop it.
        yield* Ref.set(callerRuntimeMode, "approval-required");
        const refused = yield* call({ ...args, client_request_id: "stop-narrow-1" });
        assert.isTrue(refused.isFailure);
        assert.include(JSON.stringify(refused.encodedResult), "broader permissions than you do");
        assert.lengthOf(yield* Ref.get(stopped), calls.length, "a refused stop dispatches nothing");
        // Unless the target is a seat of a Crew the caller commands.
        yield* Ref.set(targetIsCallersSeat, true);
        const commanded = yield* call({ ...args, client_request_id: "stop-seat-1" });
        assert.equal(commanded.result, "already_idle");
        assert.lengthOf(yield* Ref.get(stopped), calls.length + 2);
        // Each Stop carries its caller's limit, except the Captain's, which has none.
        assert.deepStrictEqual(yield* Ref.get(stopLimits), [
          "full-access",
          "full-access",
          "full-access",
          undefined,
        ]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "lists a peer server's agents when it is named and reports the peers it could not read",
  () =>
    Effect.gen(function* () {
      const ledgerProjectId = LedgerProjectId.make("project:j5:mcp-peer-list");
      const callerParticipantId = ParticipantId.make("agent:j5:mcp-peer-caller");
      const remoteParticipantId = ParticipantId.make("agent:j5:a2a:thread:support");
      const archivedRemoteId = ParticipantId.make("agent:j5:a2a:thread:retired");
      const twinParticipantId = ParticipantId.make("agent:j5:a2a:thread:twin");
      const callerRow = {
        projectId: ledgerProjectId,
        participantId: callerParticipantId,
        participant: {
          kind: "agent" as const,
          id: callerParticipantId,
          threadId: invocation.threadId,
        },
        archived: false,
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: false,
      } satisfies ParticipantDirectoryRow;
      const remoteAgent = {
        environmentId: "environment-home",
        environmentLabel: "Home",
        projectId: LedgerProjectId.make("project:home-support"),
        projectTitle: "L2 Support Rotation",
        participantId: remoteParticipantId,
        threadId: ThreadId.make("thread:support"),
        displayName: "Support triage",
        archived: false,
        canReceiveMessage: true,
        // Home is a peer this server sends to directly, so nothing measures it.
        available: null,
        lastAvailableAt: null,
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          A2ASendService,
          A2ASendService.of({
            send: () => Effect.die("unused"),
            clearOwnAsk: () => Effect.die("unused"),
            sendAsMachine: () => Effect.die("unused"),
            listParticipants: () => Effect.succeed([callerRow]),
          }),
        ),
        Layer.mock(ParticipantPlacementService)({ listParticipants: () => Effect.succeed([]) }),
        Layer.succeed(
          PeerDirectory,
          PeerDirectory.of({
            listAgents: () =>
              Effect.succeed({
                agents: [
                  remoteAgent,
                  {
                    ...remoteAgent,
                    participantId: archivedRemoteId,
                    threadId: ThreadId.make("thread:retired"),
                    displayName: "Retired",
                    archived: true,
                    canReceiveMessage: false,
                    available: false,
                    lastAvailableAt: "2026-10-02T09:00:00.000Z",
                  },
                  // A peer may carry the same name as this server; names are not unique.
                  {
                    ...remoteAgent,
                    environmentId: "environment-twin",
                    environmentLabel: "Work VM",
                    participantId: twinParticipantId,
                    threadId: ThreadId.make("thread:twin"),
                    displayName: "Twin",
                  },
                ],
                unreadPeers: [
                  { environmentId: "environment-mac", label: "Mac", reason: "ECONNREFUSED" },
                ],
                selfName: "Work VM",
              }),
            resolveAgent: () => Effect.die("unused"),
            snapshotAgent: () => Effect.succeed(null),
            serverStatus: () => Effect.die("unused"),
          }),
        ),
        Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
        Layer.mock(OrchestratorV2)({
          getShellSnapshot: () =>
            Effect.fail(new OrchestratorProjectionError({ threadId: invocation.threadId })),
        }),
        Layer.mock(A2AHomeRegistrar)({}),
        Layer.mock(A2ALedger)({ listProjectLedgers: () => Effect.succeed([]) }),
        Layer.mock(SpawnCompositionService)({}),
        threadManagementMock({}),
        Layer.mock(OrchestratorMcpService)({}),
        Layer.mock(AgentCrewInstanceService)({
          findMembership: () => Effect.succeed(null),
          listForCaptain: () => Effect.succeed([]),
        }),
        Layer.mock(ArchiveCrewService)({}),
        Layer.mock(CrewStopService)({}),
        Layer.mock(CrewProposalService)({}),
        Layer.mock(ProjectService)({}),
        Layer.mock(ThreadRegistration)({}),
        NodeServices.layer,
      );
      const layer = J5ToolkitHandlersLive.pipe(
        Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
        Layer.provideMerge(dependencies),
      );

      yield* Effect.gen(function* () {
        const toolkit = yield* J5Toolkit;
        const callList = (input: J5ListParticipantsInput) =>
          toolkit
            .handle("j5_list_participants", input)
            .pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(McpInvocationContext, scope),
            );
        const list = (input: J5ListParticipantsInput) =>
          callList(input).pipe(
            Effect.flatMap((response) => decodeJ5ListParticipantsResult(response.encodedResult)),
          );
        const local = yield* list({});
        assert.deepStrictEqual(
          local.participants.map((row) => [row.participant_id, row.project_id]),
          [[callerParticipantId, ledgerProjectId]],
          "this server's agents only, until a peer server is named",
        );
        assert.equal(local.participants[0]!.project_title, null);
        assert.deepStrictEqual(local.participants[0]!.server, { name: "Work VM", local: true });
        assert.deepStrictEqual(
          local.servers,
          [
            { name: "Work VM", local: true },
            { name: "Home", local: false },
            { name: "Mac", local: false },
            { name: "Work VM", local: false },
          ],
          "every server is named, the one that did not answer included",
        );
        assert.equal(local.unread_peer_count, 1, "an unread peer is counted");
        assert.isFalse(hasKey(local, "unread_peers"));

        const listed = yield* list({ server: "Home" });
        assert.deepStrictEqual(
          listed.participants.map((row) => [row.participant_id, row.project_id]),
          [[remoteParticipantId, "project:home-support"]],
          "an archived remote agent is hidden until asked for, like a local one",
        );
        const remoteRow = listed.participants[0]!;
        assert.equal(remoteRow.display_name, "Support triage");
        assert.equal(remoteRow.project_title, "L2 Support Rotation");
        assert.equal(remoteRow.can_receive_message, true);
        assert.equal(remoteRow.can_open_exchange, true);
        assert.equal(remoteRow.self, false);
        assert.equal(remoteRow.thread_id, "thread:support");
        assert.deepStrictEqual(remoteRow.provenance, { kind: "unrecorded" });
        assert.isFalse(hasKey(remoteRow, "environment_id"), "a server is named, never its id");
        assert.deepStrictEqual(
          remoteRow.server,
          { name: "Home", local: false },
          "nothing measures a peer this server sends to, so the row claims nothing",
        );

        const withArchived = yield* list({ server: "Home", include_archived: true });
        assert.deepStrictEqual(
          withArchived.participants.map((row) => [row.participant_id, row.archived]),
          [
            [remoteParticipantId, false],
            [archivedRemoteId, true],
          ],
        );
        assert.equal(withArchived.participants[1]!.can_receive_message, false);
        assert.deepStrictEqual(
          withArchived.participants[1]!.server,
          {
            name: "Home",
            local: false,
            available: false,
            last_available_at: "2026-10-02T09:00:00.000Z",
          },
          "an agent on a peer that polls, and is offline, says so, and since when",
        );
        assert.deepStrictEqual(
          (yield* list({ server: "Home", project_id: ledgerProjectId })).participants,
          [],
          "a project filter applies to the named server's agents",
        );

        // A peer that shares this server's name is still reachable by that name; this
        // server's own agents are the listing with no name.
        assert.deepStrictEqual(
          (yield* list({ server: "Work VM" })).participants.map((row) => row.participant_id),
          [twinParticipantId],
        );
        const unknown = yield* callList({ server: "Elsewhere" });
        assert.isTrue(unknown.isFailure);
        assert.include(JSON.stringify(unknown.encodedResult), "no peer server named Elsewhere");
        const settledRemote = yield* callList({ server: "Home", settled: true });
        assert.isTrue(settledRemote.isFailure);
      }).pipe(Effect.provide(layer));
    }),
);
