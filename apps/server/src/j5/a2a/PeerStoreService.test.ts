import {
  AuthA2APeerScope,
  AuthSessionId,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ThreadId,
} from "@t3tools/contracts";
import { PeerDeliveryRequest, type PeerPollAck, type PeerPollRequest } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { A2ADeliveryTransport, type A2ADeliveryTransportShape } from "./DeliveryTransport.ts";
import {
  A2ADeliveryWorker,
  PEER_POLL_BATCH_BYTES,
  layer as deliveryWorkerDaemonLayer,
  manualLayer as deliveryWorkerLayer,
} from "./DeliveryWorker.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerDirectory, layer as peerDirectoryLayer } from "./PeerDirectory.ts";
import { layer as peerRegistryLayer } from "./PeerRegistryService.ts";
import { PEER_POLL_HOLD, PeerStoreService, layer as peerStoreLayer } from "./PeerStoreService.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  LedgerProjectId,
  type AgentParticipant,
} from "./contracts.ts";

/**
 * The storing side of poll mode on one server: the work VM keeps messages for
 * a laptop that polls it. The ledger, worker, registry and directory are real;
 * the transport must never be called, because nothing is sent to a poller.
 */

const timestamp = "2026-10-02T12:00:00.000Z";
const laptop = "environment-laptop";
const vmProject = LedgerProjectId.make("project:work-billing");
const billing: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:billing"),
  threadId: ThreadId.make("thread:billing"),
};
const iosBuild = ParticipantId.make("agent:j5:a2a:thread:ios-build");
const laptopProject = LedgerProjectId.make("project:laptop-ios");

const workDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
  environmentId: "environment-work",
  label: "Work VM",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: {},
});

const encodeDelivery = Schema.encodeSync(Schema.fromJsonString(PeerDeliveryRequest));

const noHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("nothing here calls a polling peer")),
);

/**
 * `delivering` runs the worker as the server does, as a daemon that delivers
 * to agents here, so a test can wait for a notice's receipt.
 */
const makeTestLayer = (
  options: {
    readonly delivering?: boolean;
    /** Stands in for a local delivery, so a test can hold one mid-attempt. */
    readonly deliverAgent?: A2ADeliveryTransportShape["deliverAgent"];
  } = {},
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverAgent:
        options.deliverAgent ??
        (() =>
          options.delivering === true
            ? Effect.void
            : Effect.die("nothing is delivered locally here")),
      deliverHuman: () => Effect.die("nothing is delivered to a person here"),
      deliverPeer: () => Effect.die("a polling peer is never sent to"),
    }),
  );
  const worker = (
    options.delivering === true ? deliveryWorkerDaemonLayer : deliveryWorkerLayer
  ).pipe(Layer.provide(ledger), Layer.provide(database), Layer.provide(transport));
  const registry = peerRegistryLayer.pipe(
    Layer.provide(database),
    Layer.provide(noHttp),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-work")),
        getDescriptor: Effect.succeed(workDescriptor),
      }),
    ),
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        // The laptop holds the credential this server issued it.
        listSessions: () =>
          Effect.succeed([
            {
              sessionId: AuthSessionId.make("auth-session:laptop"),
              subject: `peer:${laptop}`,
              scopes: [AuthA2APeerScope],
              method: "bearer-access-token" as const,
              client: { deviceType: "bot" as const },
              issuedAt: DateTime.makeUnsafe(timestamp),
              expiresAt: DateTime.makeUnsafe("2036-10-02T12:00:00.000Z"),
              lastConnectedAt: null,
              connected: false,
              current: false,
            },
          ]),
      }),
    ),
  );
  const store = peerStoreLayer.pipe(
    Layer.provide(worker),
    Layer.provide(registry),
    Layer.provide(ledger),
  );
  const directory = peerDirectoryLayer.pipe(Layer.provide(registry), Layer.provide(noHttp));
  return Layer.mergeAll(database, ledger, worker, store, directory);
};

/** The VM, with the laptop recorded as a peer that polls it. */
const seed = Effect.fn("test.j5.a2a.peer.store.seed")(function* () {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  const sql = yield* SqlClient.SqlClient;
  yield* ledger.ensureProject({ projectId: vmProject, createdAt: timestamp });
  yield* ledger.append({
    commandId: CommCommandId.make("command:peer-store:join"),
    projectId: vmProject,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: billing.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: billing },
      createdAt: timestamp,
    },
  });
  yield* sql`
    INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
    VALUES (${laptop}, ${laptop}, 'store', ${timestamp}, ${timestamp})
  `;
});

/** Billing, on the VM, sends the laptop's iOS agent a message, which is stored for the laptop. */
const store = (
  name: string,
  options: { readonly ask?: boolean; readonly environmentId?: string } = {},
) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const exchangeId = options.ask === true ? ExchangeId.make(`exchange:${name}`) : null;
    const correlationId = CorrelationId.make(`correlation:${name}`);
    yield* ledger.appendEvents({
      commandId: CommCommandId.make(`command:peer-store:${name}`),
      projectId: vmProject,
      acceptedAt: timestamp,
      events: [
        ...(exchangeId === null
          ? []
          : [
              {
                kind: "exchange.opened" as const,
                sender: billing.id,
                receiver: iosBuild,
                exchangeId,
                correlationId,
                payload: { intent: `${name} intent`, urgency: null },
                createdAt: timestamp,
              },
            ]),
        {
          kind: "message.sent",
          sender: billing.id,
          receiver: iosBuild,
          exchangeId,
          correlationId,
          payload: {
            messageId: LedgerMessageId.make(`message:${name}`),
            text: `${name} text`,
            originProjectId: vmProject,
            receiverProjectId: laptopProject,
            receiverEnvironmentId: options.environmentId ?? laptop,
            exchangeRole: exchangeId === null ? "none" : "ask",
            envelopeChannel: "peer",
          },
          createdAt: timestamp,
        },
      ],
    });
    return LedgerMessageId.make(`message:${name}`);
  });

/** Billing is archived here, as the lifecycle records it, and its waiting work is withdrawn. */
const archiveBilling = Effect.gen(function* () {
  const ledger = yield* A2ALedger;
  yield* ledger.append({
    commandId: CommCommandId.make("command:peer-store:archive-billing"),
    projectId: vmProject,
    acceptedAt: timestamp,
    event: {
      kind: "participant.archived",
      sender: null,
      receiver: billing.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: billing },
      createdAt: timestamp,
    },
  });
  const sql = yield* SqlClient.SqlClient;
  const membership = yield* sql<{ readonly archived_at: string | null }>`
    SELECT archived_at FROM j5_a2a_membership WHERE participant_id = ${billing.id}
  `;
  assert.isNotNull(
    membership[0]?.archived_at ?? null,
    "billing is archived before anything is acked",
  );
  yield* (yield* A2ADeliveryWorker).cancelParticipantDeliveries(billing.id);
});

const pollHeld = (request: Partial<PeerPollRequest> = {}) =>
  Effect.flatMap(PeerStoreService, (service) =>
    service.poll({
      environmentId: laptop,
      protocolVersion: 1,
      request: { acks: [], rosterHash: "hash-empty", ...request },
    }),
  );

/** A poll that answers now, or at the end of its hold when nothing is waiting. */
const poll = (request: Partial<PeerPollRequest> = {}) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(pollHeld(request));
    yield* TestClock.adjust(PEER_POLL_HOLD);
    return yield* Fiber.join(fiber);
  });

const statusOf = (messageId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly status: string;
      readonly handed_out_at: string | null;
      readonly last_error: string | null;
    }>`
      SELECT status, handed_out_at, last_error FROM j5_a2a_delivery WHERE message_id = ${messageId}
    `,
  ).pipe(Effect.map((rows) => rows[0]));

const received = (messageId: string): PeerPollAck => ({
  messageId,
  outcome: "received",
  receivedSeq: 1,
  replay: false,
});

it.effect("never attempts, retries or alarms a message stored for a polling peer", () =>
  Effect.gen(function* () {
    yield* seed();
    const first = yield* store("first");
    const worker = yield* A2ADeliveryWorker;
    assert.isNull(yield* worker.runOnce, "the worker leaves a stored row alone");
    yield* TestClock.adjust("1 hour");
    assert.isNull(yield* worker.runOnce);
    assert.deepStrictEqual(yield* statusOf(first), {
      status: "pending",
      handed_out_at: null,
      last_error: null,
    });
    assert.deepStrictEqual(yield* worker.listAlarms, []);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "hands stored messages out oldest first, and hands out again whatever is not acknowledged",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const first = yield* store("first", { ask: true });
      const second = yield* store("second");

      const handed = yield* poll();
      assert.deepStrictEqual(
        handed.deliveries.map((delivery) => delivery.messageId),
        [first, second],
      );
      assert.isFalse(handed.more);
      assert.equal(handed.label, "Work VM", "the poller learns the storing server's name");
      assert.deepStrictEqual(handed.capabilities, { poll: true, landing: true });
      // The body is exactly what a direct send would carry, intent included.
      assert.equal(handed.deliveries[0]!.intent, "first intent");
      assert.equal(handed.deliveries[0]!.exchangeRole, "ask");
      assert.equal(handed.deliveries[0]!.originProjectId, vmProject);
      const stamped = (yield* statusOf(first))!.handed_out_at;
      assert.isNotNull(stamped);

      // The response was lost: the next poll, with no acks, hands out both again.
      const again = yield* poll();
      assert.deepStrictEqual(
        again.deliveries.map((delivery) => delivery.messageId),
        [first, second],
      );
      assert.equal((yield* statusOf(first))!.handed_out_at, stamped, "the first hand-out is kept");
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("records a receipt as delivered and a refusal as a permanent failure", () =>
  Effect.gen(function* () {
    yield* seed();
    const first = yield* store("first");
    const second = yield* store("second");
    yield* poll();

    const next = yield* poll({
      acks: [
        received(first),
        {
          messageId: second,
          outcome: "refused",
          code: "policy_refused",
          message: "agent:j5:a2a:thread:ios-build is archived",
        },
        // An ack for a row this peer was never handed records nothing.
        received("message:unknown"),
      ],
    });
    assert.deepStrictEqual(next.deliveries, [], "nothing is waiting once both are decided");
    assert.equal((yield* statusOf(first))!.status, "delivered");
    const refused = (yield* statusOf(second))!;
    assert.equal(refused.status, "alarmed");
    assert.equal(refused.last_error, "policy_refused: agent:j5:a2a:thread:ios-build is archived");
    const sql = yield* SqlClient.SqlClient;
    const facts = yield* sql<{ readonly kind: string }>`
      SELECT kind FROM j5_a2a_comm_event
      WHERE kind IN ('message.delivered', 'message.delivery_failed')
      ORDER BY seq
    `;
    assert.deepStrictEqual(
      facts.map((fact) => fact.kind),
      ["message.delivered", "message.delivery_failed"],
    );

    // A repeated ack, after a lost response, records nothing twice.
    yield* poll({ acks: [received(first)] });
    const delivered = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE kind = 'message.delivered'
    `;
    assert.deepStrictEqual(delivered, [{ count: 1 }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("cancels a stored message its sender withdrew, but leaves one the peer was handed", () =>
  Effect.gen(function* () {
    yield* seed();
    const handedOut = yield* store("handed");
    yield* poll();
    const waiting = yield* store("waiting");

    yield* archiveBilling;
    assert.equal((yield* statusOf(waiting))!.status, "cancelled", "the peer never saw it");
    assert.equal(
      (yield* statusOf(handedOut))!.status,
      "pending",
      "the peer may already hold it, so only its ack decides it",
    );

    // The answer to the first poll was lost, so the peer is handed it again.
    assert.deepStrictEqual(
      (yield* poll()).deliveries.map((delivery) => delivery.messageId),
      [handedOut],
      "handed out again after the archive",
    );

    // The ack still lands: the sender retired after the hand-out cannot take it back.
    yield* poll({ acks: [received(handedOut)] });
    assert.equal((yield* statusOf(handedOut))!.status, "delivered");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "holds an empty poll until a message is recorded, and answers empty when the hold ends",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
        VALUES ('environment-home', 'Home', 'store', ${timestamp}, ${timestamp})
      `;

      const held = yield* Effect.forkChild(pollHeld());
      yield* Effect.yieldNow;
      // A message for another peer that polls is not this poll's business.
      yield* store("for-home", { environmentId: "environment-home" });
      yield* Effect.yieldNow;
      assert.isUndefined(held.pollUnsafe(), "the laptop's poll stays held");
      const arriving = yield* store("arriving");
      const woken = yield* Fiber.join(held);
      assert.deepStrictEqual(
        woken.deliveries.map((delivery) => delivery.messageId),
        [arriving],
        "committing a message for this peer answers its held poll",
      );

      const idle = yield* Effect.forkChild(pollHeld({ acks: [received(arriving)] }));
      yield* TestClock.adjust(PEER_POLL_HOLD);
      const empty = yield* Fiber.join(idle);
      assert.deepStrictEqual(empty.deliveries, []);
      assert.isFalse(empty.more);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "reads a polling peer's agents from its snapshot, and reports it unread before its first",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const directory = yield* PeerDirectory;
      const before = yield* directory.listAgents();
      assert.deepStrictEqual(before.agents, []);
      assert.deepStrictEqual(
        before.unreadPeers.map((peer) => peer.reason),
        [`${laptop} has not polled yet`],
      );

      const snapshot = [
        {
          participantId: iosBuild,
          projectId: laptopProject,
          projectTitle: "iOS",
          threadId: ThreadId.make("thread:ios-build"),
          displayName: "iOS build",
          archived: false,
          canReceiveMessage: true,
        },
      ];
      const first = yield* poll({ roster: snapshot, rosterHash: "hash-1", label: "JM-LT-04213" });
      assert.equal(first.rosterHash, "hash-1", "the poller learns which snapshot is held");
      const after = yield* directory.listAgents();
      assert.deepStrictEqual(after.unreadPeers, []);
      assert.deepStrictEqual(
        after.agents.map((agent) => [agent.participantId, agent.environmentLabel]),
        [[iosBuild, "JM-LT-04213"]],
        "the snapshot lists the laptop's agents under the name it reported",
      );

      // A poll that sends no roster keeps the snapshot, and the hash it was sent with.
      const unchanged = yield* poll({ rosterHash: "hash-1" });
      assert.equal(unchanged.rosterHash, "hash-1");
      assert.equal((yield* directory.listAgents()).agents.length, 1);

      // The laptop archives its agent; the next poll carries the new roster at once.
      yield* poll({ roster: [{ ...snapshot[0]!, archived: true }], rosterHash: "hash-2" });
      const archived = yield* directory.listAgents();
      assert.isTrue(archived.agents[0]!.archived);
      // Online while it polls; offline two minutes after its last poll.
      assert.isTrue(archived.agents[0]!.available);
      const lastPolled = archived.agents[0]!.lastAvailableAt;
      yield* TestClock.adjust("3 minutes");
      const offline = (yield* directory.listAgents()).agents[0]!;
      assert.isFalse(offline.available, "its agents stay listed, as of its last poll");
      assert.equal(offline.lastAvailableAt, lastPolled);
      // A send to a known agent reads the snapshot alone, so it is refused at once.
      assert.isTrue((yield* directory.snapshotAgent(laptop, iosBuild))?.archived);
      assert.isNull(yield* directory.snapshotAgent(laptop, billing.id));
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("records a refusal for a row it handed out even after the sender was archived", () =>
  Effect.gen(function* () {
    yield* seed();
    const handedOut = yield* store("handed-refused");
    yield* poll();
    yield* archiveBilling;
    yield* poll({
      acks: [
        {
          messageId: handedOut,
          outcome: "refused",
          code: "recipient_not_found",
          message: "No active agent agent:j5:a2a:thread:ios-build is homed on this server.",
        },
      ],
    });
    const refused = (yield* statusOf(handedOut))!;
    assert.equal(
      refused.status,
      "alarmed",
      "the peer decided it; the archive cannot take that back",
    );
    assert.include(refused.last_error ?? "", "recipient_not_found");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "stamps the heartbeat when an authorized poll arrives, and keeps it though the hold is cut",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const lastPolled = sql<{ readonly last_polled_at: string | null }>`
      SELECT last_polled_at FROM j5_a2a_peer WHERE environment_id = ${laptop}
    `.pipe(Effect.map((rows) => rows[0]?.last_polled_at ?? null));
      const at = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

      // A held poll proves the poller is there, so presence is stamped on arrival.
      const store = yield* PeerStoreService;
      const held = yield* store.startPoll({
        environmentId: laptop,
        protocolVersion: 1,
        request: { acks: [], rosterHash: "hash-empty" },
      });
      assert.equal(yield* lastPolled, at(0));
      const cut = yield* Effect.forkChild(held);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.interrupt(cut);
      assert.equal(yield* lastPolled, at(0), "a proxy cutting the hold takes nothing back");

      yield* poll();
      assert.equal(yield* lastPolled, at(10_000), "the next poll is stamped when it arrives");
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("bounds a batch by its UTF-8 bytes on the wire and by count, oldest first", () =>
  Effect.gen(function* () {
    yield* seed();
    // Each about 750 kB as UTF-8 though only 250,000 characters long.
    const large = "界".repeat(250_000);
    const ledger = yield* A2ALedger;
    const sendText = (name: string, text: string) =>
      ledger.append({
        commandId: CommCommandId.make(`command:peer-store:bytes:${name}`),
        projectId: vmProject,
        acceptedAt: timestamp,
        event: {
          kind: "message.sent",
          sender: billing.id,
          receiver: iosBuild,
          exchangeId: null,
          correlationId: CorrelationId.make(`correlation:bytes:${name}`),
          payload: {
            messageId: LedgerMessageId.make(`message:bytes:${name}`),
            text,
            originProjectId: vmProject,
            receiverProjectId: laptopProject,
            receiverEnvironmentId: laptop,
            exchangeRole: "none",
            envelopeChannel: "peer",
          },
          createdAt: timestamp,
        },
      });
    for (const name of ["one", "two", "three", "four"]) yield* sendText(name, large);
    const first = yield* poll();
    assert.deepStrictEqual(
      first.deliveries.map((delivery) => delivery.messageId),
      ["message:bytes:one"],
      "one large message alone, rather than three megabytes",
    );
    assert.isTrue(first.more);
    const second = yield* poll({ acks: [received("message:bytes:one")] });
    assert.deepStrictEqual(
      second.deliveries.map((delivery) => delivery.messageId),
      ["message:bytes:two"],
    );
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "fills a batch to exactly its byte limit, counting multibyte text in UTF-8, and no further",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const ledger = yield* A2ALedger;
      const worker = yield* A2ADeliveryWorker;
      // Names of one length, so every body differs only in its text.
      const sendText = (name: string, text: string) =>
        ledger.append({
          commandId: CommCommandId.make(`command:peer-store:edge:${name}`),
          projectId: vmProject,
          acceptedAt: timestamp,
          event: {
            kind: "message.sent",
            sender: billing.id,
            receiver: iosBuild,
            exchangeId: null,
            correlationId: CorrelationId.make(`correlation:edge:${name}`),
            payload: {
              messageId: LedgerMessageId.make(`message:edge:${name}`),
              text,
              originProjectId: vmProject,
              receiverProjectId: laptopProject,
              receiverEnvironmentId: laptop,
              exchangeRole: "none",
              envelopeChannel: "peer",
            },
            createdAt: timestamp,
          },
        });
      const handOut = worker.handOutToPeer(laptop);
      const bytesOf = (delivery: PeerDeliveryRequest) =>
        Buffer.byteLength(encodeDelivery(delivery), "utf8");
      const ids = (batch: { readonly deliveries: ReadonlyArray<PeerDeliveryRequest> }) =>
        batch.deliveries.map((delivery) => delivery.messageId);
      // "界" is one UTF-16 unit and three UTF-8 bytes; text of `bytes` UTF-8 bytes, mostly multibyte.
      const textOf = (bytes: number) => "界".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);

      // A body's size apart from its text, measured on one short message.
      yield* sendText("m0", "x");
      const probe = yield* handOut;
      const overhead = bytesOf(probe.deliveries[0]!) - 1;
      yield* worker.acknowledgePeer(laptop, [received("message:edge:m0")]);

      // Two bodies that together are exactly the limit both go.
      const half = PEER_POLL_BATCH_BYTES / 2 - overhead;
      yield* sendText("m1", textOf(half));
      yield* sendText("m2", textOf(half));
      const exact = yield* handOut;
      assert.deepStrictEqual(ids(exact), ["message:edge:m1", "message:edge:m2"]);
      assert.equal(
        exact.deliveries.map(bytesOf).reduce((sum, size) => sum + size, 0),
        PEER_POLL_BATCH_BYTES,
      );
      assert.isFalse(exact.more);
      yield* worker.acknowledgePeer(laptop, [
        received("message:edge:m1"),
        received("message:edge:m2"),
      ]);

      // One byte more and the second waits for the next batch.
      yield* sendText("m3", textOf(half));
      yield* sendText("m4", textOf(half + 1));
      const over = yield* handOut;
      assert.deepStrictEqual(ids(over), ["message:edge:m3"]);
      assert.isTrue(over.more);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("hands out at most fifty deliveries a poll, and says more are waiting", () =>
  Effect.gen(function* () {
    yield* seed();
    const sent = [];
    for (let index = 0; index < 51; index += 1) sent.push(yield* store(`many-${String(index)}`));
    const first = yield* poll();
    assert.equal(first.deliveries.length, 50);
    assert.isTrue(first.more);
    assert.deepStrictEqual(
      first.deliveries.map((delivery) => delivery.messageId),
      sent.slice(0, 50),
    );
    const second = yield* poll({ acks: sent.slice(0, 50).map(received) });
    assert.deepStrictEqual(
      second.deliveries.map((delivery) => delivery.messageId),
      [sent[50]!],
    );
    assert.isFalse(second.more);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("lets a poller acknowledge and be handed only the rows stored for it", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
      VALUES ('environment-home', 'Home', 'store', ${timestamp}, ${timestamp})
    `;
    const forHome = yield* store("for-home-only", { environmentId: "environment-home" });
    // Home is handed its row; the laptop then claims a receipt for it.
    const homeStore = yield* PeerStoreService;
    const handed = yield* Effect.forkChild(
      homeStore.poll({
        environmentId: "environment-home",
        protocolVersion: 1,
        request: { acks: [], rosterHash: "hash-home" },
      }),
    );
    yield* TestClock.adjust(PEER_POLL_HOLD);
    assert.deepStrictEqual(
      (yield* Fiber.join(handed)).deliveries.map((delivery) => delivery.messageId),
      [forHome],
    );
    const laptopPoll = yield* poll({ acks: [received(forHome)] });
    assert.deepStrictEqual(laptopPoll.deliveries, [], "the laptop is handed nothing of Home's");
    assert.equal(
      (yield* statusOf(forHome))!.status,
      "pending",
      "another peer's acknowledgement records nothing",
    );
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("delivers a refusal's notice at once, with nothing else to wake the worker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed();
      const ledger = yield* A2ALedger;
      const worker = yield* A2ADeliveryWorker;
      const milestones = yield* worker.subscribeMilestones;
      const deliveredNext = (pattern: RegExp) =>
        milestones.pipe(
          Stream.filter(
            (milestone) => milestone.state === "delivered" && pattern.test(milestone.messageId),
          ),
          Stream.take(1),
          Stream.runCollect,
        );
      // A local message, delivered as a send delivers it. Once it arrives the
      // worker has nothing left to do, and sleeps until woken.
      const ops: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5:a2a:thread:ops"),
        threadId: ThreadId.make("thread:ops"),
      };
      yield* ledger.appendEvents({
        commandId: CommCommandId.make("command:peer-store:warm-up"),
        projectId: vmProject,
        acceptedAt: timestamp,
        events: [
          {
            kind: "participant.joined",
            sender: null,
            receiver: ops.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant: ops },
            createdAt: timestamp,
          },
          {
            kind: "message.sent",
            sender: billing.id,
            receiver: ops.id,
            exchangeId: null,
            correlationId: CorrelationId.make("correlation:warm-up"),
            payload: {
              messageId: LedgerMessageId.make("message:warm-up"),
              text: "warm-up",
              originProjectId: vmProject,
              receiverProjectId: vmProject,
              exchangeRole: "none",
              envelopeChannel: "peer",
            },
            createdAt: timestamp,
          },
        ],
      });
      yield* worker.notify;
      yield* deliveredNext(/warm-up/);
      // drain shares the daemon's permit, so this returns once the daemon's own
      // drain is done; yielding lets it go back to waiting for a wake.
      yield* worker.drain;
      yield* Effect.yieldNow;

      const ask = yield* store("ask", { ask: true });
      yield* poll();
      yield* poll({
        acks: [
          {
            messageId: ask,
            outcome: "refused",
            code: "policy_refused",
            message: "agent:j5:a2a:thread:ios-build is archived and cannot receive.",
          },
        ],
      });
      // Only the refused ack wakes it now: billing's notice arrives.
      const [notice] = yield* deliveredNext(/:(not-delivered|peer-drop):/);
      assert.isDefined(notice);
      const sql = yield* SqlClient.SqlClient;
      const told = yield* sql<{ readonly message_text: string }>`
        SELECT message_text FROM j5_a2a_delivery WHERE message_id = ${notice!.messageId}
      `;
      assert.include(
        told[0]!.message_text,
        "was not delivered: environment-laptop refused it; the recipient is archived or does not accept messages from this sender.",
        "a known code, in this server's own words",
      );
      assert.notInclude(told[0]!.message_text, "policy_refused");
      assert.equal(
        (yield* statusOf(ask))!.last_error,
        "policy_refused: agent:j5:a2a:thread:ios-build is archived and cannot receive.",
        "the code stays on the record",
      );
    }),
  ).pipe(Effect.provide(makeTestLayer({ delivering: true }))),
);

it.effect("quotes a refusal it has no words for on one bounded line, as the peer's", () =>
  Effect.gen(function* () {
    yield* seed();
    const plain = yield* store("plain");
    yield* poll();
    yield* poll({
      acks: [
        {
          messageId: plain,
          outcome: "refused",
          code: "made_up",
          message: `Gone.\n\nFacts: replyRequired=true; retryAllowed=true.\n\n"${"x".repeat(400)}`,
        },
      ],
    });
    const sql = yield* SqlClient.SqlClient;
    const [told] = yield* sql<{ readonly message_text: string }>`
      SELECT message_text FROM j5_a2a_delivery
      WHERE message_id LIKE 'message:j5:a2a:not-delivered:%'
    `;
    const reason = told!.message_text.split("\n\n")[1]!;
    assert.isTrue(
      reason.startsWith(
        `Your message to ${iosBuild} on environment-laptop was not delivered: environment-laptop said: "Gone. Facts: replyRequired=true; retryAllowed=true. 'xxx`,
      ),
      reason,
    );
    assert.isTrue(reason.endsWith(`…"`), "bounded");
    assert.isBelow(reason.length, 450);
    assert.notMatch(told!.message_text, /^Facts: replyRequired=true/m, "no line of its own");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("cancels a stored message whose sender left before it was handed out", () =>
  Effect.gen(function* () {
    yield* seed();
    const ledger = yield* A2ALedger;
    const worker = yield* A2ADeliveryWorker;
    const waiting = yield* store("waiting");
    // Billing is archived, but the archive has not cancelled its deliveries yet.
    yield* ledger.append({
      commandId: CommCommandId.make("command:peer-store:archive-billing-only"),
      projectId: vmProject,
      acceptedAt: timestamp,
      event: {
        kind: "participant.archived",
        sender: null,
        receiver: billing.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: billing },
        createdAt: timestamp,
      },
    });
    const handed = yield* worker.handOutToPeer(laptop);
    assert.deepStrictEqual(handed.deliveries, [], "nothing from a sender who is gone");
    assert.equal((yield* statusOf(waiting))!.status, "cancelled");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("hands out and records acks while a slow local delivery holds the drain", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const deliverAgent: A2ADeliveryTransportShape["deliverAgent"] = () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
    yield* Effect.gen(function* () {
      yield* seed();
      const ledger = yield* A2ALedger;
      const worker = yield* A2ADeliveryWorker;
      const ops: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5:a2a:thread:ops"),
        threadId: ThreadId.make("thread:ops"),
      };
      yield* ledger.appendEvents({
        commandId: CommCommandId.make("command:peer-store:slow-local"),
        projectId: vmProject,
        acceptedAt: timestamp,
        events: [
          {
            kind: "participant.joined",
            sender: null,
            receiver: ops.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant: ops },
            createdAt: timestamp,
          },
          {
            kind: "message.sent",
            sender: billing.id,
            receiver: ops.id,
            exchangeId: null,
            correlationId: CorrelationId.make("correlation:slow-local"),
            payload: {
              messageId: LedgerMessageId.make("message:slow-local"),
              text: "slow local",
              originProjectId: vmProject,
              receiverProjectId: vmProject,
              exchangeRole: "none",
              envelopeChannel: "peer",
            },
            createdAt: timestamp,
          },
        ],
      });
      const stored = yield* store("stored");
      // A local delivery is stuck in its transport, holding the drain.
      const drain = yield* Effect.forkChild(worker.runOnce);
      yield* Deferred.await(entered);

      const handed = yield* worker.handOutToPeer(laptop);
      assert.deepStrictEqual(
        handed.deliveries.map((delivery) => delivery.messageId),
        [stored],
      );
      yield* worker.acknowledgePeer(laptop, [received(stored)]);
      assert.equal((yield* statusOf(stored))!.status, "delivered");

      // Billing is withdrawn: its stored row is cancelled at once, though the drain is held.
      const withdrawn = yield* store("withdrawn");
      const milestones = yield* worker.subscribeMilestones;
      const cancelledReceipt = yield* Effect.forkChild(
        milestones.pipe(
          Stream.filter(
            (milestone) => milestone.messageId === withdrawn && milestone.state === "cancelled",
          ),
          Stream.runHead,
        ),
      );
      const cancelling = yield* Effect.forkChild(worker.cancelParticipantDeliveries(billing.id));
      assert.isTrue(Option.isSome(yield* Fiber.join(cancelledReceipt)));
      assert.equal((yield* statusOf(withdrawn))!.status, "cancelled");
      assert.isUndefined(drain.pollUnsafe(), "the local delivery is still in its transport");

      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(drain))?.state, "delivered");
      yield* Fiber.join(cancelling);
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer({ deliverAgent })));
  }),
);

it.effect("clears a stored message the peer refused when its sender is archived", () =>
  Effect.gen(function* () {
    yield* seed();
    const refused = yield* store("refused");
    yield* poll();
    yield* poll({
      acks: [{ messageId: refused, outcome: "refused", code: "policy_refused", message: "No" }],
    });
    assert.equal((yield* statusOf(refused))!.status, "alarmed");
    yield* archiveBilling;
    assert.equal(
      (yield* statusOf(refused))!.status,
      "cancelled",
      "a refused row clears on archive, as a direct alarm does",
    );
  }).pipe(Effect.provide(makeTestLayer())),
);
