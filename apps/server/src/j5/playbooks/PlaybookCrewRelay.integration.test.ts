import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { stringify } from "yaml";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "../../orchestration-v2/EffectWorker.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderTurnStartServiceTestkit from "../../orchestration-v2/ProviderTurnStartService.testkit.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ProjectEnrichmentService } from "../../project/ProjectEnrichmentService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "../a2a/AgentCrewInstanceService.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { J5ThreadRegistrationLayer } from "../a2a/runtimeLayer.ts";
import { LedgerProjectId } from "../a2a/contracts.ts";
import { makePlaybookCrewRelay } from "./PlaybookCrewRelay.ts";
import { makePlaybookStore, playbookError, PlaybookStore } from "./PlaybookStore.ts";

// The real orchestrator, command receipts, and effect worker, the way
// DelegatedCompletionDelivery.test.ts assembles them, so the step notice's command id is
// replayed by the orchestrator's own receipts rather than by a mock.
const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused title link") }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-j5-playbook-crew-relay-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("provider sessions are not used by the step hand-off test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const TestLayer = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provideMerge(J5ThreadRegistrationLayer)),
  RuntimeLayer.layerEventSink,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfigLayer),
          Layer.provide(PlatformTestLayer),
        ),
      ),
    ),
  ),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(ledgerLayer, crewInstanceLayer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(PlatformTestLayer),
);

const projectId = ProjectId.make("project:playbook-relay");
const captainThread = ThreadId.make("thread:playbook-relay:captain");
const seatThread = ThreadId.make("thread:playbook-relay:seat");
const ledgerProjectId = LedgerProjectId.make("ledger:playbook-relay");

it.layer(TestLayer)("Crew playbook hand-off through the real orchestrator", (it) => {
  it.effect("a crash between the dispatch and its record replays one notice, never two", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const worker = yield* OrchestrationEffectWorkerV2;
      const crews = yield* AgentCrewInstanceService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* runJ5A2AMigrations();

      const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-relay-it-" });
      const definitionPath = path.join(root, ".j5/playbooks/review.yaml");
      yield* fs.makeDirectory(path.dirname(definitionPath), { recursive: true });
      yield* fs.writeFileString(
        definitionPath,
        stringify({
          title: "Review a change",
          description: "Inspect and report.",
          steps: [
            { id: "inspect", title: "Inspect", prompt: "Read the change." },
            { id: "report", title: "Report", prompt: "Report the findings." },
          ],
        }),
      );
      yield* (yield* ProjectService).create({
        commandId: CommandId.make("command:playbook-relay:project"),
        projectId,
        title: "Playbook relay",
        workspaceRoot: root,
        defaultModelSelection: modelSelection,
      });
      for (const threadId of [captainThread, seatThread])
        yield* threads.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:playbook-relay:create:${threadId}`),
          threadId,
          projectId,
          title: `Playbook relay ${threadId}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
      yield* (yield* A2ALedger).ensureProject({ projectId: ledgerProjectId, createdAt: now });
      yield* crews.record({
        id: "crew:playbook-relay",
        projectId: ledgerProjectId,
        captainParticipantId: participantIdForThread(captainThread),
        captainThreadId: captainThread,
        displayName: "Relay Crew",
        brief: "Follow the playbook.",
        createdAt: now,
        playbook: { name: "review", definitionPath },
        members: [
          {
            seatName: "reviewer",
            agentId: null,
            participantId: participantIdForThread(seatThread),
            threadId: seatThread,
            reason: null,
            playbookStepIds: ["inspect"],
          },
        ],
      });

      // The seam: the write that records a finished hand-off fails once, after the dispatch.
      const real = yield* makePlaybookStore;
      const failRecord = yield* Ref.make(true);
      const store = PlaybookStore.of({
        ...real,
        resolveLanding: (runId, requestId, outcome) =>
          Ref.getAndSet(failRecord, false).pipe(
            Effect.flatMap((fail) =>
              fail && outcome === "delivered"
                ? Effect.fail(playbookError("operation_failed", "The process stopped here."))
                : real.resolveLanding(runId, requestId, outcome),
            ),
          ),
      });
      const relay = yield* makePlaybookCrewRelay.pipe(Effect.provideService(PlaybookStore, store));
      const seatNotices = threads
        .getThreadProjection(seatThread)
        .pipe(
          Effect.map((projection) =>
            projection.messages.filter((message) => message.text.includes("<j5_playbook_step>")),
          ),
        );

      const started = yield* relay.start({
        owner: captainThread,
        root,
        name: "review",
        key: "start-1",
        crewInstanceId: "crew:playbook-relay",
      });
      yield* worker.drain();
      assert.deepStrictEqual(started.delivery, {
        state: "pending",
        seat: "reviewer",
        threadId: seatThread,
      });
      assert.lengthOf(yield* seatNotices, 1);
      assert.isNull((yield* real.landing(started.runId, "start-1"))?.resolvedAt);

      // The prompt changes before the retry. The receipt replays the committed command without
      // comparing payloads, so the seat keeps the notice it already has: no second copy, no error.
      yield* fs.writeFileString(
        definitionPath,
        stringify({
          title: "Review a change",
          description: "Inspect and report.",
          steps: [
            { id: "inspect", title: "Inspect", prompt: "Read the edited change." },
            { id: "report", title: "Report", prompt: "Report the findings." },
          ],
        }),
      );
      // Nothing retries on its own. The Captain's next move first finishes the pending landing,
      // re-dispatching the same command id, which the receipt replays; then it moves, and the
      // unowned step is the Captain's.
      const next = yield* relay.mutate(captainThread, {
        runId: started.runId,
        operation: "next",
        expectedStepId: "inspect",
        client_request_id: "next-1",
      });
      yield* worker.drain();
      assert.equal(next.delivery?.state, "captain");
      const notices = yield* seatNotices;
      assert.lengthOf(notices, 1);
      assert.include(notices[0]?.id, "playbook-step");
      assert.include(notices[0]?.text, "Read the change.");
      assert.notInclude(notices[0]?.text, "edited");
      assert.equal((yield* real.landing(started.runId, "start-1"))?.outcome, "delivered");
    }).pipe(Effect.scoped),
  );
});
