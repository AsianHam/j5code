// @effect-diagnostics nodeBuiltinImport:off - the redirect test needs a real HTTP server.
import * as NodeHttp from "node:http";
import { DeviceService } from "../../device/DeviceService.ts";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId } from "@t3tools/contracts";
import { HttpRouter } from "effect/http";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as ServerConfig from "../../config.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { layer as outboxLayer } from "../../orchestration-v2/EffectOutbox.ts";
import { ProviderAdapterRegistryV2 } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { A2ADeliveryTransport, live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { j5AuthenticatedRoutesLayer } from "./J5AuthenticatedRoutes.ts";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ThreadLifecycleService } from "../../orchestration-v2/ThreadLifecycleService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/OrchestrationCommandReceipts.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";
import { A2ALifecycleService } from "./LifecycleService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { A2ASilenceDetector } from "./SilenceDetector.ts";
import { ThreadRegistration } from "./ThreadRegistration.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import { SpawnWorkspaceService, layer as spawnWorkspaceLayer } from "./spawnWorkspace.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { ReadChanges } from "./ReadChanges.ts";
import { settledReadRevisions } from "./test-support/readRevisions.ts";
import { makeJ5A2ARuntimeLayer, peerHttpClient } from "./runtimeLayer.ts";

const archiveDependencies = Layer.mergeAll(
  // j5_spawn_agent and Crew seats prepare worktrees through upstream's launch and receipts.
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(OrchestrationCommandReceiptRepository)({}),
  Layer.mock(ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
  }),
  Layer.mock(ThreadLifecycleService)({
    archive: () => Effect.die("unused archive in runtime topology test"),
  }),
);

// The Crew and silence daemons read their start point from the event store; this one is empty.
const emptyEventStore = Layer.mock(EventSinkV2)({
  latestSequence: () => Effect.succeed(0),
  stream: () => Stream.never,
});

const measureNestedRuntimeBuilds = (nested: "http" | "mcp") =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      const database = Layer.succeed(
        SqlClient.SqlClient,
        Context.get(databaseContext, SqlClient.SqlClient),
      );
      yield* Effect.all([runMigrations(), runJ5A2AMigrations()], {
        concurrency: 1,
        discard: true,
      }).pipe(Effect.provide(database));

      const ledgers = new Set<A2ALedger["Service"]>();
      const countedLedger = ledgerLayer.pipe(
        Layer.tap((context) => Effect.sync(() => ledgers.add(Context.get(context, A2ALedger)))),
      );
      const threadManagement = Layer.mock(ThreadManagementService)({
        streamStoredEventsFrom: () => Stream.never,
      });
      const runtime = makeJ5A2ARuntimeLayer({ ledger: countedLedger });
      const httpConsumer = Layer.effectDiscard(A2ALedger.pipe(Effect.asVoid));
      const mcpConsumer = Layer.effectDiscard(A2ASilenceDetector.pipe(Effect.asVoid));
      yield* Layer.build(
        Layer.mergeAll(
          nested === "http" ? httpConsumer.pipe(Layer.provide(Layer.fresh(runtime))) : httpConsumer,
          nested === "mcp" ? mcpConsumer.pipe(Layer.provide(Layer.fresh(runtime))) : mcpConsumer,
        ).pipe(
          Layer.provide(runtime),
          Layer.provide(threadManagement),
          Layer.provide(emptyEventStore),
          Layer.provide(Layer.mock(ProviderRegistry)({})),
          Layer.provide(Layer.mock(OrchestratorV2)({})),
          Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
          Layer.provide(archiveDependencies),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(Layer.mock(ProjectService)({})),
          Layer.provide(Layer.mock(GitWorkflowService)({})),
          Layer.provide(Layer.mock(EnvironmentAuth)({})),
          Layer.provide(
            Layer.mock(ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:runtime-nested")),
            }),
          ),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "j5-a2a-runtime-layer-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provide(database),
          // The crew artifact writer reaches the project artifacts directory through the file system.
          Layer.provide(NodeServices.layer),
        ),
      );
      return ledgers.size;
    }),
  );

it.effect("shares one runtime and outbox across the production HTTP and MCP registrations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      const database = Layer.succeed(
        SqlClient.SqlClient,
        Context.get(databaseContext, SqlClient.SqlClient),
      );
      yield* Effect.all([runMigrations(), runJ5A2AMigrations()], {
        concurrency: 1,
        discard: true,
      }).pipe(Effect.provide(database));

      const ledgers = new Set<A2ALedger["Service"]>();
      let threadManagementBuilds = 0;
      const transports = new Set<A2ADeliveryTransport["Service"]>();
      const outboxes = new Set<EffectOutboxV2["Service"]>();
      const spawnWorkspaces = new Set<SpawnWorkspaceService["Service"]>();
      const countedLedger = ledgerLayer.pipe(
        Layer.tap((context) => Effect.sync(() => ledgers.add(Context.get(context, A2ALedger)))),
      );
      const countedThreadManagement = Layer.mock(ThreadManagementService)({
        streamStoredEventsFrom: () => Stream.never,
      }).pipe(Layer.tap(() => Effect.sync(() => (threadManagementBuilds += 1))));
      const ledgerConsumer = Layer.effectDiscard(A2ALedger.pipe(Effect.asVoid));
      const secondThreadConsumer = Layer.effectDiscard(ThreadManagementService.pipe(Effect.asVoid));
      const placementConsumer = Layer.effectDiscard(
        ParticipantPlacementService.pipe(Effect.asVoid),
      );
      const silenceConsumer = Layer.effectDiscard(A2ASilenceDetector.pipe(Effect.asVoid));
      const lifecycleConsumer = Layer.effectDiscard(A2ALifecycleService.pipe(Effect.asVoid));
      const archiveFactsConsumer = Layer.effectDiscard(A2AArchiveFacts.pipe(Effect.asVoid));
      const threadRegistrationConsumer = Layer.effectDiscard(
        ThreadRegistration.pipe(Effect.asVoid),
      );
      const spawnCompositionConsumer = Layer.effectDiscard(
        SpawnCompositionService.pipe(Effect.asVoid),
      );
      // j5_spawn_agent reads the workspace service from the route graph; CrewLaunch is built with it.
      const spawnWorkspaceConsumer = Layer.effectDiscard(SpawnWorkspaceService.pipe(Effect.asVoid));
      // The Crew store is given its `ReadChanges` apart from the one the routes are handed; a
      // write through it must move the revisions a client is streamed.
      let routeReadChanges: ReadChanges["Service"] | undefined;
      let routePeers: PeerRegistryService["Service"] | undefined;
      const readChangesConsumer = Layer.effectDiscard(
        Effect.gen(function* () {
          routeReadChanges = yield* ReadChanges;
          routePeers = yield* PeerRegistryService;
          yield* (yield* AgentCrewInstanceService).markArchived(
            "crew:none",
            "2026-10-12T00:00:00.000Z",
          );
        }),
      );
      const runtime = makeJ5A2ARuntimeLayer({
        ledger: countedLedger,
        spawnWorkspace: spawnWorkspaceLayer.pipe(
          Layer.tap((context) =>
            Effect.sync(() => spawnWorkspaces.add(Context.get(context, SpawnWorkspaceService))),
          ),
        ),
        deliveryTransport: deliveryTransportLayer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(PeerRegistryService)({})),
          Layer.tap((context) =>
            Effect.sync(() => transports.add(Context.get(context, A2ADeliveryTransport))),
          ),
        ),
      });
      yield* Layer.build(
        HttpRouter.serve(
          Layer.mergeAll(
            j5AuthenticatedRoutesLayer,
            McpHttpServer.layer,
            ledgerConsumer,
            secondThreadConsumer,
            placementConsumer,
            silenceConsumer,
            lifecycleConsumer,
            archiveFactsConsumer,
            threadRegistrationConsumer,
            spawnCompositionConsumer,
            spawnWorkspaceConsumer,
            readChangesConsumer,
          ).pipe(
            Layer.provideMerge(runtime),
            Layer.provide(countedThreadManagement),
            Layer.provide(emptyEventStore),
            Layer.provide(Layer.mock(DeviceService)({})),
            Layer.provide(Layer.mock(OrchestratorV2)({})),
            Layer.provide(
              outboxLayer.pipe(
                Layer.tap((context) =>
                  Effect.sync(() => outboxes.add(Context.get(context, EffectOutboxV2))),
                ),
              ),
            ),
            Layer.provide(McpSessionRegistry.layer),
            Layer.provide(PreviewAutomationBroker.layer),
            Layer.provide(
              Layer.mock(ServerEnvironment)({
                getEnvironmentId: Effect.succeed(
                  EnvironmentId.make("environment:runtime-composition"),
                ),
              }),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentAuth)({}),
                Layer.mock(ProjectService)({}),
                Layer.mock(ProjectSetupScriptRunner)({}),
                Layer.mock(ProviderRegistry)({}),
                Layer.mock(ProviderAdapterRegistryV2)({}),
                Layer.mock(ScheduledTaskService)({}),
                Layer.mock(GitWorkflowService)({}),
                Layer.mock(VcsStatusBroadcaster)({}),
                Layer.mock(VcsProcess)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(PreviewBrowser.PreviewBrowser)({}),
                ServerSettingsService.layerTest(),
              ),
            ),
            Layer.provide(archiveDependencies),
            Layer.provide(AnalyticsService.layerTest),
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "j5-a2a-production-runtime-",
              }).pipe(Layer.provide(NodeServices.layer)),
            ),
            Layer.provide(database),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          Layer.provide(Layer.mock(EnvironmentAuth)({})),
          Layer.provide(
            Layer.mock(ServerEnvironment)({
              getEnvironmentId: Effect.succeed(
                EnvironmentId.make("environment:runtime-composition"),
              ),
            }),
          ),
          Layer.provide(NodeHttpServer.layerTest),
          Layer.provide(NodeServices.layer),
        ),
      );

      assert.equal(ledgers.size, 1);
      assert.equal(threadManagementBuilds, 1);
      assert.equal(transports.size, 1);
      assert.equal(outboxes.size, 1);
      // The start guard holds only if j5_spawn_agent and CrewLaunch share one workspace service.
      assert.equal(spawnWorkspaces.size, 1);
      // The peer registry's writes are followed by the feeds, which hold the same `ReadChanges`:
      // a store peer adopted through the registry the routes are handed moves `peers`.
      const laptop = {
        environmentId: "environment-laptop",
        sessionId: "auth-session:laptop-store",
      };
      yield* routePeers!.grantStore({ ...laptop, issuedAt: "2026-10-12T00:00:00.000Z" });
      assert.isTrue(
        yield* routePeers!.adoptStorePeer({ ...laptop, at: "2026-10-12T00:00:00.000Z" }),
      );
      const revisions = yield* settledReadRevisions.pipe(
        Effect.provideService(ReadChanges, routeReadChanges!),
      );
      assert.equal(revisions.crew, 1);
      assert.equal(revisions.peers, 1);
      const sql = Context.get(databaseContext, SqlClient.SqlClient);
      const people = yield* sql<{
        readonly is_local_operator: number;
        readonly person_id: string;
      }>`
        SELECT person_id, is_local_operator
        FROM j5_a2a_human_person
      `;
      assert.lengthOf(people, 1);
      assert.match(people[0]!.person_id, /^human:[0-9a-f]{8}-[0-9a-f-]{27}$/);
      assert.equal(people[0]!.is_local_operator, 1);
      const domainCounts = yield* sql<{
        readonly events: number;
        readonly memberships: number;
        readonly projects: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM j5_a2a_project_ledger) AS projects,
          (SELECT COUNT(*) FROM j5_a2a_membership) AS memberships,
          (SELECT COUNT(*) FROM j5_a2a_comm_event) AS events
      `;
      assert.deepStrictEqual(domainCounts, [{ projects: 0, memberships: 0, events: 0 }]);
    }),
  ),
);

it.effect("detects a fresh nested HTTP or MCP runtime as a distinct ledger instance", () =>
  Effect.gen(function* () {
    assert.equal(yield* measureNestedRuntimeBuilds("http"), 2);
    assert.equal(yield* measureNestedRuntimeBuilds("mcp"), 2);
  }),
);

it.live("the peer HTTP client never follows a redirect", () =>
  Effect.gen(function* () {
    // A real server and the real fetch client, since following is fetch's own behavior.
    const hits: Array<string> = [];
    const server = NodeHttp.createServer((request, response) => {
      hits.push(request.url ?? "");
      if (request.url === "/api/j5/peer/poll") {
        response.writeHead(307, { location: "/elsewhere" }).end();
        return;
      }
      response.writeHead(200).end();
    });
    const port = yield* Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resume(
            Effect.succeed(typeof address === "object" && address !== null ? address.port : 0),
          );
        });
      }),
      () => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
    );
    const response = yield* HttpClient.post(
      `http://127.0.0.1:${String(port)}/api/j5/peer/poll`,
    ).pipe(Effect.provide(peerHttpClient));
    assert.equal(response.status, 307);
    assert.deepStrictEqual(hits, ["/api/j5/peer/poll"], "the redirect is not followed");
  }).pipe(Effect.scoped),
);
