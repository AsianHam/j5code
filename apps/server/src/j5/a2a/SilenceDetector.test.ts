import { assert, it } from "@effect/vitest";
import {
  MessageId,
  EventId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import {
  EventSinkStreamError,
  EventSinkV2,
  type EventSinkV2Shape,
} from "../../orchestration-v2/EventSink.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import {
  A2ADeliveryTransport,
  type A2ADeliveryTransportShape,
  deliveryMessageId,
} from "./DeliveryTransport.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  A2ASilenceDetector,
  REMOVED_NOTICE_TYPE,
  removedNoticeMessage,
  SilenceNoticePayload,
  STOPPED_NOTICE_INSTRUCTION,
  layer as liveSilenceDetectorLayer,
  manualLayer as silenceDetectorLayer,
} from "./SilenceDetector.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  MessageSentPayload,
  LedgerProjectId,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  type AgentParticipant,
  type HumanParticipant,
} from "./contracts.ts";

const projectId = LedgerProjectId.make("project:silence-test");
const waiter: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:waiter"),
  threadId: ThreadId.make("thread:silence:waiter"),
};
const subject: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:subject"),
  threadId: ThreadId.make("thread:silence:subject"),
};
const peer: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:peer"),
  threadId: ThreadId.make("thread:silence:peer"),
};
const newerPeer: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:newer-peer"),
  threadId: ThreadId.make("thread:silence:newer-peer"),
};
const person: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:silence-person"),
};
const failureDetail = {
  class: "provider_error" as const,
  message: "Provider exited with the measured failure detail.",
  code: "TEST_FAILURE",
  retryable: false,
} satisfies OrchestrationV2ProviderFailure;

const iso = (second: number) => `2026-08-19T12:00:${String(second).padStart(2, "0")}.000Z`;
const decodeSilenceNotice = Schema.decodeUnknownEffect(SilenceNoticePayload);
const decodeMessageSentPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MessageSentPayload),
);

const defaultRunId = RunId.make("run:silence:test");

/**
 * The receiver's thread as the detector reads it. Each test layer starts it over with the
 * default run; `seedInbound` records which run a delivered ask belongs to.
 */
const thread: {
  thread: { archivedAt: string | null; deletedAt: string | null };
  runs: Array<OrchestrationV2Run>;
  messages: Array<{ readonly id: MessageId; readonly runId: RunId }>;
} = { thread: { archivedAt: null, deletedAt: null }, runs: [], messages: [] };

const threadMock = (overrides: Partial<ThreadManagementService["Service"]> = {}) => {
  thread.thread = { archivedAt: null, deletedAt: null };
  thread.runs = [runOf(terminalEvent("completed"))];
  thread.messages = [];
  return Layer.mock(ThreadManagementService)({
    getThreadRecords: (() => Effect.succeed(thread)) as never,
    ...overrides,
  });
};

const makeTestLayer = () => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const threads = threadMock({
    getThreadProjection: () =>
      Effect.succeed({
        turnItems: [
          {
            runId: RunId.make("run:silence:test"),
            type: "error",
            status: "failed",
            failure: failureDetail,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection),
  });
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      deliverAgent: () => Effect.void,
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    } satisfies A2ADeliveryTransportShape),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const detector = silenceDetectorLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(threads),
    Layer.provide(Layer.mock(EventSinkV2)({})),
    Layer.provideMerge(crewInstanceLayer.pipe(Layer.provide(database))),
    Layer.provideMerge(worker),
  );
  return Layer.mergeAll(database, ledger, send, detector);
};

const makeDaemonTestLayer = (
  storedEvents: (input?: {
    readonly afterSequence?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent>,
  latestSequence: EventSinkV2Shape["latestSequence"],
) => {
  const database = SqlitePersistenceMemory;
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const threads = threadMock({ streamStoredEventsFrom: storedEvents });
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      deliverAgent: () => Effect.void,
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer: () => Effect.die("peer delivery is not under test"),
      deliverHuman: () => Effect.void,
    } satisfies A2ADeliveryTransportShape),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const detector = liveSilenceDetectorLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(threads),
    Layer.provide(Layer.mock(EventSinkV2)({ latestSequence })),
    Layer.provideMerge(crewInstanceLayer.pipe(Layer.provide(database))),
    Layer.provideMerge(worker),
  );
  return Layer.mergeAll(database, ledger, send, detector);
};

const join = Effect.fn("test.j5.a2a.silence.join")(function* (
  participant: AgentParticipant,
  suffix: string,
) {
  const participantId = participant.id;
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:join:${suffix}`),
    projectId,
    acceptedAt: iso(0),
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: participantId,
      exchangeId: null,
      correlationId: null,
      payload: { participant },
      createdAt: iso(0),
    },
  });
});

const seed = Effect.fn("test.j5.a2a.silence.seed")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES (${person.id}, 1, ${iso(0)})
  `;
  yield* ledger.ensureProject({ projectId: projectId, createdAt: iso(0) });
  yield* join(waiter, "waiter");
  yield* join(subject, "subject");
  yield* join(peer, "peer");
  yield* join(newerPeer, "newer-peer");
});

const openExchange = Effect.fn("test.j5.a2a.silence.openExchange")(function* (
  from: AgentParticipant,
  to: ParticipantId,
  suffix: string,
  acceptedAtSecond = 0,
) {
  return yield* (yield* A2ASendService).send({
    commandId: CommCommandId.make(`command:silence:send:${suffix}`),
    senderThreadId: from.threadId,
    to,
    message: `Silence detector request ${suffix}`,
    expectReply: true,
    intent: `Prove ${suffix}`,
    ...(to === person.id ? { urgency: "blocking" as const } : {}),
    acceptedAt: iso(acceptedAtSecond),
  });
});

const markDelivered = Effect.fn("test.j5.a2a.silence.markDelivered")(function* (
  messageId: LedgerMessageId,
  exchangeId: ExchangeId,
  senderId: ParticipantId,
  receiverId: ParticipantId,
  second: number,
  channel: "agent" | "human" = "agent",
) {
  const result = yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:delivered:${messageId}`),
    projectId,
    acceptedAt: iso(second),
    event: {
      kind: "message.delivered",
      sender: senderId,
      receiver: receiverId,
      exchangeId,
      correlationId: CorrelationId.make(`correlation:silence:delivered:${messageId}`),
      payload: { messageId, attempt: 1, channel },
      createdAt: iso(second),
    },
  });
  return result.event;
});

const markAlarmed = Effect.fn("test.j5.a2a.silence.markAlarmed")(function* (
  messageId: LedgerMessageId,
  exchangeId: ExchangeId,
  senderId: ParticipantId,
  receiverId: ParticipantId,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:alarmed:${messageId}`),
    projectId,
    acceptedAt: iso(1),
    event: {
      kind: "message.delivery_failed",
      sender: senderId,
      receiver: receiverId,
      exchangeId,
      correlationId: CorrelationId.make(`correlation:silence:alarmed:${messageId}`),
      payload: {
        messageId,
        attempt: 3,
        error: "Human inbox delivery failed",
        nextAttemptAt: null,
        alarmed: true,
      },
      createdAt: iso(1),
    },
  });
});

const silenceAppendCommand = (
  exchangeId: ExchangeId,
  deliveryMessageId: LedgerMessageId,
  suffix: string,
) => {
  const observedAt = iso(6);
  const correlationId = CorrelationId.make(`correlation:silence:serialization:${suffix}`);
  return {
    commandId: CommCommandId.make(`command:silence:serialization:${suffix}`),
    projectId,
    acceptedAt: observedAt,
    events: [
      {
        kind: "silence.notice" as const,
        sender: null,
        receiver: waiter.id,
        exchangeId,
        correlationId,
        payload: {
          subjectId: subject.id,
          deliveryMessageId,
          observedAt,
          state: "turn-ended-no-reply" as const,
          runId: null,
          processing: "never-processed" as const,
        },
        createdAt: observedAt,
      },
      {
        kind: "message.sent" as const,
        sender: SILENCE_DETECTOR_PARTICIPANT_ID,
        receiver: waiter.id,
        exchangeId: null,
        correlationId,
        payload: {
          messageId: LedgerMessageId.make(`message:silence:serialization:${suffix}`),
          text: "Serialization seam silence notice",
          originProjectId: projectId,
          receiverProjectId: projectId,
          exchangeRole: "none" as const,
          envelopeChannel: "silence_notice" as const,
        },
        createdAt: observedAt,
      },
    ],
  };
};

const dropExchange = Effect.fn("test.j5.a2a.silence.dropExchange")(function* (
  exchangeId: ExchangeId,
  suffix: string,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:serialization:drop:${suffix}`),
    projectId,
    acceptedAt: iso(5),
    event: {
      kind: "exchange.dropped",
      sender: waiter.id,
      receiver: subject.id,
      exchangeId,
      correlationId: CorrelationId.make(`correlation:silence:serialization:drop:${suffix}`),
      payload: {
        disposition: "receiver-retired",
        cause: {
          kind: "participant-archived",
          participantId: subject.id,
          projectId: projectId,
        },
        facts: {
          replyRequired: false,
          retryAllowed: false,
          replacementRequired: false,
        },
        noticeMessageId: LedgerMessageId.make(`message:silence:serialization:drop:${suffix}`),
      },
      createdAt: iso(5),
    },
  });
});

const terminalEvent = (
  status: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back",
  sequence = 100,
  carries: {
    readonly id: RunId;
    readonly userMessageId: MessageId;
    readonly completedAtSecond: number;
  } = {
    id: defaultRunId,
    userMessageId: MessageId.make("message:silence:upstream"),
    completedAtSecond: 3,
  },
  started = true,
): OrchestrationV2StoredEvent => {
  const completedAt = DateTime.makeUnsafe(iso(carries.completedAtSecond));
  const runId = carries.id;
  return {
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`event:silence:${status}:${sequence}`),
      type: "run.updated",
      threadId: subject.threadId,
      runId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt: completedAt,
      payload: {
        id: runId,
        threadId: subject.threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: carries.userMessageId,
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: DateTime.makeUnsafe(iso(0)),
        startedAt: started ? DateTime.makeUnsafe(iso(1)) : null,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  };
};

const readNotices = Effect.fn("test.j5.a2a.silence.readNotices")(function* () {
  const page = yield* (yield* A2ALedger).readEvents({
    projectId,
    cursor: { afterSeq: 0 },
    limit: 100,
  });
  return yield* Effect.forEach(
    page.events.filter((event) => event.kind === "silence.notice"),
    (event) => decodeSilenceNotice(event.payload),
  );
});

const seedInbound = Effect.fn("test.j5.a2a.silence.seedInbound")(function* (
  deliveredAt: number,
  // The run the delivered ask belongs to; null when the thread never took the message.
  owner: RunId | null = defaultRunId,
) {
  const exchange = yield* openExchange(waiter, subject.id, `inbound-${deliveredAt}`);
  assert.isNotNull(exchange.exchangeId);
  if (owner !== null) {
    thread.messages.push({ id: deliveryMessageId(exchange.messageId), runId: owner });
  }
  const deliveryEvent = yield* markDelivered(
    exchange.messageId,
    exchange.exchangeId!,
    waiter.id,
    subject.id,
    deliveredAt,
  );
  return { ...exchange, deliveryEvent };
});

const captureNoticeIdentity = (producer: "delivery" | "lifecycle") =>
  Effect.gen(function* () {
    yield* seed();
    const exchange = yield* seedInbound(2);
    const detector = yield* A2ASilenceDetector;
    if (producer === "delivery") {
      yield* detector.handleDeliveryEvent(exchange.deliveryEvent);
    } else {
      yield* detector.handleStoredEvent(terminalEvent("completed"));
    }

    const rows = yield* (yield* SqlClient.SqlClient)<{
      readonly command_id: string;
      readonly correlation_id: string;
      readonly message_id: string;
    }>`
      SELECT command_id, correlation_id, message_id
      FROM j5_a2a_delivery
      WHERE envelope_channel = 'silence_notice'
    `;
    assert.lengthOf(rows, 1);
    return { exchange, identity: rows[0]! };
  }).pipe(Effect.provide(makeTestLayer()));

it.effect("uses one receipt identity across delivery and lifecycle producers", () =>
  Effect.gen(function* () {
    const fromDelivery = yield* captureNoticeIdentity("delivery");
    const fromLifecycle = yield* captureNoticeIdentity("lifecycle");

    assert.deepStrictEqual(fromDelivery.identity, fromLifecycle.identity);
    const noticeIdentity = [
      projectId,
      fromDelivery.exchange.exchangeId!,
      fromDelivery.exchange.messageId,
    ]
      .map(encodeURIComponent)
      .join(":");
    assert.deepStrictEqual(fromDelivery.identity, {
      command_id: `command:j5:a2a:silence:${noticeIdentity}`,
      correlation_id: `correlation:j5:a2a:silence:${noticeIdentity}`,
      message_id: `message:j5:a2a:silence:${noticeIdentity}`,
    });
  }),
);

it.effect("emits processed mid-turn silence and dedupes a later lifecycle sequence", () =>
  Effect.gen(function* () {
    yield* seed();
    const exchange = yield* seedInbound(2);
    const detector = yield* A2ASilenceDetector;
    yield* detector.handleStoredEvent(terminalEvent("completed"));
    yield* detector.handleStoredEvent(terminalEvent("completed", 101));

    const notices = yield* readNotices();
    assert.lengthOf(notices, 1, "a later lifecycle event must not duplicate the notice");
    assert.equal(notices[0]?.state, "turn-ended-no-reply");
    if (notices[0]?.state === "turn-ended-no-reply") {
      assert.equal(notices[0].processing, "processed");
    }
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${exchange.exchangeId}
    `;
    assert.deepStrictEqual(rows, [{ status: "open" }]);
    const deliveries = yield* sql<{
      readonly command_id: string;
      readonly correlation_id: string;
      readonly envelope_channel: string;
      readonly message_id: string;
      readonly message_text: string;
      readonly sender_id: string;
      readonly status: string;
    }>`
      SELECT
        command_id,
        correlation_id,
        envelope_channel,
        message_id,
        message_text,
        sender_id,
        status
      FROM j5_a2a_delivery
      WHERE envelope_channel = 'silence_notice'
    `;
    assert.lengthOf(deliveries, 1);
    const noticeDelivery = deliveries[0]!;
    assert.equal(noticeDelivery.envelope_channel, "silence_notice");
    assert.include(noticeDelivery.message_text, "platform-authored delivery signal");
    assert.notInclude(noticeDelivery.message_text, "[Cross-agent message from");
    assert.equal(noticeDelivery.sender_id, SILENCE_DETECTOR_PARTICIPANT_ID);
    assert.equal(noticeDelivery.status, "pending");
    const noticeIdentity = [projectId, exchange.exchangeId!, exchange.messageId]
      .map(encodeURIComponent)
      .join(":");
    assert.equal(noticeDelivery.command_id, `command:j5:a2a:silence:${noticeIdentity}`);
    assert.equal(noticeDelivery.message_id, `message:j5:a2a:silence:${noticeIdentity}`);
    assert.equal(noticeDelivery.correlation_id, `correlation:j5:a2a:silence:${noticeIdentity}`);

    const milestones = yield* (yield* A2ADeliveryWorker).drain;
    assert.isTrue(
      milestones.some((milestone) => milestone.messageId === noticeDelivery.message_id),
      "the existing A2 worker must drain the typed silence-notice row",
    );
    const delivered = yield* sql<{ readonly status: string }>`
      SELECT status FROM j5_a2a_delivery WHERE message_id = ${noticeDelivery.message_id}
    `;
    assert.deepStrictEqual(delivered, [{ status: "delivered" }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

const runOf = (stored: OrchestrationV2StoredEvent): OrchestrationV2Run => {
  if (stored.event.type !== "run.updated") throw new Error("expected a run event");
  return stored.event.payload;
};

const carrierRunId = RunId.make("run:silence:carrier");

const otherRun = (name: string, completedAtSecond: number, sequence = 100) =>
  terminalEvent("completed", sequence, {
    id: RunId.make(`run:silence:${name}`),
    userMessageId: MessageId.make(`message:silence:${name}`),
    completedAtSecond,
  });

const carrierRun = (
  messageId: LedgerMessageId,
  completedAtSecond: number,
  sequence = 101,
  status: "completed" | "cancelled" = "completed",
) =>
  terminalEvent(status, sequence, {
    id: carrierRunId,
    userMessageId: deliveryMessageId(messageId),
    completedAtSecond,
  });

it.effect("waits for the run that carries a queued ask before reporting silence (#433)", () =>
  Effect.gen(function* () {
    yield* seed();
    const ask = yield* seedInbound(2, carrierRunId);
    const busy = otherRun("busy", 3);
    const carrier = carrierRun(ask.messageId, 5);
    thread.runs = [runOf(busy), runOf(carrier)];
    const detector = yield* A2ASilenceDetector;

    yield* detector.handleStoredEvent(busy);
    assert.lengthOf(yield* readNotices(), 0, "the run that was already busy never saw the ask");

    yield* detector.handleStoredEvent(carrier);
    const notices = yield* readNotices();
    assert.lengthOf(notices, 1);
    assert.equal(notices[0]?.state, "turn-ended-no-reply");
    assert.equal(notices[0]?.runId, carrierRunId);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("reconciling stays quiet while the run that carries the ask is still queued", () =>
  Effect.gen(function* () {
    yield* seed();
    const ask = yield* seedInbound(2, carrierRunId);
    thread.runs = [
      { ...runOf(carrierRun(ask.messageId, 0)), status: "queued", completedAt: null },
      { ...runOf(otherRun("later", 4)), status: "cancelled" },
    ];
    yield* (yield* A2ASilenceDetector).reconcileOpenExchanges;
    assert.lengthOf(yield* readNotices(), 0, "a later run ending is not the ask's run ending");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("reports the carrying run when its delivery is recorded after it ended", () =>
  Effect.gen(function* () {
    yield* seed();
    const ask = yield* seedInbound(4, carrierRunId);
    const carrier = carrierRun(ask.messageId, 3, 100);
    const later = otherRun("later", 5, 101);
    thread.runs = [runOf(carrier), { ...runOf(later), status: "queued", completedAt: null }];
    const detector = yield* A2ASilenceDetector;

    yield* detector.handleStoredEvent(carrier);
    yield* detector.handleDeliveryEvent(ask.deliveryEvent);
    thread.runs = [runOf(carrier), runOf(later)];
    yield* detector.handleStoredEvent(later);

    const notices = yield* readNotices();
    assert.lengthOf(notices, 1);
    assert.equal(notices[0]?.runId, carrierRunId);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("follows a queued ask promoted into the running turn (#435)", () =>
  Effect.gen(function* () {
    yield* seed();
    const running = otherRun("running", 5, 101);
    // Promotion cancels the queued run and moves its message into the running turn.
    const ask = yield* seedInbound(2, runOf(running).id);
    const promoted = carrierRun(ask.messageId, 3, 100, "cancelled");
    thread.runs = [{ ...runOf(running), status: "running", completedAt: null }, runOf(promoted)];
    const detector = yield* A2ASilenceDetector;

    yield* detector.handleStoredEvent(promoted);
    yield* detector.reconcileOpenExchanges;
    assert.lengthOf(yield* readNotices(), 0, "the turn that took the ask can still answer it");

    thread.runs = [runOf(running), runOf(promoted)];
    yield* detector.handleStoredEvent(running);
    const notices = yield* readNotices();
    assert.lengthOf(notices, 1);
    assert.equal(notices[0]?.state, "turn-ended-no-reply");
    assert.equal(notices[0]?.runId, runOf(running).id);
  }).pipe(Effect.provide(makeTestLayer())),
);

/** A message the waiter sent the subject without asking for a reply, queued as `carrierRunId`. */
const seedQueuedMessage = Effect.fn("test.j5.a2a.silence.seedQueuedMessage")(function* () {
  const sent = yield* (yield* A2ASendService).send({
    commandId: CommCommandId.make("command:silence:send:queued"),
    senderThreadId: waiter.threadId,
    to: subject.id,
    message: "Queued update that never ran",
    acceptedAt: iso(1),
  });
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make("command:silence:delivered:queued"),
    projectId,
    acceptedAt: iso(2),
    event: {
      kind: "message.delivered",
      sender: waiter.id,
      receiver: subject.id,
      exchangeId: null,
      correlationId: CorrelationId.make("correlation:silence:delivered:queued"),
      payload: { messageId: sent.messageId, attempt: 1, channel: "agent" },
      createdAt: iso(2),
    },
  });
  thread.messages.push({ id: deliveryMessageId(sent.messageId), runId: carrierRunId });
  // Removed from the queue: the run ended without ever starting.
  const removed = terminalEvent(
    "cancelled",
    100,
    { id: carrierRunId, userMessageId: deliveryMessageId(sent.messageId), completedAtSecond: 3 },
    false,
  );
  thread.runs = [runOf(removed)];
  return removed;
});

const readRemovedNotices = Effect.fn("test.j5.a2a.silence.readRemovedNotices")(function* () {
  return yield* (yield* SqlClient.SqlClient)<{
    readonly receiver_id: string;
    readonly message_text: string;
  }>`
    SELECT receiver_id, message_text
    FROM j5_a2a_delivery
    WHERE envelope_channel = 'silence_notice'
  `;
});

it.effect("tells the sender once when its queued message is removed before it runs", () =>
  Effect.gen(function* () {
    yield* seed();
    const removed = yield* seedQueuedMessage();
    const detector = yield* A2ASilenceDetector;

    yield* detector.handleStoredEvent(removed);
    yield* detector.handleStoredEvent(removed);

    const notices = yield* readRemovedNotices();
    assert.lengthOf(notices, 1);
    assert.equal(notices[0]?.receiver_id, waiter.id);
    assert.include(
      notices[0]?.message_text,
      `[Cross-agent messaging system notice: ${REMOVED_NOTICE_TYPE}]`,
    );
    assert.include(
      notices[0]?.message_text,
      removedNoticeMessage(subject.id, "Queued update that never ran"),
    );
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect.each(["promoted into the running turn", "archived with its receiver"] as const)(
  "says nothing about a queued message %s",
  (reason) =>
    Effect.gen(function* () {
      yield* seed();
      const removed = yield* seedQueuedMessage();
      if (reason === "archived with its receiver") {
        thread.thread = { archivedAt: iso(3), deletedAt: null };
      } else {
        thread.messages = thread.messages.map((message) => ({
          ...message,
          runId: defaultRunId,
        }));
      }

      yield* (yield* A2ASilenceDetector).handleStoredEvent(removed);

      assert.lengthOf(yield* readRemovedNotices(), 0);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("no-ops when A9 drops after the A3 read but before its serialized append", () =>
  Effect.gen(function* () {
    yield* seed();
    const inbound = yield* seedInbound(2);
    assert.isNotNull(inbound.exchangeId);
    const exchangeId = inbound.exchangeId!;
    const sql = yield* SqlClient.SqlClient;
    const observed = yield* sql<{ readonly status: string }>`
      SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}
    `;
    assert.deepStrictEqual(observed, [{ status: "open" }]);

    yield* dropExchange(exchangeId, "drop-before-append");
    const attempted = yield* (yield* A2ALedger).appendEventsIfExchangeOpen(
      silenceAppendCommand(exchangeId, inbound.messageId, "drop-before-append"),
      exchangeId,
    );
    assert.isNull(attempted);

    const rows = yield* sql<{
      readonly dropped: number;
      readonly silence: number;
      readonly silence_deliveries: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped' AND exchange_id = ${exchangeId}) AS dropped,
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'silence.notice' AND exchange_id = ${exchangeId}) AS silence,
        (SELECT COUNT(*) FROM j5_a2a_delivery WHERE envelope_channel = 'silence_notice' AND command_id = 'command:silence:serialization:drop-before-append') AS silence_deliveries
    `;
    assert.deepStrictEqual(rows, [{ dropped: 1, silence: 0, silence_deliveries: 0 }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("keeps both historical facts when A3 appends before A9 drops", () =>
  Effect.gen(function* () {
    yield* seed();
    const inbound = yield* seedInbound(2);
    assert.isNotNull(inbound.exchangeId);
    const exchangeId = inbound.exchangeId!;
    const ledger = yield* A2ALedger;
    const appended = yield* ledger.appendEventsIfExchangeOpen(
      silenceAppendCommand(exchangeId, inbound.messageId, "append-before-drop"),
      exchangeId,
    );
    assert.isNotNull(appended);
    assert.isTrue(appended!.committed);

    yield* dropExchange(exchangeId, "append-before-drop");
    const rows = yield* (yield* SqlClient.SqlClient)<{
      readonly dropped: number;
      readonly silence: number;
      readonly silence_deliveries: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped' AND exchange_id = ${exchangeId}) AS dropped,
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'silence.notice' AND exchange_id = ${exchangeId}) AS silence,
        (SELECT COUNT(*) FROM j5_a2a_delivery WHERE envelope_channel = 'silence_notice' AND command_id = 'command:silence:serialization:append-before-drop') AS silence_deliveries
    `;
    assert.deepStrictEqual(rows, [{ dropped: 1, silence: 1, silence_deliveries: 1 }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits never-processed when no turn started after the latest delivery", () =>
  Effect.gen(function* () {
    yield* seed();
    const inbound = yield* seedInbound(4, null);
    yield* (yield* A2ASilenceDetector).handleDeliveryEvent(inbound.deliveryEvent);
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "turn-ended-no-reply");
    if (notices[0]?.state === "turn-ended-no-reply") {
      assert.equal(notices[0].processing, "never-processed");
      assert.isNull(notices[0].runId);
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("daemon retries its stored-event stream and advances the durable cursor", () => {
  const stored = terminalEvent("completed", 130);
  let streamCalls = 0;
  const observedCursors: Array<number> = [];
  const gateEffect = Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const firstFailureObserved = yield* Deferred.make<void>();
    const daemonLayer = makeDaemonTestLayer(
      (input) => {
        streamCalls += 1;
        observedCursors.push(input?.afterSequence ?? 0);
        if (streamCalls === 1) {
          return Stream.concat(
            Stream.fromEffect(Deferred.succeed(firstFailureObserved, undefined)).pipe(Stream.drain),
            Stream.die("simulated stored-event stream failure"),
          );
        }
        if ((input?.afterSequence ?? 0) >= stored.sequence) return Stream.never;
        return Stream.fromEffect(Deferred.await(gate).pipe(Effect.as(stored)));
      },
      () => Effect.succeed(75),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* seed();
        yield* seedInbound(0);
        const committed = yield* (yield* A2ALedger).subscribeCommitted;
        const noticeFiber = yield* committed.pipe(
          Stream.filter((event) => event.kind === "silence.notice"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(firstFailureObserved);
        yield* TestClock.adjust(Duration.millis(250));
        yield* Deferred.succeed(gate, undefined);
        const notice = yield* Fiber.join(noticeFiber);
        assert.isTrue(Option.isSome(notice));

        const sql = yield* SqlClient.SqlClient;
        const cursor = yield* sql<{ readonly after_sequence: number | null }>`
          SELECT after_sequence
          FROM j5_a2a_silence_detector_cursor
          WHERE singleton = 1
        `;
        assert.deepStrictEqual(cursor, [{ after_sequence: stored.sequence }]);
        assert.isAtLeast(streamCalls, 2);
        assert.equal(observedCursors[0], 75);
        assert.notInclude(observedCursors, 0);
      }).pipe(Effect.provide(daemonLayer)),
    );
  });
  return gateEffect;
});

it.effect(
  "a new cursor starts at the event store's latest sequence, retrying a failed read rather than 0",
  () =>
    Effect.gen(function* () {
      const firstReadFailed = yield* Deferred.make<void>();
      const streamStarted = yield* Deferred.make<number>();
      let reads = 0;
      let streamCalls = 0;
      const daemonLayer = makeDaemonTestLayer(
        (input) => {
          streamCalls += 1;
          return Stream.fromEffect(Deferred.succeed(streamStarted, input?.afterSequence ?? 0)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          );
        },
        () =>
          Effect.suspend(() => {
            reads += 1;
            return reads === 1
              ? Deferred.succeed(firstReadFailed, undefined).pipe(
                  Effect.andThen(Effect.fail(new EventSinkStreamError({}))),
                )
              : Effect.succeed(4200);
          }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Deferred.await(firstReadFailed);
          assert.equal(streamCalls, 0);
          yield* TestClock.adjust(Duration.millis(250));
          assert.equal(yield* Deferred.await(streamStarted), 4200);
          const cursor = yield* (yield* SqlClient.SqlClient)<{
            readonly after_sequence: number | null;
          }>`
            SELECT after_sequence
            FROM j5_a2a_silence_detector_cursor
            WHERE singleton = 1
          `;
          assert.deepStrictEqual(cursor, [{ after_sequence: 4200 }]);
        }).pipe(Effect.provide(daemonLayer)),
      );
    }),
);

it.effect("backs off exponentially across consecutive lifecycle stream failures", () =>
  Effect.gen(function* () {
    const failures = yield* Queue.unbounded<number>();
    const fourthCall = yield* Deferred.make<void>();
    let streamCalls = 0;
    const daemonLayer = makeDaemonTestLayer(
      () => {
        streamCalls += 1;
        if (streamCalls <= 3) {
          return Stream.concat(
            Stream.fromEffect(Queue.offer(failures, streamCalls)).pipe(Stream.drain),
            Stream.die(`simulated lifecycle failure ${streamCalls}`),
          );
        }
        return Stream.concat(
          Stream.fromEffect(Deferred.succeed(fourthCall, undefined)).pipe(Stream.drain),
          Stream.never,
        );
      },
      () => Effect.succeed(75),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        assert.equal(yield* Queue.take(failures), 1);
        yield* TestClock.adjust(Duration.millis(249));
        assert.equal(streamCalls, 1);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(failures), 2);

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(streamCalls, 2);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(failures), 3);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(streamCalls, 3);
        yield* TestClock.adjust(Duration.millis(1));
        yield* Deferred.await(fourthCall);
        assert.equal(streamCalls, 4);
      }).pipe(Effect.provide(daemonLayer)),
    );
  }),
);

it.effect("attaches the persisted provider detail to an errored notice", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("failed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "errored");
    if (notices[0]?.state === "errored") assert.deepStrictEqual(notices[0].detail, failureDetail);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("stays quiet about a seat's failed run when the asker is its Captain", () =>
  Effect.gen(function* () {
    yield* seed();
    // The waiter commands a live Crew the subject sits in: the launch report or the seat's finish
    // notice tells it about the failure, with the run's error, so no errored notice is posted here.
    yield* (yield* AgentCrewInstanceService).record({
      id: "crew:silence",
      projectId,
      captainParticipantId: waiter.id,
      captainThreadId: waiter.threadId,
      displayName: "Silence Crew",
      brief: "Prove the rule.",
      createdAt: iso(0),
      members: [
        {
          seatName: "subject",
          agentId: "subject",
          participantId: subject.id,
          threadId: subject.threadId,
          reason: null,
        },
      ],
    });
    yield* seedInbound(0);
    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("failed"));
    assert.deepStrictEqual(yield* readNotices(), []);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("maps interrupted, cancelled, and rolled-back runs to the stop instruction", () =>
  Effect.forEach(
    ["interrupted", "cancelled", "rolled_back"] as const,
    (status, index) =>
      Effect.gen(function* () {
        yield* seed();
        yield* seedInbound(0);
        yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent(status, 110 + index));
        const notices = yield* readNotices();
        assert.equal(notices[0]?.state, "stopped/cancelled");
        if (notices[0]?.state === "stopped/cancelled") {
          assert.equal(notices[0].lifecycleStatus, status);
          assert.equal(notices[0].instruction, STOPPED_NOTICE_INSTRUCTION);
        }
      }).pipe(Effect.provide(makeTestLayer())),
    { concurrency: 1 },
  ).pipe(Effect.asVoid),
);

it.effect("emits awaiting-human with human-knows when the inbox row exists", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    const outbound = yield* openExchange(subject, person.id, "human-knows");
    assert.isNotNull(outbound.exchangeId);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO j5_a2a_human_inbox_data (
        origin_project_id, message_id, exchange_id, sender_id, receiver_id, payload, created_at
      ) VALUES (
        ${projectId}, ${outbound.messageId}, ${outbound.exchangeId}, ${subject.id},
        ${person.id}, 'Human request', ${iso(1)}
      )
    `;
    yield* markDelivered(
      outbound.messageId,
      outbound.exchangeId!,
      subject.id,
      person.id,
      1,
      "human",
    );

    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("completed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "awaiting-human");
    if (notices[0]?.state === "awaiting-human") {
      assert.equal(notices[0].humanState, "human-knows");
      assert.equal(notices[0].humanExchangeId, outbound.exchangeId);
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits awaiting-human with human-doesnt-know after terminal inbox failure", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    const outbound = yield* openExchange(subject, person.id, "human-alarmed");
    assert.isNotNull(outbound.exchangeId);
    yield* markAlarmed(outbound.messageId, outbound.exchangeId!, subject.id, person.id);

    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("completed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "awaiting-human");
    if (notices[0]?.state === "awaiting-human") {
      assert.equal(notices[0].humanState, "human-doesnt-know");
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("stores the blocking peer id structurally", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    yield* openExchange(subject, peer.id, "older-blocked-peer");
    const newestOutbound = yield* openExchange(subject, newerPeer.id, "newer-blocked-peer", 2);
    assert.isNotNull(newestOutbound.exchangeId);

    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("completed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "blocked-on-peer");
    if (notices[0]?.state === "blocked-on-peer") {
      assert.equal(notices[0].peerId, newerPeer.id);
      assert.equal(notices[0].peerExchangeId, newestOutbound.exchangeId);
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits nothing for an idle agent that owes no reply", () =>
  Effect.gen(function* () {
    yield* seed();
    const appended = yield* (yield* A2ASilenceDetector).handleStoredEvent(
      terminalEvent("completed"),
    );
    assert.deepStrictEqual(appended, []);
    assert.deepStrictEqual(yield* readNotices(), []);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "emits nothing for a reply to another project that is accepted but not yet delivered",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledger = yield* A2ALedger;
      const subjectProjectId = LedgerProjectId.make("project:silence-test:subject");
      yield* ledger.ensureProject({ projectId: projectId, createdAt: iso(0) });
      yield* ledger.ensureProject({ projectId: subjectProjectId, createdAt: iso(0) });
      yield* join(waiter, "waiter");
      yield* ledger.append({
        commandId: CommCommandId.make("command:silence:join:cross-subject"),
        projectId: subjectProjectId,
        acceptedAt: iso(0),
        event: {
          kind: "participant.joined",
          sender: null,
          receiver: subject.id,
          exchangeId: null,
          correlationId: null,
          payload: { participant: subject },
          createdAt: iso(0),
        },
      });
      const exchange = yield* seedInbound(2);
      yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:silence:send:cross-reply"),
        senderThreadId: subject.threadId,
        to: waiter.id,
        message: "Answered before the turn ended.",
        exchangeId: exchange.exchangeId!,
        acceptedAt: iso(3),
      });
      const pending = yield* (yield* SqlClient.SqlClient)<{ readonly status: string }>`
      SELECT status FROM j5_a2a_delivery WHERE exchange_role = 'reply'
    `;
      assert.deepStrictEqual(pending, [{ status: "pending" }], "the worker has not run");

      const appended = yield* (yield* A2ASilenceDetector).handleStoredEvent(
        terminalEvent("completed"),
      );
      assert.deepStrictEqual(appended, []);
      assert.deepStrictEqual(yield* readNotices(), []);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits nothing when the human is the quiet recipient", () =>
  Effect.gen(function* () {
    yield* seed();
    const outbound = yield* openExchange(subject, person.id, "human-silence");
    assert.isNotNull(outbound.exchangeId);
    const delivered = yield* markDelivered(
      outbound.messageId,
      outbound.exchangeId!,
      subject.id,
      person.id,
      1,
      "human",
    );
    const appended = yield* (yield* A2ASilenceDetector).handleDeliveryEvent(delivered);
    assert.deepStrictEqual(appended, []);
    assert.deepStrictEqual(yield* readNotices(), []);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("addresses a silence notice to a waiter on a peer server through the peer path", () =>
  Effect.gen(function* () {
    yield* seed();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const remoteAsker = ParticipantId.make("agent:j5:a2a:thread:remote-asker");
    const exchangeId = ExchangeId.make("exchange:j5:a2a:remote-ask");
    const correlationId = CorrelationId.make("correlation:j5:a2a:remote-ask");
    const messageId = LedgerMessageId.make("message:j5:a2a:remote-ask");
    // The ask came in from a peer: the inbound service's two facts, as it records them.
    yield* ledger.appendEvents({
      commandId: CommCommandId.make("command:silence:remote-ask"),
      projectId,
      acceptedAt: iso(0),
      events: [
        {
          kind: "exchange.opened",
          sender: remoteAsker,
          receiver: subject.id,
          exchangeId,
          correlationId,
          payload: { intent: "incident status", urgency: null },
          createdAt: iso(0),
        },
        {
          kind: "message.received",
          sender: remoteAsker,
          receiver: subject.id,
          exchangeId,
          correlationId,
          payload: {
            originProjectId: LedgerProjectId.make("project:home-support"),
            originEnvironmentId: "environment-home",
            message: {
              messageId,
              text: "What is the incident status?",
              originProjectId: "project:home-support",
              receiverProjectId: projectId,
              exchangeRole: "ask",
              envelopeChannel: "peer",
            },
          },
          createdAt: iso(0),
        },
      ],
    });
    assert.equal((yield* (yield* A2ADeliveryWorker).runOnce)?.state, "delivered");
    thread.messages.push({ id: deliveryMessageId(messageId), runId: defaultRunId });

    const appended = yield* (yield* A2ASilenceDetector).handleStoredEvent(
      terminalEvent("completed"),
    );
    assert.equal(appended.length, 1);
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "turn-ended-no-reply");

    const sent = yield* sql<{ readonly receiver: string; readonly payload: string }>`
      SELECT receiver, payload FROM j5_a2a_comm_event
      WHERE kind = 'message.sent' AND json_extract(payload, '$.envelopeChannel') = 'silence_notice'
    `;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.receiver, remoteAsker);
    const payload = yield* decodeMessageSentPayload(sent[0]!.payload);
    assert.equal(payload.receiverEnvironmentId, "environment-home");
    assert.equal(payload.receiverProjectId, "project:home-support");
    const row = yield* sql<{ readonly receiver_environment_id: string | null }>`
      SELECT receiver_environment_id FROM j5_a2a_delivery WHERE message_id = ${payload.messageId}
    `;
    assert.deepStrictEqual(row, [{ receiver_environment_id: "environment-home" }]);
  }).pipe(Effect.provide(makeTestLayer())),
);
