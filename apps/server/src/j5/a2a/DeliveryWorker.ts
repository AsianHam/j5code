import {
  PEER_POLL_BATCH_COUNT,
  PeerDeliveryRequest,
  type PeerPollAck,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type * as Scope from "effect/Scope";

import { reportedLabel } from "./peerLabel.ts";
import config from "./delivery-config.v1.json" with { type: "json" };
import {
  type A2ADeliveryHeldError,
  type A2ADeliveryRefusedError,
  A2ADeliveryTransport,
  A2ADeliveryTransportError,
  isHeldError,
  isRefusedError,
} from "./DeliveryTransport.ts";
import {
  CommCommandId,
  type CommEvent,
  CorrelationId,
  LedgerProjectId,
  ExchangeId,
  isHumanParticipantId,
  isMachineParticipantId,
  LedgerMessageId,
  MessageSentPayload,
  ParticipantId,
  type DeliveryAlarm,
  type DeliveryMilestone,
} from "./contracts.ts";
import { A2ALedgerTransactionWriter, A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import {
  canBeNotified,
  type DroppedExchange,
  formatNotDeliveredNotice,
  notDeliveredNoticeEvent,
  peerDropEvents,
  peerRefusalReason,
} from "./deliveryNotices.ts";
import { buildPeerDeliveryBody } from "./peerDeliveryBody.ts";

export const A2A_DELIVERY_CONFIG_VERSION = config.version;

/** One poll hands out at most this many deliveries, or about this many bytes of message text. */
export { PEER_POLL_BATCH_COUNT };
export const PEER_POLL_BATCH_BYTES = 1_000_000;

const decodeSentPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(MessageSentPayload));
const encodeDeliveryBody = Schema.encodeSync(Schema.fromJsonString(PeerDeliveryRequest));

interface DeliveryRow {
  readonly project_id: string;
  readonly message_id: string;
  readonly sent_seq: number;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly receiver_project_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: "none" | "ask" | "followup" | "reply" | "terminal_notice";
  readonly envelope_channel: "peer" | "silence_notice" | "lifecycle_notice";
  readonly correlation_id: string;
  readonly message_text: string;
  readonly status: "pending" | "retry_scheduled" | "delivered" | "alarmed";
  readonly attempts: number;
  readonly created_at: string;
  /** Set when the row came in from a peer server; NULL means the origin is `project_id` here. */
  readonly origin_project_id: string | null;
  readonly origin_environment_id: string | null;
  /** Set when the receiver is homed on a peer server, which writes its own received row. */
  readonly receiver_environment_id: string | null;
  /** When a polling peer was first handed the row; only its ack decides it after that. */
  readonly handed_out_at: string | null;
}

export interface DeliveryAttempt {
  readonly projectId: LedgerProjectId;
  readonly messageId: LedgerMessageId;
  readonly attempt: number;
}

export interface A2ADeliveryHooksShape {
  readonly afterTransportSuccess: (
    attempt: DeliveryAttempt,
  ) => Effect.Effect<void, A2ADeliveryHookError>;
  /** Tests only: runs once a hand-out has chosen its rows, just before it stamps them. */
  readonly beforeHandOutStamp?: Effect.Effect<void>;
}

export class A2ADeliveryHookError extends Schema.TaggedError<A2ADeliveryHookError>()(
  "A2ADeliveryHookError",
  { cause: Schema.Defect() },
) {}

export class A2ADeliveryWorkerError extends Schema.TaggedError<A2ADeliveryWorkerError>()(
  "A2ADeliveryWorkerError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class A2ADeliveryHooks extends Context.Service<A2ADeliveryHooks, A2ADeliveryHooksShape>()(
  "t3/j5/a2a/DeliveryWorker/A2ADeliveryHooks",
) {}

export const noopHooks = Layer.succeed(
  A2ADeliveryHooks,
  A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
);

export interface A2ADeliveryWorkerShape {
  readonly notify: Effect.Effect<void>;
  readonly cancelParticipantDeliveries: (
    participantId: ParticipantId,
  ) => Effect.Effect<void, A2ADeliveryWorkerError>;
  readonly runOnce: Effect.Effect<DeliveryMilestone | null, A2ADeliveryWorkerError>;
  /**
   * Whether a direct attempt of this row to a peer server is on the wire now,
   * so the peer may already hold it. Read under the ledger writer's permit, it
   * is exact: an attempt registers under that permit before it sends.
   */
  readonly peerAttemptInFlight: (projectId: string, messageId: string) => Effect.Effect<boolean>;
  readonly drain: Effect.Effect<ReadonlyArray<DeliveryMilestone>, A2ADeliveryWorkerError>;
  readonly listAlarms: Effect.Effect<ReadonlyArray<DeliveryAlarm>, A2ADeliveryWorkerError>;
  /** The next batch of messages stored for a polling peer, stamped as handed out. */
  readonly handOutToPeer: (environmentId: string) => Effect.Effect<
    {
      readonly deliveries: ReadonlyArray<PeerDeliveryRequest>;
      readonly more: boolean;
    },
    A2ADeliveryWorkerError
  >;
  readonly acknowledgePeer: (
    environmentId: string,
    acks: ReadonlyArray<PeerPollAck>,
  ) => Effect.Effect<void, A2ADeliveryWorkerError>;
  readonly subscribeMilestones: Effect.Effect<Stream.Stream<DeliveryMilestone>, never, Scope.Scope>;
}

export class A2ADeliveryWorker extends Context.Service<A2ADeliveryWorker, A2ADeliveryWorkerShape>()(
  "t3/j5/a2a/DeliveryWorker/A2ADeliveryWorker",
) {}

type A2ADeliveryAttemptError =
  | A2ALedgerError
  | A2ADeliveryTransportError
  | A2ADeliveryRefusedError
  | A2ADeliveryHeldError
  | A2ADeliveryHookError
  | SqlError;

const errorText = (cause: Cause.Cause<A2ADeliveryAttemptError>) =>
  Cause.pretty(cause).slice(0, 4_000);

const workerError = (operation: string) => (cause: unknown) =>
  new A2ADeliveryWorkerError({ operation, cause });

/**
 * A held receiver queue waits for a person; recheck it slowly and never alarm on it.
 * Each recheck appends a ledger event, so the interval doubles from one minute to a
 * fifteen-minute cap: a long hold costs about four events an hour, not sixty.
 */
export const heldQueueRecheckMs = (attempt: number) =>
  Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);

const heldError = (cause: Cause.Cause<A2ADeliveryAttemptError>) => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" && isHeldError(error.value) ? error.value : undefined;
};

/** A peer server's refusal: its code, and its own sentence for why. */
interface PeerRefusal {
  readonly code: string;
  readonly message: string;
}

/** A peer server's refusal of a direct send: as final as a polling peer's refusing ack. */
const refusalOf = (cause: Cause.Cause<A2ADeliveryAttemptError>): PeerRefusal | undefined => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" && isRefusedError(error.value)
    ? { code: error.value.code, message: error.value.refusal }
    : undefined;
};

const backoffMs = (attempt: number) =>
  Math.min(config.initialBackoffMs * 2 ** Math.max(0, attempt - 1), config.maximumBackoffMs);

const commandId = (operation: string, messageId: LedgerMessageId, attempt?: number) =>
  CommCommandId.make(
    ["command", "j5", "a2a", operation, encodeURIComponent(messageId), attempt]
      .filter((part) => part !== undefined)
      .join(":"),
  );

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    A2ADeliveryWorker,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const writer = yield* A2ALedgerTransactionWriter;
      const transport = yield* A2ADeliveryTransport;
      const hooks = yield* A2ADeliveryHooks;
      const sql = yield* SqlClient.SqlClient;
      const wakeups = yield* Queue.unbounded<void>();
      const milestones = yield* PubSub.unbounded<DeliveryMilestone>();
      const drainPermit = yield* Semaphore.make(1);
      // Rows stored for a polling peer are never drained; their hand-outs, acks
      // and cancels share this permit instead, so a slow local delivery or a dead
      // direct peer holding the drain permit never stalls a poll.
      const storePermit = yield* Semaphore.make(1);
      // Direct attempts to a peer server now on the wire, by `projectId messageId`.
      const peerAttemptsInFlight = new Set<string>();
      // A row for a peer that polls waits for its poll: never attempted, retried or alarmed here.
      const notStoredForPollingPeer = sql`(
        receiver_environment_id IS NULL
        OR receiver_environment_id NOT IN (
          SELECT environment_id FROM j5_a2a_peer WHERE link_mode = 'store'
        )
      )`;
      const storedForPollingPeer = sql`(
        receiver_environment_id IN (SELECT environment_id FROM j5_a2a_peer WHERE link_mode = 'store')
      )`;

      const appendReceiverEntry = Effect.fn("j5.a2a.delivery.appendReceiverEntry")(function* (
        row: DeliveryRow,
      ) {
        if (row.project_id === row.receiver_project_id) return;
        const originProjectId = LedgerProjectId.make(row.project_id);
        const receiverProjectId = LedgerProjectId.make(row.receiver_project_id);
        const exchangeId = row.exchange_id === null ? null : ExchangeId.make(row.exchange_id);
        const receivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        // A reply's Exchange was closed in this ledger when the reply was accepted.
        const events: Array<CommEvent> = [
          {
            kind: "message.received",
            sender: ParticipantId.make(row.sender_id),
            receiver: ParticipantId.make(row.receiver_id),
            exchangeId,
            correlationId: CorrelationId.make(row.correlation_id),
            payload: {
              originProjectId,
              message: {
                messageId: row.message_id,
                text: row.message_text,
                originProjectId,
                receiverProjectId,
                exchangeRole: row.exchange_role,
                envelopeChannel: row.envelope_channel,
              },
            },
            createdAt: receivedAt,
          },
        ];
        yield* ledger.appendEvents({
          commandId: commandId("receive", LedgerMessageId.make(row.message_id)),
          projectId: receiverProjectId,
          acceptedAt: receivedAt,
          events,
        });
      });

      const attemptDelivery = Effect.fn("j5.a2a.delivery.attempt")(function* (
        row: DeliveryRow,
        attempt: number,
      ) {
        // The ledger that owns the row records the outcome; the envelope names
        // the origin, which differs only for rows received from a peer server.
        const ledgerProjectId = LedgerProjectId.make(row.project_id);
        const originProjectId = LedgerProjectId.make(row.origin_project_id ?? row.project_id);
        const receiverProjectId = LedgerProjectId.make(row.receiver_project_id);
        const messageId = LedgerMessageId.make(row.message_id);
        const senderId = ParticipantId.make(row.sender_id);
        const receiverId = ParticipantId.make(row.receiver_id);
        const exchangeId = row.exchange_id === null ? null : ExchangeId.make(row.exchange_id);
        if (row.receiver_environment_id !== null) {
          yield* transport.deliverPeer({
            receiverEnvironmentId: row.receiver_environment_id,
            body: yield* buildPeerDeliveryBody(sql, row).pipe(
              Effect.mapError(
                (cause) =>
                  new A2ADeliveryTransportError({ operation: "build peer delivery", cause }),
              ),
            ),
          });
        } else if (isHumanParticipantId(receiverId)) {
          yield* appendReceiverEntry(row);
          yield* transport.deliverHuman({
            originProjectId,
            receiverProjectId,
            messageId,
            senderId,
            receiverId,
            exchangeId,
            exchangeRole: row.exchange_role,
            message: row.message_text,
            envelopeChannel: row.envelope_channel,
            createdAt: row.created_at,
          });
        } else {
          yield* appendReceiverEntry(row);
          // Canonical references live in the immutable sent fact. Reading that
          // indexed row avoids a second projection and a schema migration.
          const sent = yield* sql<{ readonly kind: string; readonly payload: string }>`
            SELECT kind, payload FROM j5_a2a_comm_event
            WHERE project_id = ${row.project_id} AND seq = ${row.sent_seq}
          `;
          const payload =
            sent[0]?.kind === "message.sent"
              ? yield* decodeSentPayload(sent[0].payload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new A2ADeliveryTransportError({
                        operation: "read delivery attachments",
                        cause,
                      }),
                  ),
                )
              : undefined;
          // A message received from a peer server names that server in its
          // envelope, by the name the peer last reported for itself.
          const senderServerName =
            row.origin_environment_id === null
              ? undefined
              : (reportedLabel(
                  (yield* sql<{ readonly label: string }>`
                    SELECT label FROM j5_a2a_peer WHERE environment_id = ${row.origin_environment_id}
                  `)[0]?.label,
                ) ?? row.origin_environment_id);
          yield* transport.deliverAgent({
            originProjectId,
            receiverProjectId,
            messageId,
            senderId,
            receiverId,
            exchangeId,
            exchangeRole: row.exchange_role,
            message: row.message_text,
            ...(payload?.attachments === undefined ? {} : { attachments: payload.attachments }),
            ...(payload?.mode === undefined ? {} : { mode: payload.mode }),
            ...(payload?.modeLimit === undefined ? {} : { modeLimit: payload.modeLimit }),
            envelopeChannel: row.envelope_channel,
            ...(senderServerName === undefined ? {} : { senderServerName }),
          });
        }
        yield* hooks.afterTransportSuccess({ projectId: ledgerProjectId, messageId, attempt });
        return yield* recordDelivered(row, attempt);
      });

      /** The receipt: a local delivery, a peer's 2xx, or a polling peer's acknowledgement. */
      const recordDelivered = Effect.fn("j5.a2a.delivery.recordDelivered")(function* (
        row: DeliveryRow,
        attempt: number,
      ) {
        const ledgerProjectId = LedgerProjectId.make(row.project_id);
        const messageId = LedgerMessageId.make(row.message_id);
        const senderId = ParticipantId.make(row.sender_id);
        const receiverId = ParticipantId.make(row.receiver_id);
        const exchangeId = row.exchange_id === null ? null : ExchangeId.make(row.exchange_id);
        const outcome = yield* writer.withPermit(
          sql.withTransaction(
            Effect.gen(function* () {
              // A peer that answered 2xx holds the message; a sender retired during
              // the call cannot take it back, so only a prior cancellation counts.
              if (yield* deliveryUnavailable(row, row.receiver_environment_id !== null))
                return null;

              const deliveredAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
              return yield* writer.appendEventsInTransaction({
                commandId: commandId("delivered", messageId),
                projectId: ledgerProjectId,
                acceptedAt: deliveredAt,
                events: [
                  {
                    kind: "message.delivered",
                    sender: senderId,
                    receiver: receiverId,
                    exchangeId,
                    correlationId: CorrelationId.make(row.correlation_id),
                    payload: {
                      messageId,
                      attempt,
                      channel: isHumanParticipantId(receiverId) ? "human" : "agent",
                    },
                    createdAt: deliveredAt,
                  },
                ],
              });
            }),
          ),
        );
        if (outcome === null) return yield* cancelDelivery(row, attempt);
        if (outcome.committed) yield* writer.publishCommitted(outcome.events);
        return {
          projectId: ledgerProjectId,
          messageId,
          state: "delivered",
          attempt,
        } satisfies DeliveryMilestone;
      });

      const recordFailure = Effect.fn("j5.a2a.delivery.recordFailure")(function* (
        row: DeliveryRow,
        attempt: number,
        cause: Cause.Cause<A2ADeliveryAttemptError>,
        /** The peer server refused the message: permanent, with the peer's own reason. */
        refusal?: PeerRefusal,
      ) {
        const failedAtDate = yield* DateTime.now;
        const failedAt = DateTime.formatIso(failedAtDate);
        // A held queue is not a failed delivery: it stays retry_scheduled, never delivered or alarmed.
        const held = heldError(cause);
        const alarmed =
          refusal !== undefined || (held === undefined && attempt >= config.alarmAfterAttempts);
        const nextAttemptAt = alarmed
          ? null
          : DateTime.formatIso(
              DateTime.add(failedAtDate, {
                milliseconds: held !== undefined ? heldQueueRecheckMs(attempt) : backoffMs(attempt),
              }),
            );
        const messageId = LedgerMessageId.make(row.message_id);
        const outcome = yield* writer.withPermit(
          sql.withTransaction(
            Effect.gen(function* () {
              // A peer server that refused the message already decided it; a
              // sender retired since cannot take that back, as with a receipt.
              if (yield* deliveryUnavailable(row, refusal !== undefined)) return null;
              const told =
                refusal === undefined ? [] : yield* refusalNotices(row, refusal, failedAt);
              return yield* writer.appendEventsInTransaction({
                commandId: commandId("failed", messageId, attempt),
                projectId: LedgerProjectId.make(row.project_id),
                acceptedAt: failedAt,
                events: [
                  {
                    kind: "message.delivery_failed",
                    sender: ParticipantId.make(row.sender_id),
                    receiver: ParticipantId.make(row.receiver_id),
                    exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
                    correlationId: CorrelationId.make(row.correlation_id),
                    payload: {
                      messageId,
                      attempt,
                      error:
                        refusal === undefined
                          ? (held?.message ?? errorText(cause))
                          : `${refusal.code}: ${refusal.message}`,
                      nextAttemptAt,
                      alarmed,
                    },
                    createdAt: failedAt,
                  },
                  ...told,
                ],
              });
            }),
          ),
        );
        if (outcome === null) return yield* cancelDelivery(row, attempt);
        if (outcome.committed) yield* writer.publishCommitted(outcome.events);
        return {
          projectId: LedgerProjectId.make(row.project_id),
          messageId,
          state: alarmed ? ("alarmed" as const) : ("retry_scheduled" as const),
          attempt,
        } satisfies DeliveryMilestone;
      });

      /**
       * What the sender is told of a peer server's refusal: one not-delivered
       * notice. A refused ask's notice also closes its Exchange, which is
       * dropped as refused.
       */
      const refusalNotices = Effect.fn("j5.a2a.delivery.refusalNotices")(function* (
        row: DeliveryRow,
        refusal: PeerRefusal,
        createdAt: string,
      ) {
        if (row.receiver_environment_id === null) return [];
        const serverName =
          reportedLabel(
            (yield* sql<{ readonly label: string }>`
              SELECT label FROM j5_a2a_peer WHERE environment_id = ${row.receiver_environment_id}
            `)[0]?.label,
          ) ?? row.receiver_environment_id;
        const reason = peerRefusalReason({ serverName, ...refusal });
        if (row.exchange_role === "ask" && row.exchange_id !== null) {
          const exchange = (yield* sql<DroppedExchange>`
            SELECT project_id, exchange_id, sender_id, receiver_id FROM j5_a2a_exchange
            WHERE project_id = ${row.project_id} AND exchange_id = ${row.exchange_id}
              AND status = 'open'
          `)[0];
          if (exchange !== undefined) {
            return peerDropEvents({
              exchange,
              disposition: "receiver-retired",
              cause: {
                kind: "delivery-refused",
                participantId: ParticipantId.make(row.receiver_id),
                projectId: LedgerProjectId.make(row.receiver_project_id),
              },
              localProjectId: row.project_id,
              noticeText: formatNotDeliveredNotice({
                receiverId: row.receiver_id,
                serverName,
                reason,
                exchangeId: exchange.exchange_id,
              }),
              createdAt,
            });
          }
        }
        if (!canBeNotified(row.sender_id)) return [];
        return [notDeliveredNoticeEvent({ message: row, serverName, reason, createdAt })];
      });

      const deliveryUnavailable = Effect.fn("j5.a2a.delivery.unavailable")(function* (
        row: DeliveryRow,
        /** The receiver's server has already accepted the message; parties no longer matter. */
        accepted = false,
      ) {
        const state = yield* sql<{ readonly status: string }>`SELECT status FROM j5_a2a_delivery
          WHERE project_id = ${row.project_id} AND message_id = ${row.message_id}`;
        if (state[0]?.status === "cancelled") return true;
        if (state[0]?.status === "delivered") return false;
        if (accepted) return false;
        // A participant on a peer server has no membership here; only local parties are checked.
        const ids = [
          ...(row.envelope_channel === "peer" && row.origin_environment_id == null
            ? [row.sender_id]
            : []),
          ...(row.receiver_environment_id == null ? [row.receiver_id] : []),
        ];
        for (const id of ids) {
          // Humans and machines never hold agent membership, and a registered
          // machine is never retired, so only agents can become unavailable.
          const participantId = ParticipantId.make(id);
          if (isHumanParticipantId(participantId) || isMachineParticipantId(participantId)) {
            continue;
          }
          const membership =
            yield* sql`SELECT 1 FROM j5_a2a_membership WHERE participant_id = ${id} AND archived_at IS NULL`;
          if (membership.length !== 1) return true;
        }
        return false;
      });
      const cancelDelivery = Effect.fn("j5.a2a.delivery.cancel")(function* (
        row: DeliveryRow,
        attempt: number,
      ) {
        const current = yield* sql<{
          readonly status: string;
        }>`SELECT status FROM j5_a2a_delivery WHERE project_id = ${row.project_id} AND message_id = ${row.message_id}`;
        if (current[0]?.status === "cancelled" || current[0]?.status === "delivered") {
          return {
            projectId: LedgerProjectId.make(row.project_id),
            messageId: LedgerMessageId.make(row.message_id),
            state: current[0].status,
            attempt,
          } satisfies DeliveryMilestone;
        }
        const state =
          isHumanParticipantId(ParticipantId.make(row.receiver_id)) ||
          row.receiver_environment_id != null
            ? "cancelled"
            : yield* transport.cancelAgent({
                receiverId: ParticipantId.make(row.receiver_id),
                messageId: LedgerMessageId.make(row.message_id),
              });
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* ledger.append({
          commandId: commandId(state, LedgerMessageId.make(row.message_id)),
          projectId: LedgerProjectId.make(row.project_id),
          acceptedAt: now,
          event: {
            kind: state === "cancelled" ? "message.cancelled" : "message.delivered",
            sender: ParticipantId.make(row.sender_id),
            receiver: ParticipantId.make(row.receiver_id),
            exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
            correlationId: CorrelationId.make(row.correlation_id),
            createdAt: now,
            payload:
              state === "cancelled"
                ? {
                    messageId: row.message_id,
                    reason:
                      "Participant is archived, deleted, or retired; accepted queue work was withdrawn.",
                  }
                : { messageId: row.message_id, attempt, channel: "agent" },
          },
        });
        return {
          projectId: LedgerProjectId.make(row.project_id),
          messageId: LedgerMessageId.make(row.message_id),
          state,
          attempt,
        } satisfies DeliveryMilestone;
      });

      const runOnceRaw = Effect.gen(function* () {
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const rows = yield* sql<DeliveryRow>`
          SELECT
            project_id,
            message_id,
            sent_seq,
            sender_id,
            receiver_id,
            receiver_project_id,
            exchange_id,
            exchange_role,
            envelope_channel,
            correlation_id,
            message_text,
            status,
            attempts,
            created_at,
            origin_project_id,
            origin_environment_id,
            receiver_environment_id
          FROM j5_a2a_delivery
          WHERE status IN ('pending', 'retry_scheduled')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
            AND ${notStoredForPollingPeer}
          ORDER BY sent_seq, project_id, message_id
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return null;
        const attempt = row.attempts + 1;
        if (yield* deliveryUnavailable(row)) {
          const milestone = yield* cancelDelivery(row, attempt);
          yield* PubSub.publish(milestones, milestone);
          return milestone;
        }
        const inFlight = `${row.project_id} ${row.message_id}`;
        if (row.receiver_environment_id !== null) {
          // Registered under the writer's permit with the row rechecked, so a peer
          // removal, which holds that permit, either sees this attempt or has
          // already cancelled the row, which is then never sent.
          const claimed = yield* writer.withPermit(
            Effect.gen(function* () {
              const [current] = yield* sql<{ readonly status: string }>`
                SELECT status FROM j5_a2a_delivery
                WHERE project_id = ${row.project_id} AND message_id = ${row.message_id}
              `;
              if (current?.status !== "pending" && current?.status !== "retry_scheduled") {
                return false;
              }
              peerAttemptsInFlight.add(inFlight);
              return true;
            }),
          );
          if (!claimed) {
            const milestone = {
              projectId: LedgerProjectId.make(row.project_id),
              messageId: LedgerMessageId.make(row.message_id),
              state: "cancelled",
              attempt,
            } satisfies DeliveryMilestone;
            yield* PubSub.publish(milestones, milestone);
            return milestone;
          }
        }
        const milestone = yield* Effect.gen(function* () {
          const exit = yield* Effect.exit(attemptDelivery(row, attempt));
          return exit._tag === "Success"
            ? exit.value
            : yield* recordFailure(row, attempt, exit.cause, refusalOf(exit.cause));
        }).pipe(Effect.ensuring(Effect.sync(() => peerAttemptsInFlight.delete(inFlight))));
        yield* PubSub.publish(milestones, milestone);
        return milestone;
      });
      const runOnceEffect = runOnceRaw.pipe(Effect.mapError(workerError("run one delivery")));
      const runOnce: A2ADeliveryWorkerShape["runOnce"] = drainPermit.withPermit(runOnceEffect);

      const drainEffect = Effect.fn("j5.a2a.delivery.drain")(function* () {
        const completed: Array<DeliveryMilestone> = [];
        while (true) {
          const milestone = yield* runOnceEffect;
          if (milestone === null) return completed;
          completed.push(milestone);
        }
      });
      const drain: A2ADeliveryWorkerShape["drain"] = drainPermit.withPermit(drainEffect());

      const nextDelay = Effect.fn("j5.a2a.delivery.nextDelay")(function* () {
        const rows = yield* sql<{ readonly next_attempt_at: string | null }>`
          SELECT next_attempt_at
          FROM j5_a2a_delivery
          WHERE status IN ('pending', 'retry_scheduled')
            AND ${notStoredForPollingPeer}
          ORDER BY next_attempt_at IS NOT NULL, next_attempt_at, sent_seq
          LIMIT 1
        `;
        const value = rows[0]?.next_attempt_at;
        if (value === undefined) return null;
        if (value === null) return 0;
        const now = yield* DateTime.now;
        return Math.max(0, Date.parse(value) - DateTime.toEpochMillis(now));
      });

      const runDaemon = Effect.forever(
        Effect.gen(function* () {
          yield* drain;
          const delay = yield* nextDelay();
          if (delay === null) {
            yield* Queue.take(wakeups);
          } else if (delay === 0) {
            yield* Effect.yieldNow;
          } else {
            yield* Effect.raceFirst(Queue.take(wakeups), Effect.sleep(Duration.millis(delay)));
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 A2A delivery drain failed", { cause }).pipe(
              Effect.andThen(
                Effect.raceFirst(
                  Queue.take(wakeups),
                  Effect.sleep(Duration.millis(config.initialBackoffMs)),
                ),
              ),
            ),
          ),
        ),
      );
      if (daemon) {
        yield* Effect.forkScoped(runDaemon);
      }
      yield* Queue.offer(wakeups, undefined);

      const cancelRows = Effect.fn("j5.a2a.delivery.cancelRows")(function* (
        rows: ReadonlyArray<DeliveryRow>,
      ) {
        for (const row of rows) {
          const milestone = yield* cancelDelivery(row, row.attempts + 1);
          yield* PubSub.publish(milestones, milestone);
        }
      });
      // Under the drain permit, so cancellation observes transport acceptance before writing a terminal fact.
      const cancelDirectDeliveries = Effect.fn("j5.a2a.delivery.cancelDirectDeliveries")(function* (
        participantId: ParticipantId,
      ) {
        yield* cancelRows(
          yield* sql<DeliveryRow>`SELECT * FROM j5_a2a_delivery
          WHERE status IN ('pending', 'retry_scheduled', 'alarmed')
            AND handed_out_at IS NULL
            AND ${notStoredForPollingPeer}
            AND (sender_id = ${participantId} OR receiver_id = ${participantId})`,
        );
      });
      // Under the store permit. A row handed out to a polling peer may already be
      // in the peer's thread, so only its acknowledgement decides it; one the peer
      // refused is already decided, and clears like a direct alarm.
      const cancelStoredDeliveries = Effect.fn("j5.a2a.delivery.cancelStoredDeliveries")(function* (
        participantId: ParticipantId,
      ) {
        yield* cancelRows(
          yield* sql<DeliveryRow>`SELECT * FROM j5_a2a_delivery
          WHERE status IN ('pending', 'retry_scheduled', 'alarmed')
            AND (handed_out_at IS NULL OR status = 'alarmed')
            AND ${storedForPollingPeer}
            AND (sender_id = ${participantId} OR receiver_id = ${participantId})`,
        );
      });
      /**
       * A polling peer's waiting rows, oldest first, up to the batch limit, each
       * stamped the first time it is handed out. A row not acknowledged is
       * handed out again next time; the peer records each idempotently by its
       * message id. A row whose sender or receiver here is no longer available
       * before its first hand-out is cancelled instead, as a direct attempt would
       * be. Runs under the store
       * permit, so a cancellation sees either no hand-out or a stamped row, never
       * a row in between.
       */
      const handOutToPeer = Effect.fn("j5.a2a.delivery.handOutToPeer")(function* (
        environmentId: string,
      ) {
        const rows = yield* sql<DeliveryRow>`
          SELECT * FROM j5_a2a_delivery
          WHERE receiver_environment_id = ${environmentId}
            AND status IN ('pending', 'retry_scheduled')
          ORDER BY sent_seq, project_id, message_id
          LIMIT ${PEER_POLL_BATCH_COUNT + 1}
        `;
        // The bound is on what goes over the wire: each body as UTF-8 JSON.
        // One delivery always goes, however large, so a big message never stalls the rest.
        const deliveries: Array<PeerDeliveryRequest> = [];
        let bytes = 0;
        for (const row of rows.slice(0, PEER_POLL_BATCH_COUNT)) {
          // A row already handed out may be in the peer's thread, and its
          // answer lost: it goes again, whoever left here since.
          if (row.handed_out_at === null && (yield* deliveryUnavailable(row))) {
            yield* PubSub.publish(milestones, yield* cancelDelivery(row, row.attempts + 1));
            continue;
          }
          const body = yield* buildPeerDeliveryBody(sql, row);
          const size = Buffer.byteLength(encodeDeliveryBody(body), "utf8");
          if (deliveries.length > 0 && bytes + size > PEER_POLL_BATCH_BYTES) break;
          deliveries.push(body);
          bytes += size;
        }
        if (deliveries.length === 0) return { deliveries: [], more: false };
        yield* hooks.beforeHandOutStamp ?? Effect.void;
        const handedOutAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        // Rechecked and stamped in one write, so a peer removal that committed
        // since these rows were read leaves nothing to hand out, and one that
        // comes after sees them handed out.
        const handed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const recorded = yield* sql`
              SELECT 1 FROM j5_a2a_peer WHERE environment_id = ${environmentId}
            `;
            if (recorded.length === 0) return new Set<string>();
            const waiting = yield* sql<{ readonly message_id: string }>`
              SELECT message_id FROM j5_a2a_delivery
              WHERE receiver_environment_id = ${environmentId}
                AND status IN ('pending', 'retry_scheduled')
                AND message_id IN ${sql.in(deliveries.map((delivery) => delivery.messageId))}
            `;
            if (waiting.length === 0) return new Set<string>();
            yield* sql`
              UPDATE j5_a2a_delivery SET handed_out_at = ${handedOutAt}
              WHERE receiver_environment_id = ${environmentId}
                AND handed_out_at IS NULL
                AND message_id IN ${sql.in(waiting.map((row) => row.message_id))}
            `;
            return new Set(waiting.map((row) => row.message_id));
          }),
        );
        const stillWaiting = deliveries.filter((delivery) => handed.has(delivery.messageId));
        return {
          deliveries: stillWaiting,
          more: stillWaiting.length > 0 && rows.length > deliveries.length,
        };
      });

      /** A polling peer's answer about each row it was handed: a receipt, or its refusal. */
      const acknowledgePeer = Effect.fn("j5.a2a.delivery.acknowledgePeer")(function* (
        environmentId: string,
        acks: ReadonlyArray<PeerPollAck>,
      ) {
        for (const ack of acks) {
          const rows = yield* sql<DeliveryRow>`
            SELECT * FROM j5_a2a_delivery
            WHERE receiver_environment_id = ${environmentId}
              AND message_id = ${ack.messageId}
              AND handed_out_at IS NOT NULL
              AND status IN ('pending', 'retry_scheduled')
            LIMIT 1
          `;
          // Already decided, never handed out, or not this peer's: nothing to record.
          const row = rows[0];
          if (row === undefined) continue;
          const milestone =
            ack.outcome === "received"
              ? yield* recordDelivered(row, row.attempts + 1)
              : yield* recordFailure(row, row.attempts + 1, Cause.empty, {
                  code: ack.code,
                  message: ack.message,
                });
          yield* PubSub.publish(milestones, milestone);
          // A refusal queues its notice here, outside the drain: wake it.
          if (ack.outcome !== "received") yield* Queue.offer(wakeups, undefined);
        }
      });

      return A2ADeliveryWorker.of({
        // Each kind of row under the permit its receipts take, side by side, so a
        // stored row is cancelled at once while a slow direct attempt holds the drain.
        cancelParticipantDeliveries: (participantId) =>
          Effect.all(
            [
              drainPermit.withPermit(cancelDirectDeliveries(participantId)),
              storePermit.withPermit(cancelStoredDeliveries(participantId)),
            ],
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.mapError(workerError("cancel participant deliveries"))),
        notify: Queue.offer(wakeups, undefined).pipe(Effect.asVoid),
        handOutToPeer: (environmentId) =>
          storePermit
            .withPermit(handOutToPeer(environmentId))
            .pipe(Effect.mapError(workerError("hand out to a polling peer"))),
        acknowledgePeer: (environmentId, acks) =>
          storePermit
            .withPermit(acknowledgePeer(environmentId, acks))
            .pipe(Effect.mapError(workerError("record a polling peer's acknowledgements"))),
        runOnce,
        peerAttemptInFlight: (projectId, messageId) =>
          Effect.sync(() => peerAttemptsInFlight.has(`${projectId} ${messageId}`)),
        drain,
        listAlarms: sql<{
          readonly project_id: string;
          readonly message_id: string;
          readonly attempts: number;
          readonly last_error: string;
        }>`
          SELECT project_id, message_id, attempts, last_error
          FROM j5_a2a_delivery
          WHERE status = 'alarmed'
          ORDER BY updated_at, project_id, message_id
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              projectId: LedgerProjectId.make(row.project_id),
              messageId: LedgerMessageId.make(row.message_id),
              attempts: row.attempts,
              lastError: row.last_error,
            })),
          ),
          Effect.mapError(workerError("list delivery alarms")),
        ),
        subscribeMilestones: PubSub.subscribe(milestones).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      });
    }),
  );

export const manualLayer = makeLayer(false).pipe(Layer.provide(noopHooks));
export const layer = makeLayer(true).pipe(Layer.provide(noopHooks));
export const layerWithHooks = (daemon: boolean) => makeLayer(daemon);
