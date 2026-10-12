import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { describe } from "vite-plus/test";

import { EnvironmentAuth } from "../../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../../background/HostPowerMonitor.ts";
import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { AnalyticsService } from "../../../telemetry/AnalyticsService.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import {
  McpInvocationContext,
  type McpInvocationScope,
} from "../../../mcp/McpInvocationContext.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../../mcp/McpSessionRegistry.testkit.ts";
import * as OrchestratorMcpService from "../../../mcp/OrchestratorMcpService.ts";
import { runDaemonWithOptions as runEffectWorkerDaemonWithOptions } from "../../../orchestration-v2/EffectWorker.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { layerFromProviderInstanceRegistry as providerAdapterRegistryFromInstances } from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../../../orchestration-v2/runtimeLayer.ts";
import { ThreadLaunchService } from "../../../orchestration-v2/ThreadLaunchService.ts";
import { layer as threadLifecycleServiceLayer } from "../../../orchestration-v2/ThreadLifecycleService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationCommandReceipts from "../../../persistence/OrchestrationCommandReceipts.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import { ManagedProjectFolders } from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { AntigravityInstallation } from "../../../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../../../provider/CodexInstallation.ts";
import * as ModelManifest from "../../../provider/ModelManifest.ts";
import * as OpenCodeRuntime from "../../../provider/opencodeRuntime.ts";
import * as OpenCodeServerLedger from "../../../provider/OpenCodeServerLedger.ts";
import * as ProviderEventLoggers from "../../../provider/ProviderEventLoggers.ts";
import * as ProviderInstanceRegistryHydration from "../../../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ResetCreditCoordinator from "../../../provider/resetCreditCoordinator.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { SourceControlProviderRegistry } from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { CommCommandId, ParticipantId, LedgerProjectId } from "../contracts.ts";
import { PlacementCommandId } from "../placementContracts.ts";
import { J5A2ARuntimeLayer, J5ThreadRegistrationLayer } from "../runtimeLayer.ts";
import { spawnThreadId } from "../spawnIds.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import {
  type J5SpawnAgentInput,
  J5SpawnAgentResult,
  type J5StopAgentInput,
  J5StopAgentResult,
  J5Toolkit,
} from "./tools.ts";

const orchestrationLayer = RuntimeLayer.layer.pipe(Layer.provideMerge(J5ThreadRegistrationLayer));

const codexInstanceId = ProviderInstanceId.make("codex");
const lunaSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.6-luna",
  options: [{ id: "reasoningEffort", value: "medium" }],
} satisfies ModelSelection;
const parentThreadId = ThreadId.make("thread:j5:luna-verb-e2e:parent");
const projectId = ProjectId.make("project:j5:luna-verb-e2e");
// A thread's home is its project, so the ledger is keyed by the project's id.
const ledgerProjectId = LedgerProjectId.make(projectId);
const requestKey = "j5-luna-verb-e2e-spawn";
const environmentId = EnvironmentId.make("environment:j5:luna-verb-e2e");
const providerSessionId = "provider-session:j5:luna-verb-e2e";
const scope: McpInvocationScope = {
  environmentId,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
  requestNamespace: providerSessionId,
  thread: { threadId: parentThreadId, providerSessionId, providerInstanceId: codexInstanceId },
  client: undefined,
};
const decodeSpawnResult = Schema.decodeUnknownEffect(J5SpawnAgentResult);
const decodeStopResult = Schema.decodeUnknownEffect(J5StopAgentResult);

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-j5-luna-verb-live-",
});
const serverSettingsLayer = ServerSettingsService.layerTest({
  providerInstances: {
    [codexInstanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
  },
});
const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);
const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer));
const backgroundPolicyLayer = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(serverSettingsLayer),
);
const providerInstanceRegistryLayer = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      serverConfigLayer.pipe(Layer.provide(NodeServices.layer)),
      serverSettingsLayer,
      FetchHttpClient.layer,
      AntigravityInstallation.layer.pipe(
        Layer.provide(serverConfigLayer),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
      ),
      ServerSecretStore.layer.pipe(
        Layer.provide(serverConfigLayer),
        Layer.provide(NodeServices.layer),
      ),
      OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(NodeServices.layer),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      CodexInstallation.CodexInstallation.layer.pipe(
        Layer.provide(serverConfigLayer),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
      ),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ).pipe(Layer.provideMerge(ModelManifest.layerTest), Layer.provideMerge(NodeServices.layer)),
  ),
);
const providerRegistryLayer = ProviderRegistry.layer.pipe(
  Layer.provide(providerInstanceRegistryLayer),
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);
const threadLifecycleLayer = threadLifecycleServiceLayer.pipe(Layer.provide(orchestrationLayer));
const secretStoreLayer = ServerSecretStore.layer.pipe(
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);
const orchestratorMcpLayer = OrchestratorMcpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      orchestrationLayer,
      Layer.mock(ScheduledTaskService)({}),
      Layer.mock(SecretRequests)({}),
      providerAdapterRegistryFromInstances,
    ),
  ),
);
const j5Layer = J5A2ARuntimeLayer.pipe(
  Layer.provideMerge(orchestrationLayer),
  Layer.provide(threadLifecycleLayer),
  Layer.provide(secretStoreLayer),
  Layer.provide(AnalyticsService.layerTest),
  // The peer registry checks which peer sessions are live; this test has no peers.
  Layer.provide(Layer.mock(EnvironmentAuth)({ listSessions: () => Effect.succeed([]) })),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);
// A verb runs inside its caller's turn, and the access gate refuses a caller with no live run.
// This test calls the verbs from outside any turn, so the gate is shown the parent mid-run.
const callerMidRunLayer = Layer.effect(
  ThreadManagementService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    return ThreadManagementService.of({
      ...threads,
      getThreadShell: (threadId) =>
        threads
          .getThreadShell(threadId)
          .pipe(
            Effect.map((shell) =>
              shell !== null && threadId === parentThreadId
                ? { ...shell, activeRunId: RunId.make("run:j5:luna-verb-e2e:parent") }
                : shell,
            ),
          ),
    });
  }),
);
const handlersLayer = J5ToolkitHandlersLive.pipe(
  Layer.provide(callerMidRunLayer),
  // The spawn here stays in the caller's project and shares its checkout, so none is read.
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "/tmp/j5-luna-named-projects" }),
      Layer.mock(ProjectService.ProjectService)({}),
      serverConfigLayer,
    ),
  ),
  Layer.provideMerge(j5Layer),
  Layer.provide(orchestrationLayer),
  Layer.provide(orchestratorMcpLayer),
);
const liveLayer = Layer.mergeAll(
  orchestrationLayer,
  orchestratorMcpLayer,
  j5Layer,
  handlersLayer,
).pipe(
  Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
  // The project is unreadable here, so every spawn shares the caller's checkout.
  Layer.provide(Layer.mock(ThreadLaunchService)({})),
  Layer.provide(OrchestrationCommandReceipts.layer),
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
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(checkpointStoreLayer),
  Layer.provide(serverConfigLayer),
  Layer.provide(serverSettingsLayer),
  Layer.provideMerge(providerRegistryLayer),
  Layer.provide(providerInstanceRegistryLayer),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(backgroundPolicyLayer),
  Layer.provide(ModelManifest.layerTest),
  Layer.provide(NodeServices.layer),
);
const testLayer = Layer.mergeAll(liveLayer, NodeServices.layer);

const runStatus = (threadId: ThreadId, statuses: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const event = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (candidate) =>
          candidate.type === "run.updated" &&
          candidate.payload.threadId === threadId &&
          statuses.has(candidate.payload.status),
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({ onNone: () => Effect.die("run stream ended"), onSome: Effect.succeed }),
      ),
    );
    return event.type === "run.updated" ? event.payload : yield* Effect.die("unreachable");
  });

const callSpawn = (input: J5SpawnAgentInput) =>
  Effect.gen(function* () {
    const toolkit = yield* J5Toolkit;
    const response = yield* toolkit
      .handle("j5_spawn_agent", input)
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        Effect.provideService(McpInvocationContext, scope),
      );
    if (response.isFailure) {
      return yield* Effect.die(new Error(`Tool j5_spawn_agent failed: ${String(response.result)}`));
    }
    return yield* decodeSpawnResult(response.result);
  });

const callStop = (input: J5StopAgentInput) =>
  Effect.gen(function* () {
    const toolkit = yield* J5Toolkit;
    const response = yield* toolkit
      .handle("j5_stop_agent", input)
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        Effect.provideService(McpInvocationContext, scope),
      );
    if (response.isFailure) {
      return yield* Effect.die(new Error(`Tool j5_stop_agent failed: ${String(response.result)}`));
    }
    return yield* decodeStopResult(response.result);
  });

describe.runIf(process.env.T3_J5_LUNA_LIVE_ORCHESTRATOR === "1")(
  "J5 orchestrator verbs with Codex Luna",
  () => {
    it.live(
      "spawns one root Peer Agent, replays once, and stops only that turn",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const isolatedWorkspace = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-j5-luna-verb-workspace-",
          });
          yield* runEffectWorkerDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:j5:luna-verb-e2e:parent-create"),
            threadId: parentThreadId,
            projectId,
            title: "J5 Luna verb E2E parent",
            modelSelection: lunaSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: isolatedWorkspace,
          });

          yield* (yield* ProviderRegistry.ProviderRegistry).refreshInstance(codexInstanceId);
          const capabilities =
            yield* (yield* OrchestratorMcpService.OrchestratorMcpService).capabilities(scope);
          const codex = capabilities.providers.find(
            (provider) => provider.providerInstanceId === codexInstanceId,
          );
          assert.isDefined(codex);
          const luna = codex?.models.find((model) => model.id === lunaSelection.model);
          assert.isDefined(luna);
          const reasoning = luna?.options?.find(
            (option) => option.type === "select" && option.id === "reasoningEffort",
          );
          assert.isDefined(reasoning);
          if (reasoning?.type === "select") {
            assert.isTrue(reasoning.options.some((option) => option.id === "medium"));
          }

          const ledger = yield* A2ALedger;
          yield* ledger.ensureProject({
            projectId: ledgerProjectId,
            createdAt: "2026-08-30T17:00:00.000Z",
          });
          const parentHome = yield* (yield* A2AHomeRegistrar).registerAtCreation({
            commandId: CommCommandId.make("command:j5:luna-verb-e2e:parent-home"),
            projectId: ledgerProjectId,
            threadId: parentThreadId,
            createdAt: "2026-08-30T17:00:00.000Z",
          });
          yield* (yield* ParticipantPlacementService).recordCreation({
            commandId: PlacementCommandId.make("command:j5:luna-verb-e2e:parent-placement"),
            projectId: ledgerProjectId,
            participantId: parentHome.participantId,
            actor: "platform",
            provenance: { kind: "unknown", source: "native_or_unobserved" },
            createdAt: "2026-08-30T17:00:00.000Z",
          });

          const expectedThreadId = spawnThreadId({ providerSessionId, requestKey });
          const runningFiber = yield* runStatus(expectedThreadId, new Set(["running"])).pipe(
            Effect.forkScoped,
          );
          const terminalFiber = yield* runStatus(
            expectedThreadId,
            new Set(["completed", "failed", "cancelled", "interrupted"]),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          const brief =
            "Do not edit files. Confirm that you are running in the isolated workspace, then wait for further direction before replying.";
          const spawned = yield* callSpawn({
            workspace: { type: "shared" as const },
            brief,
            title: "Luna verb E2E peer",
            provider: codexInstanceId,
            model: lunaSelection.model,
            reasoning: "medium",
            client_request_id: requestKey,
          });
          assert.equal(spawned.thread_id, expectedThreadId);
          assert.equal(spawned.project_id, ledgerProjectId);
          yield* Fiber.join(runningFiber);

          const stopped = yield* callStop({
            participant_id: spawned.participant_id,
            client_request_id: "j5-luna-verb-e2e-stop",
          });
          assert.equal(stopped, "interrupt_requested");
          const terminal = yield* Fiber.join(terminalFiber);
          assert.equal(terminal.status, "interrupted");

          const replay = yield* callSpawn({
            workspace: { type: "shared" as const },
            brief:
              "A conflicting retry must not replace the first committed spawn context or brief.",
            title: "Luna verb E2E peer",
            provider: codexInstanceId,
            model: lunaSelection.model,
            reasoning: "medium",
            client_request_id: requestKey,
          });
          assert.deepStrictEqual(replay, spawned);

          const projection = yield* orchestrator.getThreadProjection(expectedThreadId);
          assert.equal(projection.thread.lineage.parentThreadId, null);
          assert.equal(projection.thread.lineage.relationshipToParent, null);
          assert.equal(projection.thread.modelSelection.instanceId, codexInstanceId);
          assert.equal(projection.thread.modelSelection.model, lunaSelection.model);
          assert.equal(projection.thread.runtimeMode, "approval-required");
          assert.equal(projection.thread.worktreePath, isolatedWorkspace);
          // No project row is seeded here, so the title falls back to the project's id.
          const firstTurnText = `<j5_spawn_context>\nPlatform-provided identity facts:\nparticipant_id: ${spawned.participant_id}\nproject_id: ${ledgerProjectId}\nproject_title: ${ledgerProjectId}\nspawned_by: ${parentHome.participantId}\nspawner_thread_id: ${parentThreadId}\n</j5_spawn_context>\n\n<spawner_brief>\n${brief}\n</spawner_brief>`;
          assert.equal(
            projection.messages.filter((message) => message.text === firstTurnText).length,
            1,
          );
          assert.equal(projection.runs.length, 1);

          const placement = yield* (yield* ParticipantPlacementService).readPlacement({
            projectId: ledgerProjectId,
            participantId: ParticipantId.make(spawned.participant_id),
          });
          assert.deepStrictEqual(placement?.provenance, {
            kind: "spawned-by",
            spawnedByParticipantId: parentHome.participantId,
            source: "j5_spawn",
          });
          assert.equal(placement?.placementParentId, parentHome.participantId);
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      360_000,
    );
  },
);
