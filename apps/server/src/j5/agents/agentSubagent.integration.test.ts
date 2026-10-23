import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { layerFromAdapters as makeLayer } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import * as Mcp from "../../mcp/OrchestratorMcpService.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";
import { personaLibraryLayer } from "../test-support/personaLibrary.ts";
import { delegateTask } from "./agentDelegation.ts";
import { invokeAgent } from "./agentInvocation.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: BUILT_IN_AGENT_PERSONAS.scout.modelRoute[0].model,
};
const provider: ServerProvider = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-08T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: modelSelection.model,
      name: "Model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
};
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("live provider execution is disabled in this test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistenceMemory;
const adapters = makeLayer([adapter]);
const orchestration = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "j5-agent-subagent" },
  adapters,
  { databaseLayer: database, runEffectWorker: false },
);
const settings = ServerSettings.layerTest({});
const threads = Threads.layer.pipe(
  Layer.provide(orchestration),
  Layer.provide(settings),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
);
const registry = Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) });
const mcp = Mcp.layer.pipe(
  Layer.provide(threads),
  Layer.provide(registry),
  Layer.provide(adapters),
  Layer.provide(Layer.mock(ScheduledTaskService)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(GitVcsDriver)({})),
  Layer.provide(Layer.mock(ThreadLaunchService)({})),
  Layer.provide(settings),
  Layer.provide(NodeServices.layer),
);
const testLayer = Layer.mergeAll(
  orchestration,
  threads,
  registry,
  mcp,
  Projections.layer.pipe(Layer.provide(database)),
  NodeServices.layer,
).pipe(
  Layer.provideMerge(personaLibraryLayer("j5-saved-subagent-", [BUILT_IN_AGENT_PERSONAS.scout])),
);

it.effect("persists the saved persona on a nested child and reuses that child on retry", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("parent");
    const runId = RunId.make("parent-run");
    const nodeId = NodeId.make("parent-node");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("parent-create"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("project"),
      title: "Parent conversation",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* projections.apply({
      id: EventId.make("parent-run-event"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("parent-message"),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("parent-node-event"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: true,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    const scope = {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "session",
      thread: {
        threadId,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId: "session",
      },
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 1,
    };
    const request = invokeAgent({
      personaId: "scout",
      task: "Return a short evidence brief.",
      clientRequestId: "same-request",
    }).pipe(Effect.provideService(McpInvocationContext, scope));
    const first = yield* request;
    const repeated = yield* request;
    assert.equal(first.childThreadId, repeated.childThreadId);
    const parent = yield* orchestrator.getThreadProjection(threadId);
    const child = yield* orchestrator.getThreadProjection(first.childThreadId);
    assert.lengthOf(parent.subagents, 1);
    assert.equal(parent.thread.agentPersonaAssignment, undefined);
    assert.equal(child.thread.lineage.relationshipToParent, "subagent");
    assert.equal(child.thread.lineage.parentThreadId, threadId);
    assert.equal(child.thread.agentPersonaAssignment?.personaId, "scout");
    assert.equal(child.thread.modelSelection.model, modelSelection.model);
    assert.equal(child.thread.runtimeMode, "approval-required");
    assert.equal(child.messages[0]?.text, "Return a short evidence brief.");
    assert.lengthOf(child.runs, 1);

    // delegate_task with agent takes the same path; target or runtimeMode alongside it is refused.
    const viaDelegate = yield* delegateTask({
      task: "Return a short evidence brief.",
      persona: "scout",
      clientRequestId: "delegate-request",
    }).pipe(Effect.provideService(McpInvocationContext, scope));
    assert.equal(
      (yield* orchestrator.getThreadProjection(viaDelegate.childThreadId)).thread
        .agentPersonaAssignment?.personaId,
      "scout",
    );
    const rejected = yield* delegateTask({
      task: "Return a short evidence brief.",
      persona: "scout",
      runtimeMode: "full-access",
    }).pipe(Effect.provideService(McpInvocationContext, scope), Effect.flip);
    assert.equal(rejected.code, "invalid_request");
    // Without persona it is upstream's plain child: no pinned assignment.
    const plain = yield* delegateTask({ task: "Plain child work.", clientRequestId: "plain" }).pipe(
      Effect.provideService(McpInvocationContext, scope),
    );
    const plainChild = yield* orchestrator.getThreadProjection(plain.childThreadId);
    assert.equal(plainChild.thread.agentPersonaAssignment, undefined);
    assert.equal(plainChild.thread.lineage.relationshipToParent, "subagent");
  }).pipe(Effect.provide(testLayer)),
);
