import type {
  CommandId,
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  formatAgentDeliveryEnvelope,
  isDeliveryMessageId,
  ledgerMessageIdOfDelivery,
} from "./DeliveryTransport.ts";
import { A2ALedgerTransactionWriter } from "./LedgerService.ts";
import { outsideAgentNameRows } from "./outsideAgentNames.ts";
import {
  CommCommandId,
  ExchangeId,
  LedgerMessageId,
  LedgerProjectId,
  ParticipantId,
  isHumanParticipantId,
  isOutsideAgentParticipantId,
} from "./contracts.ts";

export interface DeliveryEnvelope {
  readonly prefix: string;
  readonly suffix: string;
}

// The formatters place the body verbatim and never write this character themselves.
const BODY_MARK = "\u0000";

/** What a formatter puts before and after any body. */
export const envelopeAround = (format: (message: string) => string): DeliveryEnvelope => {
  const rendered = format(BODY_MARK);
  const at = rendered.indexOf(BODY_MARK);
  return { prefix: rendered.slice(0, at), suffix: rendered.slice(at + BODY_MARK.length) };
};

/** The body of `text` inside `envelope`; undefined when the text no longer has that envelope. */
export const bodyInEnvelope = (text: string, envelope: DeliveryEnvelope) =>
  text.length >= envelope.prefix.length + envelope.suffix.length &&
  text.startsWith(envelope.prefix) &&
  text.endsWith(envelope.suffix)
    ? text.slice(envelope.prefix.length, text.length - envelope.suffix.length)
    : undefined;

interface DeliveryRow {
  readonly project_id: string;
  readonly origin_project_id: string | null;
  readonly origin_environment_id: string | null;
  readonly receiver_project_id: string;
  readonly message_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: "none" | "ask" | "followup" | "reply" | "terminal_notice";
  readonly envelope_channel: "peer" | "silence_notice" | "lifecycle_notice";
  readonly message_text: string;
  readonly edit_source_sequence: number | null;
}

/**
 * The envelope a delivery was queued in, rendered again from its record as `DeliveryTransport`
 * rendered it. Undefined for a person's reply and for a message from a peer server, whose headers
 * carry names this server held only when it delivered them; their edits are recorded whole. A
 * project renamed since makes the header differ, and the message then reads as rewritten.
 */
const envelopeOf = Effect.fn("j5.a2a.queuedEdits.envelopeOf")(function* (row: DeliveryRow) {
  const senderId = ParticipantId.make(row.sender_id);
  if (row.origin_environment_id !== null || isHumanParticipantId(senderId)) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const originProjectId = LedgerProjectId.make(row.origin_project_id ?? row.project_id);
  const titles = yield* sql<{ readonly title: string }>`
    SELECT title FROM projection_projects WHERE project_id = ${originProjectId}
  `;
  const outsideAgent = isOutsideAgentParticipantId(senderId)
    ? yield* outsideAgentNameRows(sql, [senderId])
    : [];
  return envelopeAround((message) =>
    formatAgentDeliveryEnvelope({
      originProjectId,
      receiverProjectId: LedgerProjectId.make(row.receiver_project_id),
      messageId: LedgerMessageId.make(row.message_id),
      senderId,
      receiverId: ParticipantId.make(row.receiver_id),
      exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
      exchangeRole: row.exchange_role,
      message,
      envelopeChannel: row.envelope_channel,
      originProjectTitle: titles[0]?.title,
      outsideAgentName: outsideAgent[0]?.display_name,
    }),
  );
});

/** A J5 delivery's record and the envelope it was queued in, when the ledger holds it. */
export const readDelivery = Effect.fn("j5.a2a.queuedEdits.readDelivery")(function* (
  messageId: LedgerMessageId,
  receiverThreadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<DeliveryRow>`
    SELECT
      delivery.project_id,
      delivery.origin_project_id,
      delivery.origin_environment_id,
      delivery.receiver_project_id,
      delivery.message_id,
      delivery.sender_id,
      delivery.receiver_id,
      delivery.exchange_id,
      delivery.exchange_role,
      delivery.envelope_channel,
      delivery.message_text,
      delivery.edit_source_sequence
    FROM j5_a2a_delivery AS delivery
    JOIN j5_a2a_membership AS membership ON membership.participant_id = delivery.receiver_id
    WHERE delivery.message_id = ${messageId}
      AND membership.thread_id = ${receiverThreadId}
    LIMIT 2
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return undefined;
  return { row, envelope: yield* envelopeOf(row) };
});

/**
 * Names who issued an edit of a queued J5 delivery, by its orchestration command id, for
 * `recordQueuedEdit` to read once the edit is committed. A retry of the same command keeps the
 * first claim. A claim is removed with the edit it names, or by whoever dispatched the command
 * when upstream refuses it.
 */
export const claimQueuedEdit = Effect.fn("j5.a2a.queuedEdits.claim")(function* (input: {
  readonly commandId: CommandId;
  readonly editorId: ParticipantId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO j5_a2a_queued_edit_claim (command_id, editor_id, created_at)
    VALUES (${input.commandId}, ${input.editorId}, ${createdAt})
    ON CONFLICT (command_id) DO NOTHING
  `;
});

export const releaseQueuedEditClaim = Effect.fn("j5.a2a.queuedEdits.release")(function* (
  commandId: CommandId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM j5_a2a_queued_edit_claim WHERE command_id = ${commandId}`;
});

/**
 * Claims a person's edit of a queued J5 delivery for them, and says whether it did. Any other
 * queued message is not the ledger's, a run that is not queued in the thread is refused by
 * upstream, and a retried command has nothing new to claim.
 */
export const claimPersonQueuedEdit = Effect.fn("j5.a2a.queuedEdits.claimPerson")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
  personId: ParticipantId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly message_id: string | null }>`
    SELECT json_extract(payload_json, '$.userMessageId') AS message_id
    FROM orchestration_v2_projection_runs
    WHERE run_id = ${command.runId} AND thread_id = ${command.threadId}
  `;
  const messageId = rows[0]?.message_id;
  if (messageId == null || !isDeliveryMessageId(messageId)) return false;
  // A retry of a command upstream already took replays its receipt and makes no new edit to claim.
  const taken = yield* sql<{ readonly found: number }>`
    SELECT 1 AS found FROM orchestration_command_receipts WHERE command_id = ${command.commandId}
  `;
  if (taken.length > 0) return false;
  yield* claimQueuedEdit({ commandId: command.commandId, editorId: personId });
  return true;
});

/** Whether upstream took `commandId` as a queued-message edit. */
const isAcceptedEdit = Effect.fn("j5.a2a.queuedEdits.isAcceptedEdit")(function* (
  commandId: CommandId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly found: number }>`
    SELECT 1 AS found FROM orchestration_command_receipts
    WHERE command_id = ${commandId}
      AND command_type = 'queued-run.edit'
      AND status = 'accepted'
  `;
  return rows.length > 0;
});

/**
 * The message's text before `sequence`, from upstream's own event log: a delivery joins the queue
 * as a `message.updated` too, so the latest earlier one holds the text the edit replaced.
 */
const previousText = Effect.fn("j5.a2a.queuedEdits.previousText")(function* (
  threadId: string,
  messageId: string,
  sequence: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly text: string | null }>`
    SELECT json_extract(payload_json, '$.text') AS text
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND stream_id = ${threadId}
      AND sequence < ${sequence}
      AND event_type = 'message.updated'
      AND json_extract(payload_json, '$.id') = ${messageId}
    ORDER BY sequence DESC
    LIMIT 1
  `;
  return rows[0]?.text ?? undefined;
});

/**
 * The ledger follows an edit to a queued J5 delivery, whoever made it: upstream's
 * `message.updated` from an accepted `queued-run.edit` command that changed the delivery's text
 * becomes a `message.edited` event carrying the new body, from the editor its command claimed.
 * Every other update to the message (joining the queue, its run starting, a promotion) records
 * nothing. An event at or before the last edit recorded is never applied again, so replaying the
 * stream after a restart cannot roll the text back. The command's claim is released whatever is
 * recorded.
 */
export const recordQueuedEdit = Effect.fn("j5.a2a.queuedEdits.record")(function* (
  stored: OrchestrationV2StoredEvent,
) {
  const event = stored.event;
  const commandId = stored.commandId;
  if (event.type !== "message.updated" || event.payload.role !== "user" || commandId === null) {
    return [];
  }
  const messageId = ledgerMessageIdOfDelivery(event.payload.id);
  if (messageId === undefined || !(yield* isAcceptedEdit(commandId))) return [];
  const delivery = yield* readDelivery(messageId, event.threadId);
  const skip = releaseQueuedEditClaim(commandId).pipe(Effect.as([]));
  if (delivery === undefined) return yield* skip;
  const { row, envelope } = delivery;
  if (row.edit_source_sequence !== null && stored.sequence <= row.edit_source_sequence) {
    return yield* skip;
  }
  const before = yield* previousText(event.threadId, event.payload.id, stored.sequence);
  if (before === event.payload.text) return yield* skip;
  const body = envelope === undefined ? undefined : bodyInEnvelope(event.payload.text, envelope);
  const text = body === undefined || body.trim().length === 0 ? event.payload.text : body;
  if (text === row.message_text) return yield* skip;
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* sql<{ readonly editor_id: string }>`
    SELECT editor_id FROM j5_a2a_queued_edit_claim WHERE command_id = ${commandId}
  `;
  const editorId = claims[0]?.editor_id;
  const editedAt = DateTime.formatIso(event.occurredAt);
  const writer = yield* A2ALedgerTransactionWriter;
  const result = yield* writer.withPermit(
    sql.withTransaction(
      Effect.gen(function* () {
        const appended = yield* writer.appendEventsInTransaction({
          commandId: CommCommandId.make(
            `command:j5:a2a:edited:${encodeURIComponent(messageId)}:${stored.sequence}`,
          ),
          projectId: LedgerProjectId.make(row.project_id),
          acceptedAt: editedAt,
          events: [
            {
              kind: "message.edited",
              sender: editorId === undefined ? null : ParticipantId.make(editorId),
              receiver: ParticipantId.make(row.receiver_id),
              exchangeId: null,
              correlationId: null,
              payload: { messageId, text, sourceSequence: stored.sequence },
              createdAt: editedAt,
            },
          ],
        });
        yield* releaseQueuedEditClaim(commandId);
        return appended;
      }),
    ),
  );
  if (result.committed) yield* writer.publishCommitted(result.events);
  return result.committed ? result.events : [];
});
