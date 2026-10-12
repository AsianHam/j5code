import {
  type CommEvent,
  CorrelationId,
  type ExchangeDropDisposition,
  type ExchangeDroppedPayload,
  ExchangeId,
  LIFECYCLE_PARTICIPANT_ID,
  LedgerMessageId,
  ParticipantId,
  LedgerProjectId,
} from "./contracts.ts";

/**
 * The notices a sender gets when a message to a peer server will not arrive:
 * the server refused it, or the peer was removed while it waited. Each message
 * gets one notice. A refused ask's notice also says its Exchange has ended,
 * and the Exchange is dropped as refused; an open Exchange with a removed peer
 * is dropped with a drop notice. Either way the party here owes nothing.
 *
 * A notice is platform-authored, so nothing a peer server wrote goes into one
 * raw: a refusal code it is known to send is told in this server's own words,
 * and any other reason is quoted on one line, bounded, as the peer's.
 */

const stablePart = (value: string) => encodeURIComponent(value);

/**
 * Only an agent on this server can be told: people are never addressed across
 * servers, and platform and machine senders cannot be told.
 */
export const canBeNotified = (participantId: string) => participantId.startsWith("agent:");

/** The most of a peer's own reason a notice quotes. */
const PEER_REASON_MAX_CHARS = 300;

/** Why a peer server refused a message, completing "… was not delivered: …". */
export const peerRefusalReason = (input: {
  /** The peer's name, as this server records it. */
  readonly serverName: string;
  readonly code: string;
  readonly message: string;
}) => {
  switch (input.code) {
    case "recipient_not_found":
      return `${input.serverName} has no active participant with that id.`;
    case "policy_refused":
      return `${input.serverName} refused it; the recipient is archived or does not accept messages from this sender.`;
    case "invalid_request":
      return `${input.serverName} could not accept the message as it was sent.`;
    case "message_id_conflict":
      return `${input.serverName} already holds a different message with the same id.`;
    case "landing_refused":
      return `${input.serverName} refused the steer or restart: the recipient runs with broader permissions than you do. Send it again without mode, as an ordinary message.`;
  }
  const flat = input.message
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
    .replaceAll('"', "'")
    .trim();
  const quoted =
    flat.length > PEER_REASON_MAX_CHARS ? `${flat.slice(0, PEER_REASON_MAX_CHARS - 1)}…` : flat;
  return `${input.serverName} said: "${quoted}"`;
};

export const formatNotDeliveredNotice = (input: {
  readonly receiverId: string;
  readonly serverName: string;
  readonly reason: string;
  /** Set for an ask: the Exchange it opened has ended. */
  readonly exchangeId?: string;
  /** The peer may already hold it: handed to a poller, or attempted directly. */
  readonly mayHaveArrived?: boolean;
}) =>
  [
    input.mayHaveArrived === true
      ? "[Cross-agent messaging system notice: message may not have been delivered]"
      : "[Cross-agent messaging system notice: message not delivered]",
    `Your message to ${input.receiverId} on ${input.serverName} ${input.mayHaveArrived === true ? "may not have been delivered" : "was not delivered"}: ${input.reason}`,
    ...(input.exchangeId === undefined
      ? []
      : [
          "The exchange is closed; nothing is owed and nothing will answer it.",
          `Facts: exchangeId=${input.exchangeId}; replyRequired=false; retryAllowed=false; replacementRequired=false.`,
        ]),
    "This is a platform-authored notice, not a peer reply.",
  ].join("\n\n");

export const formatPeerDropNotice = (input: {
  readonly exchangeId: string;
  readonly disposition: ExchangeDropDisposition;
  /** Why it ended, completing "Exchange X ended because …". */
  readonly because: string;
}) =>
  [
    "[Cross-agent messaging system notice: exchange dropped]",
    `Exchange ${input.exchangeId} ended because ${input.because} (${input.disposition}).`,
    input.disposition === "receiver-retired"
      ? "The receiver will not answer this Exchange. Do not retry it."
      : "The asker is gone. Your reply obligation has ended; do not send a replacement reply.",
    "Facts: replyRequired=false; retryAllowed=false; replacementRequired=false.",
    "This is a platform-authored terminal notice, not a peer reply.",
  ].join("\n\n");

/** The message a notice is about, as its delivery row records it. */
export interface UndeliveredMessage {
  readonly project_id: string;
  readonly message_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

const notDeliveredKey = (message: UndeliveredMessage) =>
  `${stablePart(message.project_id)}:${stablePart(message.message_id)}`;

/** The one notice a message can get, so a later step can see it was already told. */
export const notDeliveredNoticeMessageId = (message: UndeliveredMessage) =>
  LedgerMessageId.make(`message:j5:a2a:not-delivered:${notDeliveredKey(message)}`);

/** A not-delivered notice to the message's sender, in the sender's project. */
export const notDeliveredNoticeEvent = (input: {
  readonly message: UndeliveredMessage;
  readonly serverName: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly mayHaveArrived?: boolean;
}): CommEvent => {
  const key = notDeliveredKey(input.message);
  return {
    kind: "message.sent",
    sender: LIFECYCLE_PARTICIPANT_ID,
    receiver: ParticipantId.make(input.message.sender_id),
    exchangeId: null,
    correlationId: CorrelationId.make(`correlation:j5:a2a:not-delivered:${key}`),
    payload: {
      messageId: notDeliveredNoticeMessageId(input.message),
      text: formatNotDeliveredNotice({
        receiverId: input.message.receiver_id,
        serverName: input.serverName,
        reason: input.reason,
        ...(input.mayHaveArrived === true ? { mayHaveArrived: true } : {}),
      }),
      originProjectId: LedgerProjectId.make(input.message.project_id),
      receiverProjectId: LedgerProjectId.make(input.message.project_id),
      exchangeRole: "none",
      envelopeChannel: "lifecycle_notice",
    },
    createdAt: input.createdAt,
  };
};

/** The open Exchange a drop ends, and the party on this server who is told. */
export interface DroppedExchange {
  readonly project_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

/**
 * The drop of an open Exchange whose other party is on a peer server, and its
 * one notice to the party here, which closes the Exchange for it.
 */
export const peerDropEvents = (input: {
  readonly exchange: DroppedExchange;
  readonly disposition: ExchangeDropDisposition;
  /** What ended it, naming the party on the peer server. */
  readonly cause: ExchangeDroppedPayload["cause"];
  /** The local party's project, where the notice is delivered. */
  readonly localProjectId: string;
  readonly noticeText: string;
  readonly createdAt: string;
}): ReadonlyArray<CommEvent> => {
  const exchangeId = ExchangeId.make(input.exchange.exchange_id);
  const key = `${stablePart(input.exchange.project_id)}:${stablePart(input.exchange.exchange_id)}:${input.cause.kind}`;
  const messageId = LedgerMessageId.make(`message:j5:a2a:peer-drop:${key}`);
  const correlationId = CorrelationId.make(`correlation:j5:a2a:peer-drop:${key}`);
  const localParty =
    input.disposition === "receiver-retired"
      ? input.exchange.sender_id
      : input.exchange.receiver_id;
  return [
    {
      kind: "exchange.dropped",
      sender: ParticipantId.make(input.exchange.sender_id),
      receiver: ParticipantId.make(input.exchange.receiver_id),
      exchangeId,
      correlationId,
      payload: {
        disposition: input.disposition,
        cause: input.cause,
        facts: { replyRequired: false, retryAllowed: false, replacementRequired: false },
        noticeMessageId: messageId,
      } satisfies ExchangeDroppedPayload,
      createdAt: input.createdAt,
    },
    ...(canBeNotified(localParty)
      ? [
          {
            kind: "message.sent",
            sender: LIFECYCLE_PARTICIPANT_ID,
            receiver: ParticipantId.make(localParty),
            exchangeId,
            correlationId,
            payload: {
              messageId,
              text: input.noticeText,
              originProjectId: LedgerProjectId.make(input.exchange.project_id),
              receiverProjectId: LedgerProjectId.make(input.localProjectId),
              exchangeRole: "terminal_notice",
              envelopeChannel: "lifecycle_notice",
            },
            createdAt: input.createdAt,
          } satisfies CommEvent,
        ]
      : []),
  ];
};
