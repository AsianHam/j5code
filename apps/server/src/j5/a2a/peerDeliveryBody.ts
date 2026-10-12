import { PEER_SENDER_LABEL_MAX_CHARS, type PeerDeliveryRequest } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { participantIdentityRows } from "./ClientReadsService.ts";
import { MessageSentPayload, ParticipantId } from "./contracts.ts";

const decodeSentPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(MessageSentPayload));

/** The delivery row columns a peer delivery is built from. */
export interface PeerBodyRow {
  readonly project_id: string;
  readonly message_id: string;
  readonly sent_seq: number;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: PeerDeliveryRequest["exchangeRole"];
  readonly envelope_channel: PeerDeliveryRequest["envelopeChannel"];
  readonly correlation_id: string;
  readonly message_text: string;
  readonly created_at: string;
  readonly origin_project_id: string | null;
}

/**
 * The one body a message crosses to a peer server in, whether this server
 * sends it directly or a polling peer is handed it. Beyond the row: an ask
 * carries its intent so the peer opens the Exchange; a terminal notice carries
 * the fact it was written with, read back from the sent row, never from
 * whatever the Exchange says by the time the row is delivered; a silence notice
 * is not part of its Exchange, so it names the Exchange it concerns from the
 * silence.notice event its own command recorded; and the sender's display name
 * travels for the peer's people, read by the statement the client identity
 * read uses so both servers agree on it. A name this server cannot read never
 * holds a delivery.
 */
export const buildPeerDeliveryBody = Effect.fn("j5.a2a.peer.deliveryBody")(function* (
  sql: SqlClient.SqlClient,
  row: PeerBodyRow,
) {
  const labelRows = yield* Effect.orElseSucceed(
    participantIdentityRows(sql, [ParticipantId.make(row.sender_id)]),
    () => [],
  );
  const senderLabel =
    labelRows[0]?.display_name?.trim().slice(0, PEER_SENDER_LABEL_MAX_CHARS) ?? "";
  return {
    messageId: row.message_id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    exchangeId: row.exchange_id,
    correlationId: row.correlation_id,
    exchangeRole: row.exchange_role,
    envelopeChannel: row.envelope_channel,
    text: row.message_text,
    originProjectId: row.origin_project_id ?? row.project_id,
    ...(yield* landing(sql, row)),
    ...(yield* exchangeFacts(sql, row)),
    ...(senderLabel.length === 0 ? {} : { senderLabel }),
    createdAt: row.created_at,
  } satisfies PeerDeliveryRequest;
});

/** The steer or restart its sender asked for, with the sender's limit, read back from the sent row. */
const landing = Effect.fn("j5.a2a.peer.deliveryBody.landing")(function* (
  sql: SqlClient.SqlClient,
  row: PeerBodyRow,
) {
  if (row.envelope_channel !== "peer") return {};
  const sent = yield* sql<{ readonly kind: string; readonly payload: string }>`
    SELECT kind, payload FROM j5_a2a_comm_event
    WHERE project_id = ${row.project_id} AND seq = ${row.sent_seq}
    LIMIT 1
  `;
  if (sent[0]?.kind !== "message.sent") return {};
  const payload = yield* decodeSentPayload(sent[0].payload);
  return payload.mode === undefined || payload.mode === "queue" || payload.modeLimit === undefined
    ? {}
    : { landing: { mode: payload.mode, limit: payload.modeLimit } };
});

const exchangeFacts = Effect.fn("j5.a2a.peer.deliveryBody.exchangeFacts")(function* (
  sql: SqlClient.SqlClient,
  row: PeerBodyRow,
) {
  if (row.envelope_channel === "silence_notice") {
    const regarding = yield* sql<{ readonly exchange_id: string | null }>`
      SELECT notice.exchange_id
      FROM j5_a2a_comm_event AS sent
      JOIN j5_a2a_comm_event AS notice
        ON notice.project_id = sent.project_id
       AND notice.command_id = sent.command_id
       AND notice.kind = 'silence.notice'
      WHERE sent.project_id = ${row.project_id} AND sent.seq = ${row.sent_seq}
      LIMIT 1
    `;
    const exchangeId = regarding[0]?.exchange_id;
    return exchangeId == null ? {} : { regardingExchangeId: exchangeId };
  }
  if (row.exchange_id === null) return {};
  if (row.exchange_role === "ask") {
    const intent = yield* sql<{ readonly intent: string }>`
      SELECT intent FROM j5_a2a_exchange
      WHERE project_id = ${row.project_id} AND exchange_id = ${row.exchange_id}
      LIMIT 1
    `;
    return intent[0] === undefined ? {} : { intent: intent[0].intent };
  }
  if (row.exchange_role === "terminal_notice") {
    const sent = yield* sql<{ readonly payload: string }>`
      SELECT payload FROM j5_a2a_comm_event
      WHERE project_id = ${row.project_id} AND seq = ${row.sent_seq}
      LIMIT 1
    `;
    if (sent[0] === undefined) return {};
    const payload = yield* decodeSentPayload(sent[0].payload);
    return payload.terminal === undefined ? {} : { terminal: payload.terminal };
  }
  return {};
});
