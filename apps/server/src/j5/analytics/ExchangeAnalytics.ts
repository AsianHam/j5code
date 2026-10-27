/**
 * Records `j5.exchange.closed` when an Exchange ends, how and after how long: whether asks get
 * answered, by whom, and how long one waits on the person. It reads committed ledger events,
 * published once per commit, so a retried reply, withdrawal or archive counts once.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import {
  ExchangeClosedPayload,
  ExchangeDroppedPayload,
  isHumanParticipantId,
  isMachineParticipantId,
  isPlatformParticipantId,
  ParticipantId,
  type StoredCommEvent,
  Urgency,
} from "../a2a/contracts.ts";
import { A2ALedger } from "../a2a/LedgerService.ts";
import { durationMsBetween } from "./recorder.ts";

const ExchangeRow = Schema.Struct({
  sender_id: ParticipantId,
  receiver_id: ParticipantId,
  urgency: Schema.NullOr(Urgency),
  created_at: Schema.String,
});
const decodeExchangeRow = Schema.decodeUnknownEffect(ExchangeRow);
const decodeClosed = Schema.decodeUnknownEffect(ExchangeClosedPayload);
const decodeDropped = Schema.decodeUnknownEffect(ExchangeDroppedPayload);

const participantKind = (id: ParticipantId) =>
  isHumanParticipantId(id)
    ? "human"
    : isMachineParticipantId(id)
      ? "machine"
      : isPlatformParticipantId(id)
        ? "platform"
        : "agent";

export interface ExchangeAnalyticsShape {
  /** Records the Exchange an `exchange.closed` or `exchange.dropped` event ends; ignores the rest. */
  readonly handleCommitted: (event: StoredCommEvent) => Effect.Effect<void>;
}

export class ExchangeAnalytics extends Context.Service<ExchangeAnalytics, ExchangeAnalyticsShape>()(
  "t3/j5/analytics/ExchangeAnalytics",
) {}

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    ExchangeAnalytics,
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;

      const outcomeOf = Effect.fn("j5.analytics.exchangeOutcome")(function* (
        event: StoredCommEvent,
      ) {
        if (event.kind === "exchange.dropped") {
          const dropped = yield* decodeDropped(event.payload);
          return { outcome: dropped.disposition, cause: dropped.cause.kind };
        }
        const closed = yield* decodeClosed(event.payload);
        return { outcome: "closureKind" in closed ? closed.closureKind : "replied" };
      });

      const record = Effect.fn("j5.analytics.exchangeClosed")(function* (event: StoredCommEvent) {
        if (event.exchangeId === null) return;
        // The ledger projects the Exchange in the commit that wrote this event.
        const rows = yield* sql`
          SELECT sender_id, receiver_id, urgency, created_at
          FROM j5_a2a_exchange
          WHERE project_id = ${event.projectId} AND exchange_id = ${event.exchangeId}
        `;
        if (rows[0] === undefined) return;
        const exchange = yield* decodeExchangeRow(rows[0]);
        yield* analytics.record("j5.exchange.closed", {
          ...(yield* outcomeOf(event)),
          senderKind: participantKind(exchange.sender_id),
          receiverKind: participantKind(exchange.receiver_id),
          urgency: exchange.urgency ?? "none",
          ...durationMsBetween(exchange.created_at, event.createdAt),
        });
      });

      const handleCommitted: ExchangeAnalyticsShape["handleCommitted"] = (event) =>
        event.kind === "exchange.closed" || event.kind === "exchange.dropped"
          ? record(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 exchange analytics skipped an Exchange", { cause }),
              ),
            )
          : Effect.void;

      if (daemon) {
        const committed = yield* ledger.subscribeCommitted;
        yield* committed.pipe(Stream.runForEach(handleCommitted), Effect.forkScoped);
      }

      return ExchangeAnalytics.of({ handleCommitted });
    }),
  );

/** For tests, which feed `handleCommitted` themselves. */
export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
