import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { makeCrewFailureAlert, needsHumanForCrewFailure } from "./crewFailureAlert.ts";
import { layer as sharedThreadsLayer } from "../sharing/SharedThreads.ts";
import {
  A2ADeliveryWorker,
  layer as daemonDeliveryWorkerLayer,
  manualLayer as deliveryWorkerLayer,
} from "./DeliveryWorker.ts";
import {
  A2ADeliveryTransport,
  live as deliveryTransportLive,
  type AgentDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  EVERYONE_HERE_PERSON_ID,
  ParticipantId,
  LedgerProjectId,
  type AgentParticipant,
  type HumanParticipant,
} from "./contracts.ts";

const person: HumanParticipant = { kind: "human", id: ParticipantId.make("human:person-one") };
const at = "2026-09-18T12:00:00.000Z";
const projectId = LedgerProjectId.make("project:alerts");
const captain: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:captain"),
  threadId: ThreadId.make("thread:captain"),
};

const makeTestLayer = (
  deliveries: Ref.Ref<ReadonlyArray<AgentDeliveryInput>>,
  options: { readonly daemon?: boolean } = {},
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const liveTransport = deliveryTransportLive.pipe(
    Layer.provide(database),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(PeerRegistryService)({})),
    Layer.provide(Layer.mock(ThreadManagementService)({})),
    Layer.provide(Layer.mock(OrchestratorV2)({})),
    Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
  );
  const transport = Layer.effect(
    A2ADeliveryTransport,
    Effect.gen(function* () {
      const production = yield* A2ADeliveryTransport;
      return A2ADeliveryTransport.of({
        deliverAgent: (input) => Ref.update(deliveries, (current) => [...current, input]),
        cancelAgent: production.cancelAgent,
        deliverPeer: production.deliverPeer,
        deliverHuman: production.deliverHuman,
      });
    }),
  ).pipe(Layer.provide(liveTransport));
  const worker = (options.daemon === true ? daemonDeliveryWorkerLayer : deliveryWorkerLayer).pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const shared = sharedThreadsLayer.pipe(Layer.provide(database));
  return Layer.mergeAll(database, ledger, send, inbox, worker, shared);
};

/** A project holding the Captain, with the local person registered. */
const seed = Effect.gen(function* () {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* A2ALedger;
  yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES (${person.id}, 1, ${at})`;
  yield* sql`INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at) VALUES (${person.id}, 'server', '', 'owner', ${at}, ${at})`;
  yield* ledger.ensureProject({ projectId: projectId, createdAt: at });
  yield* ledger.appendEvents({
    commandId: CommCommandId.make("join:alerts"),
    projectId,
    acceptedAt: at,
    events: [
      {
        kind: "participant.joined",
        sender: null,
        receiver: captain.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: captain },
        createdAt: at,
      },
    ],
  });
});

const failure = {
  class: "provider_error" as const,
  message: "OAuth token has expired",
  code: null,
  retryable: false,
};
const reviewCrew = {
  id: "crew:review",
  projectId,
  captainParticipantId: captain.id,
  captainThreadId: captain.threadId,
  displayName: "Review",
};

it("network failures alone do not need the person", () => {
  assert.isTrue(needsHumanForCrewFailure(failure));
  assert.isTrue(
    needsHumanForCrewFailure({ ...failure, class: "permission_error", message: "denied" }),
  );
  assert.isFalse(needsHumanForCrewFailure({ ...failure, message: "Cannot reach API server" }));
  assert.isFalse(needsHumanForCrewFailure(null));
});

it.effect(
  "a Crew's failures fold into its own alert, never into the Captain's ask, and replies reach the Captain",
  () =>
    Effect.gen(function* () {
      const deliveries = yield* Ref.make<ReadonlyArray<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* seed;
        const inbox = yield* A2AHumanInbox;
        const worker = yield* A2ADeliveryWorker;
        const send = yield* A2ASendService;
        const alert = yield* makeCrewFailureAlert;
        const ask = yield* send.send({
          commandId: CommCommandId.make("ask:alerts"),
          senderThreadId: captain.threadId,
          to: person.id,
          message: "Choose the release date",
          expectReply: true,
          intent: "Release date",
          urgency: "blocking",
          acceptedAt: at,
        });
        const critic = { instance: reviewCrew, seatName: "critic", runId: "run:critic", failure };
        yield* alert(critic);
        yield* alert(critic);
        yield* alert({
          ...critic,
          seatName: "builder",
          runId: "run:builder",
          failure: { ...failure, class: "permission_error" as const },
        });
        // Another Crew under the same Captain gets its own alert.
        yield* alert({
          instance: { ...reviewCrew, id: "crew:release", displayName: "Release" },
          seatName: "critic",
          runId: "run:release-critic",
          failure,
        });
        yield* worker.drain;

        const items = yield* inbox.list(person.id);
        assert.lengthOf(items, 3);
        const own = items.find((item) => item.exchangeId === ask.exchangeId);
        assert.equal(own?.message, "Choose the release date");
        const review = items.filter((item) => item.message.includes('Crew "Review"'));
        assert.lengthOf(review, 1);
        const alertItem = review[0]!;
        assert.equal(alertItem.urgency, "blocking");
        assert.include(alertItem.message, 'seat "critic"');
        assert.include(alertItem.message, 'seat "builder"');
        // The replayed run appended nothing.
        assert.equal(alertItem.message.split('seat "critic"').length, 2);
        assert.isTrue(items.some((item) => item.message.includes('Crew "Release"')));

        yield* inbox.answer({
          commandId: CommCommandId.make("answer:alerts"),
          personId: person.id,
          exchangeId: alertItem.exchangeId,
          message: "Signed in. Please retry.",
          acceptedAt: at,
        });
        yield* worker.drain;
        const replies = yield* Ref.get(deliveries);
        assert.lengthOf(replies, 1);
        assert.equal(replies[0]!.receiverId, captain.id);
        assert.equal(replies[0]!.exchangeId, alertItem.exchangeId);
        assert.equal(replies[0]!.message, "Signed in. Please retry.");

        // A replay after the answer reopens nothing; a new failure opens a fresh alert.
        yield* alert(critic);
        const afterReplay = yield* inbox.list(person.id);
        assert.isFalse(afterReplay.some((item) => item.message.includes('Crew "Review"')));
        yield* alert({ ...critic, runId: "run:critic-again" });
        yield* worker.drain;
        const next = (yield* inbox.list(person.id)).filter((item) =>
          item.message.includes('Crew "Review"'),
        );
        assert.lengthOf(next, 1);
        assert.notEqual(next[0]!.exchangeId, alertItem.exchangeId);
        assert.notInclude(next[0]!.message, 'seat "builder"');
        // The Captain's own ask never gained a platform notice.
        const untouched = (yield* inbox.list(person.id)).find(
          (item) => item.exchangeId === ask.exchangeId,
        );
        assert.equal(untouched?.message, "Choose the release date");

        // With an alert open, the Captain can still open a new ask of its own.
        yield* inbox.answer({
          commandId: CommCommandId.make("answer:release-date"),
          personId: person.id,
          exchangeId: ask.exchangeId!,
          message: "Friday.",
          acceptedAt: at,
        });
        const second = yield* send.send({
          commandId: CommCommandId.make("ask:alerts-second"),
          senderThreadId: captain.threadId,
          to: person.id,
          message: "Which branch ships?",
          expectReply: true,
          intent: "Release branch",
          urgency: "soon",
          acceptedAt: at,
        });
        assert.isFalse(second.joinedExistingExchange);
        assert.notEqual(second.exchangeId, next[0]!.exchangeId);
      }).pipe(Effect.provide(makeTestLayer(deliveries)));
    }).pipe(Effect.scoped),
);

it.effect("the alert reaches the Inbox on its own, with the worker running as its daemon", () =>
  Effect.gen(function* () {
    const deliveries = yield* Ref.make<ReadonlyArray<AgentDeliveryInput>>([]);
    yield* Effect.gen(function* () {
      yield* seed;
      const inbox = yield* A2AHumanInbox;
      const worker = yield* A2ADeliveryWorker;
      const send = yield* A2ASendService;
      const alert = yield* makeCrewFailureAlert;
      // Settle the daemon first: deliver one ask and wait for it, so the worker is idle and
      // waiting to be woken before the alert commits. Nothing below calls drain.
      const first = yield* worker.subscribeMilestones;
      yield* send.send({
        commandId: CommCommandId.make("ask:daemon"),
        senderThreadId: captain.threadId,
        to: person.id,
        message: "Choose the release date",
        expectReply: true,
        intent: "Release date",
        urgency: "blocking",
        acceptedAt: at,
      });
      yield* worker.notify;
      yield* Stream.runHead(first);
      // An end-to-end smoke check, not the regression test: the worker's wake queue can hold a
      // spare wake, so this passes even if the alert never wakes the worker. The wake-count test
      // below ("an alert wakes the delivery worker once it commits") is the regression test.
      const next = yield* worker.subscribeMilestones;
      yield* alert({ instance: reviewCrew, seatName: "critic", runId: "run:daemon", failure });
      yield* Stream.runHead(next);
      const items = yield* inbox.list(person.id);
      assert.isTrue(items.some((item) => item.message.includes('Crew "Review"')));
    }).pipe(Effect.provide(makeTestLayer(deliveries, { daemon: true })));
  }).pipe(Effect.scoped),
);

it.effect("an alert wakes the delivery worker once it commits, and a replay wakes nothing", () =>
  Effect.gen(function* () {
    const wakes = yield* Ref.make(0);
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const ledger = ledgerLayer.pipe(Layer.provide(database));
    // The ledger PubSub never wakes the worker, so the alert must: count the wakes it sends.
    const worker = Layer.mock(A2ADeliveryWorker)({ notify: Ref.update(wakes, (n) => n + 1) });
    yield* Effect.gen(function* () {
      yield* seed;
      const alert = yield* makeCrewFailureAlert;
      const critic = { instance: reviewCrew, seatName: "critic", runId: "run:wake", failure };
      yield* alert(critic);
      assert.equal(yield* Ref.get(wakes), 1);
      yield* alert(critic);
      assert.equal(yield* Ref.get(wakes), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(database, ledger, worker, sharedThreadsLayer.pipe(Layer.provide(database))),
      ),
    );
  }),
);

it.effect(
  "where more than one person writes to the Captain's thread, the alert asks everyone here",
  () =>
    Effect.gen(function* () {
      const deliveries = yield* Ref.make<ReadonlyArray<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES ('human:priya', 0, ${at})`;
        yield* sql`INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at) VALUES ('human:priya', 'server', '', 'collaborator', ${at}, ${at})`;
        const alert = yield* makeCrewFailureAlert;
        yield* alert({ instance: reviewCrew, seatName: "critic", runId: "run:shared", failure });
        const asked = yield* sql<{ readonly receiver_id: string }>`
        SELECT receiver_id FROM j5_a2a_exchange WHERE sender_id = ${captain.id}
      `;
        assert.deepStrictEqual(asked, [{ receiver_id: EVERYONE_HERE_PERSON_ID }]);
      }).pipe(Effect.provide(makeTestLayer(deliveries)));
    }),
);
