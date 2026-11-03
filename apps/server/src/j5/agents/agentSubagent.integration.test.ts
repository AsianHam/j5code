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
import { CrewMemberModels } from "./crewMemberModels.ts";
import {
  crewMemberModelsLayer,
  permissiveCrewMemberModels,
} from "../test-support/crewMemberModels.ts";
import { invokeAgent } from "./agentInvocation.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: BUILT_IN_AGENT_PERSONAS.scout.modelRoute[0].model,
};
const otherModel = "gpt-5.6-other";
const plainModel = "gpt-5.6-plain";
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
    ...[modelSelection.model, otherModel].map((slug) => ({
      slug,
      name: "Model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "low", label: "Low" },
            ],
          },
        ],
      },
    })),
    // A model that advertises no reasoning option has no level to hold.
    { slug: plainModel, name: "Plain", isCustom: false, capabilities: null },
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
const makeTestLayer = (memberModels: Layer.Layer<CrewMemberModels>) =>
  Layer.mergeAll(
    orchestration,
    threads,
    registry,
    mcp,
    memberModels,
    Projections.layer.pipe(Layer.provide(database)),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(personaLibraryLayer("j5-saved-subagent-", [BUILT_IN_AGENT_PERSONAS.scout])),
  );
const testLayer = makeTestLayer(permissiveCrewMemberModels);

/** A parent thread with an active run, as the tool call of a running agent sees it. */
const runningParent = Effect.gen(function* () {
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
  return { orchestrator, scope, threadId };
});

it.effect("persists the saved persona on a nested child and reuses that child on retry", () =>
  Effect.gen(function* () {
    const { orchestrator, scope, threadId } = yield* runningParent;
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

const settingsLayer = ServerSettings.layerTest({});
const listedLayer = Layer.merge(
  makeTestLayer(
    crewMemberModelsLayer({
      providers: [provider],
      settingsLayer,
      projectTitle: "Billing Migration",
    }),
  ),
  settingsLayer,
);

it.effect("holds a plain delegated child to the list, inherited model included", () =>
  Effect.gen(function* () {
    const { orchestrator, scope } = yield* runningParent;
    const settings = yield* ServerSettings.ServerSettingsService;
    const asParent = Effect.provideService(McpInvocationContext, scope);
    const plain = (clientRequestId: string, target?: { readonly model: string }) =>
      delegateTask({
        task: "Plain child work.",
        clientRequestId,
        ...(target === undefined
          ? {}
          : { target: { providerInstanceId: modelSelection.instanceId, model: target.model } }),
      }).pipe(asParent);

    // Until a list is saved, the child inherits the parent's model as it always did.
    const free = yield* plain("free");
    assert.equal(
      (yield* orchestrator.getThreadProjection(free.childThreadId)).thread.modelSelection.model,
      modelSelection.model,
    );

    // The parent's own model is off the list, so inheriting it is refused with what to use.
    yield* settings.updateSettings({
      crewMemberModels: [{ instanceId: modelSelection.instanceId, model: otherModel }],
    });
    const refused = yield* plain("inherits").pipe(Effect.flip);
    assert.equal(refused.code, "model_unavailable");
    for (const part of [
      modelSelection.model,
      "Billing Migration",
      "Models for custom members in Agent Setup",
      `codex/${otherModel}`,
      "Retry with target",
    ])
      assert.include(refused.message, part);

    // A persona runs on its own model whatever the list says; an explicit checked target works.
    const persona = yield* delegateTask({
      task: "Return a short evidence brief.",
      persona: "scout",
      clientRequestId: "persona",
    }).pipe(asParent);
    assert.equal(
      (yield* orchestrator.getThreadProjection(persona.childThreadId)).thread.modelSelection.model,
      modelSelection.model,
    );
    const explicit = yield* plain("explicit", { model: otherModel });
    assert.equal(
      (yield* orchestrator.getThreadProjection(explicit.childThreadId)).thread.modelSelection.model,
      otherModel,
    );

    // A list saved afterwards does not refuse the retry of a delegation already accepted.
    yield* settings.updateSettings({ crewMemberModels: [] });
    const replayed = yield* plain("explicit", { model: otherModel });
    assert.equal(replayed.childThreadId, explicit.childThreadId);
    const none = yield* plain("fresh", { model: otherModel }).pipe(Effect.flip);
    assert.include(none.message, "nothing is checked");
  }).pipe(Effect.provide(listedLayer)),
);

it.effect("holds a plain delegated child to the level list, an inherited level included", () =>
  Effect.gen(function* () {
    const { orchestrator, scope } = yield* runningParent;
    const settings = yield* ServerSettings.ServerSettingsService;
    const asParent = Effect.provideService(McpInvocationContext, scope);
    const plain = (
      clientRequestId: string,
      target?: { readonly model: string; readonly level?: string },
    ) =>
      delegateTask({
        task: "Plain child work.",
        clientRequestId,
        ...(target === undefined
          ? {}
          : {
              target: {
                providerInstanceId: modelSelection.instanceId,
                model: target.model,
                ...(target.level === undefined
                  ? {}
                  : { options: [{ id: "reasoningEffort", value: target.level }] }),
              },
            }),
      }).pipe(asParent);
    const level = { instanceId: modelSelection.instanceId, level: "low" };

    // The parent runs on its model's default level, high, which this list leaves out.
    yield* settings.updateSettings({ crewMemberReasoning: [level] });
    const refused = yield* plain("inherits").pipe(Effect.flip);
    assert.equal(refused.code, "model_unavailable");
    for (const part of [
      `Reasoning level high of ${modelSelection.model}`,
      "Billing Migration",
      "Models for custom members in Agent Setup",
      `Eligible levels for ${modelSelection.model}: low.`,
      "Retry with target options",
    ])
      assert.include(refused.message, part);

    // A persona runs on its own level, a model with no reasoning option has nothing to hold, and
    // an explicit checked level works.
    const persona = yield* delegateTask({
      task: "Return a short evidence brief.",
      persona: "scout",
      clientRequestId: "persona",
    }).pipe(asParent);
    assert.equal(
      (yield* orchestrator.getThreadProjection(persona.childThreadId)).thread.modelSelection.model,
      modelSelection.model,
    );
    yield* plain("plain-model", { model: plainModel });
    const explicit = yield* plain("explicit", { model: otherModel, level: "low" });
    assert.equal(
      (yield* orchestrator.getThreadProjection(explicit.childThreadId)).thread.modelSelection.model,
      otherModel,
    );
    const unchecked = yield* plain("unchecked", { model: otherModel, level: "high" }).pipe(
      Effect.flip,
    );
    assert.include(unchecked.message, `Reasoning level high of ${otherModel}`);

    // A list saved afterwards does not refuse the retry of a delegation already accepted.
    yield* settings.updateSettings({ crewMemberReasoning: [] });
    const replayed = yield* plain("explicit", { model: otherModel, level: "low" });
    assert.equal(replayed.childThreadId, explicit.childThreadId);
    const none = yield* plain("fresh", { model: otherModel, level: "low" }).pipe(Effect.flip);
    assert.include(none.message, "No reasoning level");
  }).pipe(Effect.provide(listedLayer)),
);
