import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { FetchHttpClient } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import {
  A2ADeliveryTransport,
  live as deliveryTransportLive,
  type AgentDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  ExchangeId,
  LedgerProjectId,
  ParticipantId,
  type AgentParticipant,
  type HumanParticipant,
} from "./contracts.ts";

const firstPerson: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:person-one"),
};
const secondPerson: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:person-two"),
};

const makeTestLayer = (deliveries: Ref.Ref<ReadonlyArray<AgentDeliveryInput>>) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const liveTransport = deliveryTransportLive.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(PeerRegistryService)({})),
    Layer.provide(database),
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
        deliverPeer: () => Effect.die("peer delivery is not under test"),
        deliverHuman: production.deliverHuman,
      });
    }),
  ).pipe(Layer.provide(liveTransport));
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  return Layer.mergeAll(database, ledger, send, inbox, worker);
};

it.effect(
  "ranks open cross-project exchanges and projects a second person's answer into A4-owned history",
  () =>
    Effect.gen(function* () {
      const deliveries = yield* Ref.make<ReadonlyArray<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        const send = yield* A2ASendService;
        const inbox = yield* A2AHumanInbox;
        const worker = yield* A2ADeliveryWorker;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
          VALUES
            (${firstPerson.id}, 1, '2026-08-23T00:00:00.000Z'),
            (${secondPerson.id}, 0, '2026-08-23T00:00:00.000Z')
        `;
        yield* sql`
        INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at)
        VALUES
          (${firstPerson.id}, 'server', '', 'owner', ${"2026-08-23T00:00:00.000Z"}, ${"2026-08-23T00:00:00.000Z"}),
          (${secondPerson.id}, 'server', '', 'collaborator', ${"2026-08-23T00:00:00.000Z"}, ${"2026-08-23T00:00:00.000Z"})
      `;
        assert.equal(yield* inbox.resolvePersonId(), firstPerson.id);
        assert.equal(yield* inbox.resolvePersonId(secondPerson.id), secondPerson.id);
        const unregistered = yield* Effect.flip(
          inbox.resolvePersonId(ParticipantId.make("human:missing-person")),
        );
        assert.equal(unregistered._tag, "A2AParticipantNotFoundError");

        const open = Effect.fn("test.j5.a2a.humanInbox.open")(function* (input: {
          readonly suffix: string;
          readonly person: HumanParticipant;
          readonly intent: string;
          readonly urgency: "blocking" | "soon" | "fyi";
          readonly openedAt: string;
        }) {
          const projectId = LedgerProjectId.make(`project:human-inbox:${input.suffix}`);
          const agent: AgentParticipant = {
            kind: "agent",
            id: ParticipantId.make(`agent:human-inbox:${input.suffix}`),
            threadId: ThreadId.make(`thread:human-inbox:${input.suffix}`),
          };
          yield* ledger.ensureProject({ projectId: projectId, createdAt: input.openedAt });
          yield* ledger.appendEvents({
            commandId: CommCommandId.make(`command:human-inbox:join:${input.suffix}`),
            projectId,
            acceptedAt: input.openedAt,
            events: [
              {
                kind: "participant.joined",
                sender: null,
                receiver: agent.id,
                exchangeId: null,
                correlationId: null,
                payload: { participant: agent },
                createdAt: input.openedAt,
              },
            ],
          });
          const sent = yield* send.send({
            commandId: CommCommandId.make(`command:human-inbox:ask:${input.suffix}`),
            senderThreadId: agent.threadId,
            to: input.person.id,
            message: `Question ${input.suffix}`,
            expectReply: true,
            intent: input.intent,
            urgency: input.urgency,
            acceptedAt: input.openedAt,
          });
          yield* worker.drain;
          return { agent, projectId, exchangeId: sent.exchangeId! };
        });

        yield* open({
          suffix: "fyi-old",
          person: firstPerson,
          intent: "Old FYI persists",
          urgency: "fyi",
          openedAt: "2020-01-01T00:00:00.000Z",
        });
        yield* open({
          suffix: "soon",
          person: firstPerson,
          intent: "Soon request",
          urgency: "soon",
          openedAt: "2026-08-23T11:00:00.000Z",
        });
        yield* open({
          suffix: "blocking-old",
          person: firstPerson,
          intent: "Older blocking request",
          urgency: "blocking",
          openedAt: "2026-08-22T11:00:00.000Z",
        });
        yield* open({
          suffix: "blocking-new",
          person: firstPerson,
          intent: "Newer blocking request",
          urgency: "blocking",
          openedAt: "2026-08-23T12:00:00.000Z",
        });
        const second = yield* open({
          suffix: "second-person",
          person: secondPerson,
          intent: "Second-person roundtrip",
          urgency: "blocking",
          openedAt: "2026-08-23T13:00:00.000Z",
        });

        const humanMemberships = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM j5_a2a_membership
          WHERE participant_kind = 'human' OR participant_id LIKE 'human:%'
        `;
        assert.deepStrictEqual(humanMemberships, [{ count: 0 }]);

        const firstInbox = yield* inbox.list(firstPerson.id);
        assert.deepStrictEqual(
          firstInbox.map((item) => item.intent),
          ["Older blocking request", "Newer blocking request", "Soon request", "Old FYI persists"],
        );
        assert.deepStrictEqual(new Set(firstInbox.map((item) => item.projectId)).size, 4);
        assert.deepStrictEqual(
          firstInbox.map((item) => item.senderThreadId),
          [
            ThreadId.make("thread:human-inbox:blocking-old"),
            ThreadId.make("thread:human-inbox:blocking-new"),
            ThreadId.make("thread:human-inbox:soon"),
            ThreadId.make("thread:human-inbox:fyi-old"),
          ],
        );
        assert.deepStrictEqual(
          (yield* inbox.list(secondPerson.id)).map((item) => item.intent),
          ["Second-person roundtrip"],
        );
        const retiredGlobal = yield* Effect.flip(inbox.list(ParticipantId.make("human:global")));
        assert.equal(retiredGlobal._tag, "A2AHumanPersonIdError");

        const senderCleared = yield* open({
          suffix: "sender-cleared",
          person: firstPerson,
          intent: "Resolved in the agent thread",
          urgency: "soon",
          openedAt: "2026-08-23T13:30:00.000Z",
        });
        const unknownClear = yield* Effect.flip(
          send.clearOwnAsk({
            commandId: CommCommandId.make("command:human-inbox:clear:unknown"),
            senderThreadId: senderCleared.agent.threadId,
            exchangeId: ExchangeId.make("exchange:human-inbox:missing"),
            acceptedAt: "2026-08-23T13:40:00.000Z",
          }),
        );
        assert.equal(unknownClear._tag, "A2AClearOwnAskUnknownExchangeError");
        assert.include(unknownClear.message, "no agent-facing own-open-asks read");
        assert.include(unknownClear.message, "original j5_send_message result");
        assert.include(unknownClear.message, "do not retry this unknown id");
        const mismatchedClear = yield* Effect.flip(
          send.clearOwnAsk({
            commandId: CommCommandId.make("command:human-inbox:clear:mismatch"),
            senderThreadId: second.agent.threadId,
            exchangeId: senderCleared.exchangeId,
            acceptedAt: "2026-08-23T13:41:00.000Z",
          }),
        );
        assert.equal(mismatchedClear._tag, "A2AClearOwnAskSenderMismatchError");
        assert.include(
          mismatchedClear.message,
          `Do not retry j5_clear_own_ask for exchange ${senderCleared.exchangeId} from this thread`,
        );
        assert.include(mismatchedClear.message, "other exchanges are unaffected");
        const collidingCommandId = CommCommandId.make(
          "command:human-inbox:clear:colliding-receipt",
        );
        yield* send.send({
          commandId: collidingCommandId,
          senderThreadId: senderCleared.agent.threadId,
          to: second.agent.id,
          message: "An unrelated agent send reserved this command id.",
          acceptedAt: "2026-08-23T13:41:30.000Z",
        });
        const collidingClear = yield* Effect.flip(
          send.clearOwnAsk({
            commandId: collidingCommandId,
            senderThreadId: senderCleared.agent.threadId,
            exchangeId: senderCleared.exchangeId,
            acceptedAt: "2026-08-23T13:41:31.000Z",
          }),
        );
        assert.equal(collidingClear._tag, "A2AClearOwnAskCommandConflictError");
        assert.include(collidingClear.message, "already bound to a different request");
        assert.include(collidingClear.message, "same clear replays its original success");
        assert.include(collidingClear.message, "unique client_request_id");
        assert.include(
          (yield* inbox.list(firstPerson.id)).map((item) => item.intent),
          "Resolved in the agent thread",
        );
        const collidingEvents = yield* sql<{ readonly kind: string }>`
          SELECT kind
          FROM j5_a2a_comm_event
          WHERE command_id = ${collidingCommandId}
          ORDER BY seq
        `;
        assert.deepStrictEqual(collidingEvents, [{ kind: "message.sent" }]);
        const clearCommand = {
          commandId: CommCommandId.make("command:human-inbox:clear:sender-cleared"),
          senderThreadId: senderCleared.agent.threadId,
          exchangeId: senderCleared.exchangeId,
          acceptedAt: "2026-08-23T13:42:00.000Z",
        } as const;
        const cleared = yield* send.clearOwnAsk(clearCommand);
        const replayedClear = yield* send.clearOwnAsk({
          ...clearCommand,
          acceptedAt: "2026-08-23T13:43:00.000Z",
        });
        assert.deepStrictEqual(replayedClear, cleared);
        assert.equal(replayedClear.closedAt, clearCommand.acceptedAt);
        assert.equal(cleared.closureKind, "sender-cleared");
        assert.notInclude(
          (yield* inbox.list(firstPerson.id)).map((item) => item.intent),
          "Resolved in the agent thread",
        );
        assert.notInclude(
          (yield* inbox.list(firstPerson.id, "answered")).map((item) => item.intent),
          "Resolved in the agent thread",
        );
        const clearedProjection = yield* sql<{
          readonly status: string;
          readonly terminal_disposition: string | null;
        }>`
          SELECT status, terminal_disposition
          FROM j5_a2a_human_inbox
          WHERE exchange_id = ${senderCleared.exchangeId}
        `;
        assert.deepStrictEqual(clearedProjection, [
          { status: "dropped", terminal_disposition: "sender-cleared" },
        ]);
        const clearedEvents = yield* sql<{
          readonly kind: string;
          readonly payload: string;
        }>`
          SELECT kind, payload
          FROM j5_a2a_comm_event
          WHERE command_id = ${clearCommand.commandId}
        `;
        assert.deepStrictEqual(
          clearedEvents.map((event) => ({ ...event, payload: JSON.parse(event.payload) })),
          [{ kind: "exchange.closed", payload: { closureKind: "sender-cleared" } }],
        );
        const alreadyClosedClear = yield* Effect.flip(
          send.clearOwnAsk({
            ...clearCommand,
            commandId: CommCommandId.make("command:human-inbox:clear:already-closed"),
          }),
        );
        assert.equal(alreadyClosedClear._tag, "A2AClearOwnAskAlreadyClosedError");
        assert.equal(
          alreadyClosedClear.message,
          `Exchange ${senderCleared.exchangeId} is already closed; j5_clear_own_ask made no change.`,
        );
        assert.notInclude(alreadyClosedClear.message, "send_message");

        const exactAnswer = "  First line\nSecond line  ";
        const answerCommand = {
          commandId: CommCommandId.make("command:human-inbox:answer:second-person"),
          personId: secondPerson.id,
          exchangeId: second.exchangeId,
          message: exactAnswer,
          acceptedAt: "2026-08-23T14:00:00.000Z",
        } as const;
        const answered = yield* inbox.answer(answerCommand);
        const replayed = yield* inbox.answer(answerCommand);
        yield* worker.drain;

        assert.equal(answered.exchangeState, "closed");
        assert.deepStrictEqual(replayed, answered);
        assert.deepStrictEqual(yield* inbox.list(secondPerson.id), []);
        assert.deepStrictEqual(
          (yield* inbox.list(secondPerson.id, "answered")).map((item) => item.intent),
          ["Second-person roundtrip"],
        );
        assert.lengthOf(yield* inbox.list(firstPerson.id), 4);
        const answerDeliveries = (yield* Ref.get(deliveries)).filter(
          (delivery) => delivery.messageId === answered.messageId,
        );
        assert.lengthOf(answerDeliveries, 1);
        assert.equal(answerDeliveries[0]?.senderId, secondPerson.id);
        assert.equal(answerDeliveries[0]?.receiverId, second.agent.id);
        assert.equal(answerDeliveries[0]?.message, exactAnswer);
        assert.equal(answerDeliveries[0]?.exchangeRole, "reply");

        const durable = yield* sql<{
          readonly message_text: string;
          readonly status: string;
          readonly terminal_disposition: string | null;
        }>`
          SELECT delivery.message_text, inbox.status, inbox.terminal_disposition
          FROM j5_a2a_delivery AS delivery
          JOIN j5_a2a_human_inbox AS inbox
            ON inbox.project_id = delivery.project_id
           AND inbox.exchange_id = delivery.exchange_id
          WHERE delivery.message_id = ${answered.messageId}
        `;
        assert.deepStrictEqual(durable, [
          {
            message_text: exactAnswer,
            status: "answered",
            terminal_disposition: "answered",
          },
        ]);
        const answerBytes = yield* sql<{
          readonly actual: string;
          readonly expected: string;
        }>`
          SELECT hex(message_text) AS actual, hex(${exactAnswer}) AS expected
          FROM j5_a2a_delivery
          WHERE message_id = ${answered.messageId}
        `;
        assert.lengthOf(answerBytes, 1);
        assert.equal(answerBytes[0]?.actual, answerBytes[0]?.expected);
        const answerEvents = yield* sql<{
          readonly kind: string;
          readonly payload: string;
          readonly receiver: string;
          readonly sender: string;
        }>`
          SELECT kind, sender, receiver, payload
          FROM j5_a2a_comm_event
          WHERE command_id = ${answerCommand.commandId}
          ORDER BY seq
        `;
        assert.deepStrictEqual(
          answerEvents.map((event) => ({ ...event, payload: JSON.parse(event.payload) })),
          [
            {
              kind: "message.sent",
              sender: secondPerson.id,
              receiver: second.agent.id,
              payload: {
                messageId: answered.messageId,
                text: exactAnswer,
                originProjectId: second.projectId,
                receiverProjectId: second.projectId,
                exchangeRole: "reply",
                envelopeChannel: "peer",
              },
            },
            {
              kind: "exchange.closed",
              sender: secondPerson.id,
              receiver: second.agent.id,
              payload: { replyMessageId: answered.messageId },
            },
          ],
        );
      }).pipe(Effect.provide(makeTestLayer(deliveries)));
    }),
);
