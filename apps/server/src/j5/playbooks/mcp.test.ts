import { seedPersonas, seedPlaybookOwners } from "./testFixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  PlaybookDiscovery,
  PlaybookError,
  PlaybookReadResponse,
  PlaybookStepResponse,
} from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";
import { stringify } from "yaml";

import { ServerConfig } from "../../config.ts";
import {
  McpInvocationContext,
  type McpThreadInvocationScope,
} from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ArchiveAgentService } from "../a2a/ArchiveAgentService.ts";
import { A2ADeliveryWorker } from "../a2a/DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../a2a/HomeRegistrar.ts";
import { A2ALedger } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { ParticipantPlacementService } from "../a2a/PlacementService.ts";
import { A2ASendService } from "../a2a/SendService.ts";
import { SpawnCompositionService } from "../a2a/SpawnCompositionService.ts";
import { ThreadRegistration } from "../a2a/ThreadRegistration.ts";
import { J5ToolkitHandlersLive } from "../a2a/mcp/handlers.ts";
import { J5Toolkit } from "../a2a/mcp/tools.ts";
import { layer as agentCrewInstanceLayer } from "../a2a/AgentCrewInstanceService.ts";
import { layer as playbookCrewRelayLayer } from "./PlaybookCrewRelay.ts";
import { makePlaybookStore, PlaybookStore } from "./PlaybookStore.ts";
import type { playbookTools } from "./mcp.ts";

const owner = ThreadId.make("thread:playbook-mcp:worktree");
const rootOwner = ThreadId.make("thread:playbook-mcp:project-root");
const projectId = ProjectId.make("project:playbook-mcp");
const createdAt = "2026-09-21T09:00:00.000Z";
const decodeStep = Schema.decodeUnknownEffect(PlaybookStepResponse);
const decodeFailure = Schema.decodeUnknownEffect(PlaybookError);
// A missing capability is refused by the playbook tool for a read and by the access declaration
// for a run tool; both say `capability_denied`.
const decodeFailureCode = Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }));
const decodeListed = Schema.decodeUnknownEffect(PlaybookDiscovery);
const decodeRead = Schema.decodeUnknownEffect(PlaybookReadResponse);
type PlaybookToolName = (typeof playbookTools)[number]["name"];
const scopeFor = (
  threadId = owner,
  providerSessionId = "session:first",
): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:playbook-mcp"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: providerSessionId,
  thread: { threadId, providerSessionId, providerInstanceId: ProviderInstanceId.make("codex") },
  client: undefined,
});
const sample = (title: string) => ({
  title,
  description: "Build a two-word report while the agent controls progress.",
  steps: [
    { id: "research", title: "Research", prompt: "Record ALPHA." },
    { id: "implement", title: "Implement", prompt: "Append BETA to your notes." },
    { id: "review", title: "Review", prompt: "Report ALPHA BETA." },
  ],
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-mcp-" });
  const projectRoot = path.join(directory, "project");
  const worktree = path.join(directory, "worktree");
  for (const [root, title] of [
    [projectRoot, "Project playbook"],
    [worktree, "Worktree playbook"],
  ] as const) {
    yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
    yield* fs.writeFileString(path.join(root, ".j5/playbooks/demo.yaml"), stringify(sample(title)));
  }
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([owner, rootOwner]);
  const store = yield* makePlaybookStore;
  const services = Layer.mergeAll(
    Layer.succeed(PlaybookStore, store),
    Layer.mock(ThreadManagementService)({
      // The access gate reads the calling thread before each tool.
      getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
      getThreadProjection: (threadId) =>
        Effect.succeed(
          emptyProjection({
            id: EventId.make(`created:${threadId}`),
            type: "thread.created",
            threadId,
            occurredAt: DateTime.makeUnsafe(createdAt),
            payload: {
              id: threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Playbook test",
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: threadId === owner ? worktree : null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: DateTime.makeUnsafe(createdAt),
              updatedAt: DateTime.makeUnsafe(createdAt),
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          }),
        ),
    }),
    Layer.mock(ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Project",
            workspaceRoot: projectRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(OrchestratorV2)({}),
    Layer.mock(OrchestratorMcpService)({}),
    Layer.mock(A2ADeliveryWorker)({}),
    Layer.mock(A2AHomeRegistrar)({}),
    Layer.mock(A2ALedger)({}),
    Layer.mock(ParticipantPlacementService)({}),
    Layer.mock(A2ASendService)({}),
    Layer.mock(SpawnCompositionService)({}),
    Layer.mock(ArchiveAgentService)({}),
    Layer.mock(ThreadRegistration)({}),
    NodeServices.layer,
  );
  const dependencies = playbookCrewRelayLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(services),
  );
  const toolkit = yield* J5Toolkit.pipe(
    Effect.provide(J5ToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends PlaybookToolName>(
    name: Name,
    input: Tool.Parameters<(typeof J5Toolkit.tools)[Name]>,
    scope = scopeFor(),
  ) =>
    toolkit
      .handle(name, input)
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        Effect.provide(dependencies),
        Effect.provideService(McpInvocationContext, scope),
      );
  return { call, fs, path, worktree, projectRoot };
});
const TestLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);

it.effect("runs a scripted three-step sample through the real J5Toolkit handlers", () =>
  Effect.gen(function* () {
    const { call } = yield* fixture;
    const first = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start-a" });
    assert.isFalse(first.isFailure);
    const run = yield* decodeStep(first.result);
    assert.equal(run.currentStep?.prompt, "Record ALPHA.");
    const notes = ["ALPHA"];
    const recovered = yield* call(
      "j5_playbook_current",
      {},
      scopeFor(owner, "session:after-compaction"),
    );
    assert.equal((yield* decodeStep(recovered.result)).runId, run.runId);

    const nextInput = { runId: run.runId, expectedStepId: "research", client_request_id: "next-1" };
    const second = yield* call("j5_playbook_next", nextInput);
    assert.equal(
      (yield* decodeStep(second.result)).currentStep?.prompt,
      "Append BETA to your notes.",
    );
    notes.push("BETA");
    const back = yield* call("j5_playbook_back", {
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "back-1",
    });
    assert.equal((yield* decodeStep(back.result)).currentStep?.prompt, "Record ALPHA.");
    const retry = yield* call("j5_playbook_next", nextInput);
    const replayed = yield* decodeStep(retry.result);
    assert.isTrue(replayed.replayed);
    assert.equal(replayed.currentStepId, "research");
    assert.deepStrictEqual(notes, ["ALPHA", "BETA"]);

    yield* call("j5_playbook_next", { ...nextInput, client_request_id: "next-2" });
    const third = yield* call("j5_playbook_next", {
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "next-3",
    });
    const review = yield* decodeStep(third.result);
    assert.equal(review.currentStep?.prompt, "Report ALPHA BETA.");
    assert.equal(review.position, 3);
    assert.equal(notes.join(" "), "ALPHA BETA");
    const completed = yield* call("j5_playbook_complete", {
      runId: run.runId,
      expectedStepId: "review",
      client_request_id: "complete-a",
    });
    assert.equal((yield* decodeStep(completed.result)).status, "completed");

    const secondRun = yield* call("j5_playbook_start", {
      name: "demo",
      client_request_id: "start-b",
    });
    const runB = yield* decodeStep(secondRun.result);
    assert.notEqual(runB.runId, run.runId);
    const cancelled = yield* call("j5_playbook_cancel", {
      runId: runB.runId,
      client_request_id: "cancel-b",
    });
    assert.equal((yield* decodeStep(cancelled.result)).status, "cancelled");
    const thirdRun = yield* call("j5_playbook_start", {
      name: "demo",
      client_request_id: "start-c",
    });
    assert.equal((yield* decodeStep(thirdRun.result)).status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("discovers and starts from the thread worktree, falling back to its project root", () =>
  Effect.gen(function* () {
    const { call, path, worktree, projectRoot } = yield* fixture;
    const decodeDiscovery = Schema.decodeUnknownEffect(PlaybookDiscovery);
    const worktreeList = yield* call("j5_playbook_list", {});
    const projectList = yield* call("j5_playbook_list", {}, scopeFor(rootOwner));
    assert.equal(
      (yield* decodeDiscovery(worktreeList.result)).playbooks[0]?.title,
      "Worktree playbook",
    );
    assert.equal(
      (yield* decodeDiscovery(projectList.result)).playbooks[0]?.title,
      "Project playbook",
    );
    const worktreeRun = yield* call("j5_playbook_start", {
      name: "demo",
      client_request_id: "start",
    });
    const projectRun = yield* call(
      "j5_playbook_start",
      { name: "demo", client_request_id: "start" },
      scopeFor(rootOwner),
    );
    assert.equal(
      (yield* decodeStep(worktreeRun.result)).definitionPath,
      path.join(worktree, ".j5/playbooks/demo.yaml"),
    );
    assert.equal(
      (yield* decodeStep(projectRun.result)).definitionPath,
      path.join(projectRoot, ".j5/playbooks/demo.yaml"),
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("denies a different owner and every tool when orchestration capability is absent", () =>
  Effect.gen(function* () {
    const { call } = yield* fixture;
    const started = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start" });
    const run = yield* decodeStep(started.result);
    const movement = { runId: run.runId, expectedStepId: "research", client_request_id: "denied" };
    for (const scope of [scopeFor(rootOwner), { ...scopeFor(), capabilities: new Set<never>() }]) {
      const expected = scope.thread.threadId === rootOwner ? "not_owner" : "capability_denied";
      const responses = [
        yield* call("j5_playbook_current", { runId: run.runId }, scope),
        yield* call("j5_playbook_next", movement, scope),
        yield* call("j5_playbook_back", movement, scope),
        yield* call("j5_playbook_complete", movement, scope),
        yield* call("j5_playbook_reselect", { ...movement, stepId: "review" }, scope),
        yield* call("j5_playbook_cancel", { runId: run.runId, client_request_id: "denied" }, scope),
      ];
      for (const response of responses) {
        assert.isTrue(response.isFailure);
        assert.equal((yield* decodeFailureCode(response.result)).code, expected);
      }
    }
    const deniedScope = { ...scopeFor(), capabilities: new Set<never>() };
    const deniedDiscovery = yield* call("j5_playbook_list", {}, deniedScope);
    const deniedStart = yield* call(
      "j5_playbook_start",
      { name: "demo", client_request_id: "denied-start" },
      deniedScope,
    );
    assert.equal((yield* decodeFailure(deniedDiscovery.result)).code, "capability_denied");
    assert.equal((yield* decodeFailureCode(deniedStart.result)).code, "capability_denied");
    const current = yield* call("j5_playbook_current", { runId: run.runId });
    assert.equal((yield* decodeStep(current.result)).currentStepId, "research");
    assert.equal((yield* decodeStep(current.result)).status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("returns actionable live-file errors and recovers or cancels through the toolkit", () =>
  Effect.gen(function* () {
    const { call, fs, path, worktree } = yield* fixture;
    const started = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start" });
    const run = yield* decodeStep(started.result);
    const file = path.join(worktree, ".j5/playbooks/demo.yaml");
    yield* fs.writeFileString(
      file,
      stringify({ ...sample("Edited playbook"), steps: sample("Edited").steps.slice(1) }),
    );
    const missing = yield* call("j5_playbook_current", { runId: run.runId });
    assert.isTrue(missing.isFailure);
    assert.deepStrictEqual((yield* decodeFailure(missing.result)).availableStepIds, [
      "implement",
      "review",
    ]);
    const recovered = yield* call("j5_playbook_reselect", {
      runId: run.runId,
      expectedStepId: "research",
      stepId: "implement",
      client_request_id: "recover",
    });
    assert.equal(
      (yield* decodeStep(recovered.result)).currentStep?.prompt,
      "Append BETA to your notes.",
    );
    yield* fs.remove(file);
    const invalid = yield* call("j5_playbook_current", { runId: run.runId });
    assert.equal((yield* decodeFailure(invalid.result)).code, "invalid_definition");
    const cancelled = yield* call("j5_playbook_cancel", {
      runId: run.runId,
      client_request_id: "cancel",
    });
    assert.isFalse(cancelled.isFailure);
    assert.equal((yield* decodeStep(cancelled.result)).status, "cancelled");
    const after = yield* call("j5_playbook_current", {});
    assert.isFalse(after.isFailure);
    assert.equal((yield* decodeStep(after.result)).status, "cancelled");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("reads step personas and warnings through the toolkit and still starts the run", () =>
  Effect.gen(function* () {
    const { call, fs, path, worktree } = yield* fixture;
    yield* seedPersonas([{ id: "planner", enabled: false }]);
    const staffed = sample("Staffed playbook");
    yield* fs.writeFileString(
      path.join(worktree, ".j5/playbooks/demo.yaml"),
      stringify({
        ...staffed,
        steps: staffed.steps.map((step, index) =>
          index === 0 ? { ...step, persona: "planner" } : step,
        ),
      }),
    );
    const warning = {
      code: "persona_disabled" as const,
      stepId: "research",
      persona: "planner",
      message: `Step "research" names persona "planner", which is turned off.`,
    };
    const listed = yield* decodeListed((yield* call("j5_playbook_list", {})).result);
    assert.isNull(listed.playbooks[0]?.issue);
    assert.deepStrictEqual(listed.playbooks[0]?.warnings, [warning]);
    assert.equal(listed.playbooks[0]?.steps[0]?.persona, "planner");

    const read = yield* call("j5_playbook_read", { name: "demo" });
    assert.isFalse(read.isFailure);
    const definition = yield* decodeRead(read.result);
    assert.deepStrictEqual(definition.warnings, [warning]);
    assert.equal(definition.steps[0]?.persona, "planner");
    assert.equal(definition.steps[1]?.prompt, "Append BETA to your notes.");
    const absent = yield* call("j5_playbook_read", { name: "absent" });
    assert.isTrue(absent.isFailure);
    assert.equal((yield* decodeFailure(absent.result)).code, "not_found");
    const denied = yield* call(
      "j5_playbook_read",
      { name: "demo" },
      { ...scopeFor(), capabilities: new Set<never>() },
    );
    assert.equal((yield* decodeFailure(denied.result)).code, "capability_denied");

    const started = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start" });
    assert.isFalse(started.isFailure);
    assert.equal((yield* decodeStep(started.result)).currentStep?.persona, "planner");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-mcp-personas-" }).pipe(
        Layer.provideMerge(TestLayer),
      ),
    ),
  ),
);
