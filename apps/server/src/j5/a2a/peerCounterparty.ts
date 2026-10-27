import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { type ExchangeId, type ParticipantId, LedgerProjectId } from "./contracts.ts";

/** Where a participant lives when it is on a peer server. */
export interface PeerCounterparty {
  readonly environmentId: string;
  readonly projectId: LedgerProjectId;
}

interface RouteRow {
  readonly environment_id: string;
  readonly project_id: string;
}

/**
 * The one reader of which peer server a participant is on, from the delivery and received rows an
 * ask left. For an open Exchange its earliest row is the route, so a participant that later appears
 * on another peer cannot move a live Exchange; for a new send, the participant's latest route is
 * the best guess.
 */
export const findPeerCounterparty = Effect.fn("j5.a2a.peerCounterparty")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: LedgerProjectId;
    readonly exchangeId: ExchangeId;
    readonly participantId: ParticipantId;
  },
) {
  const outbound = yield* sql<RouteRow>`
    SELECT receiver_environment_id AS environment_id, receiver_project_id AS project_id
    FROM j5_a2a_delivery
    WHERE project_id = ${input.projectId}
      AND exchange_id = ${input.exchangeId}
      AND receiver_id = ${input.participantId}
      AND receiver_environment_id IS NOT NULL
    ORDER BY sent_seq
    LIMIT 1
  `;
  if (outbound[0] !== undefined) return toCounterparty(outbound[0]);
  const inbound = yield* sql<RouteRow>`
    SELECT
      json_extract(payload, '$.originEnvironmentId') AS environment_id,
      json_extract(payload, '$.originProjectId') AS project_id
    FROM j5_a2a_comm_event
    WHERE project_id = ${input.projectId}
      AND kind = 'message.received'
      AND exchange_id = ${input.exchangeId}
      AND sender = ${input.participantId}
      AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
    ORDER BY seq
    LIMIT 1
  `;
  return inbound[0] === undefined ? null : toCounterparty(inbound[0]);
});

/** The latest route the ledger recorded for a participant, for a send that opens nothing yet. */
export const findPeerRoute = Effect.fn("j5.a2a.peerRoute")(function* (
  sql: SqlClient.SqlClient,
  participantId: ParticipantId,
) {
  const outbound = yield* sql<RouteRow>`
    SELECT receiver_environment_id AS environment_id, receiver_project_id AS project_id
    FROM j5_a2a_delivery
    WHERE receiver_id = ${participantId} AND receiver_environment_id IS NOT NULL
    ORDER BY sent_seq DESC
    LIMIT 1
  `;
  if (outbound[0] !== undefined) return toCounterparty(outbound[0]);
  const inbound = yield* sql<RouteRow>`
    SELECT
      json_extract(payload, '$.originEnvironmentId') AS environment_id,
      json_extract(payload, '$.originProjectId') AS project_id
    FROM j5_a2a_comm_event
    WHERE kind = 'message.received'
      AND sender = ${participantId}
      AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
    ORDER BY seq DESC
    LIMIT 1
  `;
  return inbound[0] === undefined ? null : toCounterparty(inbound[0]);
});

/** Whether any recorded route places the participant on a server other than the one given. */
export const isRoutedElsewhere = Effect.fn("j5.a2a.peerRoutedElsewhere")(function* (
  sql: SqlClient.SqlClient,
  participantId: ParticipantId,
  environmentId: string,
) {
  const rows = yield* sql<{ readonly elsewhere: number }>`
    SELECT (
      EXISTS (
        SELECT 1 FROM j5_a2a_delivery
        WHERE receiver_id = ${participantId}
          AND receiver_environment_id IS NOT NULL
          AND receiver_environment_id <> ${environmentId}
      )
      OR EXISTS (
        SELECT 1 FROM j5_a2a_comm_event
        WHERE kind = 'message.received'
          AND sender = ${participantId}
          AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
          AND json_extract(payload, '$.originEnvironmentId') <> ${environmentId}
      )
    ) AS elsewhere
  `;
  return rows[0]?.elsewhere === 1;
});

const toCounterparty = (row: RouteRow): PeerCounterparty => ({
  environmentId: row.environment_id,
  projectId: LedgerProjectId.make(row.project_id),
});
