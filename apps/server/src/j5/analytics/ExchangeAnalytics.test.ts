import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import {
  CommCommandId,
  type CommEvent,
  type ExchangeClosedPayload,
  ExchangeId,
  LedgerMessageId,
  LedgerProjectId,
  type Participant,
  ParticipantId,
} from "../a2a/contracts.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { layer as exchangeAnalyticsLayer } from "./ExchangeAnalytics.ts";

const projectId = LedgerProjectId.make("ledger:exchange-analytics");
const agent = (name: string): Participant => ({
  kind: "agent",
  id: ParticipantId.make(`agent:exchange-analytics:${name}`),
  threadId: ThreadId.make(`thread:exchange-analytics:${name}`),
});
const asker = agent("asker");
const answerer = agent("answerer");
const person = ParticipantId.make("human:global");

type Recorded = Readonly<Record<string, unknown>>;

const testLayer = (recorded: Queue.Queue<Recorded>) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const analytics = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: (event, properties = {}) =>
        Queue.offer(recorded, { event, ...properties }).pipe(Effect.asVoid),
      flush: Effect.void,
      recordOwners: () => Effect.void,
    }),
  );
  // The daemon layer: it subscribes to the ledger's committed events as production does.
  return exchangeAnalyticsLayer.pipe(
    Layer.provide(analytics),
    Layer.provideMerge(ledger),
    Layer.provideMerge(database),
  );
};

it.effect("says how each Exchange ended and how long it was open", () =>
  Effect.gen(function* () {
    const recorded = yield* Queue.unbounded<Recorded>();
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledger = yield* A2ALedger;
      yield* ledger.ensureProject({ projectId, createdAt: "2026-10-10T12:00:00.000Z" });
      let command = 0;
      const append = (event: CommEvent) =>
        ledger.append({
          commandId: CommCommandId.make(`command:exchange-analytics:${(command += 1)}`),
          projectId,
          acceptedAt: event.createdAt,
          event,
        });
      for (const participant of [asker, answerer]) {
        yield* append({
          kind: "participant.joined",
          sender: null,
          receiver: participant.id,
          exchangeId: null,
          correlationId: null,
          payload: { participant },
          createdAt: "2026-10-10T12:00:00.000Z",
        });
      }
      const open = (name: string, receiver: ParticipantId, urgency: "blocking" | null) =>
        append({
          kind: "exchange.opened",
          sender: asker.id,
          receiver,
          exchangeId: ExchangeId.make(`exchange:exchange-analytics:${name}`),
          correlationId: null,
          payload: { intent: "The intent never leaves the machine", urgency },
          createdAt: "2026-10-10T12:00:00.000Z",
        });
      const close = (name: string, receiver: ParticipantId, payload: ExchangeClosedPayload) =>
        append({
          kind: "exchange.closed",
          sender: asker.id,
          receiver,
          exchangeId: ExchangeId.make(`exchange:exchange-analytics:${name}`),
          correlationId: null,
          payload,
          createdAt: "2026-10-10T12:00:30.000Z",
        });

      // The person answers a blocking ask from the Inbox.
      yield* open("answered", person, "blocking");
      yield* close("answered", person, { replyMessageId: LedgerMessageId.make("message:reply") });
      // An agent withdraws an ask another agent never answered.
      yield* open("withdrawn", answerer.id, null);
      yield* close("withdrawn", answerer.id, { closureKind: "sender-cleared" });

      assert.deepStrictEqual(yield* Queue.take(recorded), {
        event: "j5.exchange.closed",
        outcome: "replied",
        senderKind: "agent",
        receiverKind: "human",
        urgency: "blocking",
        durationMs: 30_000,
      });
      assert.deepStrictEqual(yield* Queue.take(recorded), {
        event: "j5.exchange.closed",
        outcome: "sender-cleared",
        senderKind: "agent",
        receiverKind: "agent",
        urgency: "none",
        durationMs: 30_000,
      });
      // Opening an Exchange and joining a project record nothing.
      assert.equal(yield* Queue.size(recorded), 0);
    }).pipe(Effect.provide(testLayer(recorded)));
  }),
);
