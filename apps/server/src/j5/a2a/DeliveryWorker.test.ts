import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ThreadManagementService,
  type ThreadManagementSendInput,
} from "../../orchestration-v2/ThreadManagementService.ts";
import {
  A2ADeliveryHookError,
  A2ADeliveryHooks,
  A2ADeliveryWorker,
  heldQueueRecheckMs,
  layerWithHooks as deliveryWorkerLayerWithHooks,
} from "./DeliveryWorker.ts";
import {
  A2ADeliveryHeldError,
  A2ADeliveryTransport,
  A2ADeliveryTransportError,
  deliveryCommandId,
  deliveryMessageId,
  live as deliveryTransportLive,
  type A2ADeliveryTransportShape,
} from "./DeliveryTransport.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  CorrelationId,
  LedgerMessageId,
  LIFECYCLE_PARTICIPANT_ID,
  LedgerProjectId,
  outsideAgentParticipantId,
  ParticipantId,
  type AgentParticipant,
  type MachineParticipant,
} from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";
const sender: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:delivery-sender"),
  threadId: ThreadId.make("thread:delivery-sender"),
};
const receiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:delivery-receiver"),
  threadId: ThreadId.make("thread:delivery-receiver"),
};
const watchdog: MachineParticipant = {
  kind: "machine",
  id: ParticipantId.make("machine:delivery-watchdog"),
  name: "delivery-watchdog",
};
const person = {
  kind: "human" as const,
  id: ParticipantId.make("human:delivery-person"),
};

const makeTestLayer = (
  transport: A2ADeliveryTransportShape,
  hooks: A2ADeliveryHooks["Service"] = A2ADeliveryHooks.of({
    afterTransportSuccess: () => Effect.void,
  }),
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const transportLayer = Layer.succeed(A2ADeliveryTransport, A2ADeliveryTransport.of(transport));
  const worker = deliveryWorkerLayerWithHooks(false).pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transportLayer),
    Layer.provide(Layer.succeed(A2ADeliveryHooks, hooks)),
  );
  return Layer.mergeAll(database, ledger, send, transportLayer, worker);
};

const join = Effect.fn("test.j5.a2a.delivery.join")(function* (
  projectId: LedgerProjectId,
  participant: AgentParticipant | MachineParticipant,
  index: string,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:delivery:join:${index}`),
    projectId,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: participant.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant },
      createdAt: timestamp,
    },
  });
});

const seedSend = Effect.fn("test.j5.a2a.delivery.seedSend")(function* (
  crossProject: boolean,
  ask = false,
) {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const ledgerService = yield* A2ALedger;
  const senderProjectId = LedgerProjectId.make("project:delivery:sender");
  const receiverProjectId = crossProject
    ? LedgerProjectId.make("project:delivery:receiver")
    : senderProjectId;
  yield* ledgerService.ensureProject({ projectId: senderProjectId, createdAt: timestamp });
  if (crossProject) {
    yield* ledgerService.ensureProject({ projectId: receiverProjectId, createdAt: timestamp });
  }
  yield* join(senderProjectId, sender, "sender");
  yield* join(receiverProjectId, receiver, "receiver");
  const sent = yield* (yield* A2ASendService).send({
    commandId: CommCommandId.make(
      crossProject ? "command:delivery:cross-project" : "command:delivery:same-project",
    ),
    senderThreadId: sender.threadId,
    to: receiver.id,
    message: "Delivery crash-window probe",
    ...(ask ? { expectReply: true, intent: "delivery probe" } : {}),
    acceptedAt: timestamp,
  });
  return { senderProjectId, receiverProjectId, sent };
});

const crashWindowScenario = (poisonIds: boolean, crossProject: boolean) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const injections = yield* Ref.make(0);
    const seen = yield* Ref.make(new Set<string>());
    const hookCalls = yield* Ref.make(0);
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: (input) =>
        Effect.gen(function* () {
          const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
          const stableKey = `${deliveryCommandId(input.messageId)}:${deliveryMessageId(input.messageId)}`;
          const key = poisonIds ? `${stableKey}:attempt:${call}` : stableKey;
          const inserted = yield* Ref.modify(seen, (keys) => {
            if (keys.has(key)) return [false, keys] as const;
            const next = new Set(keys);
            next.add(key);
            return [true, next] as const;
          });
          if (inserted) yield* Ref.update(injections, (count) => count + 1);
        }).pipe(
          Effect.mapError(
            (cause) => new A2ADeliveryTransportError({ operation: "test delivery", cause }),
          ),
        ),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    };
    const hooks = A2ADeliveryHooks.of({
      afterTransportSuccess: () =>
        Ref.updateAndGet(hookCalls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Effect.fail(
                  new A2ADeliveryHookError({
                    cause: "simulated crash after injection before delivery receipt",
                  }),
                )
              : Effect.void,
          ),
        ),
    });

    const result = yield* Effect.gen(function* () {
      const { receiverProjectId, sent } = yield* seedSend(crossProject);
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      if (crossProject) {
        const before = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM j5_a2a_comm_event
          WHERE project_id = ${receiverProjectId} AND kind = 'message.received'
        `;
        assert.equal(before[0]?.count, 0, "sender commit precedes receiver double-entry");
        const senderState = yield* sql<{ readonly status: string }>`
          SELECT status
          FROM j5_a2a_delivery
          WHERE message_id = ${sent.messageId}
        `;
        assert.deepStrictEqual(senderState, [{ status: "pending" }]);
      }

      const first = yield* worker.runOnce;
      assert.equal(first?.state, "retry_scheduled");
      assert.equal(first?.attempt, 1);
      yield* TestClock.adjust("250 millis");
      const replay = yield* worker.runOnce;
      assert.equal(replay?.state, "delivered");
      assert.equal(replay?.attempt, 2);

      const received = crossProject
        ? yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_comm_event
            WHERE project_id = ${receiverProjectId}
              AND kind = 'message.received'
              AND correlation_id IS NOT NULL
          `
        : [{ count: 0 }];
      const senderState = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM j5_a2a_delivery
        WHERE message_id = ${sent.messageId}
      `;
      return {
        messageId: sent.messageId,
        injectionCount: yield* Ref.get(injections),
        receivedCount: received[0]?.count ?? 0,
        senderState: senderState[0]?.status,
      };
    }).pipe(Effect.provide(makeTestLayer(transport, hooks)));
    return result;
  });

it.effect("recovers the injected-but-unrecorded window with one upstream injection", () =>
  Effect.gen(function* () {
    const result = yield* crashWindowScenario(false, false);
    assert.equal(result.injectionCount, 1);
  }),
);

it.effect("negative control: poisoned retry ids are detected as a double injection", () =>
  Effect.gen(function* () {
    const poisoned = yield* crashWindowScenario(true, false);
    assert.equal(poisoned.injectionCount, 2);
    assert.notEqual(poisoned.injectionCount, 1);
  }),
);

it.effect("serializes manual runOnce calls against a concurrent drain", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((call) =>
            call === 1
              ? Deferred.succeed(firstEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Effect.void,
          ),
        ),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    };

    yield* Effect.gen(function* () {
      yield* seedSend(false);
      const worker = yield* A2ADeliveryWorker;
      const runOnceFiber = yield* worker.runOnce.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstEntered);
      const drainFiber = yield* worker.drain.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(calls), 1, "drain cannot claim the in-flight delivery");

      yield* Deferred.succeed(releaseFirst, undefined);
      assert.equal((yield* Fiber.join(runOnceFiber))?.state, "delivered");
      assert.deepStrictEqual(yield* Fiber.join(drainFiber), []);
      assert.equal(yield* Ref.get(calls), 1);
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("cross-project half-write recovery records exactly one receiver entry", () =>
  Effect.gen(function* () {
    const result = yield* crashWindowScenario(false, true);
    assert.equal(result.injectionCount, 1);
    assert.equal(result.receivedCount, 1);
    assert.equal(result.senderState, "delivered");
  }),
);

it.effect("delivers a cross-project reply to the asker and closes its Exchange once", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: (input) =>
        Ref.update(delivered, (all) => [...all, `${input.exchangeRole}:${input.receiverId}`]),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    };
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const ledgerService = yield* A2ALedger;
      const sendService = yield* A2ASendService;
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      const senderProjectId = LedgerProjectId.make("project:exchange:sender");
      const receiverProjectId = LedgerProjectId.make("project:exchange:receiver");
      yield* ledgerService.ensureProject({ projectId: senderProjectId, createdAt: timestamp });
      yield* ledgerService.ensureProject({ projectId: receiverProjectId, createdAt: timestamp });
      yield* join(senderProjectId, sender, "exchange-sender");
      yield* join(receiverProjectId, receiver, "exchange-receiver");

      const opened = yield* sendService.send({
        commandId: CommCommandId.make("command:exchange:cross:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Please reply across projects.",
        expectReply: true,
        intent: "Prove cross-project reply closure",
        acceptedAt: timestamp,
      });
      assert.equal(opened.exchangeState, "open");
      assert.equal((yield* worker.runOnce)?.state, "delivered");

      const reply = yield* sendService.send({
        commandId: CommCommandId.make("command:exchange:cross:reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "Cross-project reply delivered.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      });
      assert.equal(reply.exchangeState, "closed");
      assert.deepStrictEqual(yield* worker.drain, [
        {
          projectId: receiverProjectId,
          messageId: reply.messageId,
          state: "delivered",
          attempt: 1,
        },
      ]);
      assert.deepStrictEqual(yield* Ref.get(delivered), [
        `ask:${receiver.id}`,
        `reply:${sender.id}`,
      ]);

      const kinds = Effect.fn(function* (projectId: LedgerProjectId) {
        const page = yield* ledgerService.readEvents({
          projectId,
          cursor: { afterSeq: 0 },
          limit: 100,
        });
        assert.isTrue(page.complete);
        return page.events.map((event) => `${event.seq}:${event.kind}`);
      });
      // The asker's ledger closes when the reply is accepted, then records its arrival.
      assert.deepStrictEqual(yield* kinds(senderProjectId), [
        "1:participant.joined",
        "2:exchange.opened",
        "3:message.sent",
        "4:message.delivered",
        "5:exchange.closed",
        "6:message.received",
      ]);
      assert.deepStrictEqual(yield* kinds(receiverProjectId), [
        "1:participant.joined",
        "2:message.received",
        "3:message.sent",
        "4:message.delivered",
      ]);
      assert.deepStrictEqual(
        yield* sql<{ readonly status: string; readonly closed_seq: number }>`
          SELECT status, closed_seq
          FROM j5_a2a_exchange
          WHERE exchange_id = ${opened.exchangeId!}
        `,
        [{ status: "closed", closed_seq: 5 }],
      );
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("startup reconciliation drains a persisted cross-project half-write after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-a2a-restart-" });
      const filename = path.join(directory, "state.sqlite");
      const firstDatabase = NodeSqliteClient.layer({ filename });
      const firstLedger = ledgerLayer.pipe(Layer.provide(firstDatabase));
      const firstSend = sendLayer.pipe(
        Layer.provide(peerDirectoryNoneLayer),
        Layer.provide(firstLedger),
        Layer.provide(firstDatabase),
      );
      const firstLayer = Layer.mergeAll(firstDatabase, firstLedger, firstSend);
      const persisted = yield* Effect.scoped(
        Effect.gen(function* () {
          const seeded = yield* seedSend(true);
          const sql = yield* SqlClient.SqlClient;
          const received = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_comm_event
            WHERE project_id = ${seeded.receiverProjectId} AND kind = 'message.received'
          `;
          assert.equal(received[0]?.count, 0);
          return seeded;
        }).pipe(Effect.provide(firstLayer)),
      );

      const injectionCount = yield* Ref.make(0);
      const transportEntered = yield* Deferred.make<void>();
      const releaseTransport = yield* Deferred.make<void>();
      const transport: A2ADeliveryTransportShape = {
        deliverAgent: () => Ref.update(injectionCount, (count) => count + 1),
        cancelAgent: () => Effect.succeed("cancelled" as const),
        deliverPeer: () => Effect.die("peer delivery is not under test"),
        deliverHuman: () => Effect.void,
      };
      const secondDatabase = NodeSqliteClient.layer({ filename });
      const secondLedger = ledgerLayer.pipe(Layer.provide(secondDatabase));
      const secondTransport = Layer.succeed(
        A2ADeliveryTransport,
        A2ADeliveryTransport.of(transport),
      );
      const secondWorker = deliveryWorkerLayerWithHooks(true).pipe(
        Layer.provide(secondLedger),
        Layer.provide(secondDatabase),
        Layer.provide(secondTransport),
        Layer.provide(
          Layer.succeed(
            A2ADeliveryHooks,
            A2ADeliveryHooks.of({
              afterTransportSuccess: () =>
                Deferred.succeed(transportEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseTransport)),
                ),
            }),
          ),
        ),
      );
      const secondLayer = Layer.mergeAll(
        secondDatabase,
        secondLedger,
        secondTransport,
        secondWorker,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* A2ADeliveryWorker;
          yield* Deferred.await(transportEntered);
          const milestoneStream = yield* worker.subscribeMilestones;
          const milestoneFiber = yield* milestoneStream.pipe(
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(releaseTransport, undefined);
          const reconciled = yield* Fiber.join(milestoneFiber).pipe(Effect.map(Option.getOrThrow));
          assert.equal(reconciled?.state, "delivered");
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_comm_event
            WHERE project_id = ${persisted.receiverProjectId}
              AND kind = 'message.received'
          `;
          assert.equal(rows[0]?.count, 1);
          assert.equal(yield* Ref.get(injectionCount), 1);
        }).pipe(Effect.provide(secondLayer)),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "forces repeated delivery failure into a visible alarm, told to its sender once (ask: %s)",
  (ask) =>
    Effect.gen(function* () {
      const failure = new A2ADeliveryTransportError({
        operation: "forced failure",
        cause: "recipient unavailable",
      });
      const transport: A2ADeliveryTransportShape = {
        deliverAgent: () => Effect.fail(failure),
        cancelAgent: () => Effect.succeed("cancelled" as const),
        deliverPeer: () => Effect.die("peer delivery is not under test"),
        deliverHuman: () => Effect.fail(failure),
      };
      yield* Effect.gen(function* () {
        const { sent } = yield* seedSend(false, ask);
        const worker = yield* A2ADeliveryWorker;
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
        yield* TestClock.adjust("250 millis");
        assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
        yield* TestClock.adjust("500 millis");
        const alarm = yield* worker.runOnce;
        assert.equal(alarm?.state, "alarmed");
        assert.equal(alarm?.attempt, 3);
        const alarms = yield* worker.listAlarms;
        assert.lengthOf(alarms, 1);
        assert.equal(alarms[0]?.messageId, alarm?.messageId);
        assert.include(alarms[0]?.lastError ?? "", "recipient unavailable");

        const notices = yield* sql<{ readonly receiver_id: string; readonly message_text: string }>`
          SELECT receiver_id, message_text FROM j5_a2a_delivery
          WHERE envelope_channel = 'lifecycle_notice'
        `;
        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.receiver_id, sender.id);
        assert.include(
          notices[0]!.message_text,
          `${ask ? `Your ask "delivery probe" (message ${sent.messageId})` : `Your message ${sent.messageId}`} to ${receiver.id} may not have been delivered: delivery failed 3 times, and it will not be tried again. The last attempt failed with: "recipient unavailable"`,
        );
        const exchanges = yield* sql<{ readonly status: string }>`
          SELECT status FROM j5_a2a_exchange
        `;
        if (ask) {
          assert.deepStrictEqual(exchanges, [{ status: "open" }], "only the asker withdraws it");
          assert.include(
            notices[0]!.message_text,
            `Exchange ${sent.exchangeId} is still open; if the ask did arrive, its reply still comes on it. To stop waiting, withdraw it with j5_clear_own_ask`,
          );
        } else {
          assert.lengthOf(exchanges, 0);
          assert.notInclude(notices[0]!.message_text, "xchange");
        }

        // The notice fails to land the same way and alarms in turn; nobody is told of that.
        assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
        yield* TestClock.adjust("250 millis");
        assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
        yield* TestClock.adjust("500 millis");
        assert.equal((yield* worker.runOnce)?.state, "alarmed");
        assert.lengthOf(yield* worker.listAlarms, 2);
        const after = yield* sql`
          SELECT 1 FROM j5_a2a_delivery WHERE envelope_channel = 'lifecycle_notice'
        `;
        assert.equal(after.length, 1, "an alarmed notice tells nobody");
      }).pipe(Effect.provide(makeTestLayer(transport)));
    }),
);

it.effect("tells nobody when a message from a peer server alarms on its local delivery", () =>
  Effect.gen(function* () {
    const failure = new A2ADeliveryTransportError({
      operation: "forced failure",
      cause: "recipient unavailable",
    });
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: () => Effect.fail(failure),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.fail(failure),
    };
    yield* Effect.gen(function* () {
      const { sent } = yield* seedSend(false);
      const sql = yield* SqlClient.SqlClient;
      // As a message a peer server handed over: its sender is on that server.
      yield* sql`
        UPDATE j5_a2a_delivery SET origin_environment_id = 'environment-peer'
        WHERE message_id = ${sent.messageId}
      `;
      const worker = yield* A2ADeliveryWorker;
      assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
      yield* TestClock.adjust("500 millis");
      assert.equal((yield* worker.runOnce)?.state, "alarmed");
      const notices = yield* sql`
        SELECT 1 FROM j5_a2a_delivery WHERE envelope_channel = 'lifecycle_notice'
      `;
      assert.equal(
        notices.length,
        0,
        "a peer server accepts a platform notice only for an Exchange",
      );
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("keeps a message queued behind a held receiver queue undelivered until resumed", () =>
  Effect.gen(function* () {
    const held = yield* Ref.make(true);
    const sends = yield* Ref.make<ReadonlyArray<ThreadManagementSendInput>>([]);
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const ledger = ledgerLayer.pipe(Layer.provide(database));
    const send = sendLayer.pipe(
      Layer.provide(peerDirectoryNoneLayer),
      Layer.provide(ledger),
      Layer.provide(database),
    );
    const threadManagement = Layer.mock(ThreadManagementService)({
      getThreadProjection: () =>
        Effect.succeed({
          thread: { projectId: "project:held", archivedAt: null },
          messages: [],
          runs: [],
          providerThreads: [],
          providerSessions: [],
        } as never),
      sendToThread: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(sends, (all) => [...all, input]);
          const queueHeld = yield* Ref.get(held);
          return {
            delivery: "queued",
            run: { id: "run:held", status: "queued", ...(queueHeld ? { queueHeld } : {}) },
          } as never;
        }),
    });
    const transport = deliveryTransportLive.pipe(
      Layer.provide(database),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.mock(PeerRegistryService)({})),
      Layer.provide(threadManagement),
      Layer.provide(Layer.mock(OrchestratorV2)({})),
      Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
    );
    const worker = deliveryWorkerLayerWithHooks(false).pipe(
      Layer.provide(ledger),
      Layer.provide(database),
      Layer.provide(transport),
      Layer.provide(
        Layer.succeed(
          A2ADeliveryHooks,
          A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const { senderProjectId, sent } = yield* seedSend(false);
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      const deliveredEvents = sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM j5_a2a_comm_event
        WHERE project_id = ${senderProjectId} AND kind = 'message.delivered'
      `;
      // Past the alarm threshold: a held queue waits for a person, not a failing transport.
      for (let attempt = 1; attempt <= 4; attempt++) {
        const milestone = yield* worker.runOnce;
        assert.equal(milestone?.state, "retry_scheduled");
        assert.equal(milestone?.attempt, attempt);
        yield* TestClock.adjust(heldQueueRecheckMs(attempt) - 1);
        assert.isNull(yield* worker.runOnce, "a held delivery is not retried in a tight loop");
        yield* TestClock.adjust(1);
      }
      assert.equal((yield* deliveredEvents)[0]?.count, 0);
      assert.lengthOf(yield* worker.listAlarms, 0);
      const row = yield* sql<{ readonly status: string; readonly last_error: string }>`
        SELECT status, last_error FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
      `;
      assert.equal(row[0]?.status, "retry_scheduled");
      assert.include(row[0]?.last_error ?? "", "not delivered");

      yield* Ref.set(held, false);
      assert.equal((yield* worker.runOnce)?.state, "delivered");
      assert.equal((yield* deliveredEvents)[0]?.count, 1);
      const inputs = yield* Ref.get(sends);
      assert.lengthOf(inputs, 5);
      // Every retry reuses the stable command, and upstream can link the sending thread.
      assert.lengthOf(new Set(inputs.map((input) => input.commandId)), 1);
      assert.equal(inputs[0]?.senderThreadId, sender.threadId);
    }).pipe(Effect.provide(Layer.mergeAll(database, ledger, send, transport, worker)));
  }),
);

type ScriptedStep = "held" | "fail";

/**
 * A local transport that answers each message from its script, one step per attempt, and lands
 * it once the steps run out. It records what landed, in order.
 */
const scriptedTransport = (
  script: Ref.Ref<ReadonlyMap<string, ReadonlyArray<ScriptedStep>>>,
  delivered: Ref.Ref<ReadonlyArray<string>>,
): A2ADeliveryTransportShape => ({
  deliverAgent: (input) =>
    Effect.gen(function* () {
      const steps = yield* Ref.get(script);
      const [step, ...rest] = steps.get(input.message) ?? [];
      yield* Ref.set(script, new Map(steps).set(input.message, rest));
      if (step === "held") {
        return yield* new A2ADeliveryHeldError({
          participantId: input.receiverId,
          waitingOn: "run test",
        });
      }
      if (step === "fail") {
        return yield* new A2ADeliveryTransportError({
          operation: "test delivery",
          cause: "offline",
        });
      }
      yield* Ref.update(delivered, (all) => [...all, input.message]);
    }),
  cancelAgent: () => Effect.succeed("cancelled" as const),
  deliverPeer: () => Effect.die("peer delivery is not under test"),
  deliverHuman: () => Effect.void,
});

const otherSender: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:delivery-other-sender"),
  threadId: ThreadId.make("thread:delivery-other-sender"),
};

/** Two senders in their own projects, and the receiver in the first, which has more history. */
const seedTwoProjects = Effect.fn("test.j5.a2a.delivery.seedTwoProjects")(function* () {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const ledgerService = yield* A2ALedger;
  const busy = LedgerProjectId.make("project:delivery:busy");
  const fresh = LedgerProjectId.make("project:delivery:fresh");
  yield* ledgerService.ensureProject({ projectId: busy, createdAt: timestamp });
  yield* ledgerService.ensureProject({ projectId: fresh, createdAt: timestamp });
  yield* join(busy, receiver, "two-projects-receiver");
  yield* join(busy, sender, "two-projects-sender");
  // History that puts the busy ledger's sequence far ahead of the fresh one's.
  for (let index = 0; index < 8; index++) {
    yield* join(
      busy,
      {
        kind: "machine",
        id: ParticipantId.make(`machine:filler-${index}`),
        name: `filler ${index}`,
      },
      `two-projects-filler-${index}`,
    );
  }
  yield* join(fresh, otherSender, "two-projects-other-sender");
});

const sendAt = (from: AgentParticipant, name: string, acceptedAt: string) =>
  Effect.gen(function* () {
    return yield* (yield* A2ASendService).send({
      commandId: CommCommandId.make(`command:delivery:order:${name}`),
      senderThreadId: from.threadId,
      to: receiver.id,
      message: name,
      acceptedAt,
    });
  });

it.effect.each([
  ["a millisecond apart", "2026-08-16T12:00:02.000Z"],
  ["in the same millisecond", "2026-08-16T12:00:01.000Z"],
] as const)("keeps send order to one agent across projects, sent %s", ([, bAcceptedAt]) =>
  Effect.gen(function* () {
    const script = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ScriptedStep>>>(
      new Map([["A", ["held"]]]),
    );
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      yield* seedTwoProjects();
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      // A is accepted first, from the project with the longer ledger, and held.
      const a = yield* sendAt(sender, "A", "2026-08-16T12:00:01.000Z");
      yield* worker.drain;
      // The hold lifts; B is sent from the fresh project before anything wakes A.
      const b = yield* sendAt(otherSender, "B", bAcceptedAt);
      const seqs = yield* sql<{ readonly message_id: string; readonly sent_seq: number }>`
        SELECT message_id, sent_seq FROM j5_a2a_delivery ORDER BY sent_seq
      `;
      assert.deepStrictEqual(
        seqs.map((row) => row.message_id),
        [b.messageId, a.messageId],
        "B's own ledger numbers it before A",
      );
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), []);

      yield* worker.wake(receiver.id);
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), ["A", "B"]);
    }).pipe(Effect.provide(makeTestLayer(scriptedTransport(script, delivered))));
  }),
);

it.effect("does not count waiting behind another message toward a delivery's alarm", () =>
  Effect.gen(function* () {
    const script = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ScriptedStep>>>(
      new Map([
        ["A", ["held", "held"]],
        ["B", ["fail"]],
      ]),
    );
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      yield* seedTwoProjects();
      const worker = yield* A2ADeliveryWorker;
      yield* sendAt(sender, "A", "2026-08-16T12:00:01.000Z");
      yield* sendAt(sender, "B", "2026-08-16T12:00:02.000Z");
      // A is held twice, and B waits behind it twice without reaching the transport.
      yield* worker.drain;
      yield* TestClock.adjust(heldQueueRecheckMs(1));
      yield* worker.drain;
      // A lands on its next recheck, and B's first transport attempt fails.
      yield* TestClock.adjust(heldQueueRecheckMs(2));
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), ["A"]);
      assert.lengthOf(yield* worker.listAlarms, 0);
      // One transport failure is retried, not alarmed.
      yield* TestClock.adjust("250 millis");
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), ["A", "B"]);
      assert.lengthOf(yield* worker.listAlarms, 0);
    }).pipe(Effect.provide(makeTestLayer(scriptedTransport(script, delivered))));
  }),
);

it.effect("tells the sender how many times the transport failed, not how often it waited", () =>
  Effect.gen(function* () {
    const script = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ScriptedStep>>>(
      new Map([
        ["A", ["held", "held"]],
        ["B", ["fail", "fail", "fail"]],
      ]),
    );
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      yield* seedTwoProjects();
      const worker = yield* A2ADeliveryWorker;
      yield* sendAt(sender, "A", "2026-08-16T12:00:01.000Z");
      yield* sendAt(sender, "B", "2026-08-16T12:00:02.000Z");
      // B waits twice behind A, then fails three times in transport once A lands.
      yield* worker.drain;
      yield* TestClock.adjust(heldQueueRecheckMs(1));
      yield* worker.drain;
      yield* TestClock.adjust(heldQueueRecheckMs(2));
      yield* worker.drain;
      yield* TestClock.adjust("250 millis");
      yield* worker.drain;
      yield* TestClock.adjust("500 millis");
      yield* worker.drain;
      assert.lengthOf(yield* worker.listAlarms, 1);
      const notice = (yield* Ref.get(delivered)).find((text) => text.includes("delivery failed"));
      assert.include(notice, "delivery failed 3 times");
    }).pipe(Effect.provide(makeTestLayer(scriptedTransport(script, delivered))));
  }),
);

const secondReceiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:delivery-second-receiver"),
  threadId: ThreadId.make("thread:delivery-second-receiver"),
};

it.effect("wakes a held delivery early but leaves one backing off after a transport failure", () =>
  Effect.gen(function* () {
    const script = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ScriptedStep>>>(
      new Map([
        ["Backing off", ["fail"]],
        ["Held", ["held"]],
      ]),
    );
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      yield* seedTwoProjects();
      yield* join(LedgerProjectId.make("project:delivery:busy"), secondReceiver, "second-receiver");
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      const backingOff = yield* sendAt(sender, "Backing off", "2026-08-16T12:00:01.000Z");
      yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:delivery:order:held-second"),
        senderThreadId: sender.threadId,
        to: secondReceiver.id,
        message: "Held",
        acceptedAt: "2026-08-16T12:00:01.000Z",
      });
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), []);

      // Both receivers wake before the failed delivery's retry is due.
      yield* worker.wake(receiver.id);
      yield* worker.wake(secondReceiver.id);
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), ["Held"]);
      const attempts = yield* sql<{ readonly attempts: number }>`
        SELECT attempts FROM j5_a2a_delivery WHERE message_id = ${backingOff.messageId}
      `;
      assert.equal(attempts[0]?.attempts, 1, "a wake does not spend a transport retry");

      yield* TestClock.adjust("250 millis");
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), ["Held", "Backing off"]);
    }).pipe(Effect.provide(makeTestLayer(scriptedTransport(script, delivered))));
  }),
);

it.effect("hands the next message over as soon as the one it waited behind alarms", () =>
  Effect.gen(function* () {
    const script = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ScriptedStep>>>(
      new Map([["A", ["fail", "fail", "fail"]]]),
    );
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      yield* seedTwoProjects();
      const worker = yield* A2ADeliveryWorker;
      yield* sendAt(sender, "A", "2026-08-16T12:00:01.000Z");
      yield* sendAt(sender, "B", "2026-08-16T12:00:02.000Z");
      yield* worker.drain;
      yield* TestClock.adjust("250 millis");
      yield* worker.drain;
      // A's third failure alarms it, and B follows at once instead of on its recheck.
      yield* TestClock.adjust("500 millis");
      yield* worker.drain;
      assert.lengthOf(yield* worker.listAlarms, 1);
      // A's sender is told of the alarm too, after B lands.
      assert.equal((yield* Ref.get(delivered))[0], "B");
    }).pipe(Effect.provide(makeTestLayer(scriptedTransport(script, delivered))));
  }),
);

it.effect("hands the next message over as soon as the one it waited behind is cancelled", () =>
  Effect.gen(function* () {
    const script = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ScriptedStep>>>(
      new Map([["A", ["held"]]]),
    );
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      yield* seedTwoProjects();
      const worker = yield* A2ADeliveryWorker;
      yield* sendAt(sender, "A", "2026-08-16T12:00:01.000Z");
      yield* sendAt(otherSender, "B", "2026-08-16T12:00:02.000Z");
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), []);
      // A's sender leaves, which cancels A; B no longer waits behind it.
      yield* worker.cancelParticipantDeliveries(sender.id);
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), ["B"]);
    }).pipe(Effect.provide(makeTestLayer(scriptedTransport(script, delivered))));
  }),
);

it.effect("hands the next message over as soon as the one it waited behind lands", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    const failNext = yield* Ref.make(true);
    const transport: A2ADeliveryTransportShape = {
      // The first attempt fails in transport; every later one lands.
      deliverAgent: (input) =>
        Ref.getAndSet(failNext, false).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new A2ADeliveryTransportError({ operation: "test delivery", cause: "offline" }),
                )
              : Ref.update(delivered, (all) => [...all, input.message]),
          ),
        ),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    };
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      const sendService = yield* A2ASendService;
      const projectId = LedgerProjectId.make("project:delivery:in-order");
      yield* (yield* A2ALedger).ensureProject({ projectId, createdAt: timestamp });
      yield* join(projectId, sender, "in-order-sender");
      yield* join(projectId, receiver, "in-order-receiver");
      const sendUpdate = (name: string) =>
        sendService.send({
          commandId: CommCommandId.make(`command:delivery:in-order:${name}`),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: `Update ${name}`,
          acceptedAt: timestamp,
        });
      yield* sendUpdate("a");
      const b = yield* sendUpdate("b");

      // A fails in transport and retries soon; B waits behind it on the slower held recheck.
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), []);

      // Only A's retry is due, yet B follows it at once.
      yield* TestClock.adjust("250 millis");
      yield* worker.drain;
      assert.deepStrictEqual(yield* Ref.get(delivered), ["Update a", "Update b"]);
      const row = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_delivery WHERE message_id = ${b.messageId}
      `;
      assert.equal(row[0]?.status, "delivered");
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("delivers a machine's send to its agent receiver instead of withdrawing it", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<ReadonlyArray<ParticipantId>>([]);
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: (input) => Ref.update(delivered, (senders) => [...senders, input.senderId]),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    };
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:delivery:machine");
      yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt: timestamp });
      yield* join(projectId, receiver, "machine-receiver");
      yield* join(projectId, watchdog, "machine-sender");
      const sent = yield* (yield* A2ASendService).sendAsMachine({
        commandId: CommCommandId.make("command:delivery:machine"),
        senderParticipantId: watchdog.id,
        to: receiver.id,
        message: "67 new signals",
        acceptedAt: timestamp,
      });

      const delivery = yield* (yield* A2ADeliveryWorker).runOnce;
      assert.equal(delivery?.state, "delivered");
      assert.deepStrictEqual(yield* Ref.get(delivered), [watchdog.id]);
      const state = yield* (yield* SqlClient.SqlClient)<{ readonly status: string }>`
        SELECT status FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
      `;
      assert.deepStrictEqual(state, [{ status: "delivered" }]);
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("delivers an outside agent's send, though it holds no membership", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<ReadonlyArray<ParticipantId>>([]);
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: (input) => Ref.update(delivered, (senders) => [...senders, input.senderId]),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    };
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:delivery:outside");
      yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt: timestamp });
      yield* join(projectId, receiver, "outside-receiver");
      const outsideId = outsideAgentParticipantId("delivery-session");
      yield* (yield* A2ASendService).sendAsOutsideAgent({
        commandId: CommCommandId.make("command:delivery:outside"),
        senderParticipantId: outsideId,
        senderName: "Claude Code",
        to: receiver.id,
        receiverProjectId: projectId,
        message: "The deploy is red.",
        acceptedAt: timestamp,
      });

      const delivery = yield* (yield* A2ADeliveryWorker).runOnce;
      assert.equal(delivery?.state, "delivered");
      assert.deepStrictEqual(yield* Ref.get(delivered), [outsideId]);
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("delivers each message the attachments from its own ledger's sent event", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<ReadonlyArray<readonly [string, ReadonlyArray<string>]>>([]);
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: (input) =>
        Ref.update(delivered, (entries) => [
          ...entries,
          [input.messageId, (input.attachments ?? []).map((attachment) => attachment.id)] as const,
        ]),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    };
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      // Two ledgers built the same way number their events alike, so both
      // message.sent facts land on the same seq.
      const sendIn = Effect.fn(function* (name: string) {
        const projectId = LedgerProjectId.make(`project:delivery:ledger-${name}`);
        const ledgerSender: AgentParticipant = {
          kind: "agent",
          id: ParticipantId.make(`agent:delivery-sender-${name}`),
          threadId: ThreadId.make(`thread:delivery-sender-${name}`),
        };
        const ledgerReceiver: AgentParticipant = {
          kind: "agent",
          id: ParticipantId.make(`agent:delivery-receiver-${name}`),
          threadId: ThreadId.make(`thread:delivery-receiver-${name}`),
        };
        yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt: timestamp });
        yield* join(projectId, ledgerSender, `ledger-${name}-sender`);
        yield* join(projectId, ledgerReceiver, `ledger-${name}-receiver`);
        return yield* (yield* A2ASendService).send({
          commandId: CommCommandId.make(`command:delivery:ledger-${name}`),
          senderThreadId: ledgerSender.threadId,
          to: ledgerReceiver.id,
          message: `Attachment from ledger ${name}`,
          attachments: [
            {
              type: "file",
              id: `attachment-${name}`,
              name: `${name}.txt`,
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
          acceptedAt: timestamp,
        });
      });
      const first = yield* sendIn("one");
      const second = yield* sendIn("two");
      const sentSeqs = yield* (yield* SqlClient.SqlClient)<{ readonly sent_seq: number }>`
        SELECT sent_seq FROM j5_a2a_delivery ORDER BY sent_seq
      `;
      assert.lengthOf(sentSeqs, 2);
      assert.equal(sentSeqs[0]?.sent_seq, sentSeqs[1]?.sent_seq);

      const worker = yield* A2ADeliveryWorker;
      assert.equal((yield* worker.runOnce)?.state, "delivered");
      assert.equal((yield* worker.runOnce)?.state, "delivered");
      const byMessage = new Map(yield* Ref.get(delivered));
      assert.deepStrictEqual(byMessage.get(first.messageId), ["attachment-one"]);
      assert.deepStrictEqual(byMessage.get(second.messageId), ["attachment-two"]);
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("delivers to the human through the idempotent inbox-data transport", () =>
  Effect.gen(function* () {
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const ledger = ledgerLayer.pipe(Layer.provide(database));
    const send = sendLayer.pipe(
      Layer.provide(peerDirectoryNoneLayer),
      Layer.provide(ledger),
      Layer.provide(database),
    );
    const threadManagement = Layer.mock(ThreadManagementService)({});
    const transport = deliveryTransportLive.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.mock(PeerRegistryService)({})),
      Layer.provide(database),
      Layer.provide(threadManagement),
      Layer.provide(Layer.mock(OrchestratorV2)({})),
      Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
    );
    const worker = deliveryWorkerLayerWithHooks(false).pipe(
      Layer.provide(ledger),
      Layer.provide(database),
      Layer.provide(transport),
      Layer.provide(
        Layer.succeed(
          A2ADeliveryHooks,
          A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
        ),
      ),
    );
    const layer = Layer.mergeAll(database, ledger, send, transport, worker);

    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const ledgerService = yield* A2ALedger;
      const projectId = LedgerProjectId.make("project:delivery:human");
      yield* ledgerService.ensureProject({ projectId: projectId, createdAt: timestamp });
      yield* join(projectId, sender, "human-sender");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${person.id}, 1, ${timestamp})
      `;
      // The first owner writes to every thread, as the server records them at startup.
      yield* sql`
        INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at)
        VALUES (${person.id}, 'server', '', 'owner', ${timestamp}, ${timestamp})
      `;
      const sent = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:delivery:human"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "Human inbox payload",
        expectReply: true,
        intent: "Obtain a human answer",
        urgency: "soon",
        acceptedAt: timestamp,
      });
      const delivery = yield* (yield* A2ADeliveryWorker).runOnce;
      assert.equal(delivery?.state, "delivered");

      const rows = yield* sql<{
        readonly message_id: string;
        readonly payload: string;
        readonly receiver_id: string;
      }>`
        SELECT message_id, payload, receiver_id
        FROM j5_a2a_human_inbox_data
        WHERE origin_project_id = ${projectId}
      `;
      assert.deepStrictEqual(rows, [
        {
          message_id: sent.messageId,
          payload: "Human inbox payload",
          receiver_id: person.id,
        },
      ]);
      const inbox = yield* sql<{
        readonly person_id: string;
        readonly exchange_id: string;
        readonly status: string;
        readonly urgency: string;
      }>`
        SELECT person_id, exchange_id, status, urgency
        FROM j5_a2a_human_inbox
      `;
      assert.deepStrictEqual(inbox, [
        {
          person_id: person.id,
          exchange_id: sent.exchangeId!,
          status: "open",
          urgency: "soon",
        },
      ]);
      assert.isNull(yield* (yield* A2ADeliveryWorker).runOnce);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "treats a historical follow-up delivered after the human answered as a successful no-op",
  () =>
    Effect.gen(function* () {
      const database = NodeSqliteClient.layer({ filename: ":memory:" });
      const ledger = ledgerLayer.pipe(Layer.provide(database));
      const send = sendLayer.pipe(
        Layer.provide(peerDirectoryNoneLayer),
        Layer.provide(ledger),
        Layer.provide(database),
      );
      const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
      const transport = deliveryTransportLive.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.mock(PeerRegistryService)({})),
        Layer.provide(database),
        Layer.provide(Layer.mock(ThreadManagementService)({})),
        Layer.provide(Layer.mock(OrchestratorV2)({})),
        Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
      );
      const worker = deliveryWorkerLayerWithHooks(false).pipe(
        Layer.provide(ledger),
        Layer.provide(database),
        Layer.provide(transport),
        Layer.provide(
          Layer.succeed(
            A2ADeliveryHooks,
            A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
          ),
        ),
      );
      const layer = Layer.mergeAll(database, ledger, send, inbox, transport, worker);

      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const ledgerService = yield* A2ALedger;
        const sendService = yield* A2ASendService;
        const deliveryWorker = yield* A2ADeliveryWorker;
        const sql = yield* SqlClient.SqlClient;
        const projectId = LedgerProjectId.make("project:delivery:human-followup-race");
        yield* ledgerService.ensureProject({ projectId: projectId, createdAt: timestamp });
        yield* join(projectId, sender, "human-followup-race-sender");
        yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${person.id}, 1, ${timestamp})
      `;
        // The first owner writes to every thread, as the server records them at startup.
        yield* sql`
          INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at)
          VALUES (${person.id}, 'server', '', 'owner', ${timestamp}, ${timestamp})
        `;
        const opened = yield* sendService.send({
          commandId: CommCommandId.make("command:delivery:human-followup-race:open"),
          senderThreadId: sender.threadId,
          to: person.id,
          message: "Initial question",
          expectReply: true,
          intent: "Reproduce answer racing a follow-up",
          urgency: "blocking",
          acceptedAt: timestamp,
        });
        assert.equal((yield* deliveryWorker.runOnce)?.state, "delivered");

        const followupMessageId = LedgerMessageId.make(
          "message:delivery:human-followup-race:legacy-followup",
        );
        yield* ledgerService.append({
          commandId: CommCommandId.make("command:delivery:human-followup-race:legacy-followup"),
          projectId,
          acceptedAt: "2026-08-16T12:00:01.000Z",
          event: {
            kind: "message.sent",
            sender: sender.id,
            receiver: person.id,
            exchangeId: opened.exchangeId!,
            correlationId: CorrelationId.make(
              "correlation:delivery:human-followup-race:legacy-followup",
            ),
            payload: {
              messageId: followupMessageId,
              text: "Pending historical follow-up",
              originProjectId: projectId,
              receiverProjectId: projectId,
              exchangeRole: "followup",
              envelopeChannel: "peer",
            },
            createdAt: "2026-08-16T12:00:01.000Z",
          },
        });
        yield* (yield* A2AHumanInbox).answer({
          commandId: CommCommandId.make("command:delivery:human-followup-race:answer"),
          personId: person.id,
          exchangeId: opened.exchangeId!,
          message: "Answered before follow-up transport",
          acceptedAt: "2026-08-16T12:00:02.000Z",
        });

        const milestone = yield* deliveryWorker.runOnce;
        assert.equal(milestone?.messageId, followupMessageId);
        assert.equal(milestone?.state, "delivered");
        const rows = yield* sql<{
          readonly attempts: number;
          readonly last_error: string | null;
          readonly status: string;
        }>`
        SELECT status, attempts, last_error
        FROM j5_a2a_delivery
        WHERE message_id = ${followupMessageId}
      `;
        assert.deepStrictEqual(rows, [{ status: "delivered", attempts: 1, last_error: null }]);
        assert.deepStrictEqual(yield* deliveryWorker.listAlarms, []);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([true, false])(
  "receipts a human lifecycle notice with retained terminal history (ask delivered=%s)",
  (deliveredBeforeClosure) =>
    Effect.gen(function* () {
      const database = NodeSqliteClient.layer({ filename: ":memory:" });
      const ledger = ledgerLayer.pipe(Layer.provide(database));
      const send = sendLayer.pipe(
        Layer.provide(peerDirectoryNoneLayer),
        Layer.provide(ledger),
        Layer.provide(database),
      );
      const transport = deliveryTransportLive.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.mock(PeerRegistryService)({})),
        Layer.provide(database),
        Layer.provide(Layer.mock(ThreadManagementService)({})),
        Layer.provide(Layer.mock(OrchestratorV2)({})),
        Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
      );
      const worker = deliveryWorkerLayerWithHooks(false).pipe(
        Layer.provide(ledger),
        Layer.provide(database),
        Layer.provide(transport),
        Layer.provide(
          Layer.succeed(
            A2ADeliveryHooks,
            A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
          ),
        ),
      );
      const layer = Layer.mergeAll(database, ledger, send, transport, worker);

      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const ledgerService = yield* A2ALedger;
        const sendService = yield* A2ASendService;
        const deliveryWorker = yield* A2ADeliveryWorker;
        const sql = yield* SqlClient.SqlClient;
        const projectId = LedgerProjectId.make("project:delivery:human-lifecycle");
        const noticeMessageId = LedgerMessageId.make("message:delivery:human-lifecycle");
        const correlationId = CorrelationId.make("correlation:delivery:human-lifecycle");
        yield* ledgerService.ensureProject({ projectId: projectId, createdAt: timestamp });
        yield* join(projectId, sender, "human-lifecycle-sender");
        yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${person.id}, 1, ${timestamp})
      `;
        // The first owner writes to every thread, as the server records them at startup.
        yield* sql`
          INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at)
          VALUES (${person.id}, 'server', '', 'owner', ${timestamp}, ${timestamp})
        `;
        const opened = yield* sendService.send({
          commandId: CommCommandId.make("command:delivery:human-lifecycle:open"),
          senderThreadId: sender.threadId,
          to: person.id,
          message: "This person-addressed obligation will be dropped loudly.",
          expectReply: true,
          intent: "Prove lifecycle notices stay non-actionable",
          urgency: "soon",
          acceptedAt: timestamp,
        });
        if (deliveredBeforeClosure)
          assert.equal((yield* deliveryWorker.runOnce)?.state, "delivered");
        yield* ledgerService.appendEvents({
          commandId: CommCommandId.make("command:delivery:human-lifecycle:drop"),
          projectId,
          acceptedAt: timestamp,
          events: [
            {
              kind: "exchange.dropped",
              sender: sender.id,
              receiver: person.id,
              exchangeId: opened.exchangeId!,
              correlationId,
              payload: {
                disposition: "sender-retired",
                cause: {
                  kind: "participant-archived",
                  participantId: sender.id,
                  projectId: projectId,
                },
                facts: {
                  replyRequired: false,
                  retryAllowed: false,
                  replacementRequired: false,
                },
                noticeMessageId,
              },
              createdAt: timestamp,
            },
            {
              kind: "message.sent",
              sender: LIFECYCLE_PARTICIPANT_ID,
              receiver: person.id,
              exchangeId: opened.exchangeId!,
              correlationId,
              payload: {
                messageId: noticeMessageId,
                text: "The exchange was dropped because its agent sender retired from A2A.",
                originProjectId: projectId,
                receiverProjectId: projectId,
                exchangeRole: "terminal_notice",
                envelopeChannel: "lifecycle_notice",
              },
              createdAt: timestamp,
            },
          ],
        });

        if (!deliveredBeforeClosure) {
          yield* ledgerService.append({
            commandId: CommCommandId.make("human-lifecycle:cancel-ask"),
            projectId,
            acceptedAt: timestamp,
            event: {
              kind: "message.cancelled",
              sender: null,
              receiver: person.id,
              exchangeId: null,
              correlationId: null,
              payload: { messageId: opened.messageId, reason: "Asker archived before delivery." },
              createdAt: timestamp,
            },
          });
        }
        const delivery = yield* deliveryWorker.runOnce;
        assert.equal(delivery?.state, "delivered");
        const rawRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM j5_a2a_human_inbox_data
        WHERE origin_project_id = ${projectId}
      `;
        const inboxRows = yield* sql<{
          readonly cause_participant_id: string;
          readonly replacement_required: number;
          readonly reply_required: number;
          readonly retry_allowed: number;
          readonly status: string;
          readonly terminal_disposition: string | null;
          readonly terminal_notice_message_id: string | null;
        }>`
        SELECT
          status,
          terminal_disposition,
          terminal_notice_message_id,
          json_extract(terminal_cause, '$.participantId') AS cause_participant_id,
          json_extract(terminal_facts, '$.replyRequired') AS reply_required,
          json_extract(terminal_facts, '$.retryAllowed') AS retry_allowed,
          json_extract(terminal_facts, '$.replacementRequired') AS replacement_required
        FROM j5_a2a_human_inbox
        WHERE person_id = ${person.id} AND exchange_id = ${opened.exchangeId!}
      `;
        const receipt = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM j5_a2a_delivery
        WHERE message_id = ${noticeMessageId}
      `;
        assert.deepStrictEqual(rawRows, [{ count: deliveredBeforeClosure ? 1 : 0 }]);
        assert.deepStrictEqual(inboxRows, [
          {
            cause_participant_id: sender.id,
            replacement_required: 0,
            reply_required: 0,
            retry_allowed: 0,
            status: "dropped",
            terminal_disposition: "sender-retired",
            terminal_notice_message_id: noticeMessageId,
          },
        ]);
        assert.deepStrictEqual(receipt, [{ status: "delivered" }]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["cancelled", "delivered"] as const)(
  "reports the confirmed transport outcome after concurrent archive (%s)",
  (outcome) =>
    Effect.gen(function* () {
      const afterTransport = yield* Ref.make<Effect.Effect<void, A2ADeliveryHookError>>(
        Effect.void,
      );
      yield* Effect.gen(function* () {
        const { senderProjectId, sent } = yield* seedSend(false);
        const ledger = yield* A2ALedger;
        yield* Ref.set(
          afterTransport,
          ledger
            .append({
              commandId: CommCommandId.make("delivery:concurrent-archive"),
              projectId: senderProjectId,
              acceptedAt: timestamp,
              event: {
                kind: "participant.archived",
                sender: null,
                receiver: receiver.id,
                exchangeId: null,
                correlationId: null,
                payload: { participant: receiver },
                createdAt: timestamp,
              },
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new A2ADeliveryHookError({ cause })),
            ),
        );
        const milestones = yield* (yield* A2ADeliveryWorker).drain;
        assert.deepStrictEqual(
          milestones.map((entry) => entry.state),
          [outcome],
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT status, next_attempt_at FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`,
          [{ status: outcome, next_attempt_at: null }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT kind FROM j5_a2a_comm_event WHERE kind IN ('message.delivered', 'message.cancelled')`,
          [{ kind: `message.${outcome}` }],
        );
        assert.lengthOf(yield* (yield* A2ADeliveryWorker).drain, 0);
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {
              deliverAgent: () => Effect.void,
              cancelAgent: () => Effect.succeed(outcome),
              deliverPeer: () => Effect.die("peer delivery is not under test"),
              deliverHuman: () => Effect.void,
            },
            {
              afterTransportSuccess: () =>
                Ref.get(afterTransport).pipe(Effect.flatMap((effect) => effect)),
            },
          ),
        ),
      );
    }),
);

it.effect(
  "records a peer-accepted delivery as delivered even if the sender retired during the call",
  () =>
    Effect.gen(function* () {
      const database = NodeSqliteClient.layer({ filename: ":memory:" });
      const ledger = ledgerLayer.pipe(Layer.provide(database));
      const transportLayer = Layer.succeed(
        A2ADeliveryTransport,
        A2ADeliveryTransport.of({
          deliverAgent: () => Effect.die("local delivery is not under test"),
          cancelAgent: () => Effect.succeed("cancelled" as const),
          deliverPeer: () => Effect.void,
          deliverHuman: () => Effect.void,
        }),
      );
      // The peer has answered 2xx; before this ledger records it, the sender is archived here.
      const hooks = Layer.effect(
        A2ADeliveryHooks,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return A2ADeliveryHooks.of({
            afterTransportSuccess: () =>
              sql`UPDATE j5_a2a_membership SET archived_at = ${timestamp}
                WHERE participant_id = ${sender.id}`.pipe(Effect.orDie),
          });
        }),
      ).pipe(Layer.provide(database));
      const worker = deliveryWorkerLayerWithHooks(false).pipe(
        Layer.provide(ledger),
        Layer.provide(database),
        Layer.provide(transportLayer),
        Layer.provide(hooks),
      );
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const projectId = LedgerProjectId.make("project:delivery:peer-race");
        yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt: timestamp });
        yield* join(projectId, sender, "peer-race");
        yield* (yield* A2ALedger).append({
          commandId: CommCommandId.make("command:delivery:peer-race:send"),
          projectId,
          acceptedAt: timestamp,
          event: {
            kind: "message.sent",
            sender: sender.id,
            receiver: receiver.id,
            exchangeId: null,
            correlationId: CorrelationId.make("correlation:delivery:peer-race"),
            payload: {
              messageId: LedgerMessageId.make("message:delivery:peer-race"),
              text: "hello over there",
              originProjectId: projectId,
              receiverProjectId: LedgerProjectId.make("project:home"),
              receiverEnvironmentId: "environment-home",
              exchangeRole: "none",
              envelopeChannel: "peer",
            },
            createdAt: timestamp,
          },
        });
        const milestone = yield* (yield* A2ADeliveryWorker).runOnce;
        assert.equal(milestone?.state, "delivered");
        const sql = yield* SqlClient.SqlClient;
        const recorded = yield* sql<{ readonly kind: string }>`
          SELECT kind FROM j5_a2a_comm_event
          WHERE project_id = ${projectId} AND kind IN ('message.delivered', 'message.cancelled')
        `;
        assert.deepStrictEqual(recorded, [{ kind: "message.delivered" }]);
      }).pipe(Effect.provide(Layer.mergeAll(database, ledger, transportLayer, worker)));
    }),
);
