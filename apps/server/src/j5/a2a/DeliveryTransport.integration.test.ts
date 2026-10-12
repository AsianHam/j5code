import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import { PlacementCommandId } from "./placementContracts.ts";
import { dispatchCommand as dispatchIntakeCommand } from "../../orchestration-v2/ThreadMessageIntake.ts";
import { J5AdaptedThreadToolkit, J5AdaptedThreadHandlersLive } from "./mcp/threadTools.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { J5ThreadRegistrationLayer } from "./runtimeLayer.ts";
import { ChatAttachmentId, EnvironmentId } from "@t3tools/contracts";
import * as Sink from "effect/Sink";
import * as Schema from "effect/Schema";
import { createPendingAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { J5AttachmentSendToolkit, J5AttachmentSendHandlersLive } from "./mcp/attachments.ts";
import { SendMessageResult, MessageSentPayload } from "./contracts.ts";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as Cause from "effect/Cause";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ServerConfig } from "../../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../mcp/McpSessionRegistry.testkit.ts";
import {
  OrchestrationEffectWorkerV2,
  type OrchestrationEffectWorkerV2Shape,
} from "../../orchestration-v2/EffectWorker.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2InterruptInput,
  ProviderAdapterV2Shape,
  ProviderAdapterV2SteerInput,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  layerEventSink as OrchestrationV2EventSinkLayerLive,
  layer as UpstreamOrchestrationV2LayerLive,
  layerProjectService as ProjectServiceLayerLive,
} from "../../orchestration-v2/runtimeLayer.ts";
import { ProjectEnrichmentService } from "../../project/ProjectEnrichmentService.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { WorkspacePaths } from "../../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  latestSteerableRun,
  ThreadManagementService,
  type ThreadManagementSendMode,
} from "../../orchestration-v2/ThreadManagementService.ts";
import {
  ThreadLifecycleService,
  layer as threadLifecycleServiceLayer,
} from "../../orchestration-v2/ThreadLifecycleService.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  A2ADeliveryHeldError,
  A2ADeliveryTransport,
  gpt6PeerSteeringRun,
  deliveryMessageId,
  formatAgentDeliveryEnvelope,
  live as deliveryTransportLive,
} from "./DeliveryTransport.ts";
import {
  A2ADeliveryWorker,
  heldQueueRecheckMs,
  manualLayer as deliveryWorkerLayer,
} from "./DeliveryWorker.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { layer as peerRegistryLayer } from "./PeerRegistryService.ts";
import {
  A2AHomeRegistrar,
  participantIdForThread,
  layer as homeRegistrarLayer,
} from "./HomeRegistrar.ts";
import { deliveryCommandId } from "./DeliveryTransport.ts";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { ProviderRuntimeRecoveryService } from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSettlement from "../../orchestration-v2/ThreadSettlementService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { GitManager } from "../../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  QueuedRunWatchdog,
  live as watchdogLayer,
  QUEUED_RUN_WATCHDOG_DELAY_MS,
} from "../run-observability/QueuedRunWatchdog.ts";
import { formatClosedHumanEnvelope, formatPeerEnvelope } from "./EnvelopeFormatter.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { readReceiverBacklog } from "./receiverBacklog.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { A2ALifecycleService, manualLayer as lifecycleServiceLayer } from "./LifecycleService.ts";
import {
  selfContainedLayer as threadRegistrationLayer,
  ThreadRegistration,
} from "./ThreadRegistration.ts";
import {
  A2ASenderNotJoinedError,
  A2ASenderRetiredError,
  A2ASendService,
  layer as sendServiceLayer,
} from "./SendService.ts";
import {
  CommCommandId,
  LedgerProjectId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  type AgentParticipant,
} from "./contracts.ts";

const decodeSendResult = Schema.decodeUnknownEffect(SendMessageResult);
const decodeSentFact = Schema.decodeUnknownEffect(Schema.fromJsonString(MessageSentPayload));
const decodeToolFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ code: Schema.String, message: Schema.String }),
);
const decodeForkResult = Schema.decodeUnknownEffect(Schema.Struct({ targetThreadId: ThreadId }));

const OrchestrationV2LayerLive = UpstreamOrchestrationV2LayerLive.pipe(
  Layer.provideMerge(J5ThreadRegistrationLayer),
);

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-j5-a2a-delivery-transport-",
});

// The live transport carries the peer side too; this test never crosses servers,
// so the registry is real but empty and the HTTP client is never called.
const peerRegistryTestLayer = peerRegistryLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.mock(EnvironmentAuth)({ listSessions: () => Effect.succeed([]) })),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:a2a-integration")),
    }),
  ),
);
const deliveryTransportLayer = deliveryTransportLive.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(peerRegistryTestLayer),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const vcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);

const checkpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(vcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");

interface DeliveryInvocation {
  readonly messageId: MessageId;
  readonly mode: ThreadManagementSendMode;
  readonly createdBy: "user" | "agent" | "system";
}

/** The fake provider's view of one started turn, so a test can drive its tool batch and ending. */
interface FakeActiveTurn {
  readonly events: PubSub.PubSub<ProviderAdapterV2Event>;
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapterV2TurnInput["runId"];
  readonly runOrdinal: ProviderAdapterV2TurnInput["runOrdinal"];
  readonly rootNodeId: ProviderAdapterV2TurnInput["rootNodeId"];
  readonly attemptId: ProviderAdapterV2TurnInput["attemptId"];
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
}

interface DeliveryHarness {
  readonly resumedThreads: Ref.Ref<ReadonlyArray<OrchestrationV2ProviderThread>>;
  readonly startedInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2TurnInput>>;
  readonly staleProjection: Ref.Ref<OrchestrationV2ThreadProjection | undefined>;
  readonly deliveryInvocations: Ref.Ref<ReadonlyArray<DeliveryInvocation>>;
  readonly steerInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2SteerInput>>;
  readonly interruptInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2InterruptInput>>;
  readonly activeTurns: Ref.Ref<ReadonlyMap<ThreadId, FakeActiveTurn>>;
}

const makeOrchestrationAdapter = (harness: DeliveryHarness): ProviderAdapterV2Shape => ({
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver,
        providerInstanceId: modelSelection.instanceId,
        status: "ready",
        cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
        model: sessionInput.modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };

      return {
        instanceId: modelSelection.instanceId,
        driver,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events: Stream.fromPubSub(events),
        ensureThread: (input) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            return {
              id: ProviderThreadId.make(`provider-thread:${input.threadId}`),
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native-thread:${input.threadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
        resumeThread: ({ providerThread }) =>
          Ref.update(harness.resumedThreads, (threads) => [...threads, providerThread]).pipe(
            Effect.as(providerThread),
          ),
        startTurn: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(harness.startedInputs, (inputs) => [...inputs, input]);
            const startedAt = yield* DateTime.now;
            yield* PubSub.publish(events, {
              type: "provider_session.updated",
              driver,
              providerSession: { ...providerSession, status: "running", updatedAt: startedAt },
            });
            const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
            yield* Ref.update(harness.activeTurns, (existing) =>
              new Map(existing).set(input.threadId, {
                events,
                threadId: input.threadId,
                runId: input.runId,
                runOrdinal: input.runOrdinal,
                rootNodeId: input.rootNodeId,
                attemptId: input.attemptId,
                providerThreadId: input.providerThread.id,
                providerTurnId,
              }),
            );
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native-turn:${input.attemptId}`,
                  strength: "strong",
                },
                ordinal: input.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              },
            });
          }),
        steerTurn: (input) => Ref.update(harness.steerInputs, (existing) => [...existing, input]),
        interruptTurn: (input) =>
          Ref.update(harness.interruptInputs, (existing) => [...existing, input]),
        respondToRuntimeRequest: () =>
          Effect.die("respondToRuntimeRequest is unused by the A2 delivery seam test"),
        readThreadSnapshot: () =>
          Effect.die("readThreadSnapshot is unused by the A2 delivery seam test"),
        rollbackThread: () => Effect.die("rollbackThread is unused by the A2 delivery seam test"),
        forkThread: () => Effect.die("forkThread is unused by the A2 delivery seam test"),
      };
    }),
});

const makeTestLayer = (
  harness: DeliveryHarness,
  settings: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
) => {
  const orchestrationAdapter = makeOrchestrationAdapter(harness);
  const providerInstance = {
    instanceId: modelSelection.instanceId,
    driverKind: driver,
    continuationIdentity: {
      driverKind: driver,
      continuationKey: "codex:j5-a2a-delivery-test",
    },
    displayName: "Codex A2 delivery test",
    enabled: true,
    // No supportedRuntimeModes: every runtime mode runs as stored.
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const providerInstanceRegistryTestLayer = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const orchestrationTestLayer = Layer.merge(
    OrchestrationV2LayerLive,
    OrchestrationV2EventSinkLayerLive,
  ).pipe(
    Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused title link"),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(mcpSessionRegistryTestLayer),
    Layer.provide(checkpointStoreTestLayer),
    Layer.provide(serverConfigLayer),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
    Layer.provide(providerInstanceRegistryTestLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const recordingThreadManagement = Layer.effect(
    ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      return ThreadManagementService.of({
        ...threads,
        getThreadProjection: (threadId) =>
          Ref.get(harness.staleProjection).pipe(
            Effect.flatMap((stale) =>
              stale === undefined ? threads.getThreadProjection(threadId) : Effect.succeed(stale),
            ),
          ),
        sendToThread: (input) =>
          Ref.update(harness.deliveryInvocations, (existing) => [
            ...existing,
            { messageId: input.messageId, mode: input.mode, createdBy: input.createdBy },
          ]).pipe(Effect.andThen(threads.sendToThread(input))),
      });
    }),
  );
  const recordedDeliveryTransport = deliveryTransportLayer.pipe(
    Layer.provide(recordingThreadManagement),
  );

  return Layer.merge(ledgerLayer, recordedDeliveryTransport).pipe(
    Layer.provideMerge(orchestrationTestLayer),
  );
};

const makeLifecycleTestLayer = (harness: DeliveryHarness) => {
  const base = makeTestLayer(harness);
  const send = sendServiceLayer.pipe(Layer.provide(peerDirectoryNoneLayer), Layer.provide(base));
  const worker = deliveryWorkerLayer.pipe(Layer.provide(base));
  const lifecycle = lifecycleServiceLayer.pipe(Layer.provide(worker), Layer.provide(base));
  const threadLifecycle = threadLifecycleServiceLayer.pipe(Layer.provide(base));
  const registration = threadRegistrationLayer.pipe(Layer.provide(base));
  return Layer.mergeAll(base, send, worker, lifecycle, threadLifecycle, registration);
};

const makeHarness = Effect.gen(function* () {
  return {
    resumedThreads: yield* Ref.make<ReadonlyArray<OrchestrationV2ProviderThread>>([]),
    startedInputs: yield* Ref.make<ReadonlyArray<ProviderAdapterV2TurnInput>>([]),
    staleProjection: yield* Ref.make<OrchestrationV2ThreadProjection | undefined>(undefined),
    deliveryInvocations: yield* Ref.make<ReadonlyArray<DeliveryInvocation>>([]),
    steerInputs: yield* Ref.make<ReadonlyArray<ProviderAdapterV2SteerInput>>([]),
    interruptInputs: yield* Ref.make<ReadonlyArray<ProviderAdapterV2InterruptInput>>([]),
    activeTurns: yield* Ref.make<ReadonlyMap<ThreadId, FakeActiveTurn>>(new Map()),
  } satisfies DeliveryHarness;
});

const seedTarget = (
  suffix: string,
  model = modelSelection.model,
  registrar?: A2AHomeRegistrar["Service"],
  existingLedgerProjectId?: LedgerProjectId,
  existingProjectId?: ProjectId,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const ledger = yield* A2ALedger;
    const threadId = ThreadId.make(`thread:j5-a2a-delivery-${suffix}`);
    const projectId = existingProjectId ?? ProjectId.make(`project:j5-a2a-delivery-${suffix}`);
    const ledgerProjectId =
      existingLedgerProjectId ?? LedgerProjectId.make(`ledger:j5-a2a-delivery-${suffix}`);
    const senderId = ParticipantId.make(`agent:j5-a2a-delivery-${suffix}-sender`);
    const receiverId =
      registrar === undefined
        ? ParticipantId.make(`agent:j5-a2a-delivery-${suffix}-receiver`)
        : participantIdForThread(threadId);
    const exchangeId = ExchangeId.make(`exchange:j5-a2a-delivery-${suffix}`);
    const messageId = LedgerMessageId.make(`message:j5-a2a-delivery-${suffix}`);
    const createdAt = "2026-08-17T12:00:00.000Z";
    const message = `Reply through the real ${suffix} delivery seam.`;
    const workspace = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: `j5-a2a-delivery-${suffix}-`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:j5-a2a-delivery-${suffix}-create-thread`),
      threadId,
      projectId,
      title: `J5 A2A ${suffix} delivery target`,
      modelSelection: { ...modelSelection, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: workspace,
    });
    if (existingLedgerProjectId === undefined) {
      yield* ledger.ensureProject({ projectId: ledgerProjectId, createdAt });
    }
    if (registrar === undefined) {
      yield* ledger.appendEvents({
        commandId: CommCommandId.make(`command:j5-a2a-delivery-${suffix}-join-target`),
        projectId: ledgerProjectId,
        acceptedAt: createdAt,
        events: [
          {
            kind: "participant.joined",
            sender: null,
            receiver: receiverId,
            exchangeId: null,
            correlationId: null,
            payload: {
              participant: { kind: "agent", id: receiverId, threadId },
            },
            createdAt,
          },
        ],
      });
    } else {
      yield* registrar.registerAtCreation({
        commandId: CommCommandId.make(`command:j5-a2a-delivery-${suffix}-register`),
        projectId: ledgerProjectId,
        threadId,
        createdAt,
      });
    }

    return {
      threadId,
      projectId,
      ledgerProjectId: ledgerProjectId,
      senderId,
      receiverId,
      exchangeId,
      messageId,
      message,
      delivery: {
        originProjectId: ledgerProjectId,
        receiverProjectId: ledgerProjectId,
        messageId,
        senderId,
        receiverId,
        exchangeId,
        exchangeRole: "ask" as const,
        message,
        envelopeChannel: "peer" as const,
      },
    };
  });

it.effect.each(["gpt-5.4", "gpt-6-astra"])(
  "starts an idle %s recipient immediately without the implicit auto mode",
  (idleModel) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const transport = yield* A2ADeliveryTransport;
        const target = yield* seedTarget("idle", idleModel);

        yield* transport.deliverAgent(target.delivery);
        yield* transport.deliverAgent(target.delivery);

        const projection = yield* threads.getThreadProjection(target.threadId);
        const upstreamMessageId = deliveryMessageId(target.messageId);
        const deliveredMessages = projection.messages.filter(
          (candidate) => candidate.id === upstreamMessageId,
        );
        assert.lengthOf(deliveredMessages, 1);
        assert.equal(
          deliveredMessages[0]?.text,
          formatPeerEnvelope({
            senderId: target.senderId,
            originProjectId: target.ledgerProjectId,
            exchangeId: target.exchangeId,
            message: target.message,
          }),
        );
        assert.lengthOf(projection.runs, 1);
        assert.equal(
          projection.turnItems.find(
            (
              candidate,
            ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
              candidate.type === "user_message" && candidate.messageId === upstreamMessageId,
          )?.inputIntent,
          "turn_start",
        );
        assert.deepStrictEqual(
          (yield* Ref.get(harness.deliveryInvocations))
            .filter((invocation) => invocation.messageId === upstreamMessageId)
            .map((invocation) => invocation.mode),
          ["queue", "queue"],
        );
        const worker = yield* OrchestrationEffectWorkerV2;
        const sink = yield* EventSinkV2;
        const running = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* worker.runOnce;
        yield* Fiber.join(running);
        // A queue receipt stays valid after its Astra run becomes steerable.
        yield* transport.deliverAgent(target.delivery);
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
        assert.lengthOf((yield* threads.getThreadProjection(target.threadId)).runs, 1);
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

/** Runs outbox effects as they become available until the awaited receipt lands. */
const runWorkerUntil = <A, E>(
  worker: OrchestrationEffectWorkerV2Shape,
  receipt: Fiber.Fiber<A, E>,
) =>
  Effect.gen(function* () {
    // Only the wait is raced; a claimed effect always runs to completion so
    // its lease and provider session are never abandoned mid-flight.
    while (receipt.pollUnsafe() === undefined) {
      yield* Effect.raceFirst(Fiber.join(receipt), worker.awaitWork);
      yield* worker.drain();
    }
    return yield* Fiber.join(receipt);
  });

/** Emits one fake shell tool call inside the active turn, the way the #73 repro's Bash and sibling calls appear. */
const publishCommandExecution = (
  turn: FakeActiveTurn,
  input: {
    readonly ordinal: number;
    readonly command: string;
    readonly status: "running" | "completed";
    readonly startedAt: DateTime.Utc;
    readonly completedAt: DateTime.Utc | null;
  },
) =>
  PubSub.publish(turn.events, {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(`turn-item:${turn.threadId}:${turn.runOrdinal}:${input.ordinal}`),
      threadId: turn.threadId,
      runId: turn.runId,
      nodeId: turn.rootNodeId,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: turn.runOrdinal * 100 + input.ordinal,
      status: input.status,
      title: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      updatedAt: input.completedAt ?? input.startedAt,
      type: "command_execution",
      input: input.command,
      ...(input.status === "completed" ? { output: "", exitCode: 0 } : {}),
    },
  });

it.effect.each([
  "gpt-6-astra",
  "astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "openai.gpt-6-luna",
  "gpt-6-astra-custom",
])("delivers updates into a running %s turn without restarting its tools", (model) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      const worker = yield* OrchestrationEffectWorkerV2;
      const sink = yield* EventSinkV2;
      const target = yield* seedTarget(model, model);
      const active = yield* threads.sendToThread({
        projectId: target.projectId,
        threadId: target.threadId,
        commandId: CommandId.make(`command:${model}:start`),
        messageId: MessageId.make(`message:${model}:start`),
        text: "Finish the original build while receiving updates.",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      // Starting/preparing is not a live provider turn: never use auto/restart.
      const starting = yield* threads.getThreadProjection(target.threadId);
      assert.isUndefined(gpt6PeerSteeringRun(starting, "peer"));
      const running = yield* sink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.status === "running",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* worker.runOnce;
      yield* Fiber.join(running);
      const projection = yield* threads.getThreadProjection(target.threadId);
      assert.equal(gpt6PeerSteeringRun(projection, "peer")?.id, active.run.id);
      for (const channel of ["silence_notice", "lifecycle_notice"] as const) {
        assert.isUndefined(gpt6PeerSteeringRun(projection, channel));
      }
      for (const otherModel of [
        "gpt-5.6-sol",
        "openai.gpt-5.6-sol",
        "gpt-5.4",
        "gpt-60-nova",
        "claude-fable-5-1",
      ]) {
        assert.isUndefined(
          gpt6PeerSteeringRun(
            {
              ...projection,
              runs: projection.runs.map((run) => ({
                ...run,
                modelSelection: { ...run.modelSelection, model: otherModel },
              })),
            },
            "peer",
          ),
        );
      }
      assert.isUndefined(
        gpt6PeerSteeringRun(
          {
            ...projection,
            providerThreads: projection.providerThreads.map((thread) => ({
              ...thread,
              driver: ProviderDriverKind.make("claude"),
            })),
          },
          "peer",
        ),
      );
      assert.isUndefined(gpt6PeerSteeringRun({ ...projection, providerSessions: [] }, "peer"));
      assert.isUndefined(
        gpt6PeerSteeringRun(
          { ...projection, thread: { ...projection.thread, archivedAt: yield* DateTime.now } },
          "peer",
        ),
      );
      assert.isUndefined(
        gpt6PeerSteeringRun(
          {
            ...projection,
            providerSessions: projection.providerSessions.map((session) => ({
              ...session,
              driver: ProviderDriverKind.make("claude"),
            })),
          },
          "peer",
        ),
      );
      assert.isUndefined(
        gpt6PeerSteeringRun(
          {
            ...projection,
            providerSessions: projection.providerSessions.map((session) => ({
              ...session,
              capabilities: {
                ...session.capabilities,
                turns: { ...session.capabilities.turns, supportsActiveSteering: false },
              },
            })),
          },
          "peer",
        ),
      );
      assert.isUndefined(gpt6PeerSteeringRun({ ...projection, providerTurns: [] }, "peer"));
      const turn = (yield* Ref.get(harness.activeTurns)).get(target.threadId)!;
      const startedAt = yield* DateTime.now;
      yield* publishCommandExecution(turn, {
        ordinal: 1,
        command: "long build",
        status: "running",
        startedAt,
        completedAt: null,
      });
      // The picker can change while the current run retains its original model.
      const orchestrator = yield* OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`command:${model}:picker-change`),
        threadId: target.threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.6-sol" },
      });
      const firstDelivery = yield* transport
        .deliverAgent(target.delivery)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* runWorkerUntil(worker, firstDelivery);
      yield* transport.deliverAgent(target.delivery);
      const secondId = LedgerMessageId.make(`message:${model}:second`);
      const secondInput = {
        ...target.delivery,
        messageId: secondId,
        exchangeRole: "reply",
        message: "The answer to your question.",
      } as const;
      const secondDelivery = yield* transport
        .deliverAgent(secondInput)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* runWorkerUntil(worker, secondDelivery);
      const steers = yield* Ref.get(harness.steerInputs);
      assert.lengthOf(steers, 2);
      // A steered delivery carries the ordinary envelope and nothing else.
      assert.sameDeepMembers(
        steers.map((input) => [input.message.messageId, input.message.text]),
        [
          [deliveryMessageId(target.messageId), formatAgentDeliveryEnvelope(target.delivery)],
          [deliveryMessageId(secondId), formatAgentDeliveryEnvelope(secondInput)],
        ],
      );
      for (const steer of steers) {
        assert.equal(steer.runId, active.run.id);
        assert.equal(steer.providerTurnId, turn.providerTurnId);
      }
      const toolCompleted = yield* sink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.type === "command_execution" &&
            stored.event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* publishCommandExecution(turn, {
        ordinal: 1,
        command: "long build",
        status: "completed",
        startedAt,
        completedAt: yield* DateTime.now,
      });
      yield* Fiber.join(toolCompleted);
      const after = yield* threads.getThreadProjection(target.threadId);
      assert.lengthOf(after.runs, 1);
      assert.equal(after.runs[0]?.status, "running");
      assert.lengthOf(after.attempts, 1);
      assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
      assert.lengthOf(
        after.messages.filter((message) => message.id === deliveryMessageId(target.messageId)),
        1,
      );
      // Notices remain queued even for Astra; they do not become peer steers.
      for (const channel of ["silence_notice", "lifecycle_notice"] as const) {
        yield* transport.deliverAgent({
          ...target.delivery,
          messageId: LedgerMessageId.make(`message:${model}:${channel}`),
          envelopeChannel: channel,
        });
      }
      assert.isFalse(yield* worker.runOnce);
      assert.lengthOf(yield* Ref.get(harness.steerInputs), 2);
      const withNotices = yield* threads.getThreadProjection(target.threadId);
      assert.equal(withNotices.runs.filter((run) => run.status === "queued").length, 2);
      // A provider turn can finish between the eligibility read and dispatch.
      // Keep the stale eligibility snapshot while the real projection moves on.
      const ended = yield* sink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* PubSub.publish(turn.events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: {
          ...projection.providerTurns[0]!,
          status: "completed",
          completedAt: yield* DateTime.now,
        },
      });
      yield* Fiber.join(ended);
      yield* Ref.set(harness.staleProjection, projection);
      const racedDelivery = {
        ...target.delivery,
        messageId: LedgerMessageId.make(`message:${model}:race`),
      };
      for (let retry = 0; retry < 2; retry++) yield* transport.deliverAgent(racedDelivery);
      yield* Ref.set(harness.staleProjection, undefined);
      const afterRace = yield* threads.getThreadProjection(target.threadId);
      assert.lengthOf(
        afterRace.messages.filter(
          (message) => message.id === deliveryMessageId(racedDelivery.messageId),
        ),
        1,
      );
      const queuedFollowUps = afterRace.runs.filter(
        (run) => run.userMessageId === deliveryMessageId(racedDelivery.messageId),
      );
      assert.lengthOf(queuedFollowUps, 1);
      assert.equal(queuedFollowUps[0]!.status, "queued");
      assert.equal(queuedFollowUps[0]!.modelSelection.model, model);
      assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

/** Starts a user turn on the target and returns once its provider turn is running. */
const startBusyTurn = Effect.fn("A2AIntegration.startBusyTurn")(function* (target: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const threads = yield* ThreadManagementService;
  const worker = yield* OrchestrationEffectWorkerV2;
  const sink = yield* EventSinkV2;
  const running = yield* sink.stream({ threadId: target.threadId }).pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "provider-turn.updated" && stored.event.payload.status === "running",
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* threads.sendToThread({
    projectId: target.projectId,
    commandId: CommandId.make(`command:${target.threadId}:busy-start`),
    threadId: target.threadId,
    messageId: MessageId.make(`message:${target.threadId}:busy-start`),
    text: "Stay busy while peers write.",
    attachments: [],
    mode: "auto",
    createdBy: "user",
    creationSource: "web",
  });
  yield* runWorkerUntil(worker, running);
});

it.effect("measures the backlog a send waits behind on a busy receiver", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const send = yield* A2ASendService;
      const worker = yield* A2ADeliveryWorker;
      const caller = yield* seedTarget("backlog-caller");
      const other = yield* seedTarget(
        "backlog-other",
        modelSelection.model,
        undefined,
        caller.ledgerProjectId,
      );
      const target = yield* seedTarget(
        "backlog",
        modelSelection.model,
        undefined,
        caller.ledgerProjectId,
      );
      let sequence = 0;
      const sendInput = (from: typeof caller, name: string) => ({
        commandId: CommCommandId.make(`command:j5-a2a-delivery-backlog-${name}`),
        senderThreadId: from.threadId,
        to: target.receiverId,
        message: `Update ${name}`,
        acceptedAt: `2026-09-24T00:00:0${sequence++}.000Z`,
      });
      const backlogFor = (sent: { readonly messageId: LedgerMessageId }) =>
        readReceiverBacklog({
          receiverId: target.receiverId,
          callerThreadId: caller.threadId,
          sentMessageId: sent.messageId,
        });

      // An idle receiver takes the message at once: nothing to warn about.
      const firstInput = sendInput(caller, "first");
      const first = yield* send.send(firstInput);
      assert.isUndefined(yield* backlogFor(first));
      // Nor once the message has started its own run.
      yield* worker.drain;
      assert.isUndefined(yield* backlogFor(first));
      yield* startPendingTestTurn(target.threadId);
      yield* finishTestTurn(harness, target.threadId);

      yield* startBusyTurn(target);
      // A replayed send of a message that has already run reports the current state.
      const replay = yield* send.send(firstInput);
      assert.equal(replay.messageId, first.messageId);
      assert.isUndefined(yield* backlogFor(replay));
      // Committed sends the worker has not handed over yet are waiting too.
      yield* send.send(sendInput(caller, "second"));
      const third = yield* send.send(sendInput(caller, "third"));
      assert.deepStrictEqual(yield* backlogFor(third), { waiting: 2, fromCaller: 2 });
      // Queued runs and pending deliveries add up; another sender's count is not the caller's.
      yield* worker.drain;
      yield* send.send(sendInput(other, "other"));
      assert.deepStrictEqual(yield* backlogFor(third), { waiting: 3, fromCaller: 2 });

      // Only agents on this server are measured.
      assert.isUndefined(
        yield* readReceiverBacklog({
          receiverId: ParticipantId.make("agent:j5-a2a-delivery-backlog-elsewhere"),
          callerThreadId: caller.threadId,
          sentMessageId: third.messageId,
        }),
      );
    }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
  }),
);

it.effect("counts a message queued before an Astra turn became steerable", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      const target = yield* seedTarget("backlog-astra-queued", "gpt-6-astra");
      yield* threads.sendToThread({
        projectId: target.projectId,
        threadId: target.threadId,
        commandId: CommandId.make("command:j5-a2a-delivery-backlog-astra-queued-start"),
        messageId: MessageId.make("message:j5-a2a-delivery-backlog-astra-queued-start"),
        text: "Start",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const sink = yield* EventSinkV2;
      const running = yield* sink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.status === "running",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      // Accepted while the turn is still starting, so it queues rather than steers.
      yield* transport.deliverAgent(target.delivery);
      yield* runWorkerUntil(yield* OrchestrationEffectWorkerV2, running);
      const projection = yield* threads.getThreadProjection(target.threadId);
      assert.equal(
        projection.runs.find((run) => run.userMessageId === deliveryMessageId(target.messageId))
          ?.status,
        "queued",
      );
      assert.deepStrictEqual(
        yield* readReceiverBacklog({
          receiverId: target.receiverId,
          callerThreadId: ThreadId.make("thread:j5-a2a-delivery-backlog-astra-queued-caller"),
          sentMessageId: target.messageId,
        }),
        { waiting: 1, fromCaller: 0 },
      );
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect("reports no backlog while the receiver's queue is held", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const target = yield* seedTarget("backlog-held");
      yield* holdTargetQueue(target);
      // A held queue waits for someone to resume the thread, not for the turn to end.
      assert.isUndefined(
        yield* readReceiverBacklog({
          receiverId: target.receiverId,
          callerThreadId: ThreadId.make("thread:j5-a2a-delivery-backlog-held-caller"),
          sentMessageId: target.messageId,
        }),
      );
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect(
  "reports no backlog for a running Astra receiver, which takes peer messages mid-turn",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const target = yield* seedTarget("backlog-astra", "gpt-6-astra");
        yield* startBusyTurn(target);
        assert.isUndefined(
          yield* readReceiverBacklog({
            receiverId: target.receiverId,
            callerThreadId: ThreadId.make("thread:j5-a2a-delivery-backlog-astra-caller"),
            sentMessageId: target.messageId,
          }),
        );
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect(
  "queues behind a busy recipient's active turn and never aborts its running tool batch",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const threads = yield* ThreadManagementService;
        const transport = yield* A2ADeliveryTransport;
        const target = yield* seedTarget("busy");
        const active = yield* threads.sendToThread({
          projectId: target.projectId,
          commandId: CommandId.make("command:j5-a2a-delivery-busy-start"),
          threadId: target.threadId,
          messageId: MessageId.make("message:j5-a2a-delivery-busy-start"),
          text: "Stay active until the peer message arrives.",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(active.delivery, "started");

        const runningEvent = yield* eventSink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        assert.isTrue(yield* worker.runOnce);
        yield* Fiber.join(runningEvent);
        const busyProjection = yield* threads.getThreadProjection(target.threadId);
        assert.equal(latestSteerableRun(busyProjection)?.id, active.run.id);
        const turn = (yield* Ref.get(harness.activeTurns)).get(target.threadId);
        assert.isDefined(turn);

        // Issue #73's deterministic shape: a long shell call is in flight and its
        // sibling has not started when the peer message lands mid-turn.
        const toolStartedAt = yield* DateTime.now;
        yield* publishCommandExecution(turn!, {
          ordinal: 1,
          command: "sleep 20",
          status: "running",
          startedAt: toolStartedAt,
          completedAt: null,
        });

        yield* transport.deliverAgent(target.delivery);
        yield* transport.deliverAgent(target.delivery);
        // Queueing schedules no provider effect: nothing steers or interrupts.
        assert.isFalse(yield* worker.runOnce);

        const upstreamMessageId = deliveryMessageId(target.messageId);
        const queuedProjection = yield* threads.getThreadProjection(target.threadId);
        const deliveredMessages = queuedProjection.messages.filter(
          (candidate) => candidate.id === upstreamMessageId,
        );
        assert.lengthOf(deliveredMessages, 1);
        assert.equal(
          deliveredMessages[0]?.text,
          formatPeerEnvelope({
            senderId: target.senderId,
            originProjectId: target.ledgerProjectId,
            exchangeId: target.exchangeId,
            message: target.message,
          }),
        );
        assert.lengthOf(queuedProjection.runs, 2);
        const queuedRun = queuedProjection.runs.find(
          (candidate) => candidate.userMessageId === upstreamMessageId,
        );
        assert.equal(queuedRun?.status, "queued");
        assert.equal(deliveredMessages[0]?.runId, queuedRun?.id);
        assert.equal(
          queuedProjection.runs.find((candidate) => candidate.id === active.run.id)?.status,
          "running",
        );
        assert.isUndefined(
          queuedProjection.turnItems.find(
            (candidate) =>
              candidate.type === "user_message" && candidate.messageId === upstreamMessageId,
          ),
        );
        assert.deepStrictEqual(
          (yield* Ref.get(harness.deliveryInvocations))
            .filter((invocation) => invocation.messageId === upstreamMessageId)
            .map((invocation) => invocation.mode),
          ["queue", "queue"],
        );
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
        assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);

        // The sibling starts after the incoming message and completes normally,
        // then the long call and the turn end on their own.
        const activeCompleted = yield* eventSink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.runId === active.run.id &&
              stored.event.payload.status === "completed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const toolCompletedAt = yield* DateTime.now;
        yield* publishCommandExecution(turn!, {
          ordinal: 2,
          command: "echo sibling",
          status: "completed",
          startedAt: toolCompletedAt,
          completedAt: toolCompletedAt,
        });
        yield* publishCommandExecution(turn!, {
          ordinal: 1,
          command: "sleep 20",
          status: "completed",
          startedAt: toolStartedAt,
          completedAt: toolCompletedAt,
        });
        yield* PubSub.publish(turn!.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            id: turn!.providerTurnId,
            providerThreadId: turn!.providerThreadId,
            nodeId: turn!.rootNodeId,
            runAttemptId: turn!.attemptId,
            nativeTurnRef: {
              driver,
              nativeId: `native-turn:${turn!.attemptId}`,
              strength: "strong",
            },
            ordinal: turn!.runOrdinal,
            status: "completed",
            startedAt: toolStartedAt,
            completedAt: toolCompletedAt,
          },
        });
        yield* PubSub.publish(turn!.events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn!.providerThreadId,
          providerTurnId: turn!.providerTurnId,
          runOrdinal: turn!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        // Completion lands once the worker captures the run's checkpoint.
        yield* runWorkerUntil(worker, activeCompleted);

        // The queued delivery becomes the next turn only after the active one ends.
        const queuedRunning = yield* eventSink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.runId === queuedRun?.id &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* runWorkerUntil(worker, queuedRunning);

        const projection = yield* threads.getThreadProjection(target.threadId);
        assert.equal(
          projection.runs.find((candidate) => candidate.id === active.run.id)?.status,
          "completed",
        );
        assert.deepStrictEqual(
          projection.turnItems
            .filter((candidate) => candidate.type === "command_execution")
            .map((candidate) => candidate.status),
          ["completed", "completed"],
        );
        assert.equal(
          projection.runs.find((candidate) => candidate.id === queuedRun?.id)?.status,
          "running",
        );
        assert.equal(
          projection.turnItems.find(
            (
              candidate,
            ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
              candidate.type === "user_message" && candidate.messageId === upstreamMessageId,
          )?.inputIntent,
          "queued_turn",
        );
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
        assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect("attributes human-origin delivery to the user actor", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      const target = yield* seedTarget("human-origin");
      const humanMessageId = LedgerMessageId.make("message:j5-a2a-delivery-human-origin");
      const personId = ParticipantId.make("human:transport-person");
      const message = "Human-authored answer delivered through A2A.";

      // The inbox answer is the only person-originated message: a closing reply.
      yield* transport.deliverAgent({
        ...target.delivery,
        messageId: humanMessageId,
        senderId: personId,
        exchangeRole: "reply",
        message,
      });

      const upstreamMessageId = deliveryMessageId(humanMessageId);
      const projection = yield* threads.getThreadProjection(target.threadId);
      const delivered = projection.messages.find((candidate) => candidate.id === upstreamMessageId);
      assert.equal(delivered?.createdBy, "user");
      assert.equal(
        delivered?.text,
        formatClosedHumanEnvelope({
          senderId: personId,
          message,
        }),
      );
      assert.deepStrictEqual(
        (yield* Ref.get(harness.deliveryInvocations)).filter(
          (invocation) => invocation.messageId === upstreamMessageId,
        ),
        [{ messageId: upstreamMessageId, mode: "queue", createdBy: "user" }],
      );
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect("routes real archive and delete commands through lifecycle closure exactly once", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threads = yield* ThreadManagementService;
      const threadLifecycle = yield* ThreadLifecycleService;
      const ledger = yield* A2ALedger;
      const send = yield* A2ASendService;
      const lifecycle = yield* A2ALifecycleService;
      const sql = yield* SqlClient.SqlClient;
      const ledgerProjectId = LedgerProjectId.make("project:j5-a2a-lifecycle-command-path");
      const sender: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5-a2a-lifecycle-command-path-sender"),
        threadId: ThreadId.make("thread:j5-a2a-lifecycle-command-path-sender"),
      };
      const receiver: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5-a2a-lifecycle-command-path-receiver"),
        threadId: ThreadId.make("thread:j5-a2a-lifecycle-command-path-receiver"),
      };
      const createdAt = "2026-08-29T14:00:00.000Z";

      for (const [index, participant] of [sender, receiver].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:j5-a2a-lifecycle-command-path-create:${index}`),
          threadId: participant.threadId,
          projectId: ProjectId.make(`project:j5-a2a-lifecycle-command-path:${index}`),
          title: `J5 A2A lifecycle command path ${index}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
      }
      yield* ledger.ensureProject({ projectId: ledgerProjectId, createdAt });
      for (const [index, participant] of [sender, receiver].entries()) {
        yield* ledger.append({
          commandId: CommCommandId.make(`command:j5-a2a-lifecycle-command-path-join:${index}`),
          projectId: ledgerProjectId,
          acceptedAt: createdAt,
          event: {
            kind: "participant.joined",
            sender: null,
            receiver: participant.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant },
            createdAt,
          },
        });
      }
      const opened = yield* send.send({
        commandId: CommCommandId.make("command:j5-a2a-lifecycle-command-path-open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Archive the reply-owing participant through the real lifecycle command.",
        expectReply: true,
        intent: "Prove the production archive bridge",
        acceptedAt: createdAt,
      });

      const storedLifecycleEvents = yield* threads.streamStoredEventsFrom().pipe(
        Stream.filter(
          (stored) =>
            stored.event.threadId === receiver.threadId &&
            (stored.event.type === "thread.archived" || stored.event.type === "thread.deleted"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* threadLifecycle.archive({
        commandId: CommandId.make("command:j5-a2a-lifecycle-command-path-archive"),
        threadId: receiver.threadId,
      });
      yield* threadLifecycle.unarchive({
        commandId: CommandId.make("command:j5-a2a-lifecycle-command-path-unarchive"),
        threadId: receiver.threadId,
      });
      yield* threadLifecycle.delete({
        commandId: CommandId.make("command:j5-a2a-lifecycle-command-path-delete"),
        threadId: receiver.threadId,
      });
      const stored = yield* Fiber.join(storedLifecycleEvents);
      assert.deepStrictEqual(
        Array.from(stored, (event) => event.event.type),
        ["thread.archived", "thread.deleted"],
      );
      for (const event of stored) yield* lifecycle.handleStoredEvent(event);

      const state = yield* sql<{
        readonly status: string;
        readonly dropped_events: number;
        readonly terminal_notices: number;
        readonly participant_deleted_events: number;
      }>`
        SELECT
          exchange.status,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'exchange.dropped' AND exchange_id = ${opened.exchangeId}
          ) AS dropped_events,
          (
            SELECT COUNT(*)
            FROM j5_a2a_delivery
            WHERE exchange_role = 'terminal_notice' AND exchange_id = ${opened.exchangeId}
          ) AS terminal_notices,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'participant.deleted' AND receiver = ${receiver.id}
          ) AS participant_deleted_events
        FROM j5_a2a_exchange AS exchange
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(state, [
        {
          status: "dropped",
          dropped_events: 1,
          terminal_notices: 1,
          participant_deleted_events: 1,
        },
      ]);
      assert.deepStrictEqual(yield* ledger.listMembership(ledgerProjectId), [
        {
          projectId: ledgerProjectId,
          participant: sender,
          joinedSeq: 1,
          updatedSeq: 1,
        },
      ]);
      const retiredSend = yield* Effect.flip(
        send.send({
          commandId: CommCommandId.make("command:j5-a2a-lifecycle-command-path-retired-send"),
          senderThreadId: receiver.threadId,
          to: sender.id,
          message: "Upstream unarchive must not revive A2A participation.",
          acceptedAt: createdAt,
        }),
      );
      assert.instanceOf(retiredSend, A2ASenderRetiredError);
      assert.include(retiredSend.message, "participant.left");
    }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
  }),
);

it.effect.each(["completed", "interrupted", "failed"] as const)(
  "settles a committed Astra steer truthfully after %s before execution",
  (terminal) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const transport = yield* A2ADeliveryTransport;
        const worker = yield* OrchestrationEffectWorkerV2;
        const sink = yield* EventSinkV2;
        const target = yield* seedTarget(`post-commit-race-${terminal}`, "gpt-6-astra");
        const running = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* threads.sendToThread({
          projectId: target.projectId,
          threadId: target.threadId,
          commandId: CommandId.make("command:post-commit-race:start"),
          messageId: MessageId.make("message:post-commit-race:start"),
          text: "Inspect until the update arrives.",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.runOnce;
        yield* Fiber.join(running);
        const projection = yield* threads.getThreadProjection(target.threadId);
        const turn = (yield* Ref.get(harness.activeTurns)).get(target.threadId)!;
        const committed = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.type === "user_message" &&
              stored.event.payload.inputIntent === "steer",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const delivery = yield* transport
          .deliverAgent(target.delivery)
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(committed);
        const ended = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === terminal,
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* PubSub.publish(turn.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            ...projection.providerTurns[0]!,
            status: terminal,
            completedAt: yield* DateTime.now,
          },
        });
        yield* Fiber.join(ended);
        // Drive the real worker's five attempts with controlled time, never sleeps.
        for (const delay of [0, 100, 200, 400, 800]) {
          yield* TestClock.adjust(delay);
          yield* worker.drain();
        }
        const outcome = yield* Fiber.join(delivery);
        assert.equal(outcome._tag, terminal === "completed" ? "Success" : "Failure");
        for (let retry = 0; retry < 2; retry++) {
          if (terminal === "completed") yield* transport.deliverAgent(target.delivery);
          else
            assert.equal(
              (yield* transport.deliverAgent(target.delivery).pipe(Effect.flip))._tag,
              "A2ADeliveryTransportError",
            );
        }
        const after = yield* threads.getThreadProjection(target.threadId);
        assert.lengthOf(after.runs, terminal === "completed" ? 2 : 1);
        const messages = after.messages.filter(
          (message) => message.id === deliveryMessageId(target.messageId),
        );
        assert.lengthOf(messages, 1);
        if (terminal === "completed") {
          const followUp = after.runs.find((run) => run.userMessageId === messages[0]!.id);
          assert.equal(followUp?.modelSelection.model, "gpt-6-astra");
        }
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
        assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect(
  "bounds a missing steer acknowledgment and recognizes a later success without reinjection",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const transport = yield* A2ADeliveryTransport;
        const worker = yield* OrchestrationEffectWorkerV2;
        const sink = yield* EventSinkV2;
        const target = yield* seedTarget("receipt-timeout", "gpt-6-astra");
        const running = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* threads.sendToThread({
          projectId: target.projectId,
          threadId: target.threadId,
          commandId: CommandId.make("command:receipt-timeout:start"),
          messageId: MessageId.make("message:receipt-timeout:start"),
          text: "Inspect until the update arrives.",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.runOnce;
        yield* Fiber.join(running);
        const committed = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.type === "user_message" &&
              stored.event.payload.inputIntent === "steer",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const delivery = yield* transport
          .deliverAgent(target.delivery)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(committed);
        // Leave the native effect pending: no provider receipt is available.
        yield* TestClock.adjust("30 seconds");
        const failure = yield* Fiber.join(delivery);
        assert.equal(failure._tag, "A2ADeliveryTransportError");
        assert.isTrue(Cause.isTimeoutError(failure.cause));
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
        // Timing out only detaches the observer. The original effect can settle.
        yield* worker.drain();
        yield* transport.deliverAgent(target.delivery);
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 1);
        const after = yield* threads.getThreadProjection(target.threadId);
        assert.lengthOf(after.runs, 1);
        assert.lengthOf(
          after.messages.filter((message) => message.id === deliveryMessageId(target.messageId)),
          1,
        );
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect(
  "carries a registered agent's ask through the human inbox and returns one durable reply",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const base = makeTestLayer(harness);
      const joined = Layer.mergeAll(
        sendServiceLayer.pipe(Layer.provide(peerDirectoryNoneLayer)),
        deliveryWorkerLayer,
        humanInboxLayer,
        homeRegistrarLayer,
      ).pipe(Layer.provideMerge(base));
      yield* Effect.gen(function* () {
        const ledger = yield* A2ALedger;
        const registrar = yield* A2AHomeRegistrar;
        const send = yield* A2ASendService;
        const inbox = yield* A2AHumanInbox;
        const delivery = yield* A2ADeliveryWorker;
        const orchestrator = yield* OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const outbox = yield* EffectOutboxV2;
        const sink = yield* EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const target = yield* seedTarget("human-roundtrip", modelSelection.model, registrar);
        const home = yield* registrar.getHomeForThread(target.threadId);
        assert.equal(home.projectId, target.ledgerProjectId);
        assert.equal(home.participantId, target.receiverId);
        const personId = ParticipantId.make("human:joined-message-path");
        yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${personId}, 1, ${createdAt})
      `;
        const ask = {
          commandId: CommCommandId.make("command:joined-message-path:ask"),
          senderThreadId: target.threadId,
          to: personId,
          message: "Please verify the scoped delivery result.",
          expectReply: true,
          intent: "Review the delivery result",
          urgency: "blocking" as const,
          acceptedAt: createdAt,
        };
        const accepted = yield* send.send(ask);
        assert.equal(accepted.exchangeState, "open");
        assert.deepStrictEqual(yield* send.send(ask), accepted);
        assert.deepStrictEqual(yield* inbox.list(personId), []);
        assert.lengthOf(yield* Ref.get(harness.startedInputs), 0);
        const milestones = yield* delivery.drain;
        assert.deepStrictEqual(
          milestones.map(({ messageId, state }) => ({ messageId, state })),
          [{ messageId: accepted.messageId, state: "delivered" }],
        );
        const obligations = yield* inbox.list(personId);
        assert.lengthOf(obligations, 1);
        assert.equal(obligations[0]?.exchangeId, accepted.exchangeId);
        const answer = {
          commandId: CommCommandId.make("command:joined-message-path:answer"),
          personId,
          exchangeId: accepted.exchangeId!,
          message: "Verified the intended recipient and the durable receipt.",
          acceptedAt: createdAt,
        };
        const replied = yield* inbox.answer(answer);
        assert.deepStrictEqual(yield* inbox.answer(answer), replied);
        assert.equal(replied.exchangeState, "closed");
        assert.deepStrictEqual(yield* inbox.list(personId), []);
        assert.lengthOf(yield* inbox.list(personId, "answered"), 1);
        assert.lengthOf((yield* orchestrator.getThreadProjection(target.threadId)).messages, 0);
        const replyMilestones = yield* delivery.drain;
        assert.deepStrictEqual(
          replyMilestones.map(({ messageId, state }) => ({ messageId, state })),
          [{ messageId: replied.messageId, state: "delivered" }],
        );
        const upstreamMessageId = deliveryMessageId(replied.messageId);
        const receipt = yield* sql<{ readonly aggregate_id: string; readonly status: string }>`
        SELECT aggregate_id, status FROM orchestration_command_receipts
        WHERE command_id = ${deliveryCommandId(replied.messageId)}
      `;
        assert.deepStrictEqual(receipt, [{ aggregate_id: target.threadId, status: "accepted" }]);
        assert.lengthOf(yield* Ref.get(harness.startedInputs), 0);
        const effects = yield* outbox.listByCommandId(deliveryCommandId(replied.messageId));
        const start = effects.find((effect) => effect.request.type === "provider-turn.start");
        assert.isDefined(start);
        assert.equal(start?.status, "pending");
        const running = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        assert.equal((yield* outbox.awaitSettled(start!.id)).status, "succeeded");
        const inputs = yield* Ref.get(harness.startedInputs);
        assert.lengthOf(inputs, 1);
        assert.equal(inputs[0]?.threadId, target.threadId);
        assert.equal(inputs[0]?.message.messageId, upstreamMessageId);
        assert.include(inputs[0]!.message.text, answer.message);
        assert.equal(inputs[0]?.message.createdBy, "user");
        assert.deepStrictEqual(yield* delivery.drain, []);
        assert.equal(yield* worker.drain(), 0);
        assert.deepStrictEqual(yield* send.send(ask), accepted);
        assert.deepStrictEqual(yield* inbox.answer(answer), replied);
        const facts = yield* ledger.readEvents({
          projectId: target.ledgerProjectId,
          cursor: { afterSeq: 0 },
          limit: 100,
        });
        assert.equal(facts.events.filter((event) => event.kind === "exchange.opened").length, 1);
        assert.equal(facts.events.filter((event) => event.kind === "exchange.closed").length, 1);
        assert.lengthOf((yield* orchestrator.getThreadProjection(target.threadId)).messages, 1);
      }).pipe(Effect.provide(joined));
    }),
);

it.effect.each(["wrong home", "unavailable participant"] as const)(
  "refuses %s without dispatching to a fallback recipient",
  (refusal) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const target = yield* seedTarget("refused-route");
        const transport = yield* A2ADeliveryTransport;
        const threads = yield* ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        const error = yield* transport
          .deliverAgent({
            ...target.delivery,
            ...(refusal === "wrong home"
              ? { receiverProjectId: LedgerProjectId.make("project:unrelated") }
              : { receiverId: ParticipantId.make("agent:unavailable") }),
          })
          .pipe(Effect.flip);
        if (error._tag !== "A2ADeliveryTransportError") return yield* Effect.die(error);
        assert.equal(error.operation, "deliver agent");
        assert.include(String(error.cause), "membership disappeared before delivery");
        assert.deepStrictEqual(yield* Ref.get(harness.deliveryInvocations), []);
        assert.deepStrictEqual(yield* Ref.get(harness.startedInputs), []);
        const projection = yield* threads.getThreadProjection(target.threadId);
        assert.lengthOf(projection.messages, 0);
        assert.lengthOf(projection.runs, 0);
        assert.deepStrictEqual(
          yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_command_receipts
          WHERE command_id = ${deliveryCommandId(target.messageId)}
        `,
          [{ count: 0 }],
        );
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect.each([
  {
    crossProject: false,
    label:
      "dispatches a same-project peer ask and reply once through the accepted ledger operation",
  },
  {
    crossProject: true,
    label: "dispatches a cross-project peer ask and reply once, closing the asker's Exchange",
  },
])("$label", ({ crossProject }) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const base = makeTestLayer(harness);
    const joined = Layer.mergeAll(
      sendServiceLayer.pipe(Layer.provide(peerDirectoryNoneLayer)),
      deliveryWorkerLayer,
      homeRegistrarLayer,
    ).pipe(Layer.provideMerge(base));
    yield* Effect.gen(function* () {
      const registrar = yield* A2AHomeRegistrar;
      const sender = yield* seedTarget("joined-sender", modelSelection.model, registrar);
      const receiver = yield* seedTarget(
        "joined-receiver",
        modelSelection.model,
        registrar,
        crossProject ? undefined : sender.ledgerProjectId,
      );
      const send = yield* A2ASendService;
      const delivery = yield* A2ADeliveryWorker;
      const orchestrator = yield* OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const sink = yield* EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const ask = {
        commandId: CommCommandId.make("command:cross-project:joined-ask"),
        senderThreadId: sender.threadId,
        to: receiver.receiverId,
        message: "Confirm receipt from your own project.",
        expectReply: true,
        intent: "Check cross-project delivery",
        acceptedAt: DateTime.formatIso(yield* DateTime.now),
      };
      const accepted = yield* send.send(ask);
      assert.deepStrictEqual(yield* send.send(ask), accepted);
      assert.equal(accepted.exchangeState, "open");
      assert.lengthOf((yield* orchestrator.getThreadProjection(receiver.threadId)).messages, 0);
      assert.lengthOf(yield* Ref.get(harness.startedInputs), 0);
      const milestones = yield* delivery.drain;
      assert.deepStrictEqual(
        milestones.map(({ messageId, state }) => ({ messageId, state })),
        [{ messageId: accepted.messageId, state: "delivered" }],
      );
      const receipt = yield* sql<{ readonly aggregate_id: string; readonly status: string }>`
        SELECT aggregate_id, status FROM orchestration_command_receipts
        WHERE command_id = ${deliveryCommandId(accepted.messageId)}
      `;
      assert.deepStrictEqual(receipt, [{ aggregate_id: receiver.threadId, status: "accepted" }]);
      const running = yield* sink.stream({ threadId: receiver.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.status === "running",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* worker.drain();
      yield* Fiber.join(running);
      const inputs = yield* Ref.get(harness.startedInputs);
      assert.lengthOf(inputs, 1);
      assert.equal(inputs[0]?.threadId, receiver.threadId);
      assert.equal(inputs[0]?.message.messageId, deliveryMessageId(accepted.messageId));
      assert.include(inputs[0]!.message.text, ask.message);
      const replyInput = {
        commandId: CommCommandId.make("command:cross-project:joined-reply"),
        senderThreadId: receiver.threadId,
        to: sender.receiverId,
        exchangeId: accepted.exchangeId!,
        message: "Confirmed from the recipient's project.",
        acceptedAt: ask.acceptedAt,
      };
      const reply = yield* send.send(replyInput);
      assert.equal(reply.exchangeState, "closed");
      assert.deepStrictEqual(yield* send.send(replyInput), reply);
      const replyMilestones = yield* delivery.drain;
      assert.deepStrictEqual(
        replyMilestones.map(({ messageId, state }) => ({ messageId, state })),
        [{ messageId: reply.messageId, state: "delivered" }],
      );
      assert.deepStrictEqual(yield* delivery.drain, []);
      const origin = yield* orchestrator.getThreadProjection(sender.threadId);
      assert.equal(
        origin.messages.filter((message) => message.id === deliveryMessageId(reply.messageId))
          .length,
        1,
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly project_id: string; readonly status: string }>`
        SELECT project_id, status FROM j5_a2a_exchange WHERE exchange_id = ${accepted.exchangeId}
      `,
        [{ project_id: sender.ledgerProjectId, status: "closed" }],
      );
      assert.deepStrictEqual(yield* send.send(ask), accepted);
      assert.deepStrictEqual(yield* send.send(replyInput), reply);
      assert.lengthOf(yield* Ref.get(harness.startedInputs), 1);
    }).pipe(Effect.provide(joined));
  }),
);

const startPendingTestTurn = Effect.fn("A2AIntegration.startPendingTestTurn")(function* (
  threadId: ThreadId,
) {
  const sink = yield* EventSinkV2;
  const worker = yield* OrchestrationEffectWorkerV2;
  const projection = yield* (yield* ThreadManagementService).getThreadProjection(threadId);
  const runId = projection.runs.at(-1)!.id;
  const running = yield* sink.stream({ threadId }).pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "provider-turn.updated" &&
        stored.event.runId === runId &&
        stored.event.payload.status === "running",
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* runWorkerUntil(worker, running);
});

const finishTestTurn = Effect.fn("A2AIntegration.finishTestTurn")(function* (
  harness: DeliveryHarness,
  threadId: ThreadId,
) {
  const turn = (yield* Ref.get(harness.activeTurns)).get(threadId)!;
  const sink = yield* EventSinkV2;
  const worker = yield* OrchestrationEffectWorkerV2;
  const completed = yield* sink.stream({ threadId }).pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" &&
        stored.event.runId === turn.runId &&
        stored.event.payload.status === "completed",
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* PubSub.publish(turn.events, {
    type: "turn.terminal",
    driver,
    providerThreadId: turn.providerThreadId,
    providerTurnId: turn.providerTurnId,
    runOrdinal: turn.runOrdinal,
    status: "completed",
    failure: null,
    threadDisposition: "reusable",
  });
  yield* runWorkerUntil(worker, completed);
});

const makeMessageLifecycleLayer = (
  harness: DeliveryHarness,
  settings: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
) => {
  const base = makeTestLayer(harness, settings);
  const messages = Layer.mergeAll(
    sendServiceLayer.pipe(Layer.provide(peerDirectoryNoneLayer)),
    deliveryWorkerLayer,
    humanInboxLayer,
    homeRegistrarLayer,
  ).pipe(Layer.provideMerge(base));
  return Layer.mergeAll(lifecycleServiceLayer, threadLifecycleServiceLayer).pipe(
    Layer.provideMerge(messages),
  );
};

it.effect(
  "keeps an open human obligation through upstream settlement and wakes once on its reply",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-01T12:00:00Z"));
      const harness = yield* makeHarness;
      const base = makeMessageLifecycleLayer(harness, { sidebarAutoSettleAfterDays: 1 });
      const settlement = ThreadSettlement.layer.pipe(
        Layer.provide(ProjectionStore.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([]),
            }),
            Layer.mock(GitManager)({}),
            Layer.mock(PullRequestService)({ subscribeMerges: Effect.succeed(Stream.never) }),
            Layer.mock(TerminalManager.TerminalManager)({ closeIdle: () => Effect.void }),
            Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
              runForThread: () => Effect.succeed({ status: "no-script" } as const),
            }),
          ),
        ),
        Layer.provideMerge(base),
      );
      yield* Effect.gen(function* () {
        const registrar = yield* A2AHomeRegistrar;
        const target = yield* seedTarget("settlement-reply", modelSelection.model, registrar);
        const threads = yield* ThreadManagementService;
        yield* threads.sendToThread({
          commandId: CommandId.make("command:settlement:initial"),
          projectId: target.projectId,
          threadId: target.threadId,
          messageId: MessageId.make("message:settlement:initial"),
          text: "Prepare a result for human review.",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* startPendingTestTurn(target.threadId);
        yield* finishTestTurn(harness, target.threadId);
        const sql = yield* SqlClient.SqlClient;
        const personId = ParticipantId.make("human:settlement-review");
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES (${personId}, 1, ${acceptedAt})`;
        const send = yield* A2ASendService;
        const delivery = yield* A2ADeliveryWorker;
        const inbox = yield* A2AHumanInbox;
        const ask = yield* send.send({
          commandId: CommCommandId.make("command:settlement:ask"),
          senderThreadId: target.threadId,
          to: personId,
          message: "Please review the prepared result.",
          expectReply: true,
          intent: "Review prepared result",
          urgency: "blocking",
          acceptedAt,
        });
        yield* delivery.drain;
        const before = yield* threads.getThreadProjection(target.threadId);
        const obligation = yield* inbox.list(personId);
        assert.lengthOf(obligation, 1);
        yield* TestClock.setTime(Date.parse("2026-09-03T12:00:00Z"));
        const sink = yield* EventSinkV2;
        const settledReceipt = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter((stored) => stored.event.type === "thread.settled"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const service = yield* ThreadSettlement.ThreadSettlementServiceV2;
        yield* service.start();
        const settled = yield* Fiber.join(settledReceipt);
        assert.isTrue(Option.isSome(settled));
        if (Option.isSome(settled))
          assert.isFalse(yield* (yield* A2ALifecycleService).handleStoredEvent(settled.value));
        const after = yield* threads.getThreadProjection(target.threadId);
        assert.equal(after.thread.settledOverride, "settled");
        assert.deepStrictEqual(after.messages, before.messages);
        assert.deepStrictEqual(yield* inbox.list(personId), obligation);
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${ask.exchangeId}`,
          [{ status: "open" }],
        );
        const answerInput = {
          commandId: CommCommandId.make("command:settlement:reply"),
          personId,
          exchangeId: ask.exchangeId!,
          message: "Reviewed; proceed with the result.",
          acceptedAt: DateTime.formatIso(yield* DateTime.now),
        };
        const answer = yield* inbox.answer(answerInput);
        assert.deepStrictEqual(yield* inbox.answer(answerInput), answer);
        yield* delivery.drain;
        const awake = yield* threads.getThreadProjection(target.threadId);
        assert.isNull(awake.thread.settledOverride);
        assert.lengthOf(
          awake.messages.filter((message) => message.id === deliveryMessageId(answer.messageId)),
          1,
        );
        yield* startPendingTestTurn(target.threadId);
        assert.lengthOf(yield* Ref.get(harness.startedInputs), 2);
        assert.deepStrictEqual(yield* delivery.drain, []);
        assert.deepStrictEqual(yield* inbox.list(personId), []);
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${ask.exchangeId}`,
          [{ status: "closed" }],
        );
      }).pipe(Effect.provide(settlement));
    }),
);

it.effect.each([false, true])(
  "recovers a delivered human reply without reopening its exchange (restart opt-in=%s)",
  (enabled) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const target = yield* seedTarget(
          "restart-reply",
          modelSelection.model,
          yield* A2AHomeRegistrar,
        );
        const send = yield* A2ASendService;
        const inbox = yield* A2AHumanInbox;
        const delivery = yield* A2ADeliveryWorker;
        const threads = yield* ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        const personId = ParticipantId.make("human:restart-review");
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES (${personId}, 1, ${acceptedAt})`;
        const askInput = {
          commandId: CommCommandId.make("command:restart:ask"),
          senderThreadId: target.threadId,
          to: personId,
          message: "Please review before I continue.",
          expectReply: true,
          intent: "Review before continuing",
          urgency: "blocking" as const,
          acceptedAt,
        };
        const ask = yield* send.send(askInput);
        yield* delivery.drain;
        const answerInput = {
          commandId: CommCommandId.make("command:restart:reply"),
          personId,
          exchangeId: ask.exchangeId!,
          message: "Reviewed; finish the remaining work.",
          acceptedAt,
        };
        const answer = yield* inbox.answer(answerInput);
        yield* delivery.drain;
        yield* startPendingTestTurn(target.threadId);
        const before = yield* threads.getThreadProjection(target.threadId);
        const sourceRun = before.runs[0]!;
        const nativeRef = before.providerThreads.find(
          (thread) => thread.id === sourceRun.providerThreadId,
        )!.nativeThreadRef;
        const recovered = yield* (yield* ProviderRuntimeRecoveryService).recover;
        assert.equal(recovered.terminalizedRuns, 1);
        const continuationEffect = yield* (yield* EffectOutboxV2).get(
          `effect:restart-continuation:${sourceRun.id}`,
        );
        assert.equal(Option.isSome(continuationEffect), enabled);
        if (Option.isSome(continuationEffect))
          assert.equal(continuationEffect.value.status, "pending");
        // Recovery leaves restart continuation parked until the ordinary worker starts.
        assert.lengthOf(yield* Ref.get(harness.startedInputs), 1);
        yield* (yield* ProviderSessionManagerV2).shutdown;
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        const after = yield* threads.getThreadProjection(target.threadId);
        assert.equal(after.runs.find((run) => run.id === sourceRun.id)?.status, "cancelled");
        const continuationId = MessageId.make(`message:restart-continuation:${sourceRun.id}`);
        assert.lengthOf(
          after.messages.filter((message) => message.id === continuationId),
          enabled ? 1 : 0,
        );
        assert.lengthOf(
          after.messages.filter((message) => message.id === deliveryMessageId(answer.messageId)),
          1,
        );
        assert.deepStrictEqual(yield* inbox.answer(answerInput), answer);
        assert.deepStrictEqual(yield* send.send(askInput), ask);
        assert.deepStrictEqual(yield* delivery.drain, []);
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${ask.exchangeId}`,
          [{ status: "closed" }],
        );
        assert.deepStrictEqual(yield* inbox.list(personId), []);
        if (enabled) {
          yield* startPendingTestTurn(target.threadId);
          const inputs = yield* Ref.get(harness.startedInputs);
          assert.lengthOf(inputs, 2);
          assert.equal(inputs[1]?.message.messageId, continuationId);
          assert.deepStrictEqual(inputs[1]?.providerThread.nativeThreadRef, nativeRef);
          assert.deepStrictEqual(
            (yield* Ref.get(harness.resumedThreads)).at(-1)?.nativeThreadRef,
            nativeRef,
          );
        } else {
          assert.lengthOf(yield* Ref.get(harness.startedInputs), 1);
          assert.equal(yield* (yield* OrchestrationEffectWorkerV2).drain(), 0);
        }
      }).pipe(
        Effect.provide(
          makeMessageLifecycleLayer(harness, { continueThreadsAfterServerUpdate: enabled }),
        ),
      );
    }),
);

it.effect.each(["archive", "delete"] as const)(
  "does not execute a prepared restart continuation after recipient %s",
  (terminal) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const target = yield* seedTarget(
          `restart-${terminal}`,
          modelSelection.model,
          yield* A2AHomeRegistrar,
        );
        yield* (yield* A2ADeliveryTransport).deliverAgent(target.delivery);
        yield* startPendingTestTurn(target.threadId);
        const recovery = yield* ProviderRuntimeRecoveryService;
        yield* recovery.prepareForShutdown;
        yield* (yield* ThreadLifecycleService)[terminal]({
          commandId: CommandId.make(`command:restart:${terminal}`),
          threadId: target.threadId,
        });
        yield* recovery.recover;
        yield* (yield* ProviderSessionManagerV2).shutdown;
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        const after = yield* (yield* ThreadManagementService).getThreadProjection(target.threadId);
        assert.isNotNull(terminal === "archive" ? after.thread.archivedAt : after.thread.deletedAt);
        assert.lengthOf(
          after.messages.filter((message) =>
            String(message.id).startsWith("message:restart-continuation:"),
          ),
          0,
        );
        assert.lengthOf(after.runs, 1);
        assert.lengthOf(yield* Ref.get(harness.startedInputs), 1);
      }).pipe(
        Effect.provide(
          makeMessageLifecycleLayer(harness, { continueThreadsAfterServerUpdate: true }),
        ),
      );
    }),
);

const replayLifecycleThrough = Effect.fn("A2AIntegration.replayLifecycleThrough")(function* (
  sequence: number,
) {
  const threads = yield* ThreadManagementService;
  const boundedThreads = ThreadManagementService.of({
    ...threads,
    streamStoredEventsFrom: (input) =>
      (input?.afterSequence ?? 0) >= sequence
        ? Stream.empty
        : threads
            .streamStoredEventsFrom(input)
            .pipe(Stream.takeUntil((stored) => stored.sequence >= sequence)),
  });
  yield* Effect.gen(function* () {
    yield* (yield* A2ALifecycleService).replayCommittedEvents;
  }).pipe(
    Effect.provide(Layer.fresh(lifecycleServiceLayer)),
    Effect.provideService(ThreadManagementService, boundedThreads),
  );
});

it.effect(
  "closes only the removed project's obligations once through real project deletion and cursor replay",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const base = makeMessageLifecycleLayer(harness);
      const enrichment = {
        repositoryIdentity: null,
        faviconPath: null,
        repositoryIdentityResolved: true,
      };
      const projects = ProjectServiceLayerLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectEnrichmentService)({
              getAvailable: () => Effect.succeed(enrichment),
              peek: () => Effect.succeed(enrichment),
              invalidate: () => Effect.void,
            }),
            Layer.mock(WorkspacePaths)({ normalizeWorkspaceRoot: (root) => Effect.succeed(root) }),
          ),
        ),
        Layer.provide(serverConfigLayer),
        Layer.provideMerge(base),
      );
      yield* Effect.gen(function* () {
        const registrar = yield* A2AHomeRegistrar;
        const first = yield* seedTarget("project-remove-first", modelSelection.model, registrar);
        const second = yield* seedTarget(
          "project-remove-second",
          modelSelection.model,
          registrar,
          first.ledgerProjectId,
          first.projectId,
        );
        const survivor = yield* seedTarget(
          "project-remove-survivor",
          modelSelection.model,
          registrar,
          first.ledgerProjectId,
        );
        const projectService = yield* ProjectService.ProjectService;
        const filesystem = yield* FileSystem.FileSystem;
        yield* projectService.create({
          commandId: CommandId.make("command:project-remove:create"),
          projectId: first.projectId,
          title: "Disposable project removal",
          workspaceRoot: yield* filesystem.makeTempDirectoryScoped({
            prefix: "j5-project-remove-",
          }),
        });
        const send = yield* A2ASendService;
        const delivery = yield* A2ADeliveryWorker;
        const inbox = yield* A2AHumanInbox;
        const sql = yield* SqlClient.SqlClient;
        const personId = ParticipantId.make("human:project-remove");
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES (${personId}, 1, ${acceptedAt})`;
        const peerAsk = yield* send.send({
          commandId: CommCommandId.make("command:project-remove:peer-ask"),
          senderThreadId: survivor.threadId,
          to: first.receiverId,
          message: "Return the project result.",
          expectReply: true,
          intent: "Return project result",
          acceptedAt,
        });
        const humanAsk = yield* send.send({
          commandId: CommCommandId.make("command:project-remove:human-ask"),
          senderThreadId: second.threadId,
          to: personId,
          message: "Review this project's result.",
          expectReply: true,
          intent: "Review project result",
          urgency: "blocking",
          acceptedAt,
        });
        const survivingAsk = yield* send.send({
          commandId: CommCommandId.make("command:project-remove:surviving-ask"),
          senderThreadId: survivor.threadId,
          to: personId,
          message: "Keep this unrelated request.",
          expectReply: true,
          intent: "Unrelated surviving request",
          urgency: "soon",
          acceptedAt,
        });
        yield* delivery.drain;
        assert.lengthOf(yield* inbox.list(personId), 2);
        const threads = yield* ThreadManagementService;
        const storedDeletions = yield* threads.streamStoredEventsFrom().pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "thread.deleted" &&
              [first.threadId, second.threadId].includes(stored.event.threadId),
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        const deletion = {
          commandId: CommandId.make("command:project-remove:delete"),
          projectId: first.projectId,
          force: true,
        };
        yield* projectService.delete(deletion);
        const stored = yield* Fiber.join(storedDeletions);
        assert.lengthOf(stored, 2);
        const lastSequence = Math.max(...stored.map((event) => event.sequence));
        // Rebuild the bridge service twice, retaining the database cursor as a restart would.
        yield* replayLifecycleThrough(lastSequence);
        yield* replayLifecycleThrough(lastSequence);
        for (const event of stored) yield* (yield* A2ALifecycleService).handleStoredEvent(event);
        // A retried delete replays its receipt; it deletes nothing a second time.
        assert.isNotNull((yield* projectService.delete(deletion)).deletedAt);
        yield* delivery.drain;
        assert.deepStrictEqual(yield* delivery.drain, []);
        const memberships = yield* (yield* A2ALedger).listMembership(first.ledgerProjectId);
        assert.deepStrictEqual(
          memberships.map((membership) => membership.participant.id),
          [survivor.receiverId],
        );
        assert.deepStrictEqual(
          (yield* inbox.list(personId)).map((row) => row.exchangeId),
          [survivingAsk.exchangeId],
        );
        for (const exchangeId of [peerAsk.exchangeId, humanAsk.exchangeId]) {
          const rows = yield* sql`
          SELECT status,
            (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped' AND exchange_id = ${exchangeId}) AS dropped,
            (SELECT COUNT(*) FROM j5_a2a_delivery WHERE exchange_role = 'terminal_notice' AND exchange_id = ${exchangeId}) AS notices
          FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}`;
          assert.deepStrictEqual(rows, [{ status: "dropped", dropped: 1, notices: 1 }]);
        }
        for (const target of [first, second]) {
          assert.isNotNull((yield* threads.getThreadProjection(target.threadId)).thread.deletedAt);
          assert.deepStrictEqual(
            yield* sql`SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE kind = 'participant.deleted' AND receiver = ${target.receiverId}`,
            [{ count: 1 }],
          );
        }
        const outside = yield* threads.getThreadProjection(survivor.threadId);
        assert.isNull(outside.thread.deletedAt);
        assert.lengthOf(outside.messages, 1);
        assert.lengthOf(yield* Ref.get(harness.startedInputs), 0);
        const oldAnswer = yield* inbox
          .answer({
            commandId: CommCommandId.make("command:project-remove:late-answer"),
            personId,
            exchangeId: humanAsk.exchangeId!,
            message: "This late answer cannot revive removed work.",
            acceptedAt,
          })
          .pipe(Effect.exit);
        assert.equal(oldAnswer._tag, "Failure");
      }).pipe(Effect.provide(projects));
    }),
);

it.effect("observes a real overdue queued delivery without terminalizing or reinjecting it", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const layer = watchdogLayer.pipe(
      Layer.provide(Layer.mergeAll(ProjectionStore.layer, IdAllocator.layer)),
      Layer.provideMerge(makeTestLayer(harness)),
    );
    yield* Effect.gen(function* () {
      const target = yield* seedTarget("watchdog-queued-delivery");
      yield* (yield* A2ADeliveryTransport).deliverAgent(target.delivery);
      const threads = yield* ThreadManagementService;
      const before = yield* threads.getThreadProjection(target.threadId);
      assert.equal(before.runs[0]?.status, "starting");
      assert.isNull(before.runs[0]?.startedAt);
      const outbox = yield* EffectOutboxV2;
      const effects = yield* outbox.listByCommandId(deliveryCommandId(target.messageId));
      yield* TestClock.adjust(QUEUED_RUN_WATCHDOG_DELAY_MS);
      const watchdog = yield* QueuedRunWatchdog;
      yield* watchdog.scan();
      yield* watchdog.scan();
      const after = yield* threads.getThreadProjection(target.threadId);
      assert.deepStrictEqual(after.runs, before.runs);
      assert.deepStrictEqual(after.messages, before.messages);
      assert.deepStrictEqual(
        yield* outbox.listByCommandId(deliveryCommandId(target.messageId)),
        effects,
      );
      const facts = after.turnItems.filter(
        (item) => item.type === "error" && item.failure.code === "queued_run_waiting",
      );
      assert.lengthOf(facts, 1);
      const fact = facts[0]!;
      assert.equal(fact.title, "Run waiting");
      if (fact.type === "error")
        assert.equal(fact.failure.message, "Run waiting 5m, not yet dispatched.");
      assert.lengthOf(yield* Ref.get(harness.startedInputs), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([false, true])(
  "cancels accepted queued delivery permanently across archive/unarchive (sender archived=%s)",
  (archiveSender) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const source = yield* seedTarget("cancel-source");
        const target = yield* seedTarget("cancel-target");
        const threads = yield* ThreadManagementService;
        const lifecycle = yield* A2ALifecycleService;
        const threadLifecycle = yield* ThreadLifecycleService;
        yield* threads.sendToThread({
          projectId: target.projectId,
          threadId: target.threadId,
          commandId: CommandId.make("cancel:active"),
          messageId: MessageId.make("cancel:active"),
          text: "Existing work",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        yield* startPendingTestTurn(target.threadId);
        const sent = yield* (yield* A2ASendService).send({
          commandId: CommCommandId.make("cancel:send"),
          senderThreadId: source.threadId,
          to: target.receiverId,
          message: "Must not execute if cancelled",
          acceptedAt: "2026-09-12T00:00:00.000Z",
        });
        // A real dispatch receipt exists, but the process has not yet committed its A2A outcome.
        yield* (yield* A2ADeliveryTransport).deliverAgent({
          ...target.delivery,
          originProjectId: source.ledgerProjectId,
          senderId: source.receiverId,
          messageId: sent.messageId,
          exchangeId: null,
          exchangeRole: "none",
          message: "Must not execute if cancelled",
        });
        const queued = (yield* threads.getThreadProjection(target.threadId)).runs.find(
          (run) => run.userMessageId === deliveryMessageId(sent.messageId),
        )!;
        assert.equal(queued.status, "queued");
        const archived = archiveSender ? source : target;
        yield* threadLifecycle.archive({
          commandId: CommandId.make("cancel:archive"),
          threadId: archived.threadId,
        });
        // Upstream archive cancels the recipient's queue, but cannot withdraw outgoing work.
        assert.equal(
          (yield* threads.getThreadProjection(target.threadId)).runs.find(
            (run) => run.id === queued.id,
          )?.status,
          archiveSender ? "queued" : "cancelled",
        );
        yield* lifecycle.archiveParticipant({
          participantId: archived.receiverId,
          archivedAt: "2026-09-12T00:01:00.000Z",
        });
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`,
          [{ status: "cancelled" }],
        );
        yield* threadLifecycle.unarchive({
          commandId: CommandId.make("cancel:unarchive"),
          threadId: archived.threadId,
        });
        yield* finishTestTurn(harness, target.threadId);
        assert.equal(yield* (yield* OrchestratorV2).resumeQueuedRuns, 0);
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        const after = yield* threads.getThreadProjection(target.threadId);
        assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "cancelled");
        assert.lengthOf(
          (yield* Ref.get(harness.startedInputs)).filter((input) => input.runId === queued.id),
          0,
        );
        assert.lengthOf(yield* (yield* A2ADeliveryWorker).drain, 0);
      }).pipe(Effect.provide(makeMessageLifecycleLayer(harness)));
    }),
);

it.effect(
  "records an already accepted idle-target run as delivered when archive leaves it executing",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const source = yield* seedTarget("accepted-source");
        const target = yield* seedTarget("accepted-idle");
        const sent = yield* (yield* A2ASendService).send({
          commandId: CommCommandId.make("accepted:send"),
          senderThreadId: source.threadId,
          to: target.receiverId,
          message: "Accepted immediate work",
          acceptedAt: "2026-09-12T00:00:00.000Z",
        });
        yield* (yield* A2ADeliveryTransport).deliverAgent({
          ...target.delivery,
          originProjectId: source.ledgerProjectId,
          senderId: source.receiverId,
          messageId: sent.messageId,
          exchangeId: null,
          exchangeRole: "none",
          message: "Accepted immediate work",
        });
        yield* startPendingTestTurn(target.threadId);
        const threads = yield* ThreadManagementService;
        const run = (yield* threads.getThreadProjection(target.threadId)).runs.find(
          (entry) => entry.userMessageId === deliveryMessageId(sent.messageId),
        )!;
        assert.equal(run.status, "running");
        yield* (yield* ThreadLifecycleService).archive({
          commandId: CommandId.make("accepted:archive"),
          threadId: target.threadId,
        });
        yield* (yield* A2ALifecycleService).archiveParticipant({
          participantId: target.receiverId,
          archivedAt: "2026-09-12T00:01:00.000Z",
        });
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`,
          [{ status: "delivered" }],
        );
        assert.equal(
          (yield* threads.getThreadProjection(target.threadId)).runs.find(
            (entry) => entry.id === run.id,
          )?.status,
          "running",
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_comm_event WHERE kind = 'message.cancelled' AND json_extract(payload, '$.messageId') = ${sent.messageId}`,
          0,
        );
        yield* finishTestTurn(harness, target.threadId);
        assert.lengthOf(yield* Ref.get(harness.startedInputs), 1);
      }).pipe(Effect.provide(makeMessageLifecycleLayer(harness)));
    }),
);

it.effect("delivers attachment-tool claims from the ledger after the pending upload is gone", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const base = makeMessageLifecycleLayer(harness).pipe(
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = J5AttachmentSendHandlersLive.pipe(Layer.provideMerge(base));
    yield* Effect.gen(function* () {
      const registrar = yield* A2AHomeRegistrar;
      const sender = yield* seedTarget("attachment-sender", modelSelection.model, registrar);
      const target = yield* seedTarget(
        "attachment-target",
        modelSelection.model,
        registrar,
        sender.ledgerProjectId,
        sender.projectId,
      );
      const threads = yield* ThreadManagementService;
      yield* threads.sendToThread({
        commandId: CommandId.make("command:attachment:sender-start"),
        projectId: sender.projectId,
        threadId: sender.threadId,
        messageId: MessageId.make("message:attachment:sender-start"),
        text: "Send a file to the other agent.",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      yield* startPendingTestTurn(sender.threadId);
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make(createPendingAttachmentId()!),
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const pendingPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      assert.isNotNull(pendingPath);
      yield* fs.writeFile(pendingPath!, new Uint8Array([1, 2, 3]));
      const toolkit = yield* J5AttachmentSendToolkit;
      const call = (threadId: ThreadId) =>
        toolkit
          .handle("t3_thread_send_attachments", {
            threadId,
            message: "Inspect this screenshot.",
            attachments: [attachment],
          })
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:attachment-test"),
              requestNamespace: "attachment-test",
              thread: {
                threadId: sender.threadId,
                providerSessionId: "attachment-test",
                providerInstanceId: modelSelection.instanceId,
              },
              client: undefined,
              capabilities: new Set(["orchestration"] as const),
              issuedAt: 1,
            }),
          );
      assert.isTrue((yield* call(sender.threadId)).isFailure);
      const send = yield* A2ASendService;
      const filesBefore = yield* fs.readDirectory(config.attachmentsDir);
      const refused = yield* call(target.threadId).pipe(
        Effect.provideService(A2ASendService, {
          ...send,
          send: (input) =>
            Effect.gen(function* () {
              assert.lengthOf(
                yield* fs.readDirectory(config.attachmentsDir),
                filesBefore.length + 1,
              );
              return yield* send.send({
                ...input,
                senderThreadId: ThreadId.make("native-unjoined-sender"),
              });
            }),
        }),
      );
      assert.isTrue(refused.isFailure);
      assert.deepEqual(
        (yield* fs.readDirectory(config.attachmentsDir)).sort(),
        [...filesBefore].sort(),
      );
      assert.isTrue(yield* fs.exists(pendingPath!));
      const outcome = yield* call(target.threadId);
      assert.isFalse(outcome.isFailure);
      assert.notProperty(outcome.result, "runId");
      const accepted = yield* decodeSendResult(outcome.result);
      const sql = yield* SqlClient.SqlClient;
      const facts = yield* sql<{
        readonly payload: string;
      }>`SELECT payload FROM j5_a2a_comm_event WHERE seq = ${accepted.durableAtSeq}`;
      const sent = yield* decodeSentFact(facts[0]!.payload);
      assert.lengthOf(sent.attachments ?? [], 1);
      const canonical = sent.attachments![0]!;
      assert.notEqual(canonical.id, attachment.id);
      yield* fs.remove(pendingPath!);
      const delivery = yield* A2ADeliveryWorker;
      assert.deepEqual(
        (yield* delivery.drain).map(({ messageId, state }) => ({ messageId, state })),
        [{ messageId: accepted.messageId, state: "delivered" }],
      );
      const projection = yield* threads.getThreadProjection(target.threadId);
      const delivered = projection.messages.filter(
        (message) => message.id === deliveryMessageId(accepted.messageId),
      );
      assert.lengthOf(delivered, 1);
      assert.deepEqual(delivered[0]!.attachments, [canonical]);
      const storedPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: canonical,
      });
      assert.deepEqual(yield* fs.readFile(storedPath!), new Uint8Array([1, 2, 3]));
      assert.deepEqual(yield* delivery.drain, []);
      yield* startPendingTestTurn(target.threadId);
      const targetInput = (yield* Ref.get(harness.startedInputs)).find(
        (input) => input.threadId === target.threadId,
      );
      assert.isDefined(targetInput);
      assert.deepEqual(targetInput!.message.attachments, [canonical]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "registers forks through both intake and MCP and retries post-commit facts without another fork",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const base = makeMessageLifecycleLayer(harness).pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const registrar = yield* A2AHomeRegistrar;
        const source = yield* seedTarget("fork-source", modelSelection.model, registrar);
        const threads = yield* ThreadManagementService;
        const sendSource = (suffix: string) =>
          threads.sendToThread({
            commandId: CommandId.make(`command:fork-source:${suffix}`),
            projectId: source.projectId,
            threadId: source.threadId,
            messageId: MessageId.make(`message:fork-source:${suffix}`),
            text: "Source context",
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          });
        const first = yield* sendSource("first");
        yield* startPendingTestTurn(source.threadId);
        yield* finishTestTurn(harness, source.threadId);
        const sourcePoint = { type: "run" as const, runId: first.run.id };
        const fork = {
          type: "thread.fork" as const,
          commandId: CommandId.make("command:fork-intake"),
          sourceThreadId: source.threadId,
          targetThreadId: ThreadId.make("thread:fork-intake"),
          sourcePoint,
          createdBy: "user" as const,
          creationSource: "web" as const,
        };
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TEMP TRIGGER fail_fork_placement BEFORE INSERT ON j5_a2a_placement_event
        BEGIN SELECT RAISE(ABORT, 'injected placement failure'); END`;
        const failed = yield* dispatchIntakeCommand(fork).pipe(Effect.flip);
        assert.include(failed.message, "Replay command command:fork-intake");
        assert.equal(
          (yield* threads.getThreadProjection(fork.targetThreadId)).thread.id,
          fork.targetThreadId,
        );
        assert.equal(
          (yield* registrar.getHomeForThread(fork.targetThreadId).pipe(Effect.flip))._tag,
          "A2AHomeNotFoundError",
        );
        yield* sql`DROP TRIGGER fail_fork_placement`;
        const repaired = yield* dispatchIntakeCommand(fork);
        const replay = yield* dispatchIntakeCommand(fork);
        assert.equal(repaired.sequence, replay.sequence);
        const home = yield* registrar.getHomeForThread(fork.targetThreadId);
        assert.equal(home.projectId, source.ledgerProjectId);
        const placement = yield* (yield* ParticipantPlacementService).readPlacement(home);
        assert.deepEqual(placement?.provenance, {
          kind: "forked-from",
          sourceParticipantId: source.receiverId,
          source: "upstream_lineage",
        });
        assert.isNull(placement?.placementParentId);
        const placementFacts = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM j5_a2a_placement_event WHERE participant_id = ${home.participantId}`;
        assert.equal(placementFacts[0]!.count, 1);
        const group = yield* seedTarget(
          "fork-group",
          modelSelection.model,
          registrar,
          source.ledgerProjectId,
          source.projectId,
        );
        yield* (yield* ParticipantPlacementService).recordCreation({
          commandId: PlacementCommandId.make("command:fork-source-placement"),
          projectId: source.ledgerProjectId,
          participantId: source.receiverId,
          actor: "agent",
          createdAt: "2026-08-17T12:00:00.000Z",
          provenance: {
            kind: "spawned-by",
            spawnedByParticipantId: group.receiverId,
            source: "j5_spawn",
          },
        });
        yield* sendSource("second");
        yield* startPendingTestTurn(source.threadId);
        const toolkit = yield* J5AdaptedThreadToolkit;
        const invokeFork = toolkit.handle("t3_thread_fork", { sourcePoint }).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, {
            environmentId: EnvironmentId.make("environment:fork-test"),
            requestNamespace: "fork-test",
            thread: {
              threadId: source.threadId,
              providerSessionId: "fork-test",
              providerInstanceId: modelSelection.instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 1,
          }),
        );
        yield* sql`CREATE TEMP TRIGGER fail_mcp_fork_placement BEFORE INSERT ON j5_a2a_placement_event
          BEGIN SELECT RAISE(ABORT, 'injected MCP placement failure'); END`;
        const mcpFailure = yield* invokeFork;
        assert.isTrue(mcpFailure.isFailure);
        const repair = yield* decodeToolFailure(mcpFailure.result);
        assert.equal(repair.code, "orchestration_error");
        assert.include(
          repair.message,
          "exists but its placement under its source could not be recorded",
        );
        assert.include(repair.message, "Replay command mcp:");
        yield* sql`DROP TRIGGER fail_mcp_fork_placement`;
        const output = yield* invokeFork;
        assert.isFalse(output.isFailure);
        const mcpFork = yield* decodeForkResult(output.result);
        assert.notEqual(mcpFork.targetThreadId, fork.targetThreadId);
        const mcpHome = yield* registrar.getHomeForThread(mcpFork.targetThreadId);
        assert.equal(mcpHome.projectId, source.ledgerProjectId);
        assert.equal(
          (yield* (yield* ParticipantPlacementService).readPlacement(mcpHome))?.placementParentId,
          group.receiverId,
        );
        const mismatch = yield* seedTarget("fork-other-project", modelSelection.model, registrar);
        const merge = {
          ...fork,
          type: "thread.merge_back" as const,
          commandId: CommandId.make("command:fork-mismatch"),
          targetThreadId: mismatch.threadId,
        };
        const before = yield* threads.getThreadProjection(source.threadId);
        // J5 adds no merge-back rule: another project's thread is refused by upstream alone.
        assert.notInclude(
          (yield* dispatchIntakeCommand(merge).pipe(Effect.flip)).message,
          "J5 thread lineage",
        );
        assert.deepEqual(
          (yield* threads.getThreadProjection(source.threadId)).contextTransfers,
          before.contextTransfers,
        );
        // Matching registration passes J5 admission; upstream still owns lineage validation.
        const sameHome = yield* seedTarget(
          "fork-unrelated-same-home",
          modelSelection.model,
          registrar,
          source.ledgerProjectId,
          source.projectId,
        );
        const rejected = yield* threads
          .dispatch({
            ...merge,
            commandId: CommandId.make("command:fork-unrelated"),
            targetThreadId: sameHome.threadId,
          })
          .pipe(Effect.flip);
        assert.notInclude(rejected.message, "J5 thread lineage");
        yield* finishTestTurn(harness, source.threadId);
        const native = {
          threadId: ThreadId.make("thread:fork-native"),
          projectId: source.projectId,
        };
        yield* (yield* OrchestratorV2).dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:fork-native:create"),
          ...native,
          title: "Native source without membership",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: (yield* threads.getThreadProjection(source.threadId)).thread.worktreePath,
          createdBy: "user",
          creationSource: "web",
        });
        const nativeRun = yield* threads.sendToThread({
          commandId: CommandId.make("command:fork-native:start"),
          projectId: native.projectId,
          threadId: native.threadId,
          messageId: MessageId.make("message:fork-native:start"),
          text: "Native context",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* startPendingTestTurn(native.threadId);
        yield* finishTestTurn(harness, native.threadId);
        const nativeFork = {
          ...fork,
          commandId: CommandId.make("command:fork-native"),
          sourceThreadId: native.threadId,
          targetThreadId: ThreadId.make("thread:fork-native-child"),
          sourcePoint: { type: "run" as const, runId: nativeRun.run.id },
        };
        yield* dispatchIntakeCommand(nativeFork);
        // A source with no home yet registers in its project when it forks, and so does its fork.
        const nativeHome = yield* registrar.getHomeForThread(native.threadId);
        assert.equal(nativeHome.projectId, LedgerProjectId.make(native.projectId));
        const nativeForkHome = yield* registrar.getHomeForThread(nativeFork.targetThreadId);
        assert.equal(nativeForkHome.projectId, LedgerProjectId.make(native.projectId));
        assert.deepEqual(
          (yield* (yield* ParticipantPlacementService).readPlacement(nativeForkHome))?.provenance,
          {
            kind: "forked-from",
            sourceParticipantId: nativeHome.participantId,
            source: "upstream_lineage",
          },
        );
      }).pipe(Effect.provide(J5AdaptedThreadHandlersLive.pipe(Layer.provideMerge(base))));
    }),
);

it.effect("organize refuses a Crew seat and applies reversible lifecycle once", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const base = crewInstanceLayer.pipe(
      Layer.provideMerge(makeMessageLifecycleLayer(harness)),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const registrar = yield* A2AHomeRegistrar;
      const source = yield* seedTarget("organize-source", modelSelection.model, registrar);
      const target = yield* seedTarget(
        "organize-target",
        modelSelection.model,
        registrar,
        source.ledgerProjectId,
        source.projectId,
      );
      const threads = yield* ThreadManagementService;
      yield* threads.sendToThread({
        commandId: CommandId.make("command:organize-start"),
        projectId: source.projectId,
        threadId: source.threadId,
        messageId: MessageId.make("message:organize-start"),
        text: "Organize agents",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      yield* startPendingTestTurn(source.threadId);
      const toolkit = yield* J5AdaptedThreadToolkit;
      const call = (threadId: ThreadId, action: "archive" | "unarchive") =>
        toolkit.handle("t3_thread_organize", { threadId, action }).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, {
            environmentId: EnvironmentId.make("environment:organize-test"),
            requestNamespace: "organize-test",
            thread: {
              threadId: source.threadId,
              providerSessionId: "organize-test",
              providerInstanceId: modelSelection.instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 1,
          }),
        );
      const member = yield* seedTarget(
        "organize-member",
        modelSelection.model,
        registrar,
        source.ledgerProjectId,
        source.projectId,
      );
      yield* (yield* AgentCrewInstanceService).record({
        id: "crew:organize-guard",
        projectId: source.ledgerProjectId,
        captainParticipantId: source.receiverId,
        captainThreadId: source.threadId,
        displayName: "Organize crew",
        brief: "Protect the member",
        createdAt: "2026-08-17T12:00:00.000Z",
        members: [
          {
            seatName: "builder",
            agentId: null,
            participantId: member.receiverId,
            threadId: member.threadId,
            reason: null,
          },
        ],
      });
      const memberArchive = yield* call(member.threadId, "archive");
      assert.isTrue(memberArchive.isFailure);
      assert.include(
        (memberArchive.result as { message: string }).message,
        "never archived one by one",
      );
      assert.isNull((yield* threads.getThreadProjection(member.threadId)).thread.archivedAt);
      const send = yield* A2ASendService;
      const opened = yield* send.send({
        commandId: CommCommandId.make("command:organize-ask"),
        senderThreadId: source.threadId,
        to: target.receiverId,
        message: "Please answer",
        expectReply: true,
        intent: "Check lifecycle",
        acceptedAt: "2026-08-17T12:00:00.000Z",
      });
      const lifecycle = yield* A2ALifecycleService;
      for (const action of ["archive", "unarchive"] as const) {
        const event = yield* threads.streamStoredEventsFrom().pipe(
          Stream.filter(
            (stored) =>
              stored.event.threadId === target.threadId &&
              stored.event.type ===
                (action === "archive" ? "thread.archived" : "thread.unarchived"),
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        assert.isFalse((yield* call(target.threadId, action)).isFailure);
        const stored = yield* Fiber.join(event).pipe(Effect.flatMap(Effect.fromOption));
        yield* lifecycle.handleStoredEvent(stored);
        yield* lifecycle.handleStoredEvent(stored);
        const directory = yield* send.listParticipants(source.threadId);
        assert.equal(
          directory.some((row) => row.participantId === target.receiverId && row.canReceiveMessage),
          action === "unarchive",
        );
        const inclusive = yield* send.listParticipants(source.threadId, true);
        assert.equal(
          inclusive.find((row) => row.participantId === target.receiverId)?.archived,
          action === "archive",
        );
        assert.deepEqual(yield* registrar.getHomeForThread(target.threadId), {
          projectId: source.ledgerProjectId,
          participantId: target.receiverId,
        });
      }
      const sql = yield* SqlClient.SqlClient;
      const counts = yield* sql<{ readonly dropped: number; readonly notices: number }>`SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped' AND exchange_id = ${opened.exchangeId}) AS dropped,
        (SELECT COUNT(*) FROM j5_a2a_delivery WHERE exchange_role = 'terminal_notice' AND exchange_id = ${opened.exchangeId}) AS notices`;
      assert.deepEqual(counts, [{ dropped: 1, notices: 1 }]);
      // Self-archive adopts upstream semantics and does not acquire a second confirmation protocol.
      assert.isFalse((yield* call(source.threadId, "archive")).isFailure);
      assert.isNotNull((yield* threads.getThreadProjection(source.threadId)).thread.archivedAt);
    }).pipe(Effect.provide(J5AdaptedThreadHandlersLive.pipe(Layer.provideMerge(base))));
  }),
);

/** Holds a target's queue the way upstream restart recovery does, behind real active work. */
const holdTargetQueue = Effect.fn("A2AIntegration.holdTargetQueue")(function* (target: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const threads = yield* ThreadManagementService;
  yield* threads.sendToThread({
    projectId: target.projectId,
    threadId: target.threadId,
    commandId: CommandId.make(`command:held:active:${target.threadId}`),
    messageId: MessageId.make(`message:held:active:${target.threadId}`),
    text: "Active work",
    attachments: [],
    mode: "queue",
    createdBy: "user",
    creationSource: "web",
  });
  const earlier = yield* threads.sendToThread({
    projectId: target.projectId,
    threadId: target.threadId,
    commandId: CommandId.make(`command:held:earlier:${target.threadId}`),
    messageId: MessageId.make(`message:held:earlier:${target.threadId}`),
    text: "Earlier work",
    attachments: [],
    mode: "queue",
    createdBy: "user",
    creationSource: "web",
  });
  yield* (yield* EventSinkV2).write({
    events: [
      {
        id: EventId.make(`event:held:earlier:${target.threadId}`),
        type: "run.updated",
        threadId: target.threadId,
        runId: earlier.run.id,
        providerInstanceId: earlier.run.providerInstanceId,
        occurredAt: yield* DateTime.now,
        payload: { ...earlier.run, status: "queued", queueHeld: true },
      },
    ],
  });
});

it.effect("keeps held delivery pending and reuses the same message when the queue resumes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const target = yield* seedTarget("held-queue", "gpt-5.4");
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      yield* holdTargetQueue(target);
      for (let retry = 0; retry < 2; retry++) {
        const error = yield* transport.deliverAgent(target.delivery).pipe(Effect.flip);
        assert.instanceOf(error, A2ADeliveryHeldError);
      }
      const held = yield* threads.getThreadProjection(target.threadId);
      assert.lengthOf(
        held.messages.filter((row) => row.id === deliveryMessageId(target.messageId)),
        1,
      );
      assert.isTrue(
        held.runs.find((row) => row.userMessageId === deliveryMessageId(target.messageId))
          ?.queueHeld,
      );
      yield* threads.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("command:held:resume"),
        threadId: target.threadId,
      });
      yield* transport.deliverAgent(target.delivery);
      assert.lengthOf(
        (yield* threads.getThreadProjection(target.threadId)).messages.filter(
          (row) => row.id === deliveryMessageId(target.messageId),
        ),
        1,
      );
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect("settles a held peer delivery once after resume without alarming", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const source = yield* seedTarget("held-worker-source");
      const target = yield* seedTarget(
        "held-worker-target",
        modelSelection.model,
        undefined,
        source.ledgerProjectId,
      );
      const threads = yield* ThreadManagementService;
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      yield* holdTargetQueue(target);
      const sent = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("held-worker:send"),
        senderThreadId: source.threadId,
        to: target.receiverId,
        message: "Wait behind the held queue",
        acceptedAt: "2026-09-24T00:00:00.000Z",
      });
      // Well past the ordinary alarm threshold: a held queue waits for a person.
      for (let attempt = 1; attempt <= 5; attempt++) {
        const milestone = yield* worker.runOnce;
        assert.equal(milestone?.state, "retry_scheduled");
        assert.equal(milestone?.attempt, attempt);
        yield* TestClock.adjust(heldQueueRecheckMs(attempt));
      }
      assert.lengthOf(yield* worker.listAlarms, 0);
      yield* threads.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("command:held-worker:resume"),
        threadId: target.threadId,
      });
      assert.equal((yield* worker.runOnce)?.state, "delivered");
      assert.isNull(yield* worker.runOnce);
      assert.lengthOf(yield* worker.listAlarms, 0);
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`,
        [{ status: "delivered" }],
      );
      const messages = (yield* threads.getThreadProjection(target.threadId)).messages.filter(
        (row) => row.id === deliveryMessageId(sent.messageId),
      );
      assert.lengthOf(messages, 1);
      // Upstream links the peer message to its sending thread.
      assert.equal(messages[0]?.senderThreadId, source.threadId);
    }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
  }),
);

// Registration: a thread becomes a participant in its project however it came to exist.
const registrationFixture = Effect.fn("A2AIntegration.registrationFixture")(function* (
  prefix: string,
) {
  const orchestrator = yield* OrchestratorV2;
  const threads = yield* ThreadManagementService;
  const sink = yield* EventSinkV2;
  const projectId = ProjectId.make(`project:${prefix}`);
  const threadId = (name: string) => ThreadId.make(`thread:${prefix}:${name}`);
  const create = (
    name: string,
    createdBy: "user" | "system",
    creationSource: "web" | "mobile" | "server",
  ) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy,
      creationSource,
      commandId: CommandId.make(`command:${prefix}:create:${name}`),
      threadId: threadId(name),
      projectId,
      title: `Registration ${name}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  yield* create("web", "user", "web");
  yield* create("mobile", "user", "mobile");
  yield* create("system-start", "system", "server");
  const template = (yield* threads.getThreadProjection(threadId("web"))).thread;
  // Both importers write `thread.created` straight to the event sink, past the command path.
  const write = (name: string, thread: typeof template) =>
    sink.write({
      events: [
        {
          id: EventId.make(`event:${prefix}:${name}:created`),
          type: "thread.created",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.createdAt,
          payload: thread,
        },
      ],
    });
  yield* write("imported", {
    ...template,
    id: threadId("imported"),
    createdBy: "system",
    creationSource: "server",
    historyOrigin: "v1_import",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId("imported"),
    },
  });
  yield* write("subagent", {
    ...template,
    id: threadId("subagent"),
    lineage: {
      parentThreadId: threadId("web"),
      relationshipToParent: "subagent",
      rootThreadId: threadId("web"),
    },
  });
  return { projectId, threadId };
});

const registeredProjects = Effect.fn("A2AIntegration.registeredProjects")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly thread_id: string;
    readonly project_id: string;
    readonly archived: number;
  }>`
    SELECT
      json_extract(joined.payload, '$.participant.threadId') AS thread_id,
      joined.project_id,
      COALESCE((
        SELECT membership.archived_at IS NOT NULL FROM j5_a2a_membership AS membership
        WHERE membership.thread_id = json_extract(joined.payload, '$.participant.threadId')
      ), 0) AS archived
    FROM j5_a2a_comm_event AS joined
    WHERE joined.kind = 'participant.joined'
    ORDER BY thread_id
  `;
});

const eventStoreHead = Effect.fn("A2AIntegration.eventStoreHead")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly head: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS head FROM orchestration_events
  `;
  return rows[0]?.head ?? 0;
});

it.effect("registers a thread in its project however it was created, and never a Subagent", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const { projectId, threadId } = yield* registrationFixture("registration-created");
      const threadLifecycle = yield* ThreadLifecycleService;
      // Archived before the daemon reaches its creation: it must still register, as archived.
      yield* threadLifecycle.archive({
        commandId: CommandId.make("command:registration-created:archive"),
        threadId: threadId("mobile"),
      });

      yield* replayLifecycleThrough(yield* eventStoreHead());

      assert.deepStrictEqual(yield* registeredProjects(), [
        { thread_id: threadId("imported"), project_id: projectId, archived: 0 },
        { thread_id: threadId("mobile"), project_id: projectId, archived: 1 },
        { thread_id: threadId("system-start"), project_id: projectId, archived: 0 },
        { thread_id: threadId("web"), project_id: projectId, archived: 0 },
      ]);
      // Reading the same events again registers nobody twice.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE j5_a2a_lifecycle_cursor SET after_sequence = 0`;
      yield* replayLifecycleThrough(yield* eventStoreHead());
      assert.lengthOf(yield* registeredProjects(), 4);
    }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
  }),
);

it.effect(
  "registers the threads an upgrade finds without a home, and leaves Subagents and deleted threads out",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const { projectId, threadId } = yield* registrationFixture("registration-existing");
        const threadLifecycle = yield* ThreadLifecycleService;
        const lifecycle = yield* A2ALifecycleService;
        const send = yield* A2ASendService;
        const sql = yield* SqlClient.SqlClient;
        yield* threadLifecycle.archive({
          commandId: CommandId.make("command:registration-existing:archive"),
          threadId: threadId("mobile"),
        });
        yield* threadLifecycle.delete({
          commandId: CommandId.make("command:registration-existing:delete"),
          threadId: threadId("system-start"),
        });
        // A server from before the upgrade read past these events without registering anyone.
        yield* sql`UPDATE j5_a2a_lifecycle_cursor SET after_sequence = ${yield* eventStoreHead()}`;
        assert.deepStrictEqual(yield* registeredProjects(), []);

        assert.strictEqual(yield* lifecycle.registerExistingThreads, 3);

        assert.deepStrictEqual(yield* registeredProjects(), [
          { thread_id: threadId("imported"), project_id: projectId, archived: 0 },
          { thread_id: threadId("mobile"), project_id: projectId, archived: 1 },
          { thread_id: threadId("web"), project_id: projectId, archived: 0 },
        ]);
        assert.strictEqual(yield* lifecycle.registerExistingThreads, 0);
        // A Subagent that calls a tool is told what it is, and is still not registered.
        const refused = yield* Effect.flip(send.listParticipants(threadId("subagent")));
        assert.instanceOf(refused, A2ASenderNotJoinedError);
        assert.include(refused.message, "Subagents are not participants");
        assert.lengthOf(yield* registeredProjects(), 3);
      }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
    }),
);

it.effect("registers an older thread on its first agent-to-agent call", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const { projectId, threadId } = yield* registrationFixture("registration-lazy");
      const send = yield* A2ASendService;
      assert.deepStrictEqual(yield* registeredProjects(), []);

      const directory = yield* send.listParticipants(threadId("web"));

      assert.deepStrictEqual(
        directory.map((row) => [row.projectId, row.participantId]),
        [[LedgerProjectId.make(projectId), participantIdForThread(threadId("web"))]],
      );
      assert.deepStrictEqual(yield* registeredProjects(), [
        { thread_id: threadId("web"), project_id: projectId, archived: 0 },
      ]);
    }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
  }),
);

it.effect("registers an archived older thread as archived, in one step or not at all", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const { projectId, threadId } = yield* registrationFixture("registration-archived");
      const threadLifecycle = yield* ThreadLifecycleService;
      const lifecycle = yield* A2ALifecycleService;
      const registration = yield* ThreadRegistration;
      const sql = yield* SqlClient.SqlClient;
      for (const archived of ["mobile", "web"]) {
        yield* threadLifecycle.archive({
          commandId: CommandId.make(`command:registration-archived:archive-${archived}`),
          threadId: threadId(archived),
        });
      }
      // A server from before the upgrade read past these events without registering anyone.
      yield* sql`UPDATE j5_a2a_lifecycle_cursor SET after_sequence = ${yield* eventStoreHead()}`;

      // Something other than the lifecycle service registers it: a fork, or a tool call.
      yield* registration.ensureRegistered(threadId("mobile"));

      assert.deepStrictEqual(yield* registeredProjects(), [
        { thread_id: threadId("mobile"), project_id: projectId, archived: 1 },
      ]);

      // The archive fails after the join was written: the join must not be left behind.
      yield* sql`
        CREATE TRIGGER fail_archive_fact BEFORE INSERT ON j5_a2a_comm_event
        WHEN NEW.kind = 'participant.archived'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      yield* Effect.flip(registration.ensureRegistered(threadId("web")));
      yield* sql`DROP TRIGGER fail_archive_fact`;

      assert.lengthOf(yield* registeredProjects(), 1);
      assert.deepStrictEqual(
        yield* sql`SELECT 1 FROM j5_a2a_membership WHERE thread_id = ${threadId("web")}`,
        [],
      );

      // The next start registers it, archived, with the two nobody had registered yet.
      assert.strictEqual(yield* lifecycle.registerExistingThreads, 3);

      assert.deepStrictEqual(yield* registeredProjects(), [
        { thread_id: threadId("imported"), project_id: projectId, archived: 0 },
        { thread_id: threadId("mobile"), project_id: projectId, archived: 1 },
        { thread_id: threadId("system-start"), project_id: projectId, archived: 0 },
        { thread_id: threadId("web"), project_id: projectId, archived: 1 },
      ]);
      assert.strictEqual(yield* lifecycle.registerExistingThreads, 0);
    }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
  }),
);
