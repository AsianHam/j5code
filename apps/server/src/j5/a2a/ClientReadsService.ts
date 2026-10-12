import { NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { type A2AHumanInboxError, A2AHumanInbox } from "./HumanInboxService.ts";
import { ParticipantId } from "./contracts.ts";
import { outsideAgentNameRows } from "./outsideAgentNames.ts";

export const DisplayIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("known"), displayName: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
export type DisplayIdentity = typeof DisplayIdentity.Type;

export const ParticipantIdentityEntry = Schema.Struct({
  participantId: ParticipantId,
  identity: DisplayIdentity,
});
export type ParticipantIdentityEntry = typeof ParticipantIdentityEntry.Type;

/** B3's batch request stays opaque: participant ids are neither trimmed nor normalized. */
export const ParticipantIdentitiesRequest = Schema.Struct({
  participantIds: Schema.Array(ParticipantId),
});
export type ParticipantIdentitiesRequest = typeof ParticipantIdentitiesRequest.Type;

export const ParticipantIdentitiesResponse = Schema.Struct({
  entries: Schema.Array(ParticipantIdentityEntry),
});
export type ParticipantIdentitiesResponse = typeof ParticipantIdentitiesResponse.Type;

export const OpenInboxCount = Schema.Struct({
  personId: ParticipantId,
  count: NonNegativeInt,
});
export type OpenInboxCount = typeof OpenInboxCount.Type;

export type ClientReadsError = SqlError | A2AHumanInboxError;

interface IdentityRow {
  readonly participant_id: string;
  readonly display_name: string | null;
}

interface OpenInboxCountRow {
  readonly count: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

/** Leaves headroom under SQLite's bind-parameter ceiling for viewport-sized reads. */
export const CLIENT_READ_PARTICIPANT_BATCH_SIZE = 900;

const uniqueInFirstOccurrenceOrder = <Value>(values: ReadonlyArray<Value>) =>
  Array.from(new Set(values));

const batchesOf = <Value>(values: ReadonlyArray<Value>) => {
  const batches: Array<ReadonlyArray<Value>> = [];
  for (let index = 0; index < values.length; index += CLIENT_READ_PARTICIPANT_BATCH_SIZE) {
    batches.push(values.slice(index, index + CLIENT_READ_PARTICIPANT_BATCH_SIZE));
  }
  return batches;
};

const unknownIdentity = (): DisplayIdentity => ({ kind: "unknown" });

const toIdentity = (row: IdentityRow | undefined): DisplayIdentity => {
  if (row === undefined || row.display_name === null) return unknownIdentity();
  const displayName = row.display_name.trim();
  return displayName.length === 0
    ? unknownIdentity()
    : { kind: "known", displayName: TrimmedNonEmptyString.make(displayName) };
};

/** The one definition of an agent's display name: the title of the thread its first `participant.joined` named. */
export const participantIdentityRows = (
  sql: SqlClient.SqlClient,
  participantIds: ReadonlyArray<ParticipantId>,
) =>
  sql<IdentityRow>`
    WITH ranked_identities AS (
      SELECT
        json_extract(event.payload, '$.participant.id') AS participant_id,
        thread.title AS display_name,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(event.payload, '$.participant.id')
          ORDER BY event.created_at ASC, event.project_id ASC, event.seq ASC
        ) AS history_rank
      FROM j5_a2a_comm_event AS event
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = json_extract(event.payload, '$.participant.threadId')
      WHERE event.kind = 'participant.joined'
        AND json_extract(event.payload, '$.participant.kind') = 'agent'
        AND json_extract(event.payload, '$.participant.id') IN ${sql.in(participantIds)}
    )
    SELECT participant_id, display_name
    FROM ranked_identities
    WHERE history_rank = 1
  `;

/** This exact statement is executed for count reads and compiled by the plan proof below. */
export const openInboxCountStatement = (sql: SqlClient.SqlClient, personId: ParticipantId) =>
  sql<OpenInboxCountRow>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_human_inbox AS inbox
    JOIN j5_a2a_exchange AS exchange
      ON exchange.project_id = inbox.project_id
     AND exchange.exchange_id = inbox.exchange_id
    WHERE inbox.status = 'open'
      AND exchange.status = 'open'
      AND inbox.person_id = ${personId}
  `;

/**
 * The label a peer sent with the delivery this server recorded last, for each
 * sender asked about. "Last" is by the time this server recorded the row: the
 * receiver stamps received rows with its own clock, so the origin cannot date
 * one into the future, and the stamp orders rows across projects, which `seq`
 * (allocated per project) does not; project id, then seq, break ties so one
 * row wins. A sender id belongs to one peer (the inbound ownership check refuses
 * a second origin), so its latest labeled row is that peer's latest label. Each
 * id is one backward seek on migration 27's index, so the cost follows the ids
 * asked about, never a sender's history. An id with no label comes back with a
 * null name; callers skip it (filtering in SQL would evaluate the seek twice).
 */
export const peerSenderLabelStatement = (
  sql: SqlClient.SqlClient,
  participantIds: ReadonlyArray<string>,
) =>
  sql<IdentityRow>`
    SELECT asked.value AS participant_id,
           (
             SELECT json_extract(event.payload, '$.senderLabel')
             FROM j5_a2a_comm_event AS event
             WHERE event.kind = 'message.received'
               AND json_extract(event.payload, '$.senderLabel') IS NOT NULL
               AND json_extract(event.payload, '$.originEnvironmentId') IS NOT NULL
               AND event.sender = asked.value
             ORDER BY event.created_at DESC, event.project_id DESC, event.seq DESC
             LIMIT 1
           ) AS display_name
    FROM json_each(${JSON.stringify(participantIds)}) AS asked
  `;

/** Test-facing plan hook for the peer label statement. */
export const explainPeerSenderLabelStatement = (
  sql: SqlClient.SqlClient,
  participantIds: ReadonlyArray<string>,
) => {
  const [statement, parameters] = peerSenderLabelStatement(sql, participantIds).compile();
  return sql.unsafe<QueryPlanRow>(`EXPLAIN QUERY PLAN ${statement}`, parameters);
};

/** Test-facing plan hook that compiles the production count statement rather than a copy. */
export const explainOpenInboxCountStatement = (
  sql: SqlClient.SqlClient,
  personId: ParticipantId,
) => {
  const [statement, parameters] = openInboxCountStatement(sql, personId).compile();
  return sql.unsafe<QueryPlanRow>(`EXPLAIN QUERY PLAN ${statement}`, parameters);
};

export interface ClientReadsShape {
  /** Batch-oriented, total identity resolution for B3 timelines and A4 inbox sender labels. */
  readonly participantIdentities: (
    input: ParticipantIdentitiesRequest,
  ) => Effect.Effect<ParticipantIdentitiesResponse, SqlError>;
  /** Counts with the same open inbox + open exchange predicate as A4's list. */
  readonly openInboxCount: (
    personId?: ParticipantId,
  ) => Effect.Effect<OpenInboxCount, ClientReadsError>;
}

export class ClientReadsService extends Context.Service<ClientReadsService, ClientReadsShape>()(
  "t3/j5/a2a/ClientReadsService",
) {}

export const layer: Layer.Layer<ClientReadsService, never, A2AHumanInbox | SqlClient.SqlClient> =
  Layer.effect(
    ClientReadsService,
    Effect.gen(function* () {
      const inbox = yield* A2AHumanInbox;
      const sql = yield* SqlClient.SqlClient;

      const participantIdentities: ClientReadsShape["participantIdentities"] = (input) =>
        Effect.gen(function* () {
          const uniqueParticipantIds = uniqueInFirstOccurrenceOrder(input.participantIds);
          if (uniqueParticipantIds.length === 0) return { entries: [] };
          const rows: Array<IdentityRow> = [];
          for (const participantIdBatch of batchesOf(uniqueParticipantIds)) {
            rows.push(...(yield* participantIdentityRows(sql, participantIdBatch)));
            // Machine senders have no thread; their display name is their registered name.
            rows.push(
              ...(yield* sql<IdentityRow>`
                SELECT participant_id, name AS display_name
                FROM j5_a2a_machine_participant
                WHERE participant_id IN ${sql.in(participantIdBatch)}
              `),
            );
            // An outside agent has no thread either; it is shown by the label it signed in with.
            rows.push(...(yield* outsideAgentNameRows(sql, participantIdBatch)));
            // A sender homed on a peer has no thread here; the label its server
            // sent with its latest delivery stands in, and only for ids nothing
            // local named, so local-only reads never touch received history.
            const named = new Set(rows.map((row) => row.participant_id));
            const unresolved = participantIdBatch.filter(
              (participantId) => !named.has(participantId),
            );
            if (unresolved.length > 0) {
              rows.push(
                ...(yield* peerSenderLabelStatement(sql, unresolved)).filter(
                  (row) => row.display_name !== null,
                ),
              );
            }
          }
          const rowsByParticipant = Map.groupBy(rows, (row) => row.participant_id);
          return {
            entries: uniqueParticipantIds.map((participantId) => {
              return {
                participantId,
                identity: toIdentity(rowsByParticipant.get(participantId)?.[0]),
              } satisfies ParticipantIdentityEntry;
            }),
          } satisfies ParticipantIdentitiesResponse;
        });

      const openInboxCount: ClientReadsShape["openInboxCount"] = (requestedPersonId) =>
        Effect.gen(function* () {
          const personId = yield* inbox.resolvePersonId(requestedPersonId);
          const rows = yield* openInboxCountStatement(sql, personId);
          return { personId, count: rows[0]?.count ?? 0 } satisfies OpenInboxCount;
        });

      return ClientReadsService.of({ participantIdentities, openInboxCount });
    }),
  );
