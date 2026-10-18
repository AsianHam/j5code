import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { getLocalOperatorHumanPersonId } from "./HumanPersonRegistry.ts";
import { SharedThreads } from "../sharing/SharedThreads.ts";
import { A2ALedgerTransactionWriter } from "./LedgerService.ts";
import {
  CommCommandId,
  CorrelationId,
  EVERYONE_HERE_PERSON_ID,
  ExchangeId,
  LedgerMessageId,
  type CommEvent,
} from "./contracts.ts";
import { formatRunFailure } from "./runFailures.ts";

/** Network failures alone do not prove that the person must act. */
export const needsHumanForCrewFailure = (failure: OrchestrationV2ProviderFailure | null) =>
  failure !== null &&
  (failure.class === "permission_error" ||
    /\b(401|403|unauthenticated|authentication[_ -]?(?:error|failed|required)|invalid[_ -]?(?:api[_ -]?key|token)|(?:session|token|credentials?)[^\n]{0,40}expired|expired[^\n]{0,40}(?:session|token|credentials?)|not logged in|signed out|sign[ -]?in required|login required)\b/i.test(
      `${failure.code ?? ""} ${failure.message}`,
    ));

/**
 * Every alert exchange id starts with this. The ledger's one-open-exchange-per-pair rule and the
 * Captain's ask lookup both skip these ids (migration 020), so an alert sits beside the Captain's
 * own ask instead of joining it.
 */
export const CREW_ALERT_EXCHANGE_PREFIX = "exchange:j5-crew-human-alert:";

/** Alert exchanges carry their Crew in the id, so a lookup can never land on another Crew's. */
const alertExchangePrefix = (crewInstanceId: string) =>
  `${CREW_ALERT_EXCHANGE_PREFIX}${encodeURIComponent(crewInstanceId)}/`;

/**
 * A platform-authored ask in the Captain's inbox conversation. Replies return to the Captain.
 * Where more than one person can write to the Captain's thread it is asked of everyone here, so
 * each of them sees it and the first answer settles it (Crews AC23); elsewhere, of the first
 * owner.
 * One open alert per Crew: failures in the same Crew fold into it without losing its text, and
 * the Captain's own asks are never touched. A receipt per failed run prevents replay from
 * appending twice or reopening an alert the person already answered. This internal producer
 * does not grant agents the ability to append follow-ups to human asks.
 */
export const makeCrewFailureAlert = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writer = yield* A2ALedgerTransactionWriter;
  const worker = yield* A2ADeliveryWorker;
  const shared = yield* SharedThreads;
  return Effect.fn("j5.a2a.crewFailureAlert")(function* (input: {
    readonly instance: Pick<
      AgentCrewInstance,
      "id" | "projectId" | "captainParticipantId" | "captainThreadId" | "displayName"
    >;
    readonly seatName: string;
    readonly runId: string;
    readonly failure: OrchestrationV2ProviderFailure | null;
  }) {
    if (!needsHumanForCrewFailure(input.failure)) return;
    const commandId = CommCommandId.make(`j5-crew-human-alert:${input.runId}`);
    const toEveryone = yield* shared.isShared(input.instance.captainThreadId);
    const outcome = yield* writer.withPermit(
      sql.withTransaction(
        Effect.gen(function* () {
          const replay =
            yield* sql`SELECT 1 FROM j5_a2a_comm_command_receipt WHERE command_id = ${commandId}`;
          if (replay.length > 0) return null;
          const personId = toEveryone
            ? EVERYONE_HERE_PERSON_ID
            : yield* getLocalOperatorHumanPersonId(sql);
          const { projectId, captainParticipantId } = input.instance;
          const prefix = alertExchangePrefix(input.instance.id);
          const existing = (yield* sql<{ readonly exchange_id: string }>`
      SELECT exchange_id FROM j5_a2a_exchange WHERE project_id = ${projectId}
        AND sender_id = ${captainParticipantId} AND receiver_id = ${personId} AND status = 'open'
        AND substr(exchange_id, 1, ${prefix.length}) = ${prefix}
    `)[0];
          const exchangeId = ExchangeId.make(
            existing?.exchange_id ?? `${prefix}${encodeURIComponent(input.runId)}`,
          );
          const previous =
            existing === undefined
              ? undefined
              : (yield* sql<{ readonly message_text: string }>`
      SELECT message_text FROM j5_a2a_delivery WHERE project_id = ${projectId}
        AND exchange_id = ${exchangeId} AND receiver_id = ${personId} ORDER BY sent_seq DESC LIMIT 1
    `)[0]?.message_text;
          const text = `Platform notice: Crew "${input.instance.displayName}", seat "${input.seatName}" needs your help.\n${formatRunFailure(input.failure)}\nCheck this environment's provider sign-in or permissions, then reply here so the Captain can re-brief the seat. No automatic retry was started.`;
          const at = DateTime.formatIso(yield* DateTime.now);
          const base = {
            sender: captainParticipantId,
            receiver: personId,
            exchangeId,
            correlationId: CorrelationId.make(`correlation:${commandId}`),
            createdAt: at,
          };
          const events: Array<CommEvent> = [];
          if (existing === undefined)
            events.push({
              ...base,
              kind: "exchange.opened",
              payload: {
                intent: `Crew ${input.instance.displayName} needs provider access`,
                urgency: "blocking",
              },
            });
          events.push({
            ...base,
            kind: "message.sent",
            payload: {
              messageId: LedgerMessageId.make(`message:${commandId}`),
              text: previous === undefined ? text : `${previous}\n\n${text}`,
              originProjectId: projectId,
              receiverProjectId: projectId,
              exchangeRole: existing === undefined ? "ask" : "followup",
              envelopeChannel: "peer",
            },
          });
          return yield* writer.appendEventsInTransaction({
            commandId,
            projectId,
            acceptedAt: at,
            events,
          });
        }),
      ),
    );
    if (!outcome?.committed) return;
    yield* writer.publishCommitted(outcome.events);
    // The ledger PubSub does not wake the delivery worker; every producer that commits a
    // delivery wakes it itself, or the alert waits for some unrelated send.
    yield* worker.notify;
  });
});
