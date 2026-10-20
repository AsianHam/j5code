import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  LedgerProjectId,
  type StoredCommEvent,
} from "./contracts.ts";
import {
  canBeNotified,
  type DroppedExchange,
  formatPeerDropNotice,
  notDeliveredNoticeEvent,
  notDeliveredNoticeMessageId,
  peerDropEvents,
} from "./deliveryNotices.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2ALedgerTransactionWriter, type A2ALedgerError } from "./LedgerService.ts";
import { findPeerCounterparty } from "./peerCounterparty.ts";
import { reportedLabel } from "./peerLabel.ts";
import { PeerRegistryService, type PeerSessionReadError } from "./PeerRegistryService.ts";

/**
 * Removing a peer wipes the slate on this server, in every link mode, in one
 * write transaction: every open Exchange with a participant on the peer is
 * dropped, with the drop notice to the party here; every message still waiting
 * to reach the peer, stored, retrying, alarmed or handed out, is cancelled, and
 * its sender gets a not-delivered notice unless its Exchange's drop already
 * told it; and the peer's record goes. Ledger writes are serialized, so nothing
 * recorded for the peer can land in between: what was recorded before is
 * wiped, and what comes after finds no peer and is refused. Peering again
 * starts empty.
 */

export interface PeerRemovalResult {
  readonly removed: boolean;
  readonly cancelledMessages: number;
  readonly droppedExchanges: number;
}

export interface PeerRemovalServiceShape {
  readonly remove: (
    environmentId: string,
  ) => Effect.Effect<PeerRemovalResult, SqlError | A2ALedgerError | PeerSessionReadError>;
}

export class PeerRemovalService extends Context.Service<
  PeerRemovalService,
  PeerRemovalServiceShape
>()("t3/j5/a2a/PeerRemovalService") {}

const stablePart = (value: string) => encodeURIComponent(value);

interface WaitingRow {
  readonly project_id: string;
  readonly message_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: string;
  readonly correlation_id: string;
  readonly attempts: number;
  readonly handed_out_at: string | null;
}

export const layer: Layer.Layer<
  PeerRemovalService,
  never,
  PeerRegistryService | A2ALedgerTransactionWriter | A2ADeliveryWorker | SqlClient.SqlClient
> = Layer.effect(
  PeerRemovalService,
  Effect.gen(function* () {
    const peers = yield* PeerRegistryService;
    const writer = yield* A2ALedgerTransactionWriter;
    const worker = yield* A2ADeliveryWorker;
    const sql = yield* SqlClient.SqlClient;

    const remove: PeerRemovalServiceShape["remove"] = (environmentId) =>
      Effect.gen(function* () {
        const committed: Array<StoredCommEvent> = [];
        const append = (command: Parameters<typeof writer.appendEventsInTransaction>[0]) =>
          writer.appendEventsInTransaction(command).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result.committed) committed.push(...result.events);
              }),
            ),
          );

        const result = yield* writer.withPermit(
          sql.withTransaction(
            Effect.gen(function* () {
              const [record] = yield* sql<{ readonly label: string }>`
                SELECT label FROM j5_a2a_peer WHERE environment_id = ${environmentId}
              `;
              const serverName = reportedLabel(record?.label) ?? environmentId;
              const because = `${serverName} is no longer peered`;
              const now = DateTime.formatIso(yield* DateTime.now);

              // Exchanges first: an ask still waiting is told of by its Exchange's drop.
              // The ask's own row exists only for an ask sent from this server.
              const exchanges = yield* sql<
                DroppedExchange & {
                  readonly intent: string;
                  readonly ask_message_id: string | null;
                }
              >`
                SELECT e.project_id, e.exchange_id, e.sender_id, e.receiver_id, e.intent,
                  (
                    SELECT d.message_id FROM j5_a2a_delivery AS d
                    WHERE d.project_id = e.project_id AND d.exchange_id = e.exchange_id
                      AND d.exchange_role = 'ask' AND d.origin_environment_id IS NULL
                    ORDER BY d.sent_seq
                    LIMIT 1
                  ) AS ask_message_id
                FROM j5_a2a_exchange AS e
                WHERE e.status = 'open'
                  AND EXISTS (
                    SELECT 1 FROM j5_a2a_delivery AS d
                    WHERE d.project_id = e.project_id AND d.exchange_id = e.exchange_id
                      AND (d.receiver_environment_id = ${environmentId}
                        OR d.origin_environment_id = ${environmentId})
                  )
                ORDER BY e.project_id, e.opened_seq, e.exchange_id
              `;
              const dropped = new Set<string>();
              for (const exchange of exchanges) {
                const projectId = LedgerProjectId.make(exchange.project_id);
                const exchangeId = ExchangeId.make(exchange.exchange_id);
                const onPeer = (participantId: string) =>
                  findPeerCounterparty(sql, {
                    projectId,
                    exchangeId,
                    participantId: ParticipantId.make(participantId),
                  }).pipe(
                    Effect.map((route) => (route?.environmentId === environmentId ? route : null)),
                  );
                const remoteReceiver = yield* onPeer(exchange.receiver_id);
                const remoteSender =
                  remoteReceiver === null ? yield* onPeer(exchange.sender_id) : null;
                const remote = remoteReceiver ?? remoteSender;
                if (remote === null) continue;
                const disposition = remoteReceiver === null ? "sender-retired" : "receiver-retired";
                yield* append({
                  commandId: CommCommandId.make(
                    `command:j5:a2a:peer-removed:drop:${stablePart(exchange.project_id)}:${stablePart(exchange.exchange_id)}`,
                  ),
                  projectId,
                  acceptedAt: now,
                  events: peerDropEvents({
                    exchange,
                    disposition,
                    cause: {
                      kind: "peer-removed",
                      participantId: ParticipantId.make(
                        remoteReceiver === null ? exchange.sender_id : exchange.receiver_id,
                      ),
                      projectId: remote.projectId,
                    },
                    localProjectId: exchange.project_id,
                    noticeText: formatPeerDropNotice({
                      exchangeId,
                      disposition,
                      because,
                      intent: exchange.intent,
                      ...(disposition === "receiver-retired" && exchange.ask_message_id !== null
                        ? { askMessageId: exchange.ask_message_id }
                        : {}),
                    }),
                    createdAt: now,
                  }),
                });
                dropped.add(`${exchange.project_id} ${exchange.exchange_id}`);
              }

              const waiting = yield* sql<WaitingRow>`
                SELECT project_id, message_id, sender_id, receiver_id, exchange_id, exchange_role,
                  correlation_id, attempts, handed_out_at
                FROM j5_a2a_delivery
                WHERE receiver_environment_id = ${environmentId}
                  AND status IN ('pending', 'retry_scheduled', 'alarmed')
                ORDER BY sent_seq, project_id, message_id
              `;
              for (const row of waiting) {
                // A refusal already told the sender, and an ask's sender, or one
                // on an Exchange this removal dropped, is told by the drop.
                const alreadyTold =
                  (yield* sql`
                    SELECT 1 FROM j5_a2a_delivery
                    WHERE project_id = ${row.project_id}
                      AND message_id = ${notDeliveredNoticeMessageId(row)}
                  `).length > 0;
                const onDropped =
                  row.exchange_id !== null && dropped.has(`${row.project_id} ${row.exchange_id}`);
                // Handed to a poller, attempted directly with no refusal back (a
                // refused one was told above), or on the wire now: the peer may hold it.
                const mayHaveArrived =
                  row.handed_out_at !== null ||
                  row.attempts > 0 ||
                  (yield* worker.peerAttemptInFlight(row.project_id, row.message_id));
                const tell =
                  row.exchange_role !== "ask" &&
                  !onDropped &&
                  canBeNotified(row.sender_id) &&
                  !alreadyTold;
                yield* append({
                  commandId: CommCommandId.make(
                    `command:j5:a2a:peer-removed:cancel:${stablePart(row.project_id)}:${stablePart(row.message_id)}`,
                  ),
                  projectId: LedgerProjectId.make(row.project_id),
                  acceptedAt: now,
                  events: [
                    {
                      kind: "message.cancelled",
                      sender: ParticipantId.make(row.sender_id),
                      receiver: ParticipantId.make(row.receiver_id),
                      exchangeId:
                        row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
                      correlationId: CorrelationId.make(row.correlation_id),
                      payload: {
                        messageId: LedgerMessageId.make(row.message_id),
                        reason: `${because}.`,
                      },
                      createdAt: now,
                    },
                    ...(tell
                      ? [
                          notDeliveredNoticeEvent({
                            message: row,
                            serverName,
                            reason: `${because}.`,
                            createdAt: now,
                            mayHaveArrived,
                          }),
                        ]
                      : []),
                  ],
                });
              }

              const { removed } = yield* peers.remove(environmentId);
              return {
                removed,
                cancelledMessages: waiting.length,
                droppedExchanges: dropped.size,
              } satisfies PeerRemovalResult;
            }),
          ),
        );
        yield* writer.publishCommitted(committed);
        // The notices are queued here, outside the delivery worker: wake it.
        if (committed.length > 0) yield* worker.notify;
        return result;
      }).pipe(Effect.withSpan("j5.a2a.peer.remove"));

    return PeerRemovalService.of({ remove });
  }),
);
