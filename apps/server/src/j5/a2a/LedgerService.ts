import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { ThreadId } from "@t3tools/contracts";

import {
  type AppendCommEventsCommand,
  CommCommandReceipt,
  type AppendCommEventCommand,
  type CommEventPage,
  type EnsureProjectCommand,
  ProjectLedger,
  ExchangeClosedPayload,
  ExchangeDroppedPayload,
  ExchangeOpenedPayload,
  type ExchangeId,
  MessageDeliveredPayload,
  MessageDeliveryFailedPayload,
  MessageEditedPayload,
  type CommEvent,
  MessageReceivedPayload,
  MessageSentPayload,
  type LedgerProjectId,
  type LedgerCursor,
  Membership,
  ParticipantId,
  StoredCommEvent,
  participantId,
} from "./contracts.ts";
import { decideAppendCommEvent } from "./decider.ts";

export class A2AStorageError extends Schema.TaggedError<A2AStorageError>()("A2AStorageError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class ProjectLedgerNotFoundError extends Schema.TaggedError<ProjectLedgerNotFoundError>()(
  "ProjectLedgerNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} has no agent-to-agent ledger yet.`;
  }
}

export class CommCommandConflictError extends Schema.TaggedError<CommCommandConflictError>()(
  "CommCommandConflictError",
  {
    commandId: Schema.String,
    requestedProjectId: Schema.String,
    existingProjectId: Schema.String,
  },
) {}

export class LedgerCursorError extends Schema.TaggedError<LedgerCursorError>()(
  "LedgerCursorError",
  {
    projectId: Schema.String,
    afterSeq: Schema.Number,
    snapshotEnd: Schema.Number,
  },
) {}

export class LedgerGapError extends Schema.TaggedError<LedgerGapError>()("LedgerGapError", {
  projectId: Schema.String,
  expectedSeq: Schema.Number,
  actualSeq: Schema.NullOr(Schema.Number),
}) {}

export type A2ALedgerError =
  | A2AStorageError
  | ProjectLedgerNotFoundError
  | CommCommandConflictError
  | LedgerCursorError
  | LedgerGapError;

const isA2ALedgerError = Schema.is(
  Schema.Union([
    A2AStorageError,
    ProjectLedgerNotFoundError,
    CommCommandConflictError,
    LedgerCursorError,
    LedgerGapError,
  ]),
);

export interface AppendResult {
  readonly receipt: CommCommandReceipt;
  readonly event: StoredCommEvent;
  readonly committed: boolean;
}

export interface AppendEventsResult {
  readonly receipt: CommCommandReceipt;
  readonly events: ReadonlyArray<StoredCommEvent>;
  readonly committed: boolean;
}

export interface A2ALedgerShape {
  /** Makes the project a ledger if it is not one yet. Every append needs its ledger to exist. */
  readonly ensureProject: (command: EnsureProjectCommand) => Effect.Effect<void, A2ALedgerError>;
  readonly listProjectLedgers: () => Effect.Effect<ReadonlyArray<ProjectLedger>, A2ALedgerError>;
  readonly readProjectLedger: (
    ledgerProjectId: LedgerProjectId,
  ) => Effect.Effect<ProjectLedger, A2ALedgerError>;
  readonly append: (command: AppendCommEventCommand) => Effect.Effect<AppendResult, A2ALedgerError>;
  readonly appendEvents: (
    command: AppendCommEventsCommand,
  ) => Effect.Effect<AppendEventsResult, A2ALedgerError>;
  readonly appendEventsIfExchangeOpen: (
    command: AppendCommEventsCommand,
    exchangeId: ExchangeId,
  ) => Effect.Effect<AppendEventsResult | null, A2ALedgerError>;
  readonly readEvents: (input: {
    readonly projectId: LedgerProjectId;
    readonly cursor: LedgerCursor;
    readonly limit: number;
  }) => Effect.Effect<CommEventPage, A2ALedgerError>;
  readonly listMembership: (
    ledgerProjectId: LedgerProjectId,
  ) => Effect.Effect<ReadonlyArray<Membership>, A2ALedgerError>;
  readonly findHistoricalAgentParticipantId: (input: {
    readonly projectId: LedgerProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<ParticipantId | null, A2ALedgerError>;
  readonly rebuildMembership: (
    ledgerProjectId: LedgerProjectId,
  ) => Effect.Effect<ReadonlyArray<Membership>, A2ALedgerError>;
  readonly subscribeCommitted: Effect.Effect<Stream.Stream<StoredCommEvent>, never, Scope.Scope>;
}

export class A2ALedger extends Context.Service<A2ALedger, A2ALedgerShape>()(
  "t3/j5/a2a/LedgerService/A2ALedger",
) {}

/**
 * Internal write seam for multi-service transactions. drainPermit and
 * lifecyclePermit are independent peers that both precede appendPermit; the
 * remaining order is appendPermit ≺ mutationPermit ≺ DB. This Semaphore(1)
 * permit is non-reentrant: callers of this seam must acquire it before BEGIN
 * and use the provided raw in-transaction APIs instead of re-acquiring it
 * through the public append methods.
 */
export interface A2ALedgerTransactionWriterShape {
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly appendInTransaction: (
    command: AppendCommEventCommand,
  ) => Effect.Effect<AppendResult, A2ALedgerError>;
  readonly appendEventsInTransaction: (
    command: AppendCommEventsCommand,
  ) => Effect.Effect<AppendEventsResult, A2ALedgerError>;
  readonly publishCommitted: (events: ReadonlyArray<StoredCommEvent>) => Effect.Effect<void>;
}

export class A2ALedgerTransactionWriter extends Context.Service<
  A2ALedgerTransactionWriter,
  A2ALedgerTransactionWriterShape
>()("t3/j5/a2a/LedgerService/A2ALedgerTransactionWriter") {}

interface ProjectLedgerRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

interface EventRow {
  readonly seq: number;
  readonly project_id: string;
  readonly kind: string;
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly exchange_id: string | null;
  readonly correlation_id: string | null;
  readonly payload: string;
  readonly created_at: string;
}

interface ReceiptRow {
  readonly command_id: string;
  readonly project_id: string;
  readonly command_type: string;
  readonly accepted_at: string;
  readonly result_seq: number;
}

interface MembershipRow {
  readonly project_id: string;
  readonly joined_seq: number;
  readonly updated_seq: number;
  readonly payload: string;
}

const decodeProjectLedger = Schema.decodeUnknownEffect(ProjectLedger);
const decodeParticipantId = Schema.decodeUnknownEffect(ParticipantId);
const decodeStoredEvent = Schema.decodeUnknownEffect(StoredCommEvent);
const decodeReceipt = Schema.decodeUnknownEffect(CommCommandReceipt);
const decodeMembership = Schema.decodeUnknownEffect(Membership);
const decodeExchangeOpened = Schema.decodeUnknownEffect(ExchangeOpenedPayload);
const decodeExchangeClosed = Schema.decodeUnknownEffect(ExchangeClosedPayload);
const decodeExchangeDropped = Schema.decodeUnknownEffect(ExchangeDroppedPayload);
const decodeMessageCancelled = Schema.decodeUnknownEffect(
  Schema.Struct({ messageId: Schema.String, reason: Schema.String }),
);
const decodeMessageSent = Schema.decodeUnknownEffect(MessageSentPayload);
const decodeMessageReceived = Schema.decodeUnknownEffect(MessageReceivedPayload);
const decodeMessageDelivered = Schema.decodeUnknownEffect(MessageDeliveredPayload);
const decodeMessageDeliveryFailed = Schema.decodeUnknownEffect(MessageDeliveryFailedPayload);
const decodeMessageEdited = Schema.decodeUnknownEffect(MessageEditedPayload);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
// The one payload with optional keys has its own encoder, so every other caller keeps the Json check.
const encodeReceivedPayload = Schema.encodeEffect(Schema.fromJsonString(MessageReceivedPayload));
// Narrowing needs the discriminated union the caller submitted; the decided copy shares its payload.
const encodeEventPayload = (event: CommEvent) =>
  event.kind === "message.received"
    ? encodeReceivedPayload(event.payload)
    : encodeJson(event.payload);

/** The pending delivery both a local send and a peer-received row project; origin columns are NULL for local sends. */
/**
 * `accept_order` is the order the row was accepted on this server, across every project's ledger,
 * which the delivery worker keeps per receiver. The insert takes the next value in one statement,
 * and a unique index holds it to one row.
 */
const insertPendingDelivery = (
  sql: SqlClient.SqlClient,
  row: {
    readonly projectId: string;
    readonly messageId: string;
    readonly commandId: string;
    readonly sentSeq: number;
    readonly senderId: string;
    readonly receiverId: string;
    readonly receiverProjectId: string;
    readonly exchangeId: string | null;
    readonly exchangeRole: string;
    readonly envelopeChannel: string;
    readonly correlationId: string | null;
    readonly messageText: string;
    readonly createdAt: string;
    readonly originProjectId: string | null;
    readonly originEnvironmentId: string | null;
    /** Set when the receiver is homed on a peer server; the worker hands such a row to the peer transport. */
    readonly receiverEnvironmentId: string | null;
  },
) => sql`
  INSERT INTO j5_a2a_delivery (
    project_id, message_id, command_id, sent_seq, sender_id, receiver_id, receiver_project_id,
    exchange_id, exchange_role, envelope_channel, correlation_id, message_text,
    status, attempts, last_error, next_attempt_at, delivered_seq, created_at, updated_at,
    origin_project_id, origin_environment_id, receiver_environment_id, accept_order
  ) VALUES (
    ${row.projectId}, ${row.messageId}, ${row.commandId}, ${row.sentSeq}, ${row.senderId}, ${row.receiverId}, ${row.receiverProjectId},
    ${row.exchangeId}, ${row.exchangeRole}, ${row.envelopeChannel}, ${row.correlationId}, ${row.messageText},
    'pending', 0, NULL, NULL, NULL, ${row.createdAt}, ${row.createdAt},
    ${row.originProjectId}, ${row.originEnvironmentId}, ${row.receiverEnvironmentId},
    (SELECT COALESCE(MAX(accept_order), 0) + 1 FROM j5_a2a_delivery)
  )
`;

const preserveDomainError =
  (operation: string) =>
  (cause: unknown): A2ALedgerError =>
    isA2ALedgerError(cause) ? cause : new A2AStorageError({ operation, cause });

const projectLedgerFromRow = (row: ProjectLedgerRow) =>
  decodeProjectLedger({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  });

const eventFromRow = Effect.fn("j5.a2a.eventFromRow")(function* (row: EventRow) {
  return yield* decodeStoredEvent({
    seq: row.seq,
    projectId: row.project_id,
    kind: row.kind,
    sender: row.sender,
    receiver: row.receiver,
    exchangeId: row.exchange_id,
    correlationId: row.correlation_id,
    payload: yield* decodeJson(row.payload),
    createdAt: row.created_at,
  });
});

const receiptFromRow = (row: ReceiptRow) =>
  decodeReceipt({
    commandId: row.command_id,
    projectId: row.project_id,
    commandType: row.command_type,
    acceptedAt: row.accepted_at,
    resultSeq: row.result_seq,
  });

const membershipFromRow = Effect.fn("j5.a2a.membershipFromRow")(function* (row: MembershipRow) {
  return yield* decodeMembership({
    projectId: row.project_id,
    participant: yield* decodeJson(row.payload),
    joinedSeq: row.joined_seq,
    updatedSeq: row.updated_seq,
  });
});

export const layer: Layer.Layer<
  A2ALedger | A2ALedgerTransactionWriter,
  never,
  SqlClient.SqlClient
> = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const appendPermit = yield* Semaphore.make(1);
    const committed = yield* PubSub.unbounded<StoredCommEvent>();

    // A ledger's name is its project's title. Upstream keeps a soft-deleted project's row, so the
    // title outlives the delete; a ledger whose project row is gone is named by its id.
    const selectProjectLedgers = (projectId: string | null) => sql<ProjectLedgerRow>`
      SELECT
        ledger.project_id AS id,
        COALESCE(project.title, ledger.project_id) AS name,
        ledger.created_at
      FROM j5_a2a_project_ledger AS ledger
      LEFT JOIN projection_projects AS project ON project.project_id = ledger.project_id
      WHERE ${projectId === null ? sql`1 = 1` : sql`ledger.project_id = ${projectId}`}
      ORDER BY ledger.created_at, ledger.project_id
    `;

    const ensureProjectLedger = Effect.fn("j5.a2a.ensureProjectLedger")(function* (
      ledgerProjectId: LedgerProjectId,
    ) {
      const rows = yield* sql<{ readonly id: string }>`
        SELECT project_id AS id FROM j5_a2a_project_ledger WHERE project_id = ${ledgerProjectId} LIMIT 1
      `;
      if (rows[0] === undefined) {
        return yield* new ProjectLedgerNotFoundError({ projectId: ledgerProjectId });
      }
    });

    const applyMembership = Effect.fn("j5.a2a.applyMembership")(function* (event: StoredCommEvent) {
      if (
        event.kind !== "participant.joined" &&
        event.kind !== "participant.left" &&
        event.kind !== "participant.archived" &&
        event.kind !== "participant.unarchived" &&
        event.kind !== "participant.deleted"
      )
        return;
      const participant = event.payload.participant;
      // Historical human membership events remain readable ledger facts. New
      // person addressability is host registry state, never project membership.
      if (participant.kind === "human") return;
      const id = participantId(participant);
      // A machine participant has no thread and never enters the agent-only
      // membership projection; its join projects into its own table. It has no
      // lifecycle events yet, so nothing else about it is projected here.
      if (participant.kind === "machine") {
        if (event.kind !== "participant.joined") return;
        yield* sql`
          INSERT INTO j5_a2a_machine_participant (
            participant_id, project_id, name, joined_seq, created_at
          ) VALUES (${id}, ${event.projectId}, ${participant.name}, ${event.seq}, ${event.createdAt})
          ON CONFLICT(participant_id) DO NOTHING
        `;
        return;
      }
      if (event.kind === "participant.archived" || event.kind === "participant.unarchived") {
        yield* sql`UPDATE j5_a2a_membership
          SET archived_at = ${event.kind === "participant.archived" ? event.createdAt : null}, updated_seq = ${event.seq}
          WHERE project_id = ${event.projectId} AND participant_id = ${id}`;
        return;
      }
      if (event.kind === "participant.left" || event.kind === "participant.deleted") {
        if (event.kind === "participant.deleted") {
          yield* sql`DELETE FROM j5_a2a_participant_placement WHERE project_id = ${event.projectId} AND participant_id = ${id}`;
        }
        yield* sql`
          DELETE FROM j5_a2a_membership
          WHERE project_id = ${event.projectId} AND participant_id = ${id}
        `;
        return;
      }
      const payload = yield* encodeJson(participant);
      const threadId = participant.kind === "agent" ? participant.threadId : null;
      yield* sql`
        INSERT INTO j5_a2a_membership (
          project_id,
          participant_id,
          participant_kind,
          thread_id,
          joined_seq,
          updated_seq,
          payload
        ) VALUES (
          ${event.projectId},
          ${id},
          ${participant.kind},
          ${threadId},
          ${event.seq},
          ${event.seq},
          ${payload}
        )
        ON CONFLICT(project_id, participant_id)
        DO UPDATE SET
          participant_kind = excluded.participant_kind,
          thread_id = excluded.thread_id,
          joined_seq = j5_a2a_membership.joined_seq,
          updated_seq = excluded.updated_seq,
          payload = excluded.payload
      `;
    });

    const applyA2Projection = Effect.fn("j5.a2a.applyA2Projection")(function* (
      event: StoredCommEvent,
      commandId: string,
    ) {
      switch (event.kind) {
        case "exchange.opened": {
          const payload = yield* decodeExchangeOpened(event.payload);
          if (event.sender === null || event.receiver === null || event.exchangeId === null) {
            return yield* new A2AStorageError({ operation: "project opened exchange" });
          }
          yield* sql`
            INSERT INTO j5_a2a_exchange (
              project_id,
              exchange_id,
              sender_id,
              receiver_id,
              status,
              intent,
              urgency,
              opened_seq,
              closed_seq,
              created_at,
              updated_at
            ) VALUES (
              ${event.projectId},
              ${event.exchangeId},
              ${event.sender},
              ${event.receiver},
              'open',
              ${payload.intent},
              ${payload.urgency},
              ${event.seq},
              NULL,
              ${event.createdAt},
              ${event.createdAt}
            )
          `;
          return;
        }
        case "exchange.closed": {
          const closure = yield* decodeExchangeClosed(event.payload);
          if (event.exchangeId === null) {
            return yield* new A2AStorageError({ operation: "project closed exchange" });
          }
          const senderCleared =
            "closureKind" in closure && closure.closureKind === "sender-cleared";
          yield* sql`
            UPDATE j5_a2a_exchange
            SET
              status = 'closed',
              closed_seq = ${event.seq},
              updated_at = ${event.createdAt}
            WHERE project_id = ${event.projectId}
              AND exchange_id = ${event.exchangeId}
              AND status = 'open'
          `;
          // Human inbox history is an A4-owned ledger projection. Lifecycle
          // producers append terminal facts and never mutate this table.
          yield* sql`
            UPDATE j5_a2a_human_inbox
            SET
              status = ${senderCleared ? "dropped" : "answered"},
              terminal_seq = ${event.seq},
              terminal_at = ${event.createdAt},
              terminal_disposition = ${senderCleared ? "sender-cleared" : "answered"},
              terminal_cause = NULL,
              terminal_facts = NULL,
              terminal_notice_message_id = NULL
            WHERE project_id = ${event.projectId}
              AND exchange_id = ${event.exchangeId}
              AND status = 'open'
          `;
          return;
        }
        case "exchange.dropped": {
          const dropped = yield* decodeExchangeDropped(event.payload);
          if (event.exchangeId === null) {
            return yield* new A2AStorageError({ operation: "project dropped exchange" });
          }
          const rows = yield* sql<{ readonly exchange_id: string }>`
            UPDATE j5_a2a_exchange
            SET
              status = 'dropped',
              closed_seq = ${event.seq},
              updated_at = ${event.createdAt}
            WHERE project_id = ${event.projectId}
              AND exchange_id = ${event.exchangeId}
              AND status = 'open'
            RETURNING exchange_id
          `;
          if (rows[0] === undefined) {
            return yield* new A2AStorageError({ operation: "project dropped exchange" });
          }
          const terminalCause = yield* encodeJson(dropped.cause);
          const terminalFacts = yield* encodeJson(dropped.facts);
          // An undelivered human ask still needs a visible terminal history row.
          // Preserve the original ask rather than treating a no-op transport as notice delivery.
          yield* sql`INSERT INTO j5_a2a_human_inbox (
            person_id, project_id, exchange_id, sender_id, intent, urgency,
            latest_message_id, latest_message, opened_seq, opened_at, status)
            SELECT e.receiver_id, e.project_id, e.exchange_id, e.sender_id, e.intent, e.urgency,
              d.message_id, d.message_text, e.opened_seq, e.created_at, 'open'
            FROM j5_a2a_exchange e JOIN j5_a2a_delivery d
              ON d.project_id = e.project_id AND d.exchange_id = e.exchange_id AND d.exchange_role = 'ask'
            WHERE e.project_id = ${event.projectId} AND e.exchange_id = ${event.exchangeId}
              AND e.receiver_id LIKE 'human:%'
            ON CONFLICT(person_id, project_id, exchange_id) DO NOTHING`;
          // A4 owns this retained projection; the ledger applies its terminal
          // state from the ordinary exchange.dropped fact in the same commit.
          yield* sql`
            UPDATE j5_a2a_human_inbox
            SET
              status = 'dropped',
              terminal_seq = ${event.seq},
              terminal_at = ${event.createdAt},
              terminal_disposition = ${dropped.disposition},
              terminal_cause = ${terminalCause},
              terminal_facts = ${terminalFacts},
              terminal_notice_message_id = ${dropped.noticeMessageId}
            WHERE project_id = ${event.projectId}
              AND exchange_id = ${event.exchangeId}
              AND status = 'open'
          `;
          return;
        }
        case "message.sent": {
          const payload = yield* decodeMessageSent(event.payload);
          if (event.sender === null || event.receiver === null || event.correlationId === null) {
            return yield* new A2AStorageError({ operation: "project sent message" });
          }
          yield* insertPendingDelivery(sql, {
            projectId: event.projectId,
            messageId: payload.messageId,
            commandId,
            sentSeq: event.seq,
            senderId: event.sender,
            receiverId: event.receiver,
            receiverProjectId: payload.receiverProjectId,
            exchangeId: event.exchangeId,
            exchangeRole: payload.exchangeRole,
            envelopeChannel: payload.envelopeChannel,
            correlationId: event.correlationId,
            messageText: payload.text,
            createdAt: event.createdAt,
            originProjectId: null,
            originEnvironmentId: null,
            receiverEnvironmentId: payload.receiverEnvironmentId ?? null,
          });
          return;
        }
        case "message.delivered": {
          const payload = yield* decodeMessageDelivered(event.payload);
          const rows = yield* sql<{ readonly message_id: string }>`
            UPDATE j5_a2a_delivery
            SET
              status = 'delivered',
              attempts = ${payload.attempt},
              last_error = NULL,
              next_attempt_at = NULL,
              delivered_seq = ${event.seq},
              updated_at = ${event.createdAt}
            WHERE project_id = ${event.projectId} AND message_id = ${payload.messageId} AND status <> 'cancelled'
            RETURNING message_id
          `;
          if (rows[0] === undefined) {
            const cancelled =
              yield* sql`SELECT 1 FROM j5_a2a_delivery WHERE project_id = ${event.projectId} AND message_id = ${payload.messageId} AND status = 'cancelled'`;
            if (cancelled.length === 0)
              return yield* new A2AStorageError({ operation: "project message delivery outcome" });
          }
          return;
        }
        case "message.delivery_failed": {
          const payload = yield* decodeMessageDeliveryFailed(event.payload);
          const rows = yield* sql<{ readonly message_id: string }>`
            UPDATE j5_a2a_delivery
            SET
              status = ${payload.alarmed ? "alarmed" : "retry_scheduled"},
              attempts = ${payload.attempt},
              held_attempts = held_attempts + ${payload.held === true ? 1 : 0},
              last_held = ${payload.held === true ? 1 : 0},
              last_error = ${payload.error},
              next_attempt_at = ${payload.nextAttemptAt},
              updated_at = ${event.createdAt}
            WHERE project_id = ${event.projectId} AND message_id = ${payload.messageId} AND status <> 'cancelled'
            RETURNING message_id
          `;
          if (rows[0] === undefined) {
            const cancelled =
              yield* sql`SELECT 1 FROM j5_a2a_delivery WHERE project_id = ${event.projectId} AND message_id = ${payload.messageId} AND status = 'cancelled'`;
            if (cancelled.length === 0)
              return yield* new A2AStorageError({ operation: "project message delivery outcome" });
          }
          return;
        }
        case "message.cancelled": {
          const payload = yield* decodeMessageCancelled(event.payload);
          yield* sql`UPDATE j5_a2a_delivery SET status = 'cancelled', next_attempt_at = NULL, last_error = ${payload.reason}, updated_at = ${event.createdAt}
            WHERE project_id = ${event.projectId} AND message_id = ${payload.messageId} AND status <> 'delivered'`;
          return;
        }
        case "message.edited": {
          const payload = yield* decodeMessageEdited(event.payload);
          const rows = yield* sql<{ readonly message_id: string }>`
            UPDATE j5_a2a_delivery
            SET
              message_text = ${payload.text},
              edited_by = ${event.sender},
              edited_at = ${event.createdAt},
              edit_source_sequence = ${payload.sourceSequence},
              updated_at = ${event.createdAt}
            WHERE project_id = ${event.projectId} AND message_id = ${payload.messageId}
            RETURNING message_id
          `;
          if (rows[0] === undefined) {
            return yield* new A2AStorageError({ operation: "project edited message" });
          }
          return;
        }
        case "message.received": {
          // A row received from a peer server is the only sent-side fact this
          // server has, so it projects the pending delivery a local send would.
          const received = yield* decodeMessageReceived(event.payload);
          if (received.originEnvironmentId === undefined) return;
          // A withdrawal records its fact and wakes nobody, locally or across servers.
          if (received.injection === "none") return;
          const message = yield* decodeMessageSent(received.message);
          if (event.sender === null || event.receiver === null) {
            return yield* new A2AStorageError({ operation: "project peer-received message" });
          }
          yield* insertPendingDelivery(sql, {
            projectId: event.projectId,
            messageId: message.messageId,
            commandId,
            sentSeq: event.seq,
            senderId: event.sender,
            receiverId: event.receiver,
            receiverProjectId: event.projectId,
            exchangeId: event.exchangeId,
            exchangeRole: message.exchangeRole,
            envelopeChannel: message.envelopeChannel,
            correlationId: event.correlationId,
            messageText: message.text,
            createdAt: event.createdAt,
            originProjectId: received.originProjectId,
            originEnvironmentId: received.originEnvironmentId,
            receiverEnvironmentId: null,
          });
          return;
        }
        case "silence.notice":
        case "participant.joined":
        case "participant.left":
        case "participant.archived":
        case "participant.unarchived":
        case "participant.deleted":
          return;
      }
    });

    const listMembershipEffect = Effect.fn("j5.a2a.listMembership")(function* (
      ledgerProjectId: LedgerProjectId,
    ) {
      yield* ensureProjectLedger(ledgerProjectId);
      const rows = yield* sql<MembershipRow>`
        SELECT project_id, joined_seq, updated_seq, payload
        FROM j5_a2a_membership
        WHERE project_id = ${ledgerProjectId}
        ORDER BY participant_id
      `;
      return yield* Effect.forEach(rows, membershipFromRow, { concurrency: 1 });
    });

    const findHistoricalAgentParticipantId = Effect.fn("j5.a2a.findHistoricalAgentParticipantId")(
      function* (input: { readonly projectId: LedgerProjectId; readonly threadId: ThreadId }) {
        yield* ensureProjectLedger(input.projectId);
        const rows = yield* sql<{ readonly participant_id: string }>`
        SELECT DISTINCT json_extract(payload, '$.participant.id') AS participant_id
        FROM j5_a2a_comm_event
        WHERE project_id = ${input.projectId}
          AND kind = 'participant.joined'
          AND json_extract(payload, '$.participant.kind') = 'agent'
          AND json_extract(payload, '$.participant.threadId') = ${input.threadId}
        ORDER BY participant_id
      `;
        return rows.length === 1 ? yield* decodeParticipantId(rows[0]!.participant_id) : null;
      },
    );

    const appendEventsInTransactionRaw = Effect.fn("j5.a2a.appendEventsInTransaction")(function* (
      command: AppendCommEventsCommand,
    ) {
      yield* ensureProjectLedger(command.projectId);
      const sequenceRows = yield* sql<{ readonly next_seq: number }>`
            SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
            FROM j5_a2a_comm_event
            WHERE project_id = ${command.projectId}
          `;
      const firstSeq = sequenceRows[0]?.next_seq;
      if (firstSeq === undefined) {
        return yield* new A2AStorageError({ operation: "allocate communication sequences" });
      }
      const resultSeq = firstSeq + command.events.length - 1;
      const reserved = yield* sql<{ readonly command_id: string }>`
            INSERT INTO j5_a2a_comm_command_receipt (
              command_id,
              project_id,
              command_type,
              accepted_at,
              result_seq
            ) VALUES (
              ${command.commandId},
              ${command.projectId},
              'comm.append',
              ${command.acceptedAt},
              ${resultSeq}
            )
            ON CONFLICT(command_id) DO NOTHING
            RETURNING command_id
          `;

      if (reserved[0] === undefined) {
        const receiptRows = yield* sql<ReceiptRow>`
              SELECT command_id, project_id, command_type, accepted_at, result_seq
              FROM j5_a2a_comm_command_receipt
              WHERE command_id = ${command.commandId}
              LIMIT 1
            `;
        const row = receiptRows[0];
        if (row === undefined) {
          return yield* new A2AStorageError({ operation: "read replayed batch receipt" });
        }
        if (row.project_id !== command.projectId) {
          return yield* new CommCommandConflictError({
            commandId: command.commandId,
            requestedProjectId: command.projectId,
            existingProjectId: row.project_id,
          });
        }
        const eventRows = yield* sql<EventRow>`
              SELECT
                seq,
                project_id,
                kind,
                sender,
                receiver,
                exchange_id,
                correlation_id,
                payload,
                created_at
              FROM j5_a2a_comm_event
              WHERE project_id = ${command.projectId} AND command_id = ${command.commandId}
              ORDER BY seq
            `;
        if (eventRows.length === 0) {
          return yield* new A2AStorageError({ operation: "read replayed batch events" });
        }
        return {
          receipt: yield* receiptFromRow(row),
          events: yield* Effect.forEach(eventRows, eventFromRow, { concurrency: 1 }),
          committed: false as const,
        };
      }

      const events: Array<StoredCommEvent> = [];
      for (const [index, candidate] of command.events.entries()) {
        if (
          (candidate.kind === "participant.joined" || candidate.kind === "participant.left") &&
          candidate.payload.participant.kind === "human"
        ) {
          return yield* new A2AStorageError({
            operation: "append host-global human as project membership",
          });
        }
        const pending = decideAppendCommEvent({
          commandId: command.commandId,
          projectId: command.projectId,
          acceptedAt: command.acceptedAt,
          event: candidate,
        })[0];
        const seq = firstSeq + index;
        const payload = yield* encodeEventPayload(candidate);
        yield* sql`
              INSERT INTO j5_a2a_comm_event (
                seq,
                project_id,
                kind,
                sender,
                receiver,
                exchange_id,
                correlation_id,
                payload,
                created_at,
                command_id
              ) VALUES (
                ${seq},
                ${pending.projectId},
                ${pending.kind},
                ${pending.sender},
                ${pending.receiver},
                ${pending.exchangeId},
                ${pending.correlationId},
                ${payload},
                ${pending.createdAt},
                ${command.commandId}
              )
            `;
        const event = yield* decodeStoredEvent({ seq, ...pending });
        yield* applyMembership(event);
        yield* applyA2Projection(event, command.commandId);
        events.push(event);
      }
      return {
        receipt: yield* decodeReceipt({
          commandId: command.commandId,
          projectId: command.projectId,
          commandType: "comm.append",
          acceptedAt: command.acceptedAt,
          resultSeq,
        }),
        events,
        committed: true as const,
      };
    });

    const appendEventsInTransaction: A2ALedgerTransactionWriterShape["appendEventsInTransaction"] =
      (command) =>
        appendEventsInTransactionRaw(command).pipe(
          Effect.mapError(preserveDomainError("append communication events in transaction")),
        );

    const publishCommitted: A2ALedgerTransactionWriterShape["publishCommitted"] = (events) =>
      Effect.forEach(events, (event) => PubSub.publish(committed, event), {
        concurrency: 1,
        discard: true,
      });

    const appendInTransaction: A2ALedgerTransactionWriterShape["appendInTransaction"] = (command) =>
      appendEventsInTransaction({
        commandId: command.commandId,
        projectId: command.projectId,
        acceptedAt: command.acceptedAt,
        events: [command.event],
      }).pipe(
        Effect.flatMap((result) => {
          const event = result.events[0];
          return event === undefined
            ? Effect.fail(new A2AStorageError({ operation: "read single appended event" }))
            : Effect.succeed({
                receipt: result.receipt,
                event,
                committed: result.committed,
              });
        }),
      );

    const appendEventsEffect = Effect.fn("j5.a2a.appendEvents")(function* (
      command: AppendCommEventsCommand,
    ) {
      return yield* sql
        .withTransaction(appendEventsInTransaction(command))
        .pipe(
          Effect.tap((result) =>
            result.committed ? publishCommitted(result.events) : Effect.void,
          ),
        );
    });

    const appendEventsIfExchangeOpenEffect = Effect.fn("j5.a2a.appendEventsIfExchangeOpen")(
      function* (command: AppendCommEventsCommand, exchangeId: ExchangeId) {
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const open = yield* sql<{ readonly exchange_id: string }>`
            SELECT exchange_id
            FROM j5_a2a_exchange
            WHERE project_id = ${command.projectId}
              AND exchange_id = ${exchangeId}
              AND status = 'open'
            LIMIT 1
          `;
            if (open[0] === undefined) return null;
            return yield* appendEventsInTransaction(command);
          }),
        );
        if (result === null) return null;
        if (result.committed) yield* publishCommitted(result.events);
        return result;
      },
    );

    const ledger = A2ALedger.of({
      ensureProject: Effect.fn("j5.a2a.ledger.ensureProject")(
        function* (command) {
          yield* sql`
            INSERT INTO j5_a2a_project_ledger (project_id, created_at)
            VALUES (${command.projectId}, ${command.createdAt})
            ON CONFLICT(project_id) DO NOTHING
          `;
        },
        Effect.mapError(preserveDomainError("ensure project ledger")),
      ),
      listProjectLedgers: Effect.fn("j5.a2a.ledger.listProjectLedgers")(
        function* () {
          return yield* Effect.forEach(yield* selectProjectLedgers(null), projectLedgerFromRow, {
            concurrency: 1,
          });
        },
        Effect.mapError(preserveDomainError("list project ledgers")),
      ),
      readProjectLedger: Effect.fn("j5.a2a.ledger.readProjectLedger")(
        function* (ledgerProjectId) {
          const row = (yield* selectProjectLedgers(ledgerProjectId))[0];
          if (row === undefined)
            return yield* new ProjectLedgerNotFoundError({ projectId: ledgerProjectId });
          return yield* projectLedgerFromRow(row);
        },
        Effect.mapError(preserveDomainError("read project ledger")),
      ),
      append: (command) =>
        appendPermit
          .withPermit(
            appendEventsEffect({
              commandId: command.commandId,
              projectId: command.projectId,
              acceptedAt: command.acceptedAt,
              events: [command.event],
            }).pipe(
              Effect.flatMap((result) => {
                const event = result.events[0];
                return event === undefined
                  ? Effect.fail(new A2AStorageError({ operation: "read single appended event" }))
                  : Effect.succeed({
                      receipt: result.receipt,
                      event,
                      committed: result.committed,
                    });
              }),
            ),
          )
          .pipe(Effect.mapError(preserveDomainError("append communication event"))),
      appendEvents: (command) =>
        appendPermit
          .withPermit(appendEventsEffect(command))
          .pipe(Effect.mapError(preserveDomainError("append communication events"))),
      appendEventsIfExchangeOpen: (command, exchangeId) =>
        appendPermit
          .withPermit(appendEventsIfExchangeOpenEffect(command, exchangeId))
          .pipe(Effect.mapError(preserveDomainError("append communication events if open"))),
      readEvents: Effect.fn("j5.a2a.ledger.readEvents")(
        function* ({ projectId: ledgerProjectId, cursor, limit }) {
          yield* ensureProjectLedger(ledgerProjectId);
          const highWaterRows = yield* sql<{ readonly high_water: number }>`
            SELECT COALESCE(MAX(seq), 0) AS high_water
            FROM j5_a2a_comm_event
            WHERE project_id = ${ledgerProjectId}
          `;
          const highWater = highWaterRows[0]?.high_water ?? 0;
          const snapshotEnd = cursor.snapshotEnd ?? highWater;
          if (cursor.afterSeq > snapshotEnd || limit < 1 || !Number.isInteger(limit)) {
            return yield* new LedgerCursorError({
              projectId: ledgerProjectId,
              afterSeq: cursor.afterSeq,
              snapshotEnd,
            });
          }
          const rows = yield* sql<EventRow>`
            SELECT
              seq,
              project_id,
              kind,
              sender,
              receiver,
              exchange_id,
              correlation_id,
              payload,
              created_at
            FROM j5_a2a_comm_event
            WHERE project_id = ${ledgerProjectId}
              AND seq > ${cursor.afterSeq}
              AND seq <= ${snapshotEnd}
            ORDER BY seq
            LIMIT ${limit}
          `;
          const events = yield* Effect.forEach(rows, eventFromRow, { concurrency: 1 });
          let expectedSeq = cursor.afterSeq + 1;
          for (const event of events) {
            if (event.seq !== expectedSeq) {
              return yield* new LedgerGapError({
                projectId: ledgerProjectId,
                expectedSeq,
                actualSeq: event.seq,
              });
            }
            expectedSeq += 1;
          }
          if (events.length === 0 && cursor.afterSeq < snapshotEnd) {
            return yield* new LedgerGapError({
              projectId: ledgerProjectId,
              expectedSeq,
              actualSeq: null,
            });
          }
          const afterSeq = events.at(-1)?.seq ?? cursor.afterSeq;
          return {
            events,
            nextCursor: { afterSeq, snapshotEnd },
            complete: afterSeq === snapshotEnd,
          };
        },
        Effect.mapError(preserveDomainError("read communication events")),
      ),
      listMembership: (ledgerProjectId) =>
        listMembershipEffect(ledgerProjectId).pipe(
          Effect.mapError(preserveDomainError("list project membership")),
        ),
      findHistoricalAgentParticipantId: (input) =>
        findHistoricalAgentParticipantId(input).pipe(
          Effect.mapError(preserveDomainError("find historical agent participant")),
        ),
      rebuildMembership: (ledgerProjectId) =>
        appendPermit
          .withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* ensureProjectLedger(ledgerProjectId);
                yield* sql`DELETE FROM j5_a2a_membership WHERE project_id = ${ledgerProjectId}`;
                const rows = yield* sql<EventRow>`
                  SELECT
                    seq,
                    project_id,
                    kind,
                    sender,
                    receiver,
                    exchange_id,
                    correlation_id,
                    payload,
                    created_at
                  FROM j5_a2a_comm_event
                  WHERE project_id = ${ledgerProjectId}
                    AND kind IN ('participant.joined', 'participant.left', 'participant.archived', 'participant.unarchived', 'participant.deleted')
                  ORDER BY seq
                `;
                for (const row of rows) {
                  yield* applyMembership(yield* eventFromRow(row));
                }
                return yield* listMembershipEffect(ledgerProjectId);
              }),
            ),
          )
          .pipe(Effect.mapError(preserveDomainError("rebuild project membership"))),
      subscribeCommitted: PubSub.subscribe(committed).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    });
    const transactionWriter = A2ALedgerTransactionWriter.of({
      withPermit: (effect) => appendPermit.withPermit(effect),
      appendInTransaction,
      appendEventsInTransaction,
      publishCommitted,
    });
    return Context.make(A2ALedger, ledger).pipe(
      Context.add(A2ALedgerTransactionWriter, transactionWriter),
    );
  }),
);
