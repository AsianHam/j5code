// @effect-diagnostics preferSchemaOverJson:off - one test seeds a pre-upgrade ledger with raw SQL.
import { assert, it } from "@effect/vitest";
import { EventId, type OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  A2ADeliveryTransport,
  A2ADeliveryTransportError,
  type A2ADeliveryTransportShape,
  type AgentDeliveryInput,
  type HumanDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { A2ALifecycleService, manualLayer as lifecycleLayer } from "./LifecycleService.ts";
import { resolveThreadHome } from "./HomeRegistrar.ts";
import { ParticipantPlacementService, layer as placementLayer } from "./PlacementService.ts";
import { PlacementCommandId } from "./placementContracts.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2AParticipantArchivedError, A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeDroppedPayload,
  LedgerProjectId,
  ParticipantId,
  type AgentParticipant,
  type HumanParticipant,
  ExchangeId,
  LedgerMessageId,
} from "./contracts.ts";

const openedAt = "2026-08-23T12:00:00.000Z";
const archivedAt = "2026-08-23T12:05:00.000Z";
const decodeExchangeDroppedPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExchangeDroppedPayload),
);

const sender: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:lifecycle:sender"),
  threadId: ThreadId.make("thread:lifecycle:sender"),
};
const receiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:lifecycle:receiver"),
  threadId: ThreadId.make("thread:lifecycle:receiver"),
};
const human: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:lifecycle:person"),
};

interface DeliveredNotice {
  readonly channel: "agent" | "human";
  readonly input: AgentDeliveryInput | HumanDeliveryInput;
}

const makeTestLayer = (
  notices: Ref.Ref<ReadonlyArray<DeliveredNotice>>,
  storedEvents: Stream.Stream<OrchestrationV2StoredEvent> = Stream.never,
  failPeerDeliveries = false,
  deliverPeer: A2ADeliveryTransportShape["deliverPeer"] = () =>
    Effect.die("peer delivery is not under test"),
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const placements = placementLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      deliverAgent: (input) =>
        failPeerDeliveries && input.envelopeChannel === "peer"
          ? Effect.fail(
              new A2ADeliveryTransportError({
                operation: "test unavailable provider",
                cause: "offline",
              }),
            )
          : Ref.update(notices, (current) => [...current, { channel: "agent" as const, input }]),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverPeer,
      deliverHuman: (input) =>
        Ref.update(notices, (current) => [...current, { channel: "human" as const, input }]),
    }),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const threadManagement = Layer.mock(ThreadManagementService)({
    streamStoredEventsFrom: ({ afterSequence }: { readonly afterSequence?: number } = {}) =>
      storedEvents.pipe(Stream.filter((event) => event.sequence > (afterSequence ?? 0))),
  });
  const lifecycle = lifecycleLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(worker),
    Layer.provide(database),
    Layer.provide(threadManagement),
  );
  return Layer.mergeAll(
    database,
    ledger,
    send,
    transport,
    worker,
    threadManagement,
    lifecycle,
    placements,
  );
};

const retiredThreadEvent = (
  type: "thread.archived" | "thread.deleted" | "thread.unarchived",
  threadId: ThreadId,
  sequence: number,
): OrchestrationV2StoredEvent =>
  ({
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`event:lifecycle:${type}:${sequence}`),
      type,
      threadId,
      occurredAt: DateTime.makeUnsafe(archivedAt),
      payload: { id: threadId },
    },
  }) as unknown as OrchestrationV2StoredEvent;

const createProjectLedger = Effect.fn("test.j5.a2a.lifecycle.createProjectLedger")(function* (
  projectId: LedgerProjectId,
) {
  yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt: openedAt });
});

const join = Effect.fn("test.j5.a2a.lifecycle.join")(function* (
  projectId: LedgerProjectId,
  participant: AgentParticipant,
  suffix: string,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:lifecycle:join:${suffix}`),
    projectId,
    acceptedAt: openedAt,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: participant.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant },
      createdAt: openedAt,
    },
  });
});

it.effect("drops a receiver-retired exchange loudly and rejects new sends to the archive", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:lifecycle:receiver-retired");
      yield* createProjectLedger(projectId);
      yield* join(projectId, sender, "receiver-retired:sender");
      yield* join(projectId, receiver, "receiver-retired:receiver");
      const send = yield* A2ASendService;
      const lifecycle = yield* A2ALifecycleService;
      const sql = yield* SqlClient.SqlClient;
      const opened = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:receiver-retired:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Please answer before retirement.",
        expectReply: true,
        intent: "Prove receiver retirement closure",
        acceptedAt: openedAt,
      });
      assert.isNotNull(opened.exchangeId);
      const exchangeId = opened.exchangeId!;

      const first = yield* lifecycle.archiveParticipant({
        participantId: receiver.id,
        archivedAt,
      });
      const replay = yield* lifecycle.archiveParticipant({
        participantId: receiver.id,
        archivedAt: "2026-08-23T12:06:00.000Z",
      });
      assert.deepStrictEqual(first.droppedExchangeIds, [exchangeId]);
      assert.isTrue(first.archived);
      assert.deepStrictEqual(replay, { archived: false, droppedExchangeIds: [] });

      const exchange = yield* sql<{
        readonly status: string;
        readonly closed_seq: number | null;
      }>`
        SELECT status, closed_seq
        FROM j5_a2a_exchange
        WHERE exchange_id = ${exchangeId}
      `;
      assert.equal(exchange[0]?.status, "dropped");
      assert.isNumber(exchange[0]?.closed_seq);

      const events = yield* sql<{
        readonly kind: string;
        readonly sender: string | null;
        readonly receiver: string | null;
        readonly payload: string;
      }>`
        SELECT kind, sender, receiver, payload
        FROM j5_a2a_comm_event
        WHERE exchange_id = ${exchangeId}
          AND kind IN ('exchange.dropped', 'message.sent')
        ORDER BY seq
      `;
      const dropped = events.find((event) => event.kind === "exchange.dropped");
      assert.equal(dropped?.sender, sender.id);
      assert.equal(dropped?.receiver, receiver.id);
      const droppedPayload = yield* decodeExchangeDroppedPayload(dropped!.payload);
      assert.deepInclude(droppedPayload, {
        disposition: "receiver-retired",
        facts: {
          replyRequired: false,
          retryAllowed: false,
          replacementRequired: false,
        },
      });
      assert.lengthOf(
        events.filter((event) => event.kind === "exchange.dropped"),
        1,
      );
      const retirement = yield* sql<{
        readonly seq: number;
        readonly kind: string;
        readonly project_id: string;
        readonly participant_id: string;
        readonly participant_kind: string;
        readonly thread_id: string;
      }>`
        SELECT
          seq,
          kind,
          project_id,
          json_extract(payload, '$.participant.id') AS participant_id,
          json_extract(payload, '$.participant.kind') AS participant_kind,
          json_extract(payload, '$.participant.threadId') AS thread_id
        FROM j5_a2a_comm_event
        WHERE kind = 'participant.archived' AND receiver = ${receiver.id}
      `;
      const joinedSequence = yield* sql<{ readonly seq: number }>`
        SELECT seq
        FROM j5_a2a_comm_event
        WHERE kind = 'participant.joined' AND receiver = ${receiver.id}
      `;
      assert.lengthOf(retirement, 1);
      assert.deepInclude(retirement[0]!, {
        kind: "participant.archived",
        project_id: projectId,
        participant_id: receiver.id,
        participant_kind: "agent",
        thread_id: receiver.threadId,
      });
      assert.isAbove(retirement[0]!.seq, joinedSequence[0]!.seq);

      const error = yield* Effect.flip(
        send.send({
          commandId: CommCommandId.make("command:lifecycle:receiver-retired:after"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "This must be rejected.",
          acceptedAt: archivedAt,
        }),
      );
      assert.instanceOf(error, A2AParticipantArchivedError);
      assert.include(error.message, "archived");

      const milestones = yield* (yield* A2ADeliveryWorker).drain;
      assert.isTrue(milestones.some((milestone) => milestone.state === "delivered"));
      const delivered = yield* Ref.get(notices);
      assert.isTrue(
        delivered.some(
          (notice) =>
            notice.input.envelopeChannel === "lifecycle_notice" &&
            notice.input.receiverId === sender.id,
        ),
      );
    }).pipe(Effect.provide(makeTestLayer(notices)));
  }),
);

it.effect("drops a sender-retired person exchange so the active inbox source is terminal", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:lifecycle:person");
      yield* createProjectLedger(projectId);
      yield* join(projectId, sender, "person:sender");
      yield* (yield* SqlClient.SqlClient)`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${human.id}, 1, ${openedAt})
      `;
      // The first owner writes to every thread, as the server records them at startup.
      yield* (yield* SqlClient.SqlClient)`
        INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at)
        VALUES (${human.id}, 'server', '', 'owner', ${openedAt}, ${openedAt})
      `;
      const opened = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:lifecycle:person:open"),
        senderThreadId: sender.threadId,
        to: human.id,
        message: "A person should not owe an archived asker.",
        expectReply: true,
        intent: "Prove person inbox closure",
        urgency: "blocking",
        acceptedAt: openedAt,
      });

      yield* (yield* A2ALifecycleService).archiveParticipant({
        participantId: sender.id,
        archivedAt,
      });
      const retiredError = yield* Effect.flip(
        (yield* A2ASendService).send({
          commandId: CommCommandId.make("command:lifecycle:person:retired-send"),
          senderThreadId: sender.threadId,
          to: human.id,
          message: "Retired send must fail.",
          acceptedAt: archivedAt,
        }),
      );
      assert.instanceOf(retiredError, A2AParticipantArchivedError);
      assert.include(retiredError.message, "archived");
      const source = yield* (yield* SqlClient.SqlClient)<{
        readonly status: string;
        readonly disposition: string;
      }>`
        SELECT
          exchange.status,
          json_extract(event.payload, '$.disposition') AS disposition
        FROM j5_a2a_exchange AS exchange
        JOIN j5_a2a_comm_event AS event
          ON event.project_id = exchange.project_id
          AND event.exchange_id = exchange.exchange_id
          AND event.kind = 'exchange.dropped'
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(source, [{ status: "dropped", disposition: "sender-retired" }]);
      yield* (yield* A2ADeliveryWorker).drain;
      const delivered = yield* Ref.get(notices);
      assert.isTrue(
        delivered.some(
          (notice) =>
            notice.channel === "human" &&
            notice.input.envelopeChannel === "lifecycle_notice" &&
            notice.input.receiverId === human.id,
        ),
      );
    }).pipe(Effect.provide(makeTestLayer(notices)));
  }),
);

it.effect("leaves unrelated same- and cross-project exchanges open", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const localProjectId = LedgerProjectId.make("project:lifecycle:healthy:local");
      const remoteProjectId = LedgerProjectId.make("project:lifecycle:healthy:remote");
      const localPeer: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:lifecycle:healthy:local"),
        threadId: ThreadId.make("thread:lifecycle:healthy:local"),
      };
      const secondLocalPeer: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:lifecycle:healthy:second-local"),
        threadId: ThreadId.make("thread:lifecycle:healthy:second-local"),
      };
      const remotePeer: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:lifecycle:healthy:remote"),
        threadId: ThreadId.make("thread:lifecycle:healthy:remote"),
      };
      yield* createProjectLedger(localProjectId);
      yield* createProjectLedger(remoteProjectId);
      yield* join(localProjectId, sender, "healthy:affected-sender");
      yield* join(localProjectId, receiver, "healthy:affected-receiver");
      yield* join(localProjectId, localPeer, "healthy:local");
      yield* join(localProjectId, secondLocalPeer, "healthy:second-local");
      yield* join(remoteProjectId, remotePeer, "healthy:remote");
      const send = yield* A2ASendService;
      const affected = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:healthy:affected"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This obligation should drop.",
        expectReply: true,
        intent: "Affected exchange",
        acceptedAt: openedAt,
      });
      const sameProject = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:healthy:same"),
        senderThreadId: localPeer.threadId,
        to: secondLocalPeer.id,
        message: "This same-project exchange stays open.",
        expectReply: true,
        intent: "Healthy same-project exchange",
        acceptedAt: openedAt,
      });
      const crossProject = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:healthy:cross"),
        senderThreadId: localPeer.threadId,
        to: remotePeer.id,
        message: "This cross-project exchange stays open.",
        expectReply: true,
        intent: "Healthy cross-project exchange",
        acceptedAt: openedAt,
      });

      yield* (yield* A2ALifecycleService).archiveParticipant({
        participantId: receiver.id,
        archivedAt,
      });

      const rows = yield* (yield* SqlClient.SqlClient)<{
        readonly exchange_id: string;
        readonly status: string;
      }>`
        SELECT exchange_id, status
        FROM j5_a2a_exchange
        WHERE exchange_id IN (${affected.exchangeId}, ${sameProject.exchangeId}, ${crossProject.exchangeId})
        ORDER BY exchange_id
      `;
      assert.deepStrictEqual(Object.fromEntries(rows.map((row) => [row.exchange_id, row.status])), {
        [affected.exchangeId!]: "dropped",
        [sameProject.exchangeId!]: "open",
        [crossProject.exchangeId!]: "open",
      });
    }).pipe(Effect.provide(makeTestLayer(notices)));
  }),
);

it.effect("replays archive then delete from its cursor without duplicating closure", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    const nativeNoHome = retiredThreadEvent(
      "thread.archived",
      ThreadId.make("thread:lifecycle:no-home"),
      6,
    );
    const archived = retiredThreadEvent("thread.archived", receiver.threadId, 7);
    const deleted = retiredThreadEvent("thread.deleted", receiver.threadId, 8);
    const storedEvents = Stream.fromIterable([nativeNoHome, archived, deleted]);
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:lifecycle:bridge");
      yield* createProjectLedger(projectId);
      yield* join(projectId, sender, "bridge:sender");
      yield* join(projectId, receiver, "bridge:receiver");
      const opened = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:lifecycle:bridge:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "The committed archive event should close this.",
        expectReply: true,
        intent: "Prove archive bridge replay",
        acceptedAt: openedAt,
      });
      assert.isNotNull(opened.exchangeId);

      const lifecycle = yield* A2ALifecycleService;
      yield* lifecycle.replayCommittedEvents;
      yield* lifecycle.replayCommittedEvents;

      const state = yield* (yield* SqlClient.SqlClient)<{
        readonly status: string;
        readonly dropped_events: number;
        readonly terminal_notices: number;
        readonly after_sequence: number;
      }>`
        SELECT
          exchange.status,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'exchange.dropped' AND exchange_id = ${opened.exchangeId}
          ) AS dropped_events,
          (
            SELECT COUNT(*)
            FROM j5_a2a_delivery
            WHERE exchange_role = 'terminal_notice' AND exchange_id = ${opened.exchangeId}
          ) AS terminal_notices,
          cursor.after_sequence
        FROM j5_a2a_exchange AS exchange
        CROSS JOIN j5_a2a_lifecycle_cursor AS cursor
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(state, [
        {
          status: "dropped",
          dropped_events: 1,
          terminal_notices: 1,
          after_sequence: 8,
        },
      ]);
    }).pipe(Effect.provide(makeTestLayer(notices, storedEvents)));
  }),
);

it.effect("drops a reply-owing participant exactly once from committed thread deletion", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    const storedEvents = Stream.make(retiredThreadEvent("thread.deleted", receiver.threadId, 11));
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:lifecycle:delete-bridge");
      yield* createProjectLedger(projectId);
      yield* join(projectId, sender, "delete-bridge:sender");
      yield* join(projectId, receiver, "delete-bridge:receiver");
      const opened = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:lifecycle:delete-bridge:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Deleting the receiver must end its reply obligation.",
        expectReply: true,
        intent: "Prove deletion bridge closure",
        acceptedAt: openedAt,
      });
      assert.isNotNull(opened.exchangeId);

      const lifecycle = yield* A2ALifecycleService;
      yield* lifecycle.replayCommittedEvents;
      yield* lifecycle.replayCommittedEvents;

      const state = yield* (yield* SqlClient.SqlClient)<{
        readonly status: string;
        readonly disposition: string;
        readonly dropped_events: number;
        readonly terminal_notices: number;
      }>`
        SELECT
          exchange.status,
          json_extract(dropped.payload, '$.disposition') AS disposition,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'exchange.dropped' AND exchange_id = ${opened.exchangeId}
          ) AS dropped_events,
          (
            SELECT COUNT(*)
            FROM j5_a2a_delivery
            WHERE exchange_role = 'terminal_notice' AND exchange_id = ${opened.exchangeId}
          ) AS terminal_notices
        FROM j5_a2a_exchange AS exchange
        JOIN j5_a2a_comm_event AS dropped
          ON dropped.exchange_id = exchange.exchange_id
          AND dropped.kind = 'exchange.dropped'
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(state, [
        {
          status: "dropped",
          disposition: "receiver-retired",
          dropped_events: 1,
          terminal_notices: 1,
        },
      ]);
    }).pipe(Effect.provide(makeTestLayer(notices, storedEvents)));
  }),
);

it.effect(
  "preserves identity and home through archive cycles and ignores replayed old lifecycle events",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const projectId = LedgerProjectId.make("project:lifecycle:cycles");
        yield* createProjectLedger(projectId);
        yield* join(projectId, sender, "cycles:sender");
        yield* join(projectId, receiver, "cycles:receiver");
        const lifecycle = yield* A2ALifecycleService;
        const ledger = yield* A2ALedger;
        const send = yield* A2ASendService;
        const sql = yield* SqlClient.SqlClient;
        const ask = yield* send.send({
          commandId: CommCommandId.make("cycles:ask"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "Old obligation",
          expectReply: true,
          intent: "Check closure",
          acceptedAt: openedAt,
        });
        const archive = retiredThreadEvent("thread.archived", receiver.threadId, 1);
        yield* lifecycle.handleStoredEvent(archive);
        assert.isFalse(
          (yield* send.listParticipants(sender.threadId)).some(
            (row) => row.participantId === receiver.id,
          ),
        );
        const hidden = (yield* send.listParticipants(sender.threadId, true)).find(
          (row) => row.participantId === receiver.id,
        )!;
        assert.isTrue(hidden.archived);
        assert.isFalse(hidden.canReceiveMessage);
        assert.isFalse(hidden.canOpenExchange);
        yield* ledger.rebuildMembership(projectId);
        assert.isFalse((yield* resolveThreadHome(sql, receiver.threadId)).retired);
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.unarchived", receiver.threadId, 2),
        );
        const restored = (yield* send.listParticipants(sender.threadId)).find(
          (row) => row.participantId === receiver.id,
        )!;
        assert.equal(restored.projectId, projectId);
        assert.isFalse(restored.archived);
        assert.isTrue(restored.canReceiveMessage);
        const next = yield* send.send({
          commandId: CommCommandId.make("cycles:new-ask"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "New obligation",
          expectReply: true,
          intent: "New cycle",
          acceptedAt: archivedAt,
        });
        yield* lifecycle.handleStoredEvent(archive);
        const state = yield* sql<{
          status: string;
        }>`SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${next.exchangeId}`;
        assert.equal(state[0]?.status, "open");
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.archived", receiver.threadId, 3),
        );
        yield* ledger.rebuildMembership(projectId);
        const events = yield* sql<{
          kind: string;
          count: number;
        }>`SELECT kind, count(*) AS count FROM j5_a2a_comm_event
        WHERE receiver = ${receiver.id} AND kind IN ('participant.joined', 'participant.archived') GROUP BY kind`;
        assert.deepStrictEqual(events, [
          { kind: "participant.archived", count: 2 },
          { kind: "participant.joined", count: 1 },
        ]);
        const cancelled = yield* sql<{
          status: string;
        }>`SELECT status FROM j5_a2a_delivery WHERE message_id = ${ask.messageId}`;
        assert.equal(cancelled[0]?.status, "cancelled");
        yield* (yield* A2ADeliveryWorker).drain;
        assert.isFalse(
          (yield* Ref.get(notices)).some((entry) => entry.input.messageId === ask.messageId),
        );
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect(
  "deletes registry and live placement while preserving children, provenance, and peer history",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const projectId = LedgerProjectId.make("project:lifecycle:delete");
        yield* createProjectLedger(projectId);
        yield* join(projectId, sender, "delete:sender");
        yield* join(projectId, receiver, "delete:receiver");
        const placements = yield* ParticipantPlacementService;
        yield* placements.recordCreation({
          commandId: PlacementCommandId.make("delete:parent"),
          projectId,
          participantId: sender.id,
          actor: "platform",
          provenance: { kind: "unknown", source: "native_or_unobserved" },
          createdAt: openedAt,
        });
        const provenance = {
          kind: "spawned-by",
          spawnedByParticipantId: sender.id,
          source: "j5_spawn",
        } as const;
        yield* placements.recordCreation({
          commandId: PlacementCommandId.make("delete:child"),
          projectId,
          participantId: receiver.id,
          actor: "platform",
          provenance,
          createdAt: openedAt,
        });
        const send = yield* A2ASendService;
        const message = yield* send.send({
          commandId: CommCommandId.make("delete:ask"),
          senderThreadId: receiver.threadId,
          to: sender.id,
          message: "Retain my history",
          expectReply: true,
          intent: "Direct deletion",
          acceptedAt: openedAt,
        });
        const lifecycle = yield* A2ALifecycleService;
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.deleted", sender.threadId, 1),
        );
        const rows = yield* placements.listParticipants(projectId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.participantId, receiver.id);
        assert.isNull(rows[0]?.placementParentId);
        assert.deepStrictEqual(rows[0]?.provenance, provenance);
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_participant_placement WHERE participant_id = ${sender.id}`,
          0,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_placement_event WHERE participant_id = ${sender.id}`,
          1,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_placement_event WHERE kind = 'participant.reparented'`,
          0,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_comm_event WHERE kind = 'message.sent' AND json_extract(payload, '$.messageId') = ${message.messageId}`,
          1,
        );
        yield* (yield* A2ALedger).rebuildMembership(projectId);
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.unarchived", sender.threadId, 2),
        );
        assert.isTrue((yield* resolveThreadHome(sql, sender.threadId)).retired);
        assert.lengthOf(yield* send.listParticipants(receiver.threadId, true), 1);
        yield* (yield* A2ADeliveryWorker).drain;
        assert.isTrue(
          (yield* Ref.get(notices)).some((entry) => entry.input.message.includes("was deleted")),
        );
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect(
  "keeps pre-upgrade retired identities dead across migration, unarchive and membership replay",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations({ toMigrationInclusive: 10 });
        const sql = yield* SqlClient.SqlClient;
        // The pre-upgrade ledger is written as rows: today's services no longer speak that schema.
        const legacyProjectId = "ledger:lifecycle:legacy";
        const projectId = LedgerProjectId.make("project:lifecycle:legacy");
        yield* sql`
          INSERT INTO j5_a2a_squadron (id, name, created_at)
          VALUES (${legacyProjectId}, 'Legacy', ${openedAt})
        `;
        yield* sql`
          INSERT INTO j5_a2a_squadron_project_reference (squadron_id, project_id, ordinal, created_at)
          VALUES (${legacyProjectId}, ${projectId}, 0, ${openedAt})
        `;
        for (const [index, event] of [
          { kind: "participant.joined", participant: sender, at: openedAt },
          { kind: "participant.joined", participant: receiver, at: openedAt },
          { kind: "participant.left", participant: receiver, at: archivedAt },
        ].entries()) {
          const seq = index + 1;
          const commandId = `legacy:${String(seq)}`;
          yield* sql`
            INSERT INTO j5_a2a_comm_event (
              seq, squadron_id, kind, sender, receiver, exchange_id, correlation_id, payload,
              created_at, command_id
            ) VALUES (
              ${seq}, ${legacyProjectId}, ${event.kind}, NULL, ${event.participant.id}, NULL, NULL,
              ${JSON.stringify({ participant: event.participant })}, ${event.at}, ${commandId}
            )
          `;
          yield* sql`
            INSERT INTO j5_a2a_comm_command_receipt (
              command_id, squadron_id, command_type, accepted_at, result_seq
            ) VALUES (${commandId}, ${legacyProjectId}, 'comm.append', ${event.at}, ${seq})
          `;
        }
        yield* sql`
          INSERT INTO j5_a2a_squadron_membership (
            squadron_id, participant_id, participant_kind, thread_id, joined_seq, updated_seq, payload
          ) VALUES (
            ${legacyProjectId}, ${sender.id}, 'agent', ${sender.threadId}, 1, 1,
            ${JSON.stringify(sender)}
          )
        `;
        const ledger = yield* A2ALedger;
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        yield* (yield* A2ALifecycleService).handleStoredEvent(
          retiredThreadEvent("thread.unarchived", receiver.threadId, 1),
        );
        yield* ledger.rebuildMembership(projectId);
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        assert.isTrue((yield* resolveThreadHome(sql, receiver.threadId)).retired);
        assert.lengthOf(yield* (yield* A2ASendService).listParticipants(sender.threadId, true), 1);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_comm_event WHERE kind = 'participant.unarchived'`,
          0,
        );
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect(
  "cancels scheduled retries permanently and retains terminal human history before first delivery",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const projectId = LedgerProjectId.make("project:lifecycle:retry");
        yield* createProjectLedger(projectId);
        yield* join(projectId, sender, "retry:sender");
        yield* join(projectId, receiver, "retry:receiver");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES (${human.id}, 1, ${openedAt})`;
        yield* sql`INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at) VALUES (${human.id}, 'server', '', 'owner', ${openedAt}, ${openedAt})`;
        const send = yield* A2ASendService;
        const peer = yield* send.send({
          commandId: CommCommandId.make("retry:peer"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "Retry me",
          acceptedAt: openedAt,
        });
        const worker = yield* A2ADeliveryWorker;
        assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
        const ask = yield* send.send({
          commandId: CommCommandId.make("retry:human"),
          senderThreadId: sender.threadId,
          to: human.id,
          message: "Retain this ask",
          expectReply: true,
          intent: "Retained human history",
          urgency: "blocking",
          acceptedAt: openedAt,
        });
        const lifecycle = yield* A2ALifecycleService;
        yield* lifecycle.archiveParticipant({ participantId: sender.id, archivedAt });
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.unarchived", sender.threadId, 1),
        );
        const deliveries =
          yield* sql`SELECT status, next_attempt_at FROM j5_a2a_delivery WHERE message_id IN (${peer.messageId}, ${ask.messageId})`;
        assert.deepStrictEqual(deliveries, [
          { status: "cancelled", next_attempt_at: null },
          { status: "cancelled", next_attempt_at: null },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT status, latest_message FROM j5_a2a_human_inbox WHERE exchange_id = ${ask.exchangeId}`,
          [{ status: "dropped", latest_message: "Retain this ask" }],
        );
        yield* worker.drain;
        assert.isFalse(
          (yield* Ref.get(notices)).some(
            (notice) =>
              notice.input.messageId === peer.messageId || notice.input.messageId === ask.messageId,
          ),
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_human_person WHERE person_id = ${human.id}`,
          1,
        );
        assert.isTrue(
          (yield* send.listParticipants(receiver.threadId)).some(
            (row) => row.participantId === human.id && !row.archived,
          ),
        );
      }).pipe(Effect.provide(makeTestLayer(notices, Stream.never, true)));
    }),
);

it.effect.each([true, false])(
  "records one archive fact per transition in both entry-point orders (direct first=%s)",
  (directFirst) =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const projectId = LedgerProjectId.make(`project:archive-order:${directFirst}`);
        yield* createProjectLedger(projectId);
        yield* join(projectId, sender, "order:sender");
        const lifecycle = yield* A2ALifecycleService;
        const sql = yield* SqlClient.SqlClient;
        for (const cycle of [0, 1]) {
          const event = retiredThreadEvent("thread.archived", sender.threadId, cycle * 2 + 1);
          const direct = lifecycle.archiveParticipant({ participantId: sender.id, archivedAt });
          if (directFirst) {
            yield* direct;
            yield* lifecycle.handleStoredEvent(event);
          } else {
            yield* lifecycle.handleStoredEvent(event);
            yield* direct;
          }
          yield* direct;
          yield* lifecycle.handleStoredEvent(event);
          assert.deepStrictEqual(
            yield* sql`SELECT count(*) AS count FROM j5_a2a_comm_event WHERE kind = 'participant.archived'`,
            [{ count: cycle + 1 }],
          );
          yield* lifecycle.handleStoredEvent(
            retiredThreadEvent("thread.unarchived", sender.threadId, cycle * 2 + 2),
          );
          yield* lifecycle.handleStoredEvent(event);
          assert.deepStrictEqual(
            yield* sql`SELECT archived_at FROM j5_a2a_membership WHERE participant_id = ${sender.id}`,
            [{ archived_at: null }],
          );
        }
        yield* (yield* A2ALedger).rebuildMembership(projectId);
        assert.deepStrictEqual(
          yield* sql`SELECT archived_at FROM j5_a2a_membership WHERE participant_id = ${sender.id}`,
          [{ archived_at: null }],
        );
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect("addresses drop notices to a counterparty on a peer server in both directions", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:lifecycle:peers");
      yield* createProjectLedger(projectId);
      yield* join(projectId, sender, "peers:sender");
      yield* join(projectId, receiver, "peers:receiver");
      const ledger = yield* A2ALedger;
      const lifecycle = yield* A2ALifecycleService;
      const sql = yield* SqlClient.SqlClient;
      const remoteAsker = ParticipantId.make("agent:j5:a2a:thread:remote-asker");
      const remoteAnswerer = ParticipantId.make("agent:j5:a2a:thread:remote-answerer");
      const homeProject = LedgerProjectId.make("project:home-support");

      // Inbound: a peer's agent asked our receiver. Outbound: our sender asked a peer's agent.
      const inboundExchange = ExchangeId.make("exchange:lifecycle:inbound");
      yield* ledger.appendEvents({
        commandId: CommCommandId.make("command:lifecycle:peers:inbound"),
        projectId,
        acceptedAt: openedAt,
        events: [
          {
            kind: "exchange.opened",
            sender: remoteAsker,
            receiver: receiver.id,
            exchangeId: inboundExchange,
            correlationId: CorrelationId.make("correlation:lifecycle:inbound"),
            payload: { intent: "inbound", urgency: null },
            createdAt: openedAt,
          },
          {
            kind: "message.received",
            sender: remoteAsker,
            receiver: receiver.id,
            exchangeId: inboundExchange,
            correlationId: CorrelationId.make("correlation:lifecycle:inbound"),
            payload: {
              originProjectId: homeProject,
              originEnvironmentId: "environment-home",
              message: {
                messageId: LedgerMessageId.make("message:lifecycle:inbound"),
                text: "inbound ask",
                originProjectId: homeProject,
                receiverProjectId: projectId,
                exchangeRole: "ask",
                envelopeChannel: "peer",
              },
            },
            createdAt: openedAt,
          },
        ],
      });
      const outboundExchange = ExchangeId.make("exchange:lifecycle:outbound");
      yield* ledger.appendEvents({
        commandId: CommCommandId.make("command:lifecycle:peers:outbound"),
        projectId,
        acceptedAt: openedAt,
        events: [
          {
            kind: "exchange.opened",
            sender: sender.id,
            receiver: remoteAnswerer,
            exchangeId: outboundExchange,
            correlationId: CorrelationId.make("correlation:lifecycle:outbound"),
            payload: { intent: "outbound", urgency: null },
            createdAt: openedAt,
          },
          {
            kind: "message.sent",
            sender: sender.id,
            receiver: remoteAnswerer,
            exchangeId: outboundExchange,
            correlationId: CorrelationId.make("correlation:lifecycle:outbound"),
            payload: {
              messageId: LedgerMessageId.make("message:lifecycle:outbound"),
              text: "outbound ask",
              originProjectId: projectId,
              receiverProjectId: homeProject,
              receiverEnvironmentId: "environment-home",
              exchangeRole: "ask",
              envelopeChannel: "peer",
            },
            createdAt: openedAt,
          },
        ],
      });
      // Home accepted the outbound ask, so it holds that Exchange and is told when it drops.
      yield* ledger.append({
        commandId: CommCommandId.make("command:lifecycle:peers:outbound:delivered"),
        projectId,
        acceptedAt: openedAt,
        event: {
          kind: "message.delivered",
          sender: sender.id,
          receiver: remoteAnswerer,
          exchangeId: outboundExchange,
          correlationId: CorrelationId.make("correlation:lifecycle:outbound"),
          payload: {
            messageId: LedgerMessageId.make("message:lifecycle:outbound"),
            attempt: 1,
            channel: "agent",
          },
          createdAt: openedAt,
        },
      });

      const receiverGone = yield* lifecycle.archiveParticipant({
        participantId: receiver.id,
        archivedAt,
      });
      assert.deepStrictEqual(receiverGone.droppedExchangeIds, [inboundExchange]);
      const senderGone = yield* lifecycle.archiveParticipant({
        participantId: sender.id,
        archivedAt,
      });
      assert.deepStrictEqual(senderGone.droppedExchangeIds, [outboundExchange]);

      const noticesSent = yield* sql<{
        readonly receiver: string;
        readonly receiver_environment: string | null;
        readonly receiver_project: string;
      }>`
        SELECT receiver,
               json_extract(payload, '$.receiverEnvironmentId') AS receiver_environment,
               json_extract(payload, '$.receiverProjectId') AS receiver_project
        FROM j5_a2a_comm_event
        WHERE kind = 'message.sent' AND json_extract(payload, '$.envelopeChannel') = 'lifecycle_notice'
        ORDER BY seq
      `;
      assert.deepStrictEqual(noticesSent, [
        {
          receiver: remoteAsker,
          receiver_environment: "environment-home",
          receiver_project: homeProject,
        },
        {
          receiver: remoteAnswerer,
          receiver_environment: "environment-home",
          receiver_project: homeProject,
        },
      ]);
      const pending = yield* sql<{ readonly receiver_environment_id: string | null }>`
        SELECT receiver_environment_id FROM j5_a2a_delivery
        WHERE exchange_role = 'terminal_notice' ORDER BY sent_seq
      `;
      assert.deepStrictEqual(pending, [
        { receiver_environment_id: "environment-home" },
        { receiver_environment_id: "environment-home" },
      ]);
    }).pipe(Effect.provide(makeTestLayer(notices)));
  }),
);

it.effect(
  "sends a peer server no drop notice for an ask that never reached it, and one for an ask it was handed",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const projectId = LedgerProjectId.make("project:lifecycle:unheld");
        yield* createProjectLedger(projectId);
        yield* join(projectId, sender, "unheld:sender");
        const ledger = yield* A2ALedger;
        const lifecycle = yield* A2ALifecycleService;
        const sql = yield* SqlClient.SqlClient;
        const homeProject = LedgerProjectId.make("project:home-support");
        const ask = (name: string) =>
          ledger.appendEvents({
            commandId: CommCommandId.make(`command:lifecycle:unheld:${name}`),
            projectId,
            acceptedAt: openedAt,
            events: [
              {
                kind: "exchange.opened",
                sender: sender.id,
                receiver: ParticipantId.make(`agent:j5:a2a:thread:${name}`),
                exchangeId: ExchangeId.make(`exchange:lifecycle:${name}`),
                correlationId: CorrelationId.make(`correlation:lifecycle:${name}`),
                payload: { intent: name, urgency: null },
                createdAt: openedAt,
              },
              {
                kind: "message.sent",
                sender: sender.id,
                receiver: ParticipantId.make(`agent:j5:a2a:thread:${name}`),
                exchangeId: ExchangeId.make(`exchange:lifecycle:${name}`),
                correlationId: CorrelationId.make(`correlation:lifecycle:${name}`),
                payload: {
                  messageId: LedgerMessageId.make(`message:lifecycle:${name}`),
                  text: `${name} ask`,
                  originProjectId: projectId,
                  receiverProjectId: homeProject,
                  receiverEnvironmentId: "environment-laptop",
                  exchangeRole: "ask",
                  envelopeChannel: "peer",
                },
                createdAt: openedAt,
              },
            ],
          });
        yield* ask("waiting");
        yield* ask("handed");
        // The laptop polled and was handed one ask, which it has not acknowledged yet.
        yield* sql`
          UPDATE j5_a2a_delivery SET handed_out_at = ${openedAt}
          WHERE message_id = 'message:lifecycle:handed'
        `;

        const gone = yield* lifecycle.archiveParticipant({ participantId: sender.id, archivedAt });
        assert.deepStrictEqual(
          [...gone.droppedExchangeIds].toSorted(),
          ["exchange:lifecycle:handed", "exchange:lifecycle:waiting"],
          "both Exchanges drop here",
        );
        const noticesSent = yield* sql<{ readonly receiver: string }>`
          SELECT receiver FROM j5_a2a_comm_event
          WHERE kind = 'message.sent' AND json_extract(payload, '$.envelopeChannel') = 'lifecycle_notice'
        `;
        assert.deepStrictEqual(
          noticesSent,
          [{ receiver: "agent:j5:a2a:thread:handed" }],
          "only the peer that was handed its ask hears of the drop",
        );
        const asks = yield* sql<{ readonly message_id: string; readonly status: string }>`
          SELECT message_id, status FROM j5_a2a_delivery WHERE exchange_role = 'ask' ORDER BY message_id
        `;
        assert.deepStrictEqual(asks, [
          { message_id: "message:lifecycle:handed", status: "pending" },
          { message_id: "message:lifecycle:waiting", status: "cancelled" },
        ]);
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect("closes an Exchange on a peer server whose ask lands while its sender is archived", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    const entered = yield* Deferred.make<void>();
    const land = yield* Deferred.make<void>();
    // The peer's 2xx arrives only once the archive is under way.
    const deliverPeer: A2ADeliveryTransportShape["deliverPeer"] = () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(land)));
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const projectId = LedgerProjectId.make("project:lifecycle:inflight");
      yield* createProjectLedger(projectId);
      yield* join(projectId, sender, "inflight:sender");
      const ledger = yield* A2ALedger;
      const lifecycle = yield* A2ALifecycleService;
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      const remote = ParticipantId.make("agent:j5:a2a:thread:remote-answerer");
      const exchangeId = ExchangeId.make("exchange:lifecycle:inflight");
      yield* ledger.appendEvents({
        commandId: CommCommandId.make("command:lifecycle:inflight"),
        projectId,
        acceptedAt: openedAt,
        events: [
          {
            kind: "exchange.opened",
            sender: sender.id,
            receiver: remote,
            exchangeId,
            correlationId: CorrelationId.make("correlation:lifecycle:inflight"),
            payload: { intent: "inflight", urgency: null },
            createdAt: openedAt,
          },
          {
            kind: "message.sent",
            sender: sender.id,
            receiver: remote,
            exchangeId,
            correlationId: CorrelationId.make("correlation:lifecycle:inflight"),
            payload: {
              messageId: LedgerMessageId.make("message:lifecycle:inflight"),
              text: "inflight ask",
              originProjectId: projectId,
              receiverProjectId: LedgerProjectId.make("project:home-support"),
              receiverEnvironmentId: "environment-home",
              exchangeRole: "ask",
              envelopeChannel: "peer",
            },
            createdAt: openedAt,
          },
        ],
      });

      const attempt = yield* Effect.forkChild(worker.runOnce);
      yield* Deferred.await(entered);
      // The archive is committed while the peer has not answered yet.
      const committed = yield* ledger.subscribeCommitted;
      const archivedFact = yield* Effect.forkChild(
        committed.pipe(
          Stream.filter(
            (event) => event.kind === "participant.archived" && event.receiver === sender.id,
          ),
          Stream.runHead,
        ),
      );
      const archive = yield* Effect.forkChild(
        lifecycle.archiveParticipant({ participantId: sender.id, archivedAt }),
      );
      yield* Fiber.join(archivedFact);
      yield* Deferred.succeed(land, undefined);
      assert.equal((yield* Fiber.join(attempt))?.state, "delivered");
      const gone = yield* Fiber.join(archive);
      assert.deepStrictEqual([...gone.droppedExchangeIds], [exchangeId]);

      const told = yield* sql<{ readonly receiver: string }>`
          SELECT receiver FROM j5_a2a_comm_event
          WHERE kind = 'message.sent' AND json_extract(payload, '$.envelopeChannel') = 'lifecycle_notice'
        `;
      assert.deepStrictEqual(
        told,
        [{ receiver: remote }],
        "the peer holds the Exchange, so it is told it closed",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(makeTestLayer(notices, Stream.never, false, deliverPeer)),
    );
  }),
);
