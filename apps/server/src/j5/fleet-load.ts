#!/usr/bin/env node
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { J5ThreadRegistrationLayer } from "./a2a/runtimeLayer.ts";
// @effect-diagnostics nodeBuiltinImport:off globalTimersInEffect:off globalDateInEffect:off globalConsole:off - Standalone host-side benchmark owns an isolated process and temporary SQLite state.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import {
  layerEventSink as OrchestrationV2EventSinkLayerLive,
  layer as UpstreamOrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2, type OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const OrchestrationV2LayerLive = UpstreamOrchestrationV2LayerLive.pipe(
  Layer.provideMerge(J5ThreadRegistrationLayer),
);

const FLEET_SIZE = 30;
const BASELINE_SAMPLES = 30;
const INTERACTIVE_P95_MS = 250;
const INTERACTIVE_BATCH_MS = 1_000;

const keepState = process.argv.includes("--keep-state");
const stateRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-fleet-load-"));
const dbPath = NodePath.join(stateRoot, "userdata", "statev2.sqlite");

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "j5-fake-provider",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("The J5 load harness does not start provider turns."),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:j5-fleet-load",
  },
  displayName: "J5 fake provider",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const ProviderRegistryTestLayer = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), stateRoot);
const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);
const SqlitePersistenceLive = makeSqlitePersistenceLive(dbPath).pipe(
  Layer.provide(NodeServices.layer),
);

const HarnessLayer = Layer.merge(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provide(Layer.mock(GitWorkflowService)({})),
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("The J5 load harness does not resolve title links."),
    }),
  ),
  Layer.provide(Layer.mock(ProjectService)({ getById: () => Effect.succeed(Option.none()) })),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistenceLive),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(ProviderRegistryTestLayer),
  Layer.provide(NodeServices.layer),
);

function percentile(samples: ReadonlyArray<number>, fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function summarize(samples: ReadonlyArray<number>) {
  return {
    samples: samples.length,
    minMs: Number(Math.min(...samples).toFixed(3)),
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

function databaseBytes(): number {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce(
    (total, path) => total + (NodeFS.existsSync(path) ? NodeFS.statSync(path).size : 0),
    0,
  );
}

const timedDispatch = Effect.fn("j5.fleetLoad.timedDispatch")(function* (
  orchestrator: OrchestratorV2Shape,
  command: Parameters<OrchestratorV2Shape["dispatch"]>[0],
) {
  const startedAt = performance.now();
  const events = yield* orchestrator.dispatch(command);
  return {
    elapsedMs: performance.now() - startedAt,
    storedEvents: events.storedEvents.length,
  };
});

const program = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const projectId = ProjectId.make("j5-fleet-load-project");
  const baselineThreadId = ThreadId.make("j5-fleet-load-baseline");
  let peakRssBytes = process.memoryUsage().rss;
  const rssBeforeBytes = peakRssBytes;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const sampler = setInterval(() => {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }, 2);
      sampler.unref();
      return sampler;
    }),
    (sampler) => Effect.sync(() => clearInterval(sampler)),
  );

  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("j5-fleet-load-baseline-create"),
    threadId: baselineThreadId,
    projectId,
    title: "J5 load baseline",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });

  const initialRows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM orchestration_events
    WHERE application_event_version = 2
  `;
  const eventCountBefore = Number(initialRows[0]?.count ?? 0);
  const storeBytesBefore = databaseBytes();

  const baselineResults = yield* Effect.forEach(
    Array.from({ length: BASELINE_SAMPLES }, (_, index) => index),
    (index) =>
      timedDispatch(orchestrator, {
        type: "thread.metadata.update",
        commandId: CommandId.make(`j5-fleet-load-baseline-update-${index}`),
        threadId: baselineThreadId,
        title: `J5 load baseline ${index}`,
      }),
    { concurrency: 1 },
  );

  const fleetThreadIds = Array.from({ length: FLEET_SIZE }, (_, index) =>
    ThreadId.make(`j5-fleet-load-agent-${index}`),
  );
  const createBatchStartedAt = performance.now();
  const createResults = yield* Effect.forEach(
    fleetThreadIds,
    (threadId, index) =>
      timedDispatch(orchestrator, {
        type: "thread.create",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make(`j5-fleet-load-create-${index}`),
        threadId,
        projectId,
        title: `J5 fleet agent ${index}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    { concurrency: "unbounded" },
  );
  const createBatchMs = performance.now() - createBatchStartedAt;

  const fleetBatchStartedAt = performance.now();
  const fleetResults = yield* Effect.forEach(
    fleetThreadIds,
    (threadId, index) =>
      timedDispatch(orchestrator, {
        type: "thread.metadata.update",
        commandId: CommandId.make(`j5-fleet-load-update-${index}`),
        threadId,
        title: `J5 fleet agent active ${index}`,
      }),
    { concurrency: "unbounded" },
  );
  const fleetBatchMs = performance.now() - fleetBatchStartedAt;

  const finalRows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM orchestration_events
    WHERE application_event_version = 2
  `;
  const eventCountAfter = Number(finalRows[0]?.count ?? 0);
  const storeBytesAfter = databaseBytes();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const rssAfterBytes = process.memoryUsage().rss;

  const baseline = summarize(baselineResults.map(({ elapsedMs }) => elapsedMs));
  const fleetDispatch = summarize(fleetResults.map(({ elapsedMs }) => elapsedMs));
  const fleetCreate = summarize(createResults.map(({ elapsedMs }) => elapsedMs));
  const returnedStoredEvents =
    baselineResults.reduce((sum, result) => sum + result.storedEvents, 0) +
    createResults.reduce((sum, result) => sum + result.storedEvents, 0) +
    fleetResults.reduce((sum, result) => sum + result.storedEvents, 0);
  const eventGrowth = eventCountAfter - eventCountBefore;
  const interactive =
    fleetDispatch.p95Ms < INTERACTIVE_P95_MS &&
    fleetBatchMs < INTERACTIVE_BATCH_MS &&
    eventGrowth === returnedStoredEvents;

  return {
    generatedAt: new Date().toISOString(),
    stateIsolation: {
      stateRoot,
      dbPath,
      kept: keepState,
    },
    method: {
      composition: "production OrchestrationV2LayerLive with file-backed SQLite",
      transport: "direct command dispatch (provider and WebSocket latency excluded)",
      provider: "stub Codex adapter; no model process or network call",
      baseline: `${BASELINE_SAMPLES} sequential updates on one active thread`,
      fleet: `${FLEET_SIZE} concurrent thread creates, then one concurrent update per thread`,
    },
    thresholds: {
      p95Ms: INTERACTIVE_P95_MS,
      batchMs: INTERACTIVE_BATCH_MS,
    },
    baseline,
    fleetCreate: {
      ...fleetCreate,
      batchMs: Number(createBatchMs.toFixed(3)),
    },
    fleetDispatch: {
      ...fleetDispatch,
      batchMs: Number(fleetBatchMs.toFixed(3)),
      p95VsBaseline: Number((fleetDispatch.p95Ms / baseline.p95Ms).toFixed(2)),
    },
    memory: {
      rssBeforeBytes,
      peakRssBytes,
      rssAfterBytes,
      peakGrowthBytes: peakRssBytes - rssBeforeBytes,
    },
    eventStore: {
      eventsBefore: eventCountBefore,
      eventsAfter: eventCountAfter,
      eventGrowth,
      bytesBefore: storeBytesBefore,
      bytesAfter: storeBytesAfter,
      byteGrowth: storeBytesAfter - storeBytesBefore,
      returnedStoredEvents,
      reconciled: eventGrowth === returnedStoredEvents,
    },
    verdict: interactive ? "pass" : "concern",
  };
});

try {
  const result = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(HarnessLayer))));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (!keepState) NodeFS.rmSync(stateRoot, { recursive: true, force: true });
}
