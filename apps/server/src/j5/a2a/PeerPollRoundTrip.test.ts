// @effect-diagnostics nodeBuiltinImport:off - one test reads the database from a second connection.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import {
  AuthA2APeerScope,
  AuthSessionId,
  EnvironmentId,
  EventId,
  ExecutionEnvironmentDescriptor,
  MessageId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  J5_PEER_API_PATHS,
  PeerPollRequest,
  PeerPollResponse,
  type A2ARosterEntry,
  type PeerRosterAgent,
  type PeerRosterResponse,
} from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { layer as crewInstanceLayer } from "./AgentCrewInstanceService.ts";
import {
  A2ADeliveryTransport,
  A2ADeliveryTransportError,
  type AgentDeliveryInput,
  deliveryMessageId,
} from "./DeliveryTransport.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { A2ALifecycleService, manualLayer as lifecycleLayer } from "./LifecycleService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerDirectory, layer as peerDirectoryLayer } from "./PeerDirectory.ts";
import {
  PeerInboundService,
  layer as peerInboundLayer,
  type PeerInboundServiceShape,
} from "./PeerInboundService.ts";
import { PeerPoller, manualLayer as peerPollerLayer, type PeerPollOutcome } from "./PeerPoller.ts";
import { PeerRegistryService, layer as peerRegistryLayer } from "./PeerRegistryService.ts";
import { PeerRemovalService, layer as peerRemovalLayer } from "./PeerRemovalService.ts";
import {
  PEER_POLL_HOLD,
  PeerStoreService,
  layer as peerStoreLayer,
  type PeerStoreServiceShape,
} from "./PeerStoreService.ts";
import { RosterService } from "./RosterService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import { A2ASilenceDetector, manualLayer as silenceDetectorLayer } from "./SilenceDetector.ts";
import {
  CommCommandId,
  ExchangeId,
  ParticipantId,
  LedgerProjectId,
  type AgentParticipant,
} from "./contracts.ts";

/**
 * Poll mode end to end: a reachable work VM, and a laptop behind a firewall that opens every
 * connection. The laptop sends directly; the VM stores what it has for the laptop until it polls.
 * Both run their real ledger, send, inbound and worker; the laptop's poller calls the VM's real
 * store service in place of HTTP.
 */

const timestamp = "2026-10-02T12:00:00.000Z";
const vmOrigin = "https://vm.example:3773";

interface Server {
  readonly environmentId: string;
  readonly label: string;
  readonly projectId: LedgerProjectId;
  readonly agent: AgentParticipant;
}

const vm: Server = {
  environmentId: "environment-vm",
  label: "Work VM",
  projectId: LedgerProjectId.make("project:vm-billing"),
  agent: {
    kind: "agent",
    id: ParticipantId.make("agent:j5:a2a:thread:billing"),
    threadId: ThreadId.make("thread:billing"),
  },
};
const laptop: Server = {
  environmentId: "environment-laptop",
  label: "JM-LT-04213",
  projectId: LedgerProjectId.make("project:laptop-ios"),
  agent: {
    kind: "agent",
    id: ParticipantId.make("agent:j5:a2a:thread:ios-build"),
    threadId: ThreadId.make("thread:ios-build"),
  },
};

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const descriptorOf = (server: Server) =>
  decodeDescriptor({
    environmentId: server.environmentId,
    label: server.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: {},
  });
const vmDescriptor = descriptorOf(vm);
const laptopDescriptor = descriptorOf(laptop);
const decodePollRequest = Schema.decodeUnknownSync(Schema.fromJsonString(PeerPollRequest));
const encodePollResponse = Schema.encodeSync(Schema.fromJsonString(PeerPollResponse));

const identityOf = (server: Server, descriptor: typeof vmDescriptor) =>
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make(server.environmentId)),
    getDescriptor: Effect.succeed(descriptor),
  });

/** The laptop holds the credential the VM issued it; the VM issued nothing the laptop presents back. */
const authHolding = (subjects: ReadonlyArray<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    listSessions: () =>
      Effect.succeed(
        subjects.map((subject) => ({
          sessionId: AuthSessionId.make(`auth-session:${subject}`),
          subject,
          scopes: [AuthA2APeerScope],
          method: "bearer-access-token" as const,
          client: { deviceType: "bot" as const },
          issuedAt: DateTime.makeUnsafe(timestamp),
          expiresAt: DateTime.makeUnsafe("2036-10-02T12:00:00.000Z"),
          lastConnectedAt: null,
          connected: false,
          current: false,
        })),
      ),
  });

/** No thread is renamed in these scenarios; roster changes come from the ledger. */
const noThreadEvents = Layer.mock(EventSinkV2)({
  latestSequence: () => Effect.succeed(0),
  stream: () => Stream.never,
});

const noHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("this server never calls out")),
);

const pollRoundTripRunId = (thread: ThreadId) => RunId.make(`run:poll-roundtrip:${thread}`);

// Archiving and silence run the real lifecycle service and silence detector;
// the scenarios hand them thread events directly, so the stream stays empty.
const threadsFor = (delivered: Ref.Ref<Array<AgentDeliveryInput>>) =>
  Layer.mock(ThreadManagementService)({
    streamStoredEventsFrom: () => Stream.never,
    getThreadProjection: () =>
      Effect.succeed({ runs: [], turnItems: [] } as unknown as OrchestrationV2ThreadProjection),
    // Every message delivered to an agent on this server belongs to its thread's one run (`runEnded`).
    getThreadRecords: ((threadId: ThreadId) =>
      Ref.get(delivered).pipe(
        Effect.map((rows) => ({
          runs: [{ id: pollRoundTripRunId(threadId) }],
          messages: rows.map((row) => ({
            id: deliveryMessageId(row.messageId),
            runId: pollRoundTripRunId(threadId),
          })),
        })),
      )) as never,
  });

/** Every server's ledger, send, inbound, worker, lifecycle and silence detector, over its own database. */
const makeCore = <DirectoryError, DirectoryContext>(input: {
  readonly database: ReturnType<typeof NodeSqliteClient.layer>;
  readonly transport: Layer.Layer<A2ADeliveryTransport>;
  /** What this server's transport delivered to its agents, which its threads hold. */
  readonly delivered: Ref.Ref<Array<AgentDeliveryInput>>;
  readonly directory: Layer.Layer<PeerDirectory, DirectoryError, DirectoryContext>;
}) => {
  const database = input.database;
  const threads = threadsFor(input.delivered);
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(input.transport),
  );
  const send = sendLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(input.directory),
  );
  const inbound = peerInboundLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const lifecycle = lifecycleLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(worker),
    Layer.provide(database),
    Layer.provide(threads),
  );
  const silence = silenceDetectorLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(threads),
    Layer.provide(Layer.mock(EventSinkV2)({})),
    Layer.provide(crewInstanceLayer.pipe(Layer.provide(database))),
    Layer.provide(worker),
  );
  return { database, ledger, worker, send, inbound, lifecycle, silence };
};

const recordingTransport = (
  delivered: Ref.Ref<Array<AgentDeliveryInput>>,
  deliverPeer: A2ADeliveryTransport["Service"]["deliverPeer"],
) =>
  Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverAgent: (input) => Ref.update(delivered, (rows) => [...rows, input]),
      deliverHuman: () => Effect.void,
      deliverPeer,
    }),
  );

interface VmOptions {
  readonly removing?: Effect.Effect<void>;
  /** A database file instead of memory, so a test can read it from a second connection. */
  readonly filename?: string;
}

/**
 * The VM: it stores the laptop's messages and reads the laptop's agents from
 * its snapshot. `removing` runs inside a removal's transaction, just before the
 * peer record goes, so a test can send traffic while the removal holds it.
 */
const makeVm = (delivered: Ref.Ref<Array<AgentDeliveryInput>>, options: VmOptions = {}) => {
  const database = NodeSqliteClient.layer({ filename: options.filename ?? ":memory:" });
  const registry = peerRegistryLayer.pipe(
    Layer.provide(database),
    Layer.provide(noHttp),
    Layer.provide(identityOf(vm, vmDescriptor)),
    Layer.provide(authHolding([`peer:${laptop.environmentId}`])),
  );
  const directory = peerDirectoryLayer.pipe(Layer.provide(registry), Layer.provide(noHttp));
  const core = makeCore({
    database,
    delivered,
    transport: recordingTransport(delivered, () =>
      Effect.die("the VM never sends to the laptop; it stores for it"),
    ),
    directory,
  });
  const store = peerStoreLayer.pipe(
    Layer.provide(core.worker),
    Layer.provide(registry),
    Layer.provide(core.ledger),
  );
  const removingRegistry = Layer.effect(
    PeerRegistryService,
    Effect.map(PeerRegistryService, (peers) =>
      PeerRegistryService.of({
        ...peers,
        remove: (environmentId) =>
          (options.removing ?? Effect.void).pipe(Effect.andThen(peers.remove(environmentId))),
      }),
    ),
  ).pipe(Layer.provide(registry));
  const removal = peerRemovalLayer.pipe(
    Layer.provide(removingRegistry),
    Layer.provide(core.ledger),
    Layer.provide(core.worker),
    Layer.provide(core.database),
  );
  return Layer.mergeAll(
    core.database,
    core.ledger,
    core.worker,
    core.send,
    core.inbound,
    core.lifecycle,
    core.silence,
    store,
    directory,
    removal,
  );
};

/** The laptop: it sends to the VM directly and polls the VM for what the VM stores for it. */
const makeLaptop = (input: {
  readonly delivered: Ref.Ref<Array<AgentDeliveryInput>>;
  readonly vmDoor: Ref.Ref<PeerInboundServiceShape | null>;
  readonly vmStore: Ref.Ref<PeerStoreServiceShape | null>;
  readonly roster: Ref.Ref<ReadonlyArray<A2ARosterEntry>>;
}) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  // The poll is handed to the VM's store service as its HTTP route would hand
  // it; a roster read gets the VM's agents and name.
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.url === `${vmOrigin}${J5_PEER_API_PATHS.roster}`) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { agents: [vmRosterAgent], label: vm.label } satisfies PeerRosterResponse,
              { headers: { "x-j5-peer-protocol": "2" } },
            ),
          );
        }
        assert.equal(request.url, `${vmOrigin}${J5_PEER_API_PATHS.poll}`);
        const store = yield* Ref.get(input.vmStore);
        if (store === null) return yield* Effect.die("the VM is not up");
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        // As the route answers: the status and headers at once, the body when the hold ends.
        const held = yield* store
          .startPoll({
            environmentId: laptop.environmentId,
            request: decodePollRequest(body),
            protocolVersion: 1,
          })
          .pipe(Effect.orDie);
        const answer = yield* Stream.fromEffect(
          held.pipe(Effect.map(encodePollResponse), Effect.orDie),
        ).pipe(Stream.encodeText, Stream.toReadableStreamEffect());
        return HttpClientResponse.fromWeb(
          request,
          new Response(answer, {
            status: 200,
            headers: { "content-type": "application/json", "x-j5-peer-protocol": "2" },
          }),
        );
      }),
    ),
  );
  const registry = peerRegistryLayer.pipe(
    Layer.provide(database),
    Layer.provide(http),
    Layer.provide(identityOf(laptop, laptopDescriptor)),
    Layer.provide(authHolding([])),
  );
  const directory = peerDirectoryLayer.pipe(Layer.provide(registry), Layer.provide(http));
  const core = makeCore({
    database,
    delivered: input.delivered,
    transport: recordingTransport(input.delivered, (delivery) =>
      Effect.gen(function* () {
        const door = yield* Ref.get(input.vmDoor);
        if (door === null) return yield* Effect.die("the VM is not up");
        yield* door
          .receive({ ...delivery.body, originEnvironmentId: laptop.environmentId })
          .pipe(
            Effect.mapError(
              (cause) => new A2ADeliveryTransportError({ operation: "deliver to peer", cause }),
            ),
          );
      }),
    ),
    // The real directory: the laptop polls the VM, so it reads the VM's roster
    // live though the VM issued it no session to hold here.
    directory,
  });
  const roster = Layer.mock(RosterService)({ list: () => Ref.get(input.roster) });
  const poller = peerPollerLayer.pipe(
    Layer.provide(registry),
    Layer.provide(core.inbound),
    Layer.provide(core.worker),
    Layer.provide(roster),
    Layer.provide(core.ledger),
    Layer.provide(noThreadEvents),
    Layer.provide(http),
  );
  return Layer.mergeAll(
    core.database,
    core.ledger,
    core.worker,
    core.send,
    core.inbound,
    core.lifecycle,
    core.silence,
    poller,
  );
};

const vmRosterAgent: PeerRosterAgent = {
  projectId: vm.projectId,
  projectTitle: "Billing Migration",
  participantId: vm.agent.id,
  threadId: vm.agent.threadId,
  displayName: "Billing agent",
  archived: false,
  canReceiveMessage: true,
};

const laptopRosterEntry = (archived: boolean): A2ARosterEntry => ({
  participantId: laptop.agent.id,
  kind: "agent",
  projectId: laptop.projectId,
  projectTitle: "iOS",
  displayName: "iOS build",
  threadId: laptop.agent.threadId,
  archived,
  canReceiveMessage: !archived,
  acceptsUrgency: false,
  liveness: null,
});

const seed = Effect.fn("test.j5.a2a.peer.pollRoundTrip.seed")(function* (self: Server) {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  yield* ledger.ensureProject({ projectId: self.projectId, createdAt: timestamp });
  yield* ledger.append({
    commandId: CommCommandId.make(`command:poll-roundtrip:join:${self.agent.id}`),
    projectId: self.projectId,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: self.agent.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: self.agent },
      createdAt: timestamp,
    },
  });
  return {
    send: yield* A2ASendService,
    inbound: yield* PeerInboundService,
    worker: yield* A2ADeliveryWorker,
    lifecycle: yield* A2ALifecycleService,
    silence: yield* A2ASilenceDetector,
    sql: yield* SqlClient.SqlClient,
  };
});

/** The VM and the laptop up and peered in poll mode, the laptop's roster already sent once. */
const pollPair = Effect.fn("test.j5.a2a.peer.pollRoundTrip.pair")(function* (
  options: VmOptions = {},
) {
  const vmDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
  const vmStoreRef = yield* Ref.make<PeerStoreServiceShape | null>(null);
  const vmDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
  const laptopDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
  const roster = yield* Ref.make<ReadonlyArray<A2ARosterEntry>>([laptopRosterEntry(false)]);

  const vmContext = yield* Layer.build(makeVm(vmDelivered, options));
  const laptopContext = yield* Layer.build(
    makeLaptop({ delivered: laptopDelivered, vmDoor, vmStore: vmStoreRef, roster }),
  );
  const vmServer = yield* seed(vm).pipe(Effect.provide(vmContext));
  const laptopServer = yield* seed(laptop).pipe(Effect.provide(laptopContext));
  // The VM recorded the laptop when it first presented its store credential; the laptop records the VM to poll.
  yield* vmServer.sql`
    INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
    VALUES (${laptop.environmentId}, ${laptop.environmentId}, 'store', ${timestamp}, ${timestamp})
  `;
  yield* laptopServer.sql`
    INSERT INTO j5_a2a_peer (environment_id, label, link_mode, origin, credential, created_at, updated_at)
    VALUES (${vm.environmentId}, ${vm.environmentId}, 'poll', ${vmOrigin}, 'vm-issued', ${timestamp}, ${timestamp})
  `;
  yield* Ref.set(vmDoor, vmServer.inbound);
  yield* Ref.set(vmStoreRef, yield* PeerStoreService.pipe(Effect.provide(vmContext)));
  const poller = yield* PeerPoller.pipe(Effect.provide(laptopContext));

  /** One laptop poll, answered now, or when the VM's hold ends with nothing waiting. */
  const poll = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(poller.pollOnce(vm.environmentId));
    yield* TestClock.adjust(PEER_POLL_HOLD);
    return yield* Fiber.join(fiber);
  });
  // The first poll carries the laptop's roster, so the VM can address its agents.
  assert.deepStrictEqual(yield* poll, { kind: "polled", received: 0, more: false });

  const vmDirectory = yield* PeerDirectory.pipe(Effect.provide(vmContext));
  const vmRemoval = yield* PeerRemovalService.pipe(Effect.provide(vmContext));
  return {
    vmContext,
    vmServer,
    laptopServer,
    vmDelivered,
    laptopDelivered,
    roster,
    poll,
    vmDirectory,
    vmRemoval,
  };
});

const exchangeStatus = (sql: SqlClient.SqlClient, exchangeId: string) =>
  sql<{ readonly status: string }>`
    SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}
  `.pipe(Effect.map((rows) => rows[0]?.status));

const deliveryStatus = (sql: SqlClient.SqlClient, messageId: string) =>
  sql<{ readonly status: string; readonly last_error: string | null }>`
    SELECT status, last_error FROM j5_a2a_delivery WHERE message_id = ${messageId}
  `.pipe(Effect.map((rows) => rows[0]));

/** The VM asks the laptop's agent, and the laptop polls and acknowledges it. */
const vmAsksLaptop = Effect.fn("test.j5.a2a.peer.pollRoundTrip.vmAsks")(function* (
  pair: Effect.Success<ReturnType<typeof pollPair>>,
  commandId: string,
) {
  const asked = yield* pair.vmServer.send.send({
    commandId: CommCommandId.make(commandId),
    senderThreadId: vm.agent.threadId,
    to: laptop.agent.id,
    message: "Build the iOS target.",
    expectReply: true,
    intent: "ios build",
    acceptedAt: timestamp,
  });
  assert.equal(asked.receiverServer, laptop.label, "the snapshot named the laptop");
  assert.isNull(yield* pair.vmServer.worker.runOnce, "the VM stores it rather than sending it");
  const handed: PeerPollOutcome = yield* pair.poll;
  assert.deepStrictEqual(handed, { kind: "polled", received: 1, more: false });
  assert.equal((yield* pair.laptopServer.worker.runOnce)?.state, "delivered");
  // The next poll acknowledges it.
  yield* pair.poll;
  assert.equal((yield* deliveryStatus(pair.vmServer.sql, asked.messageId))?.status, "delivered");
  return ExchangeId.make(asked.exchangeId!);
});

/** An ask from the laptop's agent to the VM's, as the VM's deliver route records it. */
const laptopAsk = (name: string) => ({
  messageId: `message:laptop:${name}`,
  senderId: laptop.agent.id,
  receiverId: vm.agent.id,
  exchangeId: `exchange:laptop:${name}`,
  correlationId: `correlation:laptop:${name}`,
  exchangeRole: "ask" as const,
  intent: `${name} intent`,
  envelopeChannel: "peer" as const,
  text: `${name} ask`,
  originProjectId: laptop.projectId,
  createdAt: timestamp,
  originEnvironmentId: laptop.environmentId,
});

it.effect(
  "wipes what was recorded for the laptop before the VM removed it, refuses what arrived during, and shows none of it until the removal commits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The removal holds one write while traffic arrives: a second, independent
        // connection sees none of it committed until it all is, and the inbound record
        // and the local send are refused by the peer-record checks in their own writes.
        const inside = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const filename = NodePath.join(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-peer-removal-")),
          "vm.sqlite",
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            NodeFS.rmSync(NodePath.dirname(filename), { recursive: true, force: true }),
          ),
        );
        // What a second connection sees while the removal holds its write: only
        // what is committed. The removal has written its drops and cancels by now.
        let committedMidRemoval: { exchange?: unknown; message?: unknown } = {};
        let waitingMessageId = "";
        const readCommitted = () => {
          const reader = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
          try {
            return {
              exchange: (
                reader
                  .prepare("SELECT status FROM j5_a2a_exchange WHERE exchange_id = ?")
                  .get("exchange:laptop:before") as { status?: string } | undefined
              )?.status,
              message: (
                reader
                  .prepare("SELECT status FROM j5_a2a_delivery WHERE message_id = ?")
                  .get(waitingMessageId) as { status?: string } | undefined
              )?.status,
            };
          } finally {
            reader.close();
          }
        };
        const pair = yield* pollPair({
          filename,
          removing: Effect.sync(() => {
            committedMidRemoval = readCommitted();
          }).pipe(
            Effect.andThen(Deferred.succeed(inside, undefined)),
            Effect.andThen(Deferred.await(proceed)),
          ),
        });
        const { vmServer } = pair;
        // As the server runs it, so a reader sees the last commit while a write is open.
        yield* vmServer.sql`PRAGMA journal_mode = WAL`;
        const sendToLaptop = (name: string) =>
          vmServer.send.send({
            commandId: CommCommandId.make(`command:poll-roundtrip:removal:${name}`),
            senderThreadId: vm.agent.threadId,
            to: laptop.agent.id,
            message: `${name} message`,
            acceptedAt: timestamp,
          });

        // Before: the laptop's agent has asked the VM's, and a message waits for the laptop.
        yield* vmServer.inbound.receive(laptopAsk("before"));
        const waiting = yield* sendToLaptop("before");
        waitingMessageId = waiting.messageId;

        // The removal holds its transaction while the same traffic arrives again.
        const removal = yield* Effect.forkChild(pair.vmRemoval.remove(laptop.environmentId));
        yield* Deferred.await(inside);
        const inbound = yield* Effect.forkChild(
          Effect.flip(vmServer.inbound.receive(laptopAsk("during"))),
        );
        const send = yield* Effect.forkChild(Effect.flip(sendToLaptop("during")));
        yield* Deferred.succeed(proceed, undefined);

        assert.deepStrictEqual(yield* Fiber.join(removal), {
          removed: true,
          cancelledMessages: 1,
          droppedExchanges: 1,
        });
        assert.deepStrictEqual(
          committedMidRemoval,
          { exchange: "open", message: "pending" },
          "nothing of the removal was committed before all of it",
        );
        assert.equal((yield* Fiber.join(inbound))._tag, "A2APeerNotRecordedError");
        assert.equal((yield* Fiber.join(send))._tag, "A2AParticipantNotFoundError");
        assert.equal(yield* exchangeStatus(vmServer.sql, "exchange:laptop:before"), "dropped");
        assert.equal((yield* deliveryStatus(vmServer.sql, waiting.messageId))?.status, "cancelled");
        assert.isUndefined(
          yield* exchangeStatus(vmServer.sql, "exchange:laptop:during"),
          "nothing from during the removal was recorded",
        );
        const left = yield* vmServer.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_delivery
          WHERE receiver_environment_id = ${laptop.environmentId}
            AND status IN ('pending', 'retry_scheduled', 'alarmed')
        `;
        assert.equal(Number(left[0]?.count), 0, "nothing waits for the laptop");
      }),
    ),
);

it.effect("rolls a removal that fails back whole, publishing nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The last step of the removal fails, after the drops and cancels were written.
      const pair = yield* pollPair({ removing: Effect.die("the disk is full") });
      const { vmServer } = pair;
      yield* vmServer.inbound.receive(laptopAsk("kept"));
      const waiting = yield* vmServer.send.send({
        commandId: CommCommandId.make("command:poll-roundtrip:rollback:kept"),
        senderThreadId: vm.agent.threadId,
        to: laptop.agent.id,
        message: "kept message",
        acceptedAt: timestamp,
      });
      // Everything committed from here on, up to a marker sent after the failed removal.
      const committed = yield* (yield* A2ALedger.pipe(Effect.provide(pair.vmContext)))
        .subscribeCommitted;
      const published = yield* Effect.forkChild(
        committed.pipe(
          Stream.takeUntil((event) => JSON.stringify(event).includes("rollback marker")),
          Stream.runCollect,
        ),
      );

      const failed = yield* Effect.exit(pair.vmRemoval.remove(laptop.environmentId));
      assert.isTrue(failed._tag === "Failure", "the removal failed");
      assert.equal(yield* exchangeStatus(vmServer.sql, "exchange:laptop:kept"), "open");
      assert.equal((yield* deliveryStatus(vmServer.sql, waiting.messageId))?.status, "pending");
      const peer = yield* vmServer.sql`
        SELECT 1 FROM j5_a2a_peer WHERE environment_id = ${laptop.environmentId}
      `;
      assert.lengthOf(peer, 1, "the peer is still recorded");

      yield* vmServer.send.send({
        commandId: CommCommandId.make("command:poll-roundtrip:rollback:marker"),
        senderThreadId: vm.agent.threadId,
        to: laptop.agent.id,
        message: "rollback marker",
        acceptedAt: timestamp,
      });
      const events = yield* Fiber.join(published);
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        ["message.sent"],
        "only the marker: nothing the rolled-back removal wrote was published",
      );
    }),
  ),
);

it.effect("carries the laptop's ask to the VM directly and polls the VM's reply back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pair = yield* pollPair();
      const { vmServer, laptopServer } = pair;

      // The laptop sends directly; the VM is reachable.
      const asked = yield* laptopServer.send.send({
        commandId: CommCommandId.make("command:poll-roundtrip:laptop-ask"),
        senderThreadId: laptop.agent.threadId,
        to: vm.agent.id,
        message: "Is the billing schema migrated?",
        expectReply: true,
        intent: "schema status",
        acceptedAt: timestamp,
      });
      assert.equal((yield* laptopServer.worker.runOnce)?.state, "delivered");
      assert.equal((yield* vmServer.worker.runOnce)?.state, "delivered");
      const vmTold = (yield* Ref.get(pair.vmDelivered)).at(-1)!;
      assert.equal(vmTold.senderServerName, laptop.label, "the envelope names the laptop");
      const exchangeId = ExchangeId.make(asked.exchangeId!);

      // The VM's reply is stored for the laptop, never sent to it.
      const replied = yield* vmServer.send.send({
        commandId: CommCommandId.make("command:poll-roundtrip:vm-reply"),
        senderThreadId: vm.agent.threadId,
        to: laptop.agent.id,
        message: "Migrated at 09:41.",
        exchangeId,
        acceptedAt: timestamp,
      });
      assert.equal(replied.exchangeState, "closed");
      assert.isNull(yield* vmServer.worker.runOnce);
      assert.equal((yield* deliveryStatus(vmServer.sql, replied.messageId))?.status, "pending");

      // The laptop polls, records the reply, and its Exchange closes too.
      assert.deepStrictEqual(yield* pair.poll, { kind: "polled", received: 1, more: false });
      assert.equal(yield* exchangeStatus(laptopServer.sql, exchangeId), "closed");
      assert.equal((yield* laptopServer.worker.runOnce)?.state, "delivered");
      const told = (yield* Ref.get(pair.laptopDelivered)).at(-1)!;
      assert.equal(told.exchangeRole, "reply");
      assert.equal(told.message, "Migrated at 09:41.");
      assert.equal(told.senderServerName, vm.label);

      // The next poll acknowledges it, so the VM records the reply delivered.
      yield* pair.poll;
      assert.equal((yield* deliveryStatus(vmServer.sql, replied.messageId))?.status, "delivered");
    }),
  ),
);

it.effect("refuses the VM's ask when the laptop archived its receiver before polling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pair = yield* pollPair();
      const { vmServer, laptopServer } = pair;

      const asked = yield* vmServer.send.send({
        commandId: CommCommandId.make("command:poll-roundtrip:refused-ask"),
        senderThreadId: vm.agent.threadId,
        to: laptop.agent.id,
        message: "Build the iOS target.",
        expectReply: true,
        intent: "ios build",
        acceptedAt: timestamp,
      });
      // The laptop archives its agent before it next polls.
      yield* laptopServer.lifecycle.archiveParticipant({
        participantId: laptop.agent.id,
        archivedAt: timestamp,
      });
      yield* Ref.set(pair.roster, [laptopRosterEntry(true)]);

      // The poll hands the ask out; the laptop refuses it and says so in the next poll.
      assert.deepStrictEqual(yield* pair.poll, { kind: "polled", received: 1, more: false });
      assert.isNull(yield* laptopServer.worker.runOnce, "nothing reaches the archived agent");
      yield* pair.poll;
      const refused = yield* deliveryStatus(vmServer.sql, asked.messageId);
      assert.equal(refused?.status, "alarmed");
      assert.include(refused?.last_error ?? "", "policy_refused");
      // The refusal ends the VM's Exchange, and one notice tells the asker why.
      assert.equal(yield* exchangeStatus(vmServer.sql, asked.exchangeId!), "dropped");
      assert.equal((yield* vmServer.worker.runOnce)?.state, "delivered");
      const told = (yield* Ref.get(pair.vmDelivered)).at(-1)!;
      assert.equal(told.receiverId, vm.agent.id);
      assert.include(
        told.message,
        `Your ask "ios build" (message ${asked.messageId}) to ${laptop.agent.id} on ${laptop.label} was not delivered: ${laptop.label} refused it; the recipient is archived or does not accept messages from this sender.`,
      );
      assert.notInclude(
        told.message,
        "policy_refused",
        "the code stays on the record, not the notice",
      );
      assert.include(
        told.message,
        "The exchange is closed; nothing is owed and nothing will answer it.",
      );
      assert.include(told.message, `exchangeId=${asked.exchangeId}`);

      // The roster that poll carried shows the agent archived, so a follow-up is refused at once.
      const listed = yield* pair.vmDirectory.listAgents();
      assert.isTrue(listed.agents[0]!.archived);
      const followUp = yield* Effect.flip(
        vmServer.send.send({
          commandId: CommCommandId.make("command:poll-roundtrip:refused-follow-up"),
          senderThreadId: vm.agent.threadId,
          to: laptop.agent.id,
          message: "Still there?",
          acceptedAt: timestamp,
        }),
      );
      assert.equal(followUp._tag, "A2AParticipantArchivedError");
    }),
  ),
);

it.effect("polls a withdrawal: the laptop's Exchange closes and its agent is not woken", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pair = yield* pollPair();
      const exchangeId = yield* vmAsksLaptop(pair, "command:poll-roundtrip:withdraw:ask");
      const delivered = (yield* Ref.get(pair.laptopDelivered)).length;

      const cleared = yield* pair.vmServer.send.clearOwnAsk({
        commandId: CommCommandId.make("command:poll-roundtrip:withdraw:clear"),
        senderThreadId: vm.agent.threadId,
        exchangeId,
        acceptedAt: timestamp,
      });
      assert.isTrue(cleared.withdrawalQueued);
      assert.deepStrictEqual(yield* pair.poll, { kind: "polled", received: 1, more: false });
      assert.equal(yield* exchangeStatus(pair.laptopServer.sql, exchangeId), "closed");
      assert.isNull(yield* pair.laptopServer.worker.runOnce);
      assert.equal((yield* Ref.get(pair.laptopDelivered)).length, delivered, "nobody is woken");
    }),
  ),
);

it.effect("polls a drop when the VM's asker is archived, and tells the laptop's agent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pair = yield* pollPair();
      const exchangeId = yield* vmAsksLaptop(pair, "command:poll-roundtrip:drop:ask");

      const archived = yield* pair.vmServer.lifecycle.archiveParticipant({
        participantId: vm.agent.id,
        archivedAt: timestamp,
      });
      assert.deepStrictEqual(archived.droppedExchangeIds, [exchangeId]);
      assert.deepStrictEqual(yield* pair.poll, { kind: "polled", received: 1, more: false });
      assert.equal(yield* exchangeStatus(pair.laptopServer.sql, exchangeId), "dropped");
      assert.equal((yield* pair.laptopServer.worker.runOnce)?.state, "delivered");
      const told = (yield* Ref.get(pair.laptopDelivered)).at(-1)!;
      assert.equal(told.envelopeChannel, "lifecycle_notice");
    }),
  ),
);

it.effect("polls a silence notice when the VM's answerer ends its turn without replying", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pair = yield* pollPair();
      const { vmServer, laptopServer } = pair;
      const asked = yield* laptopServer.send.send({
        commandId: CommCommandId.make("command:poll-roundtrip:silence:ask"),
        senderThreadId: laptop.agent.threadId,
        to: vm.agent.id,
        message: "Is the billing schema migrated?",
        expectReply: true,
        intent: "schema status",
        acceptedAt: timestamp,
      });
      assert.equal((yield* laptopServer.worker.runOnce)?.state, "delivered");
      assert.equal((yield* vmServer.worker.runOnce)?.state, "delivered");

      const measured = yield* vmServer.silence.handleStoredEvent(
        runEnded(vm.agent.threadId, "completed"),
      );
      assert.equal(measured.length, 1);
      assert.isNull(yield* vmServer.worker.runOnce, "the notice is stored for the laptop");
      assert.deepStrictEqual(yield* pair.poll, { kind: "polled", received: 1, more: false });
      assert.equal((yield* laptopServer.worker.runOnce)?.state, "delivered");
      const told = (yield* Ref.get(pair.laptopDelivered)).at(-1)!;
      assert.equal(told.envelopeChannel, "silence_notice");
      assert.equal(yield* exchangeStatus(laptopServer.sql, asked.exchangeId!), "open");
    }),
  ),
);

it.effect(
  "keeps a reply for a laptop asleep for hours, unalarmed, and hands it over on waking",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* pollPair();
        const { vmServer, laptopServer } = pair;
        const asked = yield* laptopServer.send.send({
          commandId: CommCommandId.make("command:poll-roundtrip:asleep:ask"),
          senderThreadId: laptop.agent.threadId,
          to: vm.agent.id,
          message: "Build numbers for the release, please.",
          expectReply: true,
          intent: "release build numbers",
          acceptedAt: timestamp,
        });
        assert.equal((yield* laptopServer.worker.runOnce)?.state, "delivered");
        assert.equal((yield* vmServer.worker.runOnce)?.state, "delivered");

        // The laptop's lid closes; the VM replies; hours pass with nobody polling.
        const replied = yield* vmServer.send.send({
          commandId: CommCommandId.make("command:poll-roundtrip:asleep:reply"),
          senderThreadId: vm.agent.threadId,
          to: laptop.agent.id,
          message: "4127 and 4128.",
          exchangeId: ExchangeId.make(asked.exchangeId!),
          acceptedAt: timestamp,
        });
        yield* TestClock.adjust("8 hours");
        assert.isNull(yield* vmServer.worker.runOnce);
        // A message sent now says the laptop is offline, and since when.
        const note = {
          commandId: CommCommandId.make("command:poll-roundtrip:asleep:note"),
          senderThreadId: vm.agent.threadId,
          to: laptop.agent.id,
          message: "The release went out.",
          acceptedAt: timestamp,
        };
        const waiting = yield* vmServer.send.send(note);
        assert.equal(waiting.receiverServer, laptop.label);
        assert.equal(waiting.delivery, "waiting_for_recipient");
        assert.isString(waiting.recipientLastAvailableAt);
        assert.equal(
          waiting.note,
          "Recorded. iOS build is on JM-LT-04213, which is offline, last available 8 h ago; it receives this when JM-LT-04213 is next available.",
        );
        assert.deepStrictEqual(yield* vmServer.worker.listAlarms, [], "waiting is not a failure");
        assert.equal((yield* deliveryStatus(vmServer.sql, replied.messageId))?.status, "pending");

        // The laptop wakes and polls; the reply and the later message are handed over in order.
        assert.deepStrictEqual(yield* pair.poll, { kind: "polled", received: 2, more: false });
        assert.equal(yield* exchangeStatus(laptopServer.sql, asked.exchangeId!), "closed");
        assert.equal((yield* laptopServer.worker.runOnce)?.state, "delivered");

        // The next poll acknowledges both, and the laptop sleeps again. Retrying a
        // send that was delivered, or that ended otherwise, says nothing of waiting.
        yield* pair.poll;
        assert.equal((yield* deliveryStatus(vmServer.sql, waiting.messageId))?.status, "delivered");
        const ended = {
          ...note,
          commandId: CommCommandId.make("command:poll-roundtrip:asleep:ended"),
          message: "Ignore the last one.",
        };
        const endedSend = yield* vmServer.send.send(ended);
        yield* vmServer.sql`
          UPDATE j5_a2a_delivery SET status = 'cancelled' WHERE message_id = ${endedSend.messageId}
        `;
        yield* TestClock.adjust("8 hours");
        for (const retry of [note, ended]) {
          const retried = yield* vmServer.send.send(retry);
          assert.equal(retried.receiverServer, laptop.label, retry.commandId);
          assert.isUndefined(retried.delivery, retry.commandId);
          assert.isUndefined(retried.note, retry.commandId);
        }
      }),
    ),
);

/** The stored event for a run that ended on `thread`, as the silence detector reads it. */
const runEnded = (thread: ThreadId, status: "completed" | "failed"): OrchestrationV2StoredEvent => {
  const runId = pollRoundTripRunId(thread);
  const at = DateTime.makeUnsafe("2026-10-02T12:00:03.000Z");
  return {
    sequence: 100,
    commandId: null,
    event: {
      id: EventId.make(`event:poll-roundtrip:${thread}:${status}`),
      type: "run.updated",
      threadId: thread,
      runId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt: at,
      payload: {
        id: runId,
        threadId: thread,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:poll-roundtrip:${thread}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
        startedAt: DateTime.makeUnsafe("2026-10-02T12:00:01.000Z"),
        completedAt: at,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  } as OrchestrationV2StoredEvent;
};
