import type { FleetAgentFacts, FleetDeliveryProblem, FleetResponse } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { CREW_ALERT_EXCHANGE_PREFIX } from "./crewFailureAlert.ts";
import { clientReadBatches } from "./clientReadBatches.ts";

type Ask = FleetAgentFacts["asks"]["owed"][number];
type ExchangeRow = {
  readonly project_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly intent: string;
  readonly created_at: string;
};
type AlarmRow = {
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly message_id: string;
  readonly exchange_id: string | null;
  readonly origin_environment_id: string | null;
  readonly updated_at: string;
  readonly last_error: string | null;
  readonly exchange_open: number;
};

/** Both directions span project boundaries: the Exchange lives with its sender. */
export const readFleetLedgerFacts = Effect.fn("readFleetLedgerFacts")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  agentIds: ReadonlyArray<string>,
  nameOf: (id: string) => string | null,
) {
  const owed = new Map<string, Array<Ask>>();
  const awaited = new Map<string, Array<Ask>>();
  const problems = new Map<string, Array<FleetDeliveryProblem>>();
  const deliveryEnvironmentIds = new Map<string, Array<string>>();
  const batches = clientReadBatches([...new Set(agentIds)]);
  const exchanges = new Map<string, Map<string, ExchangeRow>>();
  for (const batch of batches) {
    for (const column of ["sender_id", "receiver_id"]) {
      const rows = yield* sql<ExchangeRow>`
        SELECT project_id, exchange_id, sender_id, receiver_id,
          CASE WHEN length(intent) > 200 THEN substr(intent, 1, 199) || '…' ELSE intent END AS intent,
          created_at
        FROM j5_a2a_exchange
        WHERE status = 'open' AND ${sql(column)} IN ${sql.in(batch)}
          AND exchange_id NOT LIKE ${`${CREW_ALERT_EXCHANGE_PREFIX}%`}
      `;
      for (const row of rows) {
        const projectExchanges = exchanges.get(row.project_id) ?? new Map<string, ExchangeRow>();
        projectExchanges.set(row.exchange_id, row);
        exchanges.set(row.project_id, projectExchanges);
      }
    }
  }
  const orderedExchanges = [...exchanges.values()]
    .flatMap((rows) => [...rows.values()])
    .toSorted(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.exchange_id.localeCompare(right.exchange_id) ||
        left.project_id.localeCompare(right.project_id),
    );
  for (const row of orderedExchanges) {
    const ask = (counterpartyId: string): Ask => ({
      exchangeId: row.exchange_id,
      counterpartyId,
      counterpartyName: nameOf(counterpartyId),
      intent: row.intent,
      openedAt: row.created_at,
    });
    const senderAsks = awaited.get(row.sender_id) ?? [];
    senderAsks.push(ask(row.receiver_id));
    awaited.set(row.sender_id, senderAsks);
    const receiverAsks = owed.get(row.receiver_id) ?? [];
    receiverAsks.push(ask(row.sender_id));
    owed.set(row.receiver_id, receiverAsks);
  }
  // Coverage follows the open debt, so acceptance needs no extra Fleet invalidation.
  // CROSS JOIN keeps the small open-Exchange set ahead of indexed receiver-route lookups.
  for (const batch of batches) {
    const destinations = yield* sql<{ sender_id: string; receiver_environment_id: string }>`
      SELECT DISTINCT d.sender_id, d.receiver_environment_id
      FROM j5_a2a_exchange e CROSS JOIN j5_a2a_delivery d
        ON d.project_id = e.project_id AND d.exchange_id = e.exchange_id
          AND d.sender_id = e.sender_id AND d.receiver_id = e.receiver_id
      WHERE e.status = 'open' AND e.sender_id IN ${sql.in(batch)}
        AND e.exchange_id NOT LIKE ${`${CREW_ALERT_EXCHANGE_PREFIX}%`}
        AND d.origin_environment_id IS NULL AND d.receiver_environment_id IS NOT NULL
        AND d.exchange_role = 'ask' AND d.envelope_channel = 'peer'
      ORDER BY d.receiver_environment_id
    `;
    for (const row of destinations) {
      const environments = deliveryEnvironmentIds.get(row.sender_id) ?? [];
      environments.push(row.receiver_environment_id);
      deliveryEnvironmentIds.set(row.sender_id, environments);
    }
  }
  const alarms = yield* sql<AlarmRow>`
    SELECT d.sender_id, d.receiver_id, d.message_id, d.exchange_id, d.origin_environment_id,
      d.updated_at, d.last_error,
      EXISTS (SELECT 1 FROM j5_a2a_exchange e WHERE e.project_id = d.project_id
        AND e.exchange_id = d.exchange_id AND e.status = 'open') AS exchange_open
    FROM j5_a2a_delivery d
    WHERE d.project_id = ${projectId} AND d.status = 'alarmed' AND d.envelope_channel = 'peer'
      AND (d.exchange_id IS NULL OR d.exchange_id NOT LIKE ${`${CREW_ALERT_EXCHANGE_PREFIX}%`})
    ORDER BY d.sent_seq, d.message_id
  `;
  const localAgents = new Set(agentIds);
  const remoteDeliveryAlarms: NonNullable<FleetResponse["remoteDeliveryAlarms"]>[number][] = [];
  for (const row of alarms) {
    const problem: FleetDeliveryProblem = {
      kind: "delivery-failed",
      messageId: row.message_id,
      exchangeId: row.exchange_id,
      receiverId: row.receiver_id,
      receiverName: nameOf(row.receiver_id),
      at: row.updated_at,
      reason: row.last_error,
      exchangeOpen: row.exchange_open === 1,
    };
    if (row.origin_environment_id !== null) {
      remoteDeliveryAlarms.push({
        originEnvironmentId: row.origin_environment_id,
        senderId: row.sender_id,
        problem,
      });
    } else if (localAgents.has(row.sender_id)) {
      const senderProblems = problems.get(row.sender_id) ?? [];
      senderProblems.push(problem);
      problems.set(row.sender_id, senderProblems);
    }
  }
  return { owed, awaited, problems, deliveryEnvironmentIds, remoteDeliveryAlarms };
});
