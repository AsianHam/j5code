import { J5ThreadRegistrationLayer } from "../runtimeLayer.ts";
import { SourceControlProviderRegistry } from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
/**
 * Dev-only disposable A2A delivery seed support.
 *
 * A6 multi-statement-truncation lesson: never seed this flow with a raw
 * multi-statement SQL string. Each scenario's durable state is written by
 * production services. A scenario is not one transaction: the orchestrator's
 * terminal-run reactor takes a thread's lock and then reads the database, so
 * holding a transaction across a dispatch to that thread deadlocks. A run
 * that fails part way leaves partial rows; discard the disposable home.
 * Run only while the target T3 server is stopped; this process owns the
 * one database accessor and exits completely after printing its receipt.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import * as NodeOS from "node:os";

import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";

import { EnvironmentAuth } from "../../../auth/EnvironmentAuth.ts";
import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ServerConfig } from "../../../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../../mcp/McpSessionRegistry.testkit.ts";
import {
  layerEventSink as OrchestrationV2EventSinkLayerLive,
  layer as UpstreamOrchestrationV2LayerLive,
} from "../../../orchestration-v2/runtimeLayer.ts";
import {
  EffectOutboxV2,
  layer as effectOutboxLayer,
} from "../../../orchestration-v2/EffectOutbox.ts";
import {
  isActiveRun,
  latestActiveRun,
  ThreadManagementService,
} from "../../../orchestration-v2/ThreadManagementService.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../../../persistence/Sqlite.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../../../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import {
  deliveryCommandId,
  deliveryMessageId,
  live as deliveryTransportLive,
} from "../DeliveryTransport.ts";
import { manualLayer as deliveryWorkerLayer, A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { formatClosedHumanEnvelope } from "../EnvelopeFormatter.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "../HumanInboxService.ts";
import { layer as peerRegistryLayer } from "../PeerRegistryService.ts";
import { ensureLocalOperatorHumanPerson } from "../HumanPersonRegistry.ts";
import { A2ALedger, layer as ledgerLayer } from "../LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "../PeerDirectory.ts";
import { A2ASendService, layer as sendServiceLayer } from "../SendService.ts";
import {
  MachineParticipantService,
  layer as machineParticipantLayer,
} from "../MachineParticipantService.ts";
import { layer as agentCrewInstanceLayer } from "../AgentCrewInstanceService.ts";
import { A2ASilenceDetector, manualLayer as silenceDetectorLayer } from "../SilenceDetector.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  LedgerProjectId,
} from "../contracts.ts";

const OrchestrationV2LayerLive = UpstreamOrchestrationV2LayerLive.pipe(
  Layer.provideMerge(J5ThreadRegistrationLayer),
);

const fakeProviderInstanceId = ProviderInstanceId.make("j5-dev-seed-unavailable");
const fakeModelSelection = {
  instanceId: fakeProviderInstanceId,
  model: "j5-dev-seed-unavailable",
} satisfies ModelSelection;
const fakeDriver = ProviderDriverKind.make("codex");

export interface DevDeliverySeedReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly baseDir: string;
  readonly dbPath: string;
  readonly project: { readonly id: ProjectId };
  readonly threads: {
    readonly sender: { readonly threadId: ThreadId; readonly participantId: ParticipantId };
    readonly receiver: { readonly threadId: ThreadId; readonly participantId: ParticipantId };
  };
  readonly scenarios: {
    readonly ta1PeerExchange: {
      readonly ledgerMessageId: LedgerMessageId;
      readonly deliveryMessageId: MessageId;
      readonly exchangeId: ExchangeId;
      readonly targetThreadId: ThreadId;
    };
    readonly ta2HumanAnswer: {
      readonly personId: ParticipantId;
      readonly inboxRequestLedgerMessageId: LedgerMessageId;
      readonly exchangeId: ExchangeId;
      readonly replyLedgerMessageId: LedgerMessageId;
      readonly replyDeliveryMessageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
    readonly ta3Silence: {
      readonly sourceLedgerMessageId: LedgerMessageId;
      readonly sourceDeliveryMessageId: MessageId;
      readonly noticeLedgerMessageId: LedgerMessageId;
      readonly noticeDeliveryMessageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
    readonly machineMessage: {
      readonly senderParticipantId: ParticipantId;
      readonly ledgerMessageId: LedgerMessageId;
      readonly deliveryMessageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
    readonly rawFutureEnvelope: {
      readonly ledgerMessageId: LedgerMessageId;
      readonly deliveryMessageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
    readonly normalNonA2AContrast: {
      readonly messageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
  };
  readonly noProviderWork: {
    readonly runnerStartedEffectWorker: false;
    readonly providerAdapterOpenSessionCalls: 0;
    readonly activeProviderSessionCount: 0;
    readonly activeRunCount: 0;
    readonly cancelledProviderStartEffectCount: number;
    readonly nextClaimableAt: null;
  };
  readonly notSeeded: {
    readonly ta4Trailing: {
      readonly status: "held";
      readonly reason: "TA4 remains behind its separately authorized timeline seam.";
    };
  };
  readonly reuse: {
    readonly invocation: "scripts/j5/a2a-delivery-seed.sh --base-dir <isolated-t3-home>";
    readonly note: "Use the receipt ids to locate only this disposable seed set; rerunning creates a new run id.";
  };
}

export class DevDeliverySeedArgumentError extends Schema.TaggedError<DevDeliverySeedArgumentError>()(
  "DevDeliverySeedArgumentError",
  { message: Schema.String },
) {}

export class DevDeliverySeedServerOffError extends Schema.TaggedError<DevDeliverySeedServerOffError>()(
  "DevDeliverySeedServerOffError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The disposable A2A seed runner could not acquire its rollback write preflight. Stop the target T3 server, confirm no process holds this isolated database, then retry.";
  }
}

class DevDeliverySeedPreflightRollback extends Schema.TaggedError<DevDeliverySeedPreflightRollback>()(
  "DevDeliverySeedPreflightRollback",
  {},
) {}

class DevDeliverySeedScenarioError extends Schema.TaggedError<DevDeliverySeedScenarioError>()(
  "DevDeliverySeedScenarioError",
  { name: Schema.String, cause: Schema.Defect() },
) {}

const isDevDeliverySeedPreflightRollback = Schema.is(DevDeliverySeedPreflightRollback);
const isDevDeliverySeedServerOffError = Schema.is(DevDeliverySeedServerOffError);

export const parseDevDeliverySeedArgs = (args: ReadonlyArray<string>) => {
  if (args.length !== 2 || args[0] !== "--base-dir") {
    throw new DevDeliverySeedArgumentError({
      message: "Usage: --base-dir <absolute isolated T3 home>",
    });
  }
  return { baseDir: args[1]! };
};

const isInside = (path: Path.Path, candidate: string, parent: string) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Require an existing, absolute disposable T3 home; resolves symlinks before rejecting live state.
 *
 * Thread worktrees live below the shared home, at `~/.j5code/worktrees/...`. A
 * linked git worktree's own `.j5code` is that checkout's disposable dev state,
 * so a base directory inside one is accepted wherever the worktree lives.
 */
export const validateIsolatedBaseDir = (baseDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(baseDir)) {
      return yield* new DevDeliverySeedArgumentError({
        message: "--base-dir must be an absolute path.",
      });
    }
    const requested = path.resolve(baseDir);
    const configuredSharedHomes = [".t3", ".j5code"].map((name) =>
      path.resolve(NodeOS.homedir(), name),
    );
    const sharedHomes = yield* Effect.all(
      configuredSharedHomes.map((sharedHome) =>
        fileSystem
          .exists(sharedHome)
          .pipe(
            Effect.flatMap((exists) =>
              exists ? fileSystem.realPath(sharedHome) : Effect.succeed(sharedHome),
            ),
          ),
      ),
    );
    let existingParent = requested;
    while (!(yield* fileSystem.exists(existingParent))) {
      const parent = path.dirname(existingParent);
      if (parent === existingParent) break;
      existingParent = parent;
    }
    // The requested path with every existing symlink resolved, before anything is created.
    const canonicalRequested = path.resolve(
      yield* fileSystem.realPath(existingParent),
      path.relative(existingParent, requested),
    );
    const isSharedState = Effect.fn(function* (candidate: string) {
      if (!sharedHomes.some((sharedHome) => isInside(path, candidate, sharedHome))) return false;
      const worktreeHome = yield* resolveWorktreeT3Home(candidate);
      return (
        worktreeHome === undefined ||
        !isInside(path, candidate, worktreeHome) ||
        sharedHomes.some((sharedHome) => isInside(path, sharedHome, worktreeHome))
      );
    });
    const sharedStateError = new DevDeliverySeedArgumentError({
      message:
        "--base-dir must not be ~/.t3 or ~/.j5code or anything below either, including their userdata directories. The one exception is a linked git worktree's own .j5code.",
    });
    if ((yield* isSharedState(requested)) || (yield* isSharedState(canonicalRequested))) {
      return yield* sharedStateError;
    }
    yield* fileSystem.makeDirectory(requested, { recursive: true });
    const resolvedBaseDir = yield* fileSystem.realPath(requested);
    if (yield* isSharedState(resolvedBaseDir)) {
      return yield* sharedStateError;
    }
    return resolvedBaseDir;
  });

const databasePathFor = (path: Path.Path, baseDir: string) =>
  path.resolve(baseDir, "userdata", "statev2.sqlite");

const seededId = (runId: string, suffix: string) => `${runId}:${suffix}`;

/** SQLite reports a busy or locked database as a lock timeout, possibly wrapped by a service error. */
const isDatabaseContention = (cause: unknown): boolean =>
  isSqlError(cause)
    ? cause.reason._tag === "LockTimeoutError"
    : cause instanceof Error && isDatabaseContention(cause.cause);

const unavailableAdapter: ProviderAdapterV2Shape = {
  instanceId: fakeProviderInstanceId,
  driver: fakeDriver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  // The runner never starts an effect worker. A call here proves that boundary was broken.
  openSession: () =>
    Effect.die("The disposable A2A seed runner must never open a provider session."),
};

const makeRuntimeLayer = (databasePath: string, baseDir: string, cwd: string) => {
  const database = makeSqlitePersistenceLive(databasePath).pipe(Layer.provide(NodeServices.layer));
  const config = ServerConfig.layerTest(cwd, baseDir);
  // The seed never crosses servers: the peer registry is real but empty.
  const peerRegistry = peerRegistryLayer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(EnvironmentAuth)({ listSessions: () => Effect.succeed([]) })),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:a2a-seed")),
      }),
    ),
  );
  const deliveryTransportLayer = deliveryTransportLive.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(peerRegistry),
  );
  const vcs = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );
  const checkpoint = CheckpointStore.layer.pipe(Layer.provide(vcs));
  const fakeProvider: ProviderInstance = {
    instanceId: fakeProviderInstanceId,
    driverKind: fakeDriver,
    continuationIdentity: {
      driverKind: fakeDriver,
      continuationKey: "j5-dev-seed-unavailable",
    },
    displayName: "J5 disposable seed unavailable provider",
    enabled: false,
    // No supportedRuntimeModes: every runtime mode runs as stored.
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: unavailableAdapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
  const providers = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === fakeProviderInstanceId ? fakeProvider : undefined),
    listInstances: Effect.succeed([fakeProvider]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  // This assembles command/persistence services only. No effect worker is started and the
  // sole provider is deliberately unavailable; every seeded run is interrupted before exit.
  const orchestration = Layer.merge(
    OrchestrationV2LayerLive,
    OrchestrationV2EventSinkLayerLive,
  ).pipe(
    Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("The delivery seed does not resolve title links."),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(mcpSessionRegistryTestLayer),
    Layer.provide(checkpoint),
    Layer.provide(config),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(providers),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(database),
  );
  const deliveryWorker = deliveryWorkerLayer.pipe(Layer.provideMerge(deliveryTransportLayer));
  const silenceDetector = silenceDetectorLayer.pipe(
    Layer.provideMerge(deliveryWorker),
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  const a2a = Layer.mergeAll(
    sendServiceLayer.pipe(Layer.provide(peerDirectoryNoneLayer)),
    deliveryWorker,
    silenceDetector,
    humanInboxLayer,
    machineParticipantLayer,
  ).pipe(Layer.provideMerge(ledgerLayer), Layer.provide(orchestration));
  // Reuse the same outbox layer reference as the V2 event sink so the receipt
  // can prove each provider-start effect is cancelled before this process exits.
  const exposedOutbox = effectOutboxLayer.pipe(Layer.provide(database));
  return Layer.mergeAll(orchestration, a2a, exposedOutbox);
};

const readAllEvents = (ledgerProjectId: LedgerProjectId) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    return (yield* ledger.readEvents({
      projectId: ledgerProjectId,
      cursor: { afterSeq: 0 },
      limit: 1_000,
    })).events;
  });

const deliveredEventFor = (ledgerProjectId: LedgerProjectId, messageId: LedgerMessageId) =>
  readAllEvents(ledgerProjectId).pipe(
    Effect.flatMap((events) => {
      const delivered = events.find(
        (event) =>
          event.kind === "message.delivered" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "messageId" in event.payload &&
          event.payload.messageId === messageId,
      );
      return delivered === undefined
        ? Effect.die(`No delivery receipt was recorded for ${messageId}.`)
        : Effect.succeed(delivered);
    }),
  );

const interruptActiveSeedRun = (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
}) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const before = yield* threads.getThreadProjection(input.threadId);
    const active = latestActiveRun(before);
    if (active === undefined) {
      return yield* Effect.die(`Seed delivery did not create an active run for ${input.threadId}.`);
    }
    const result = yield* threads.interruptThread({
      projectId: input.projectId,
      threadId: input.threadId,
      runId: active.id,
      commandId: input.commandId,
      reason: "Disposable A2A seed: cancel before any provider effect can run.",
    });
    if (result.type !== "interrupt_requested") {
      return yield* Effect.die(`Expected to interrupt seed run ${active.id}.`);
    }
    const after = yield* threads.getThreadProjection(input.threadId);
    const run = after.runs.find((candidate) => candidate.id === active.id);
    if (run?.status !== "interrupted" || after.providerSessions.length !== 0) {
      return yield* Effect.die(
        `Seed run ${active.id} was not terminal without a provider session.`,
      );
    }
    return active.id;
  });

const scenario = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new DevDeliverySeedScenarioError({ name, cause })));

/**
 * Takes and rolls back a real production-ledger write before any scenario.
 * A busy DB reaches the caller as a clear server-off precondition failure.
 */
const assertTargetServerStopped = (input: {
  readonly projectId: LedgerProjectId;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* A2ALedger;
    yield* sql
      .withTransaction(
        ledger
          .ensureProject({ projectId: input.projectId, createdAt: input.createdAt })
          .pipe(Effect.andThen(Effect.fail(new DevDeliverySeedPreflightRollback()))),
      )
      .pipe(
        Effect.catch((cause) =>
          isDevDeliverySeedPreflightRollback(cause)
            ? Effect.void
            : Effect.fail(new DevDeliverySeedServerOffError({ cause })),
        ),
      );
  });

const joinScenarioAgents = (input: {
  readonly projectId: LedgerProjectId;
  readonly senderId: ParticipantId;
  readonly senderThreadId: ThreadId;
  readonly receiverId: ParticipantId;
  readonly receiverThreadId: ThreadId;
  readonly acceptedAt: string;
  readonly commandId: CommCommandId;
}) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    yield* ledger.appendEvents({
      commandId: input.commandId,
      projectId: input.projectId,
      acceptedAt: input.acceptedAt,
      events: [
        {
          kind: "participant.joined",
          sender: null,
          receiver: input.senderId,
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: { kind: "agent", id: input.senderId, threadId: input.senderThreadId },
          },
          createdAt: input.acceptedAt,
        },
        {
          kind: "participant.joined",
          sender: null,
          receiver: input.receiverId,
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: { kind: "agent", id: input.receiverId, threadId: input.receiverThreadId },
          },
          createdAt: input.acceptedAt,
        },
      ],
    });
  });

/**
 * Seeds the delivery scenarios into `requestedBaseDir`.
 *
 * By default the seed makes its own project rooted at `process.cwd()`. Pass
 * `project` to put the seed threads into a project that already exists in the
 * home, so the home keeps one project per directory.
 */
export const runDevDeliverySeed = (
  requestedBaseDir: string,
  options: {
    readonly project?: { readonly id: ProjectId; readonly workspaceRoot: string };
  } = {},
) =>
  Effect.gen(function* () {
    const baseDir = yield* validateIsolatedBaseDir(requestedBaseDir);
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const runId = `j5-a2a-seed-${yield* crypto.randomUUIDv4}`;
    const now = DateTime.formatIso(yield* DateTime.now);
    const projectId = options.project?.id ?? ProjectId.make(`project:${runId}`);
    const workspaceRoot = options.project?.workspaceRoot ?? process.cwd();
    const senderThreadId = ThreadId.make(`thread:${runId}:sender`);
    const receiverThreadId = ThreadId.make(`thread:${runId}:receiver`);
    const senderId = ParticipantId.make(`agent:${runId}:sender`);
    const receiverId = ParticipantId.make(`agent:${runId}:receiver`);
    // A thread's home is its project, so the ledger is keyed by the project's id.
    const ledgerProjectId = LedgerProjectId.make(projectId);
    const runtime = makeRuntimeLayer(databasePathFor(path, baseDir), baseDir, workspaceRoot);

    const seed = Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const ledger = yield* A2ALedger;
      const sender = yield* A2ASendService;
      const deliveries = yield* A2ADeliveryWorker;
      const silence = yield* A2ASilenceDetector;
      const inbox = yield* A2AHumanInbox;
      const machines = yield* MachineParticipantService;
      const outbox = yield* EffectOutboxV2;

      yield* assertTargetServerStopped({
        projectId: LedgerProjectId.make(seededId(runId, "server-off-preflight")),
        createdAt: now,
      });
      // This is the production host-local registry bootstrap: it has no project or thread
      // state and must exist before the real HumanInbox send/answer scenario can address a person.
      const localOperatorPersonId = yield* ensureLocalOperatorHumanPerson(
        yield* SqlClient.SqlClient,
      );

      yield* scenario(
        "bootstrap",
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (options.project === undefined) {
            // The seed runs no project commands, so it writes the project row the ledger reads
            // titles from and a machine registration requires.
            yield* sql`
              INSERT INTO projection_projects (
                project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
              ) VALUES (
                ${projectId}, 'J5 disposable A2A seed', ${workspaceRoot}, '[]', ${now}, ${now}, NULL
              )
            `;
          } else {
            const existing = yield* sql<{ readonly workspaceRoot: string }>`
              SELECT workspace_root AS "workspaceRoot" FROM projection_projects
              WHERE project_id = ${projectId} AND deleted_at IS NULL
            `;
            if (existing[0]?.workspaceRoot !== workspaceRoot) {
              return yield* Effect.die(
                `Project ${projectId} is not registered at ${workspaceRoot} in this home.`,
              );
            }
          }
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(seededId(runId, "bootstrap:sender-thread")),
            threadId: senderThreadId,
            projectId,
            title: "J5 disposable A2A sender seed",
            modelSelection: fakeModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceRoot,
            createdBy: "system",
            creationSource: "server",
          });
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(seededId(runId, "bootstrap:receiver-thread")),
            threadId: receiverThreadId,
            projectId,
            title: "J5 disposable A2A receiver seed",
            modelSelection: fakeModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceRoot,
            createdBy: "system",
            creationSource: "server",
          });
          yield* ledger.ensureProject({ projectId: ledgerProjectId, createdAt: now });
          yield* joinScenarioAgents({
            projectId: ledgerProjectId,
            senderId,
            senderThreadId,
            receiverId,
            receiverThreadId,
            acceptedAt: now,
            commandId: CommCommandId.make(seededId(runId, "bootstrap:membership")),
          });
        }),
      );

      const ta1 = yield* scenario(
        "ta1-peer-exchange",
        Effect.gen(function* () {
          const result = yield* sender.send({
            commandId: CommCommandId.make(seededId(runId, "ta1:send")),
            senderThreadId,
            to: receiverId,
            message: "Peer delivery seed: please reply through this exchange.",
            expectReply: true,
            intent: "Seed a visible peer exchange.",
            acceptedAt: now,
          });
          if (result.exchangeId === null)
            return yield* Effect.die("TA1 seed did not open an exchange.");
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: receiverThreadId,
            commandId: CommandId.make(seededId(runId, "ta1:cancel-provider-start")),
          });
          return {
            ledgerMessageId: result.messageId,
            deliveryMessageId: deliveryMessageId(result.messageId),
            exchangeId: result.exchangeId,
            targetThreadId: receiverThreadId,
          };
        }),
      );

      const ta2 = yield* scenario(
        "ta2-human-answer",
        Effect.gen(function* () {
          const opened = yield* sender.send({
            commandId: CommCommandId.make(seededId(runId, "ta2:ask-human")),
            senderThreadId,
            to: localOperatorPersonId,
            message: "Human inbox seed: reply through this exchange.",
            expectReply: true,
            intent: "Seed a real HumanInbox answer delivery.",
            urgency: "soon",
            acceptedAt: now,
          });
          if (opened.exchangeId === null) {
            return yield* Effect.die("TA2 seed did not open a human exchange.");
          }
          yield* deliveries.drain;

          const resolvedPersonId = yield* inbox.resolvePersonId();
          if (resolvedPersonId !== localOperatorPersonId) {
            return yield* Effect.die("TA2 HumanInbox resolved a different local operator.");
          }
          const pending = yield* inbox.list(resolvedPersonId);
          const pendingItem = pending.find((item) => item.exchangeId === opened.exchangeId);
          if (
            pendingItem === undefined ||
            pendingItem.senderId !== senderId ||
            pendingItem.message !== "Human inbox seed: reply through this exchange."
          ) {
            return yield* Effect.die("TA2 seed did not create the expected HumanInbox item.");
          }

          const replyText = "Human inbox answer seed: this reply came through the real inbox.";
          const answered = yield* inbox.answer({
            commandId: CommCommandId.make(seededId(runId, "ta2:answer-human")),
            personId: resolvedPersonId,
            exchangeId: pendingItem.exchangeId,
            message: replyText,
            acceptedAt: now,
          });
          if (answered.exchangeState !== "closed" || answered.exchangeId !== opened.exchangeId) {
            return yield* Effect.die("TA2 HumanInbox answer did not close its exchange.");
          }
          yield* deliveries.drain;

          const replyDeliveryMessageId = deliveryMessageId(answered.messageId);
          const projected = yield* threads.getThreadProjection(senderThreadId);
          const reply = projected.messages.find((message) => message.id === replyDeliveryMessageId);
          const expectedEnvelope = formatClosedHumanEnvelope({
            senderId: localOperatorPersonId,
            message: replyText,
          });
          if (
            reply?.role !== "user" ||
            reply.createdBy !== "user" ||
            reply.creationSource !== "mcp" ||
            reply.text !== expectedEnvelope
          ) {
            return yield* Effect.die(
              "TA2 reply was not the closed human envelope with user/MCP provenance.",
            );
          }
          yield* interruptActiveSeedRun({
            projectId,
            threadId: senderThreadId,
            commandId: CommandId.make(seededId(runId, "ta2:cancel-provider-start")),
          });
          return {
            personId: localOperatorPersonId,
            inboxRequestLedgerMessageId: opened.messageId,
            exchangeId: opened.exchangeId,
            replyLedgerMessageId: answered.messageId,
            replyDeliveryMessageId,
            targetThreadId: senderThreadId,
          };
        }),
      );

      const ta3 = yield* scenario(
        "ta3-silence",
        Effect.gen(function* () {
          const source = yield* sender.send({
            commandId: CommCommandId.make(seededId(runId, "ta3:send")),
            senderThreadId,
            to: receiverId,
            message: "Silence seed: this delivery will end before a reply.",
            expectReply: true,
            intent: "Seed a truthful silence notice.",
            acceptedAt: now,
          });
          if (source.exchangeId === null) {
            return yield* Effect.die("TA3 seed did not open an exchange.");
          }
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: receiverThreadId,
            commandId: CommandId.make(seededId(runId, "ta3:cancel-provider-start")),
          });
          const delivered = yield* deliveredEventFor(ledgerProjectId, source.messageId);
          const notices = yield* silence.handleDeliveryEvent(delivered);
          const notice = notices[0];
          if (notice?.kind !== "silence.notice") {
            return yield* Effect.die("TA3 seed did not produce a silence notice.");
          }
          const noticeMessageId = LedgerMessageId.make(
            `message:j5:a2a:silence:${encodeURIComponent(ledgerProjectId)}:${encodeURIComponent(source.exchangeId)}:${encodeURIComponent(source.messageId)}`,
          );
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: senderThreadId,
            commandId: CommandId.make(seededId(runId, "ta3:cancel-notice-provider-start")),
          });
          return {
            sourceLedgerMessageId: source.messageId,
            sourceDeliveryMessageId: deliveryMessageId(source.messageId),
            noticeLedgerMessageId: noticeMessageId,
            noticeDeliveryMessageId: deliveryMessageId(noticeMessageId),
            targetThreadId: senderThreadId,
          };
        }),
      );

      const machineMessage = yield* scenario(
        "machine-message",
        Effect.gen(function* () {
          const { participant } = yield* machines.register({
            commandId: CommCommandId.make(seededId(runId, "machine:register")),
            projectId: ledgerProjectId,
            // Machine names are unique across projects, and every run makes a
            // new project, so a reused home needs a per-run name.
            name: `seed-watchdog-${runId.slice(-12)}`,
            acceptedAt: now,
          });
          const result = yield* sender.sendAsMachine({
            commandId: CommCommandId.make(seededId(runId, "machine:send")),
            senderParticipantId: participant.participantId,
            to: receiverId,
            message: "Machine delivery seed: the nightly check passed. No reply is possible.",
            acceptedAt: now,
          });
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: receiverThreadId,
            commandId: CommandId.make(seededId(runId, "machine:cancel-provider-start")),
          });
          return {
            senderParticipantId: participant.participantId,
            ledgerMessageId: result.messageId,
            deliveryMessageId: deliveryMessageId(result.messageId),
            targetThreadId: receiverThreadId,
          };
        }),
      );

      const rawFutureEnvelope = yield* scenario(
        "raw-future-envelope",
        Effect.gen(function* () {
          const messageId = LedgerMessageId.make(seededId(runId, "raw:future-envelope"));
          yield* ledger.appendEvents({
            commandId: CommCommandId.make(seededId(runId, "raw:future-envelope")),
            projectId: ledgerProjectId,
            acceptedAt: now,
            events: [
              {
                kind: "message.sent",
                sender: SILENCE_DETECTOR_PARTICIPANT_ID,
                receiver: receiverId,
                exchangeId: null,
                correlationId: CorrelationId.make(seededId(runId, "raw:future-correlation")),
                payload: {
                  messageId,
                  text: "[Cross-agent messaging system notice: template-v999]\n\nThis deliberately future/unrecognized envelope must render as raw text.\n\nNo current renderer template owns this body.",
                  originProjectId: ledgerProjectId,
                  receiverProjectId: ledgerProjectId,
                  exchangeRole: "none",
                  envelopeChannel: "silence_notice",
                },
                createdAt: now,
              },
            ],
          });
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: receiverThreadId,
            commandId: CommandId.make(seededId(runId, "raw:cancel-provider-start")),
          });
          return {
            ledgerMessageId: messageId,
            deliveryMessageId: deliveryMessageId(messageId),
            targetThreadId: receiverThreadId,
          };
        }),
      );

      const normalNonA2AContrast = yield* scenario(
        "normal-non-a2a-contrast",
        Effect.gen(function* () {
          const messageId = MessageId.make(`message:mcp:${runId}:thread-send:contrast`);
          yield* threads.sendToThread({
            projectId,
            threadId: senderThreadId,
            commandId: CommandId.make(seededId(runId, "normal:mcp-send")),
            messageId,
            text: "Normal MCP-shaped contrast: this must retain the generic timeline row.",
            attachments: [],
            modelSelection: fakeModelSelection,
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* interruptActiveSeedRun({
            projectId,
            threadId: senderThreadId,
            commandId: CommandId.make(seededId(runId, "normal:cancel-provider-start")),
          });
          return { messageId, targetThreadId: senderThreadId };
        }),
      );

      const senderProjection = yield* threads.getThreadProjection(senderThreadId);
      const receiverProjection = yield* threads.getThreadProjection(receiverThreadId);
      const projections = [senderProjection, receiverProjection];
      const activeRunCount = projections
        .flatMap((projection) => projection.runs)
        .filter(isActiveRun).length;
      const activeProviderSessionCount = projections.reduce(
        (total, projection) => total + projection.providerSessions.length,
        0,
      );
      if (activeRunCount !== 0 || activeProviderSessionCount !== 0) {
        return yield* Effect.die("Disposable seed left provider-executable work behind.");
      }
      const effectedCommandIds = [
        deliveryCommandId(ta1.ledgerMessageId),
        deliveryCommandId(ta2.replyLedgerMessageId),
        deliveryCommandId(ta3.sourceLedgerMessageId),
        deliveryCommandId(ta3.noticeLedgerMessageId),
        deliveryCommandId(machineMessage.ledgerMessageId),
        deliveryCommandId(rawFutureEnvelope.ledgerMessageId),
        CommandId.make(seededId(runId, "normal:mcp-send")),
      ];
      const persistedEffects = yield* Effect.forEach(
        effectedCommandIds,
        (commandId) => outbox.listByCommandId(commandId),
        { concurrency: 1 },
      ).pipe(Effect.map((groups) => groups.flat()));
      const cancelledProviderStartEffectCount = persistedEffects.filter(
        (effect) => effect.request.type === "provider-turn.start" && effect.status === "cancelled",
      ).length;
      if (cancelledProviderStartEffectCount !== effectedCommandIds.length) {
        return yield* Effect.die("Disposable seed left a provider-turn start effect executable.");
      }
      const nextClaimableAt = yield* outbox.nextClaimableAt;
      if (Option.isSome(nextClaimableAt)) {
        return yield* Effect.die("Disposable seed left a claimable orchestration effect behind.");
      }

      return {
        version: 1,
        runId,
        baseDir,
        dbPath: databasePathFor(path, baseDir),
        project: { id: projectId },
        threads: {
          sender: { threadId: senderThreadId, participantId: senderId },
          receiver: { threadId: receiverThreadId, participantId: receiverId },
        },
        scenarios: {
          ta1PeerExchange: ta1,
          ta2HumanAnswer: ta2,
          ta3Silence: ta3,
          machineMessage,
          rawFutureEnvelope,
          normalNonA2AContrast,
        },
        noProviderWork: {
          runnerStartedEffectWorker: false,
          providerAdapterOpenSessionCalls: 0,
          activeProviderSessionCount,
          activeRunCount,
          cancelledProviderStartEffectCount,
          nextClaimableAt: null,
        },
        notSeeded: {
          ta4Trailing: {
            status: "held",
            reason: "TA4 remains behind its separately authorized timeline seam.",
          },
        },
        reuse: {
          invocation: "scripts/j5/a2a-delivery-seed.sh --base-dir <isolated-t3-home>",
          note: "Use the receipt ids to locate only this disposable seed set; rerunning creates a new run id.",
        },
      } satisfies DevDeliverySeedReceipt;
    }).pipe(Effect.provide(runtime));
    return yield* seed.pipe(
      Effect.catch((cause) =>
        isDevDeliverySeedServerOffError(cause) || !isDatabaseContention(cause)
          ? Effect.fail(cause)
          : Effect.fail(new DevDeliverySeedServerOffError({ cause })),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));
