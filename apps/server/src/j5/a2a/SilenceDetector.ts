import {
  OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { canBeNotified } from "./deliveryNotices.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { deliveryMessageId, ledgerMessageIdOfDelivery } from "./DeliveryTransport.ts";
import { formatSilenceNoticeEnvelope } from "./EnvelopeFormatter.ts";
import { A2ALedger } from "./LedgerService.ts";
import { findPeerCounterparty } from "./peerCounterparty.ts";
import {
  CommCommandId,
  CorrelationId,
  LedgerProjectId,
  ExchangeId,
  isHumanParticipantId,
  LedgerMessageId,
  MessageDeliveredPayload,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  type StoredCommEvent,
} from "./contracts.ts";

export const STOPPED_NOTICE_INSTRUCTION =
  "Do not retry this work or replace the agent automatically; wait for operator direction." as const;

// The ledger stores JSON; an absent reset time is an absent key, never `undefined`.
const SilenceFailureDetail = Schema.Struct({
  ...OrchestrationV2ProviderFailure.fields,
  resetAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const noticeBase = {
  subjectId: ParticipantId,
  deliveryMessageId: LedgerMessageId,
  observedAt: Schema.String,
} as const;

export const SilenceNoticePayload = Schema.Union([
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("turn-ended-no-reply"),
    runId: Schema.NullOr(RunId),
    processing: Schema.Literals(["processed", "never-processed"]),
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("errored"),
    runId: RunId,
    detail: SilenceFailureDetail,
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("stopped/cancelled"),
    runId: RunId,
    lifecycleStatus: Schema.Literals(["interrupted", "cancelled", "rolled_back"]),
    instruction: Schema.Literal(STOPPED_NOTICE_INSTRUCTION),
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("awaiting-human"),
    runId: RunId,
    humanState: Schema.Literals(["human-knows", "human-doesnt-know"]),
    humanExchangeId: ExchangeId,
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("blocked-on-peer"),
    runId: RunId,
    peerId: ParticipantId,
    peerExchangeId: ExchangeId,
  }),
]);
export type SilenceNoticePayload = typeof SilenceNoticePayload.Type;
export type SilenceNoticeState = SilenceNoticePayload["state"];

interface SilenceNoticeBase {
  readonly subjectId: ParticipantId;
  readonly runId: RunId;
  readonly deliveryMessageId: LedgerMessageId;
  readonly observedAt: string;
}

export class A2ASilenceDetectorError extends Schema.TaggedError<A2ASilenceDetectorError>()(
  "A2ASilenceDetectorError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface A2ASilenceDetectorShape {
  readonly handleStoredEvent: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ReadonlyArray<StoredCommEvent>, A2ASilenceDetectorError>;
  readonly handleDeliveryEvent: (
    event: StoredCommEvent,
  ) => Effect.Effect<ReadonlyArray<StoredCommEvent>, A2ASilenceDetectorError>;
  readonly reconcileOpenExchanges: Effect.Effect<
    ReadonlyArray<StoredCommEvent>,
    A2ASilenceDetectorError
  >;
}

export class A2ASilenceDetector extends Context.Service<
  A2ASilenceDetector,
  A2ASilenceDetectorShape
>()("t3/j5/a2a/SilenceDetector/A2ASilenceDetector") {}

interface MembershipRow {
  readonly project_id: string;
  readonly participant_id: string;
}

interface ExchangeRow {
  readonly project_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly created_at: string;
}

interface DeliveredMessageRow {
  readonly message_id: string;
  readonly delivered_at: string;
}

interface OpenDeliveryRow extends ExchangeRow, DeliveredMessageRow {
  readonly thread_id: string;
}

interface DeliveryStateRow {
  readonly status: "pending" | "retry_scheduled" | "delivered" | "alarmed";
}

interface RemovedDeliveryRow {
  readonly project_id: string;
  readonly message_id: string;
  readonly sender_id: string;
  readonly message_text: string;
}

interface CursorRow {
  readonly after_sequence: number | null;
}

const detectorError = (operation: string) => (cause: unknown) =>
  new A2ASilenceDetectorError({ operation, cause });

const decodeMessageDelivered = Schema.decodeUnknownEffect(MessageDeliveredPayload);
const decodeSilenceNotice = Schema.decodeUnknownEffect(SilenceNoticePayload);

const terminalRun = (stored: OrchestrationV2StoredEvent): OrchestrationV2Run | undefined => {
  const event = stored.event;
  return event.type === "run.updated" && ThreadManagement.isTerminalRunStatus(event.payload.status)
    ? event.payload
    : undefined;
};

const stablePart = (value: string) => encodeURIComponent(value);

const noticeIdentity = (projectId: string, exchangeId: string, deliveryMessageId: string) =>
  `${stablePart(projectId)}:${stablePart(exchangeId)}:${stablePart(deliveryMessageId)}`;

const commandIdFor = (projectId: string, exchangeId: string, deliveryMessageId: string) =>
  CommCommandId.make(
    `command:j5:a2a:silence:${noticeIdentity(projectId, exchangeId, deliveryMessageId)}`,
  );

const messageIdFor = (projectId: string, exchangeId: string, deliveryMessageId: string) =>
  LedgerMessageId.make(
    `message:j5:a2a:silence:${noticeIdentity(projectId, exchangeId, deliveryMessageId)}`,
  );

const correlationIdFor = (projectId: string, exchangeId: string, deliveryMessageId: string) =>
  CorrelationId.make(
    `correlation:j5:a2a:silence:${noticeIdentity(projectId, exchangeId, deliveryMessageId)}`,
  );

export const REMOVED_NOTICE_TYPE = "queued-message-removed" as const;

const REMOVED_NOTICE_EXCERPT_LENGTH = 200;

/** Told to the sender of a queued message that was taken out of the receiver's queue unread. */
export const removedNoticeMessage = (subjectId: ParticipantId, text: string): string => {
  const excerpt =
    text.length > REMOVED_NOTICE_EXCERPT_LENGTH
      ? `${text.slice(0, REMOVED_NOTICE_EXCERPT_LENGTH)}…`
      : text;
  return `Your message to ${subjectId} was removed from its queue before it ran, so ${subjectId} never read it. Send it again if it still matters. The message began: ${excerpt}`;
};

const noticeMessage = (payload: SilenceNoticePayload, exchangeId: ExchangeId): string => {
  switch (payload.state) {
    case "turn-ended-no-reply":
      return payload.processing === "never-processed"
        ? `${payload.subjectId} did not start a turn for the delivered message on ${exchangeId}.`
        : `${payload.subjectId}'s turn ended without replying on ${exchangeId}. The latest delivered message was processed.`;
    case "errored":
      return `${payload.subjectId} errored without replying on ${exchangeId}: ${payload.detail.message}`;
    case "stopped/cancelled":
      return `${payload.subjectId} was ${payload.lifecycleStatus} without replying on ${exchangeId}. ${payload.instruction}`;
    case "awaiting-human":
      return `${payload.subjectId} is awaiting the human on ${payload.humanExchangeId} (${payload.humanState}).`;
    case "blocked-on-peer":
      return `${payload.subjectId} is blocked on ${payload.peerId} via ${payload.peerExchangeId}.`;
  }
};

/**
 * The run a delivered message belongs to is the run that owes its reply: the run the message
 * started or queued as, the turn it was steered into, or the turn a queued message was promoted
 * into. Undefined when the thread holds no run for the message.
 */
const owingRun = (
  thread: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  messageId: LedgerMessageId,
): OrchestrationV2Run | undefined => {
  const delivered = deliveryMessageId(messageId);
  const runId = thread.messages.find((message) => message.id === delivered)?.runId;
  return thread.runs.find((run) => run.id === runId);
};

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    A2ASilenceDetector,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const deliveryWorker = yield* A2ADeliveryWorker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const events = yield* EventSinkV2;
      const crews = yield* AgentCrewInstanceService;
      const sql = yield* SqlClient.SqlClient;

      const readRunsAndMessages = (threadId: ThreadId) =>
        threads.getThreadRecords(threadId, ["runs", "messages"], { messageRoles: ["user"] });

      /**
       * A seat's failed run reaches its Captain as a Crew fact, from the launch report or the
       * seat's finish notice, with the run's error. The same failure framed here as an unanswered
       * ask would be the Captain's third telling of one death (Jackson's dogfood, 2026-09-17).
       */
      const captainHearsFailureElsewhere = Effect.fn("j5.a2a.silence.captainHearsFailureElsewhere")(
        function* (exchange: ExchangeRow) {
          const membership = yield* crews.findMembership(ParticipantId.make(exchange.receiver_id));
          if (membership === null) return false;
          const instance = yield* crews.read(membership.crewInstanceId);
          return (
            instance !== null &&
            instance.archivedAt === null &&
            instance.captainParticipantId === exchange.sender_id
          );
        },
      );

      const failureDetail = Effect.fn("j5.a2a.silence.failureDetail")(function* (
        threadId: ThreadId,
        runId: RunId,
      ) {
        const projection = yield* threads.getThreadProjection(threadId);
        const item = projection.turnItems.findLast(
          (candidate) =>
            candidate.runId === runId &&
            candidate.type === "error" &&
            candidate.status === "failed",
        );
        if (item?.type === "error") {
          const { resetAt, ...failure } = item.failure;
          return resetAt === undefined ? failure : { ...failure, resetAt };
        }
        return {
          class: "unknown" as const,
          message: "The provider run failed without a persisted error detail.",
          code: null,
          retryable: null,
        };
      });

      const dependencyNotice = Effect.fn("j5.a2a.silence.dependencyNotice")(function* (
        base: SilenceNoticeBase,
      ) {
        const outbound = yield* sql<ExchangeRow>`
          SELECT project_id, exchange_id, sender_id, receiver_id, created_at
          FROM j5_a2a_exchange
          WHERE sender_id = ${base.subjectId} AND status = 'open'
          ORDER BY created_at DESC, project_id, exchange_id
        `;
        for (const exchange of outbound) {
          const exchangeId = ExchangeId.make(exchange.exchange_id);
          if (!isHumanParticipantId(ParticipantId.make(exchange.receiver_id))) {
            return {
              ...base,
              state: "blocked-on-peer" as const,
              peerId: ParticipantId.make(exchange.receiver_id),
              peerExchangeId: exchangeId,
            };
          }
          const inbox = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_human_inbox_data
            WHERE origin_project_id = ${exchange.project_id}
              AND exchange_id = ${exchange.exchange_id}
          `;
          if ((inbox[0]?.count ?? 0) > 0) {
            return {
              ...base,
              state: "awaiting-human" as const,
              humanState: "human-knows" as const,
              humanExchangeId: exchangeId,
            };
          }
          const states = yield* sql<DeliveryStateRow>`
            SELECT status
            FROM j5_a2a_delivery
            WHERE project_id = ${exchange.project_id}
              AND exchange_id = ${exchange.exchange_id}
            ORDER BY sent_seq DESC
            LIMIT 1
          `;
          if (states[0]?.status === "alarmed") {
            return {
              ...base,
              state: "awaiting-human" as const,
              humanState: "human-doesnt-know" as const,
              humanExchangeId: exchangeId,
            };
          }
        }
        return null;
      });

      const deriveNotice = Effect.fn("j5.a2a.silence.deriveNotice")(function* (
        run: OrchestrationV2Run,
        threadId: ThreadId,
        subjectId: ParticipantId,
        delivery: DeliveredMessageRow,
        observedAt: string,
      ) {
        const base = {
          subjectId,
          runId: run.id,
          deliveryMessageId: LedgerMessageId.make(delivery.message_id),
          observedAt,
        };
        switch (run.status) {
          case "failed":
            return {
              ...base,
              state: "errored" as const,
              detail: yield* failureDetail(threadId, run.id),
            };
          case "interrupted":
          case "cancelled":
          case "rolled_back":
            return {
              ...base,
              state: "stopped/cancelled" as const,
              lifecycleStatus: run.status,
              instruction: STOPPED_NOTICE_INSTRUCTION,
            };
          case "completed": {
            const dependency = yield* dependencyNotice(base);
            return (
              dependency ?? {
                ...base,
                state: "turn-ended-no-reply" as const,
                // Lifecycle handling only reports the run the delivered message belongs to.
                // The delivery/reconciliation path exclusively owns never-processed.
                processing: "processed" as const,
              }
            );
          }
          case "preparing":
          case "queued":
          case "starting":
          case "running":
          case "waiting":
            throw new Error(`Nonterminal run reached silence derivation: ${run.status}`);
        }
      });

      const alreadyNoticed = Effect.fn("j5.a2a.silence.alreadyNoticed")(function* (
        exchange: ExchangeRow,
        messageId: string,
      ) {
        const prior = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM j5_a2a_comm_event
          WHERE project_id = ${exchange.project_id}
            AND kind = 'silence.notice'
            AND exchange_id = ${exchange.exchange_id}
            AND json_extract(payload, '$.deliveryMessageId') = ${messageId}
        `;
        return (prior[0]?.count ?? 0) > 0;
      });

      const appendNotice = Effect.fn("j5.a2a.silence.appendNotice")(function* (
        exchange: ExchangeRow,
        payload: SilenceNoticePayload,
      ) {
        yield* decodeSilenceNotice(payload);
        if (payload.state === "errored" && (yield* captainHearsFailureElsewhere(exchange)))
          return [];
        if (yield* alreadyNoticed(exchange, payload.deliveryMessageId)) return [];

        const exchangeId = ExchangeId.make(exchange.exchange_id);
        // The waiter may be on a peer server; the notice then travels the peer path back.
        const remoteWaiter = yield* findPeerCounterparty(sql, {
          projectId: LedgerProjectId.make(exchange.project_id),
          exchangeId,
          participantId: ParticipantId.make(exchange.sender_id),
        });
        const messageId = messageIdFor(
          exchange.project_id,
          exchange.exchange_id,
          payload.deliveryMessageId,
        );
        const correlationId = correlationIdFor(
          exchange.project_id,
          exchange.exchange_id,
          payload.deliveryMessageId,
        );
        const result = yield* ledger.appendEventsIfExchangeOpen(
          {
            commandId: commandIdFor(
              exchange.project_id,
              exchange.exchange_id,
              payload.deliveryMessageId,
            ),
            projectId: LedgerProjectId.make(exchange.project_id),
            acceptedAt: payload.observedAt,
            events: [
              {
                kind: "silence.notice",
                sender: null,
                receiver: ParticipantId.make(exchange.sender_id),
                exchangeId,
                correlationId,
                payload,
                createdAt: payload.observedAt,
              },
              {
                kind: "message.sent",
                sender: SILENCE_DETECTOR_PARTICIPANT_ID,
                receiver: ParticipantId.make(exchange.sender_id),
                exchangeId: null,
                correlationId,
                payload: {
                  messageId,
                  text: formatSilenceNoticeEnvelope({
                    noticeType: payload.state,
                    message: noticeMessage(payload, exchangeId),
                  }),
                  originProjectId: LedgerProjectId.make(exchange.project_id),
                  receiverProjectId:
                    remoteWaiter?.projectId ?? LedgerProjectId.make(exchange.project_id),
                  ...(remoteWaiter === null
                    ? {}
                    : { receiverEnvironmentId: remoteWaiter.environmentId }),
                  exchangeRole: "none",
                  envelopeChannel: "silence_notice",
                },
                createdAt: payload.observedAt,
              },
            ],
          },
          exchangeId,
        );
        if (result === null) return [];
        return result.committed
          ? result.events.filter((event) => event.kind === "silence.notice")
          : [];
      });

      /**
       * A queued message that leaves the queue unread, whoever removed it, is told to its sender:
       * the ledger recorded it delivered when it joined the queue (#504). An ask is reported on its
       * Exchange instead, a promoted message moved into the running turn, and an archived receiver
       * is gone altogether. A sender on a peer server is not told: a peer accepts a platform
       * notice only for an Exchange.
       */
      const noticeRemovedDelivery = Effect.fn("j5.a2a.silence.noticeRemovedDelivery")(function* (
        run: OrchestrationV2Run,
        threadId: ThreadId,
        subjectId: ParticipantId,
        observedAt: string,
      ) {
        const messageId = ledgerMessageIdOfDelivery(run.userMessageId);
        if (run.status !== "cancelled" || run.startedAt !== null || messageId === undefined) {
          return [];
        }
        const rows = yield* sql<RemovedDeliveryRow>`
          SELECT project_id, message_id, sender_id, message_text
          FROM j5_a2a_delivery
          WHERE message_id = ${messageId}
            AND receiver_id = ${subjectId}
            AND status = 'delivered'
            AND envelope_channel = 'peer'
            AND exchange_role <> 'ask'
            AND origin_environment_id IS NULL
          LIMIT 2
        `;
        const row = rows[0];
        if (rows.length !== 1 || row === undefined) return [];
        if (!canBeNotified(row.sender_id)) return [];
        const senderId = ParticipantId.make(row.sender_id);
        const records = yield* readRunsAndMessages(threadId);
        if (
          records.thread.archivedAt !== null ||
          records.thread.deletedAt !== null ||
          owingRun(records, messageId)?.id !== run.id
        ) {
          return [];
        }
        const identity = `${stablePart(row.project_id)}:${stablePart(row.message_id)}`;
        const result = yield* ledger.appendEvents({
          commandId: CommCommandId.make(`command:j5:a2a:removed:${identity}`),
          projectId: LedgerProjectId.make(row.project_id),
          acceptedAt: observedAt,
          events: [
            {
              kind: "message.sent",
              sender: SILENCE_DETECTOR_PARTICIPANT_ID,
              receiver: senderId,
              exchangeId: null,
              correlationId: CorrelationId.make(`correlation:j5:a2a:removed:${identity}`),
              payload: {
                messageId: LedgerMessageId.make(`message:j5:a2a:removed:${identity}`),
                text: formatSilenceNoticeEnvelope({
                  noticeType: REMOVED_NOTICE_TYPE,
                  message: removedNoticeMessage(subjectId, row.message_text),
                }),
                originProjectId: LedgerProjectId.make(row.project_id),
                receiverProjectId: LedgerProjectId.make(row.project_id),
                exchangeRole: "none",
                envelopeChannel: "silence_notice",
              },
              createdAt: observedAt,
            },
          ],
        });
        return result.committed ? result.events : [];
      });

      const inspectOpenDelivery = Effect.fn("j5.a2a.silence.inspectOpenDelivery")(function* (
        row: OpenDeliveryRow,
        observedAt: string,
      ) {
        const subjectId = ParticipantId.make(row.receiver_id);
        const messageId = LedgerMessageId.make(row.message_id);
        const threadId = ThreadId.make(row.thread_id);
        const run = owingRun(yield* readRunsAndMessages(threadId), messageId);
        let payload: SilenceNoticePayload;
        if (run === undefined) {
          payload = {
            subjectId,
            runId: null,
            deliveryMessageId: messageId,
            observedAt,
            state: "turn-ended-no-reply",
            processing: "never-processed",
          };
        } else if (ThreadManagement.isTerminalRunStatus(run.status) && run.completedAt !== null) {
          payload = yield* deriveNotice(run, threadId, subjectId, row, observedAt);
        } else {
          return [];
        }
        return yield* appendNotice(row, payload);
      });

      const handleDeliveryEventRaw = Effect.fn("j5.a2a.silence.handleDeliveryEvent")(function* (
        event: StoredCommEvent,
      ) {
        if (
          event.kind !== "message.delivered" ||
          event.receiver === null ||
          isHumanParticipantId(event.receiver)
        ) {
          return [];
        }
        const payload = yield* decodeMessageDelivered(event.payload);
        const rows = yield* sql<OpenDeliveryRow>`
          SELECT
            exchange.project_id,
            exchange.exchange_id,
            exchange.sender_id,
            exchange.receiver_id,
            exchange.created_at,
            membership.thread_id,
            delivery.message_id,
            ${event.createdAt} AS delivered_at
          FROM j5_a2a_delivery AS delivery
          JOIN j5_a2a_exchange AS exchange
            ON exchange.project_id = delivery.project_id
           AND exchange.exchange_id = delivery.exchange_id
          JOIN j5_a2a_membership AS membership
            ON membership.participant_id = exchange.receiver_id
          WHERE delivery.project_id = ${event.projectId}
            AND delivery.message_id = ${payload.messageId}
            AND delivery.envelope_channel = 'peer'
            AND exchange.status = 'open'
          LIMIT 2
        `;
        if (rows.length !== 1) return [];
        const appended = yield* inspectOpenDelivery(rows[0]!, event.createdAt);
        if (appended.length > 0) yield* deliveryWorker.notify;
        return appended;
      });

      const reconcileOpenExchangesRaw = Effect.fn("j5.a2a.silence.reconcileOpenExchanges")(
        function* () {
          const rows = yield* sql<OpenDeliveryRow>`
            SELECT
              exchange.project_id,
              exchange.exchange_id,
              exchange.sender_id,
              exchange.receiver_id,
              exchange.created_at,
              membership.thread_id,
              json_extract(delivered.payload, '$.messageId') AS message_id,
              delivered.created_at AS delivered_at
            FROM j5_a2a_exchange AS exchange
            JOIN j5_a2a_membership AS membership
              ON membership.participant_id = exchange.receiver_id
            JOIN j5_a2a_comm_event AS delivered
              ON delivered.project_id = exchange.project_id
             AND delivered.exchange_id = exchange.exchange_id
             AND delivered.kind = 'message.delivered'
            JOIN j5_a2a_delivery AS delivery
              ON delivery.project_id = exchange.project_id
             AND delivery.message_id = json_extract(delivered.payload, '$.messageId')
             AND delivery.envelope_channel = 'peer'
            WHERE exchange.status = 'open'
              AND exchange.receiver_id NOT LIKE 'human:%'
              AND delivered.seq = (
                SELECT MAX(candidate.seq)
                FROM j5_a2a_comm_event AS candidate
                WHERE candidate.project_id = exchange.project_id
                  AND candidate.exchange_id = exchange.exchange_id
                  AND candidate.kind = 'message.delivered'
              )
            ORDER BY delivered.created_at, exchange.project_id, exchange.exchange_id
          `;
          const appended: Array<StoredCommEvent> = [];
          for (const row of rows) {
            appended.push(...(yield* inspectOpenDelivery(row, row.delivered_at)));
          }
          if (appended.length > 0) yield* deliveryWorker.notify;
          return appended;
        },
      );

      const handleStoredEventRaw = Effect.fn("j5.a2a.silence.handleStoredEvent")(function* (
        stored: OrchestrationV2StoredEvent,
      ) {
        const run = terminalRun(stored);
        if (run === undefined || run.completedAt === null) return [];
        const memberships = yield* sql<MembershipRow>`
          SELECT project_id, participant_id
          FROM j5_a2a_membership
          WHERE thread_id = ${stored.event.threadId}
          ORDER BY project_id, participant_id
          LIMIT 2
        `;
        if (memberships.length !== 1) return [];
        const subjectId = ParticipantId.make(memberships[0]!.participant_id);
        const appended: Array<StoredCommEvent> = [
          ...(yield* noticeRemovedDelivery(
            run,
            stored.event.threadId,
            subjectId,
            DateTime.formatIso(stored.event.occurredAt),
          )),
        ];
        const inbound = yield* sql<ExchangeRow>`
          SELECT project_id, exchange_id, sender_id, receiver_id, created_at
          FROM j5_a2a_exchange
          WHERE receiver_id = ${subjectId} AND status = 'open'
          ORDER BY created_at, project_id, exchange_id
        `;
        let thread: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | undefined;
        for (const exchange of inbound) {
          const delivered = yield* sql<DeliveredMessageRow>`
            SELECT
              json_extract(payload, '$.messageId') AS message_id,
              created_at AS delivered_at
            FROM j5_a2a_comm_event
            WHERE project_id = ${exchange.project_id}
              AND kind = 'message.delivered'
              AND exchange_id = ${exchange.exchange_id}
              AND receiver = ${subjectId}
              AND created_at <= ${DateTime.formatIso(run.completedAt)}
            ORDER BY seq DESC
            LIMIT 1
          `;
          const delivery = delivered[0];
          if (delivery === undefined) continue;
          // An Exchange stays open after its notice; later runs need not read the thread for it.
          if (yield* alreadyNoticed(exchange, delivery.message_id)) continue;
          thread ??= yield* readRunsAndMessages(stored.event.threadId);
          if (owingRun(thread, LedgerMessageId.make(delivery.message_id))?.id !== run.id) continue;
          const payload = yield* deriveNotice(
            run,
            stored.event.threadId,
            subjectId,
            delivery,
            DateTime.formatIso(stored.event.occurredAt),
          );
          appended.push(...(yield* appendNotice(exchange, payload)));
        }
        if (appended.length > 0) yield* deliveryWorker.notify;
        return appended;
      });

      const handleStoredEvent: A2ASilenceDetectorShape["handleStoredEvent"] = (event) =>
        handleStoredEventRaw(event).pipe(Effect.mapError(detectorError("handle lifecycle event")));

      const handleDeliveryEvent: A2ASilenceDetectorShape["handleDeliveryEvent"] = (event) =>
        handleDeliveryEventRaw(event).pipe(Effect.mapError(detectorError("handle delivery event")));

      const reconcileOpenExchanges = reconcileOpenExchangesRaw().pipe(
        Effect.mapError(detectorError("reconcile open exchanges")),
      );

      const readCursor = Effect.fn("j5.a2a.silence.readCursor")(function* () {
        const rows = yield* sql<CursorRow>`
          SELECT after_sequence
          FROM j5_a2a_silence_detector_cursor
          WHERE singleton = 1
        `;
        return rows[0]?.after_sequence ?? null;
      });

      const writeCursor = Effect.fn("j5.a2a.silence.writeCursor")(function* (sequence: number) {
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* sql`
          UPDATE j5_a2a_silence_detector_cursor
          SET after_sequence = ${sequence}, updated_at = ${now}
          WHERE singleton = 1
            AND (after_sequence IS NULL OR after_sequence < ${sequence})
        `;
      });

      const initializeCursor = Effect.fn("j5.a2a.silence.initializeCursor")(function* () {
        const existing = yield* readCursor();
        if (existing !== null) return existing;
        // A failed read fails the init, which the lifecycle daemon retries with backoff; the
        // cursor is never seeded at 0, which would replay the whole event history (#349).
        const highWater = yield* events.latestSequence();
        yield* reconcileOpenExchangesRaw();
        yield* writeCursor(highWater);
        return highWater;
      });

      let lifecycleRetryDelayMs = 250;

      const prepareLifecycleStream = Effect.gen(function* () {
        const existing = yield* readCursor();
        if (existing === null) {
          yield* initializeCursor();
        } else {
          yield* reconcileOpenExchangesRaw();
        }
      });

      const runLifecycleStream = Effect.gen(function* () {
        const existing = yield* readCursor();
        let checkpoint = existing ?? (yield* initializeCursor());
        yield* threads.streamStoredEventsFrom({ afterSequence: checkpoint }).pipe(
          Stream.runForEach((event) =>
            handleStoredEventRaw(event).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if (terminalRun(event) !== undefined || event.sequence - checkpoint >= 128) {
                    yield* writeCursor(event.sequence);
                    checkpoint = event.sequence;
                  }
                  lifecycleRetryDelayMs = 250;
                }),
              ),
            ),
          ),
        );
        return yield* Effect.die("J5 A2A lifecycle subscription ended");
      });

      const waitAfterLifecycleFailure = (cause: unknown) => {
        const delayMs = lifecycleRetryDelayMs;
        lifecycleRetryDelayMs = Math.min(delayMs * 2, 30_000);
        return Effect.logWarning("J5 A2A lifecycle subscription failed; resuming from cursor", {
          cause,
          retryDelayMs: delayMs,
        }).pipe(Effect.andThen(Effect.sleep(Duration.millis(delayMs))));
      };

      const runLifecycleDaemon = Effect.gen(function* () {
        let prepared = false;
        while (!prepared) {
          prepared = yield* prepareLifecycleStream.pipe(
            Effect.as(true),
            Effect.catchCause((cause) => waitAfterLifecycleFailure(cause).pipe(Effect.as(false))),
          );
        }
        lifecycleRetryDelayMs = 250;
        return yield* Effect.forever(
          runLifecycleStream.pipe(Effect.catchCause(waitAfterLifecycleFailure)),
        );
      });

      if (daemon) {
        const committed = yield* ledger.subscribeCommitted;
        yield* committed.pipe(
          Stream.runForEach((event) =>
            handleDeliveryEvent(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 A2A delivery silence check failed; reconciling open work", {
                  cause,
                }).pipe(
                  Effect.andThen(reconcileOpenExchangesRaw()),
                  Effect.catchCause((reconcileCause) =>
                    Effect.logError("J5 A2A delivery silence reconciliation failed", {
                      cause: reconcileCause,
                    }),
                  ),
                ),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Effect.forkScoped(runLifecycleDaemon);
      }

      return A2ASilenceDetector.of({
        handleStoredEvent,
        handleDeliveryEvent,
        reconcileOpenExchanges,
      });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
