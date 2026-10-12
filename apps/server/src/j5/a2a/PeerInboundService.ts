import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import type { PeerDeliveryRequest } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { exceededDispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import { A2ALedgerTransactionWriter, type A2ALedgerError } from "./LedgerService.ts";
import { stablePart } from "./spawnIds.ts";
import { findPeerCounterparty, isRoutedElsewhere } from "./peerCounterparty.ts";
import {
  type CommEvent,
  CommCommandId,
  CorrelationId,
  ExchangeId,
  isHumanParticipantId,
  isMachineParticipantId,
  isOutsideAgentParticipantId,
  isPlatformParticipantId,
  LedgerMessageId,
  LIFECYCLE_PARTICIPANT_ID,
  Participant,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  LedgerProjectId,
} from "./contracts.ts";

/**
 * The receiving side of a cross-server delivery. A peer's message becomes the
 * receiver project's own `message.received` row, which the ledger projects into
 * the pending delivery the worker then carries to the agent's thread. An ask
 * also opens the Exchange here, so the local agent's reply is an ordinary
 * same-project reply and the silence detector measures the debt; a reply
 * closes the Exchange the local agent opened. One command id per origin
 * message makes a retry a replay.
 */

export interface PeerInboundInput extends PeerDeliveryRequest {
  readonly originEnvironmentId: string;
}

export interface PeerInboundResult {
  readonly receivedSeq: number;
  readonly replay: boolean;
}

/** The codes a refusal answers with; a sender takes only these as final. */
export const PeerDeliveryRefusalCode = Schema.Literals([
  "recipient_not_found",
  "policy_refused",
  "invalid_request",
  "message_id_conflict",
  "landing_refused",
]);
export type PeerDeliveryRefusalCode = typeof PeerDeliveryRefusalCode.Type;

/**
 * How a refused delivery from a peer is answered, the same whether it came to
 * the deliver route or was handed to this server by a poll and is refused in
 * the next poll's ack. Null for a failure that is not a refusal, which is
 * retried rather than answered.
 */
export const peerDeliveryRefusal = (
  error: unknown,
): {
  readonly status: number;
  readonly code: PeerDeliveryRefusalCode;
  readonly message: string;
  readonly reason?: string;
} | null => {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "";
  const message = error instanceof Error ? error.message : "Delivery refused.";
  switch (tag) {
    case "A2APeerReceiverNotFoundError":
      return { status: 404, code: "recipient_not_found", message };
    case "A2APeerReceiverNotDeliverableError":
    case "A2APeerSenderNotOwnedError":
    case "A2APeerSenderNotAllowedError":
      return { status: 403, code: "policy_refused", message, reason: tag };
    case "A2APeerAskIntentRequiredError":
      return { status: 400, code: "invalid_request", message };
    case "A2APeerLandingRefusedError":
      return { status: 403, code: "landing_refused", message };
    case "CommCommandConflictError":
      return { status: 409, code: "message_id_conflict", message };
    default:
      return null;
  }
};

/**
 * The sender asked for a steer or a restart, and the receiver runs with broader modes than the
 * sender could touch: upstream's rule for a write to another thread, applied to a peer's agent.
 */
export class A2APeerLandingRefusedError extends Schema.TaggedError<A2APeerLandingRefusedError>()(
  "A2APeerLandingRefusedError",
  {
    participantId: Schema.String,
    mode: Schema.Literals(["steer", "restart"]),
    exceeded: Schema.Literals(["runtime", "interaction"]),
  },
) {
  override get message(): string {
    return `${this.participantId} runs with a broader ${this.exceeded === "runtime" ? "permission" : "interaction"} mode than the sender, so the ${this.mode} is refused.`;
  }
}

export class A2APeerReceiverNotFoundError extends Schema.TaggedError<A2APeerReceiverNotFoundError>()(
  "A2APeerReceiverNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `No active agent ${this.participantId} is homed on this server.`;
  }
}

export class A2APeerReceiverNotDeliverableError extends Schema.TaggedError<A2APeerReceiverNotDeliverableError>()(
  "A2APeerReceiverNotDeliverableError",
  { participantId: Schema.String, reason: Schema.Literals(["human", "machine", "archived"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "human":
        return `${this.participantId} is a person; a person is never addressed across servers.`;
      case "machine":
        return `${this.participantId} is a machine participant and receives nothing.`;
      case "archived":
        return `${this.participantId} is archived and cannot receive.`;
    }
  }
}

export class A2APeerSenderNotOwnedError extends Schema.TaggedError<A2APeerSenderNotOwnedError>()(
  "A2APeerSenderNotOwnedError",
  { participantId: Schema.String, originEnvironmentId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is not homed on the peer that sent this message (${this.originEnvironmentId}); a peer may speak only for its own agents.`;
  }
}

export class A2APeerAskIntentRequiredError extends Schema.TaggedError<A2APeerAskIntentRequiredError>()(
  "A2APeerAskIntentRequiredError",
  { messageId: Schema.String, reason: Schema.Literals(["exchange-id", "intent"]) },
) {
  override get message(): string {
    return this.reason === "intent"
      ? `Message ${this.messageId} is an ask without an intent.`
      : `Message ${this.messageId} is an ask without an Exchange id; an ask opens an Exchange or it is not an ask.`;
  }
}

/**
 * A peer speaks only for its agents. It may not deliver as a person, a machine
 * participant or the platform, and an agent's message travels on the peer
 * channel as a plain send, ask, follow-up or reply.
 */
export class A2APeerSenderNotAllowedError extends Schema.TaggedError<A2APeerSenderNotAllowedError>()(
  "A2APeerSenderNotAllowedError",
  {
    senderId: Schema.String,
    reason: Schema.Literals([
      "human",
      "machine",
      "outside",
      "platform",
      "channel",
      "role",
      "exchange",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "human":
        return `${this.senderId} is a person; a peer server may not deliver as a person.`;
      case "machine":
        return `${this.senderId} is a machine participant; a peer server may not deliver as one.`;
      case "outside":
        return `${this.senderId} is an outside agent; it reaches agents on its own server only, and a peer server may not deliver as one.`;
      case "platform":
        return `${this.senderId} is not a platform notice a peer may carry: only the lifecycle's terminal notice or the silence detector's notice, each on its own channel and in its own shape.`;
      case "channel":
        return `${this.senderId} must deliver on the peer envelope channel.`;
      case "role":
        return `${this.senderId} may send, ask, follow up or reply; a terminal notice is the platform's to send.`;
      case "exchange":
        return `${this.senderId} may end only an Exchange this peer is party to.`;
    }
  }
}

/** The sending server is no longer a recorded peer: it was removed while this message was on its way. */
export class A2APeerNotRecordedError extends Schema.TaggedError<A2APeerNotRecordedError>()(
  "A2APeerNotRecordedError",
  { originEnvironmentId: Schema.String },
) {
  override get message(): string {
    return `Environment ${this.originEnvironmentId} is not a recorded peer of this server.`;
  }
}

export type PeerInboundError =
  | A2APeerNotRecordedError
  | SqlError
  | Schema.SchemaError
  | A2ALedgerError
  | A2APeerReceiverNotFoundError
  | A2APeerReceiverNotDeliverableError
  | A2APeerAskIntentRequiredError
  | A2APeerSenderNotAllowedError
  | A2APeerSenderNotOwnedError
  | A2APeerLandingRefusedError;

export interface PeerInboundServiceShape {
  readonly receive: (input: PeerInboundInput) => Effect.Effect<PeerInboundResult, PeerInboundError>;
}

export class PeerInboundService extends Context.Service<
  PeerInboundService,
  PeerInboundServiceShape
>()("t3/j5/a2a/PeerInboundService") {}

/** One receipt per origin message, whatever the peer retries. */
const peerReceiveCommandId = (input: {
  readonly originEnvironmentId: string;
  readonly messageId: string;
}) =>
  CommCommandId.make(
    `command:j5:a2a:peer:receive:${stablePart(input.originEnvironmentId)}:${stablePart(input.messageId)}`,
  );

/**
 * The message id this ledger keys the delivery by. The origin's id is
 * namespaced by its environment so a peer can never collide with, replay
 * into, or displace a local message or another peer's.
 */
const localMessageIdFor = (input: {
  readonly originEnvironmentId: string;
  readonly messageId: string;
}) =>
  LedgerMessageId.make(
    `message:j5:a2a:peer:${stablePart(input.originEnvironmentId)}:${stablePart(input.messageId)}`,
  );

/** Refuse the sender kinds, channels and roles a peer may not use, before anything is read. */
/**
 * Who a peer may speak as. Its agents, on the peer channel, never a terminal
 * notice. Or the platform itself, as exactly one of two notices, each in the
 * shape its producer writes: the lifecycle's terminal notice (the fact that
 * ends an Exchange) or the silence detector's notice (not part of any
 * Exchange, naming the one whose answerer went quiet). The receive path then
 * checks the Exchange is one this peer is party to.
 */
const assertSenderShape = (input: PeerInboundInput) => {
  const senderId = ParticipantId.make(input.senderId);
  const refuse = (reason: A2APeerSenderNotAllowedError["reason"]) =>
    Effect.fail(new A2APeerSenderNotAllowedError({ senderId, reason }));
  if (isHumanParticipantId(senderId)) return refuse("human");
  if (isMachineParticipantId(senderId)) return refuse("machine");
  if (isOutsideAgentParticipantId(senderId)) return refuse("outside");
  if (isPlatformParticipantId(senderId)) {
    const terminalNotice =
      senderId === LIFECYCLE_PARTICIPANT_ID &&
      input.envelopeChannel === "lifecycle_notice" &&
      input.exchangeRole === "terminal_notice" &&
      input.exchangeId !== null &&
      input.terminal !== undefined;
    if (terminalNotice) return Effect.succeed({ senderId, platform: "terminal" as const });
    const silenceNotice =
      senderId === SILENCE_DETECTOR_PARTICIPANT_ID &&
      input.envelopeChannel === "silence_notice" &&
      input.exchangeRole === "none" &&
      input.exchangeId === null &&
      input.terminal === undefined &&
      input.regardingExchangeId !== undefined;
    if (silenceNotice) return Effect.succeed({ senderId, platform: "silence" as const });
    return refuse("platform");
  }
  if (input.envelopeChannel !== "peer") return refuse("channel");
  if (input.exchangeRole === "terminal_notice") return refuse("role");
  return Effect.succeed({ senderId, platform: null });
};

interface MembershipRow {
  readonly project_id: string;
  readonly payload: string;
  readonly archived_at: string | null;
}

interface ExchangeRow {
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

type PeerInboundServiceRequirements = A2ALedgerTransactionWriter | SqlClient.SqlClient;

export const layer: Layer.Layer<PeerInboundService, never, PeerInboundServiceRequirements> =
  Layer.effect(
    PeerInboundService,
    Effect.gen(function* () {
      const writer = yield* A2ALedgerTransactionWriter;
      const sql = yield* SqlClient.SqlClient;

      const localReceiver = Effect.fn("j5.a2a.peer.inbound.receiver")(function* (
        id: ParticipantId,
      ) {
        if (isHumanParticipantId(id)) {
          return yield* new A2APeerReceiverNotDeliverableError({
            participantId: id,
            reason: "human",
          });
        }
        if (isMachineParticipantId(id)) {
          return yield* new A2APeerReceiverNotDeliverableError({
            participantId: id,
            reason: "machine",
          });
        }
        const rows = yield* sql<MembershipRow>`
          SELECT project_id, payload, archived_at
          FROM j5_a2a_membership
          WHERE participant_id = ${id}
          LIMIT 2
        `;
        const row = rows.length === 1 ? rows[0] : undefined;
        if (row === undefined)
          return yield* new A2APeerReceiverNotFoundError({ participantId: id });
        if (row.archived_at !== null) {
          return yield* new A2APeerReceiverNotDeliverableError({
            participantId: id,
            reason: "archived",
          });
        }
        const participant = yield* decodeParticipant(row.payload);
        if (participant.kind !== "agent") {
          return yield* new A2APeerReceiverNotFoundError({ participantId: id });
        }
        return { projectId: LedgerProjectId.make(row.project_id), participant };
      });

      /**
       * A retry replays the first receipt whatever has happened to the receiver
       * since: the peer's acknowledgement was lost, not the fact it recorded.
       */
      const priorReceipt = Effect.fn("j5.a2a.peer.inbound.priorReceipt")(function* (
        commandId: CommCommandId,
      ) {
        const rows = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM j5_a2a_comm_event
          WHERE command_id = ${commandId} AND kind = 'message.received'
          LIMIT 1
        `;
        return rows[0] === undefined
          ? null
          : ({ receivedSeq: rows[0].seq, replay: true } satisfies PeerInboundResult);
      });

      /**
       * A peer may speak only for agents it owns. An id homed here, or one the
       * ledger has already routed to a different peer, cannot be claimed by this
       * origin. First contact from an unknown id passes.
       */
      const assertSenderOwnedByOrigin = Effect.fn("j5.a2a.peer.inbound.senderOwned")(function* (
        senderId: ParticipantId,
        originEnvironmentId: string,
      ) {
        const local = yield* sql<{ readonly one: number }>`
          SELECT 1 AS one FROM j5_a2a_membership WHERE participant_id = ${senderId} LIMIT 1
        `;
        const owned =
          local[0] === undefined && !(yield* isRoutedElsewhere(sql, senderId, originEnvironmentId));
        if (!owned) {
          return yield* new A2APeerSenderNotOwnedError({
            participantId: senderId,
            originEnvironmentId,
          });
        }
      });

      const receive: PeerInboundServiceShape["receive"] = (input) =>
        Effect.gen(function* () {
          const commandId = peerReceiveCommandId({
            originEnvironmentId: input.originEnvironmentId,
            messageId: input.messageId,
          });
          const replayed = yield* priorReceipt(commandId);
          if (replayed !== null) return replayed;
          const { senderId, platform } = yield* assertSenderShape(input);
          if (platform === null)
            yield* assertSenderOwnedByOrigin(senderId, input.originEnvironmentId);
          const receiverId = ParticipantId.make(input.receiverId);
          const receiver = yield* localReceiver(receiverId);
          if (input.landing !== undefined) {
            // The sender's own server could not check this: only this one knows the receiver's
            // modes. Upstream checks the limit again when the message is dispatched.
            const modes = yield* sql<{
              readonly runtime_mode: RuntimeMode;
              readonly interaction_mode: ProviderInteractionMode;
            }>`
              SELECT runtime_mode, interaction_mode FROM orchestration_v2_projection_threads
              WHERE thread_id = ${receiver.participant.threadId}
            `;
            const exceeded =
              modes[0] === undefined
                ? undefined
                : exceededDispatchModeLimit(input.landing.limit, {
                    runtimeMode: modes[0].runtime_mode,
                    interactionMode: modes[0].interaction_mode,
                  });
            if (exceeded !== undefined) {
              return yield* new A2APeerLandingRefusedError({
                participantId: receiverId,
                mode: input.landing.mode,
                exceeded,
              });
            }
          }
          const exchangeId = input.exchangeId === null ? null : ExchangeId.make(input.exchangeId);
          const correlationId = CorrelationId.make(input.correlationId);
          const messageId = localMessageIdFor(input);
          const originProjectId = LedgerProjectId.make(input.originProjectId);
          // This ledger's clock stamps what happened here; the origin's time is kept for display.
          const receivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const events: Array<CommEvent> = [];

          if (input.exchangeRole === "ask") {
            if (exchangeId === null) {
              return yield* new A2APeerAskIntentRequiredError({
                messageId: input.messageId,
                reason: "exchange-id",
              });
            }
            if (input.intent === undefined) {
              return yield* new A2APeerAskIntentRequiredError({
                messageId: input.messageId,
                reason: "intent",
              });
            }
            events.push({
              kind: "exchange.opened",
              sender: senderId,
              receiver: receiverId,
              exchangeId,
              correlationId,
              payload: { intent: input.intent, urgency: null },
              createdAt: receivedAt,
            });
          }

          events.push({
            kind: "message.received",
            sender: senderId,
            receiver: receiverId,
            exchangeId,
            correlationId,
            payload: {
              originProjectId,
              originEnvironmentId: input.originEnvironmentId,
              originMessageId: input.messageId,
              originCreatedAt: input.createdAt,
              // A withdrawal closes the debt here as it does at the origin: silently.
              ...(input.terminal?.kind === "sender-cleared" ? { injection: "none" as const } : {}),
              ...(input.senderLabel === undefined ? {} : { senderLabel: input.senderLabel }),
              ...(input.landing === undefined
                ? {}
                : { mode: input.landing.mode, modeLimit: input.landing.limit }),
              message: {
                messageId,
                text: input.text,
                originProjectId,
                receiverProjectId: receiver.projectId,
                exchangeRole: input.exchangeRole,
                envelopeChannel: input.envelopeChannel,
              },
            },
            createdAt: receivedAt,
          });

          /**
           * Only the peer that the ledger records as the Exchange's other party
           * may close or drop it here. A credential proves which server is
           * calling; this proves that server owns the participant it speaks for.
           */
          const exchangeWithPeer = Effect.fn("j5.a2a.peer.inbound.exchangeWithPeer")(function* (
            id: ExchangeId,
          ) {
            const rows = yield* sql<ExchangeRow>`
                SELECT exchange_id, sender_id, receiver_id, status
                FROM j5_a2a_exchange
                WHERE project_id = ${receiver.projectId}
                  AND exchange_id = ${id}
                  AND (sender_id = ${receiverId} OR receiver_id = ${receiverId})
                LIMIT 1
              `;
            const row = rows[0];
            if (row === undefined) return null;
            const otherParty = ParticipantId.make(
              row.sender_id === receiverId ? row.receiver_id : row.sender_id,
            );
            const counterparty = yield* findPeerCounterparty(sql, {
              projectId: receiver.projectId,
              exchangeId: id,
              participantId: otherParty,
            });
            return counterparty?.environmentId === input.originEnvironmentId
              ? { row, otherParty }
              : null;
          });

          if (input.exchangeRole === "reply" && exchangeId !== null) {
            const open = yield* exchangeWithPeer(exchangeId);
            if (
              open !== null &&
              open.row.status === "open" &&
              open.row.sender_id === receiverId &&
              open.otherParty === senderId
            ) {
              events.push({
                kind: "exchange.closed",
                sender: senderId,
                receiver: receiverId,
                exchangeId,
                correlationId,
                payload: { replyMessageId: messageId },
                createdAt: receivedAt,
              });
            }
          }

          if (platform === "silence" && input.regardingExchangeId !== undefined) {
            // The waiter here asked; the answerer on the calling peer went quiet.
            const party = yield* exchangeWithPeer(ExchangeId.make(input.regardingExchangeId));
            if (
              party === null ||
              party.row.status !== "open" ||
              party.row.sender_id !== receiverId
            ) {
              return yield* new A2APeerSenderNotAllowedError({ senderId, reason: "exchange" });
            }
          }

          if (platform === "terminal" && input.terminal !== undefined && exchangeId !== null) {
            // The origin ended the Exchange; this side holds the same Exchange and
            // ends it the same way. Which side retired is this ledger's to say.
            const party = yield* exchangeWithPeer(exchangeId);
            if (party === null) {
              return yield* new A2APeerSenderNotAllowedError({ senderId, reason: "exchange" });
            }
            const { row, otherParty } = party;
            if (
              row.status === "open" &&
              input.terminal.kind === "dropped" &&
              input.terminal.cause.participantId === otherParty
            ) {
              events.push({
                kind: "exchange.dropped",
                sender: ParticipantId.make(row.sender_id),
                receiver: ParticipantId.make(row.receiver_id),
                exchangeId,
                correlationId,
                payload: {
                  disposition: otherParty === row.sender_id ? "sender-retired" : "receiver-retired",
                  cause: {
                    kind: input.terminal.cause.kind,
                    participantId: otherParty,
                    projectId: LedgerProjectId.make(input.terminal.cause.projectId),
                  },
                  facts: {
                    replyRequired: false,
                    retryAllowed: false,
                    replacementRequired: false,
                  },
                  noticeMessageId: messageId,
                },
                createdAt: receivedAt,
              });
            } else if (
              row.status === "open" &&
              input.terminal.kind === "sender-cleared" &&
              row.sender_id === otherParty
            ) {
              // The remote asker withdrew its own ask; the local answerer owes nothing more.
              events.push({
                kind: "exchange.closed",
                sender: otherParty,
                receiver: receiverId,
                exchangeId,
                correlationId,
                payload: { closureKind: "sender-cleared" },
                createdAt: receivedAt,
              });
            }
          }

          // The peer is checked in the same write as the record, so a message that
          // arrives as the peer is being removed is either wiped by the removal or,
          // once the removal committed, refused here.
          const appended = yield* writer.withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                const recorded = yield* sql`
                  SELECT 1 FROM j5_a2a_peer WHERE environment_id = ${input.originEnvironmentId}
                `;
                if (recorded.length === 0) {
                  return yield* new A2APeerNotRecordedError({
                    originEnvironmentId: input.originEnvironmentId,
                  });
                }
                return yield* writer.appendEventsInTransaction({
                  commandId,
                  projectId: receiver.projectId,
                  acceptedAt: receivedAt,
                  events,
                });
              }),
            ),
          );
          if (appended.committed) yield* writer.publishCommitted(appended.events);
          const received = appended.events.find((event) => event.kind === "message.received");
          return {
            receivedSeq: received?.seq ?? appended.receipt.resultSeq,
            replay: !appended.committed,
          } satisfies PeerInboundResult;
        });

      return PeerInboundService.of({ receive });
    }),
  );
