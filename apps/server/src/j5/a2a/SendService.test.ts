import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { A2A_MESSAGE_TEXT_MAX_CHARS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  AgentParticipant,
  CommCommandId,
  ExchangeId,
  LedgerProjectId,
  ParticipantId,
} from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const ledger = ledgerLayer.pipe(Layer.provide(database));
const send = sendLayer.pipe(
  Layer.provide(peerDirectoryNoneLayer),
  Layer.provide(ledger),
  Layer.provide(database),
);
const testLayer = Layer.mergeAll(database, ledger, send);
const encodeAgentParticipantPayload = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ participant: AgentParticipant })),
);

const sender: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:sender"),
  threadId: ThreadId.make("thread:sender"),
};
const receiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:receiver"),
  threadId: ThreadId.make("thread:receiver"),
};
const person = {
  kind: "human" as const,
  id: ParticipantId.make("human:send-person"),
};

const registerPerson = Effect.fn("test.j5.a2a.registerPerson")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES (${person.id}, 1, ${timestamp})
  `;
});

const setupSameProject = Effect.fn("test.j5.a2a.setupSameProject")(function* () {
  yield* runJ5A2AMigrations();
  const ledgerService = yield* A2ALedger;
  const projectId = LedgerProjectId.make("project:exchange");
  yield* ledgerService.ensureProject({ projectId: projectId, createdAt: timestamp });
  for (const [index, participant] of [sender, receiver].entries()) {
    yield* ledgerService.append({
      commandId: CommCommandId.make(`command:join:${index}`),
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participant.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  }
  return projectId;
});

it.effect("opens once per sender-receiver pair, joins follow-ups, and one reply closes", () =>
  Effect.gen(function* () {
    const projectId = yield* setupSameProject();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;

    const first = yield* service.send({
      commandId: CommCommandId.make("command:exchange:first"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Can you verify delivery?",
      expectReply: true,
      intent: "Verify the delivery path",
      acceptedAt: timestamp,
    });
    const followup = yield* service.send({
      commandId: CommCommandId.make("command:exchange:followup"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Please include the crash window.",
      expectReply: true,
      acceptedAt: timestamp,
    });
    assert.equal(followup.exchangeId, first.exchangeId);
    assert.isTrue(followup.joinedExistingExchange);

    const reply = yield* service.send({
      commandId: CommCommandId.make("command:exchange:reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "Verified.",
      exchangeId: first.exchangeId!,
      acceptedAt: timestamp,
    });
    assert.equal(reply.exchangeState, "closed");
    assert.deepStrictEqual(
      yield* service.send({
        commandId: CommCommandId.make("command:exchange:reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "Verified.",
        exchangeId: first.exchangeId!,
        acceptedAt: timestamp,
      }),
      reply,
      "the same-project reply command replays its original durable sequence",
    );
    assert.deepStrictEqual(
      yield* service.send({
        commandId: CommCommandId.make("command:exchange:first"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Can you verify delivery?",
        expectReply: true,
        intent: "Verify the delivery path",
        acceptedAt: timestamp,
      }),
      first,
      "the opening command replays its original result after closure",
    );
    assert.deepStrictEqual(
      yield* service.send({
        commandId: CommCommandId.make("command:exchange:followup"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Please include the crash window.",
        expectReply: true,
        acceptedAt: timestamp,
      }),
      followup,
      "the follow-up command replays its original result after closure",
    );

    const rows = yield* sql<{ readonly kind: string; readonly count: number }>`
      SELECT kind, COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE project_id = ${projectId}
        AND kind IN ('exchange.opened', 'message.sent', 'exchange.closed')
      GROUP BY kind
      ORDER BY kind
    `;
    assert.deepStrictEqual(rows, [
      { kind: "exchange.closed", count: 1 },
      { kind: "exchange.opened", count: 1 },
      { kind: "message.sent", count: 3 },
    ]);

    const closedError = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:exchange:second-reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "A duplicate reply.",
        exchangeId: first.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(closedError._tag, "A2AExchangeNotOpenError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a second reply when an accepted reply exists on an open exchange", () =>
  Effect.gen(function* () {
    yield* setupSameProject();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const opened = yield* service.send({
      commandId: CommCommandId.make("command:already-answered:open"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Can you answer once?",
      expectReply: true,
      intent: "Exercise the one-reply guard",
      acceptedAt: timestamp,
    });
    yield* service.send({
      commandId: CommCommandId.make("command:already-answered:first-reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "This is the accepted reply.",
      exchangeId: opened.exchangeId!,
      acceptedAt: timestamp,
    });

    // Reconstruct the defensive state: the reply is durable while the exchange projection is open.
    yield* sql`
      UPDATE j5_a2a_exchange
      SET status = 'open', closed_seq = NULL
      WHERE exchange_id = ${opened.exchangeId!}
    `;

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:already-answered:second-reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "This duplicate must be refused.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(error._tag, "A2AExchangeAlreadyAnsweredError");

    const replies = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_delivery
      WHERE exchange_id = ${opened.exchangeId!}
        AND exchange_role = 'reply'
    `;
    assert.deepStrictEqual(replies, [{ count: 1 }]);
  }).pipe(Effect.provide(testLayer)),
);

const setupTwoProjects = Effect.fn("test.j5.a2a.setupTwoProjects")(function* () {
  yield* runJ5A2AMigrations();
  const ledgerService = yield* A2ALedger;
  const askerProjectId = LedgerProjectId.make("project:exchange:asker");
  const replierProjectId = LedgerProjectId.make("project:exchange:replier");
  for (const [projectId, participant] of [
    [askerProjectId, sender],
    [replierProjectId, receiver],
  ] as const) {
    yield* ledgerService.ensureProject({ projectId: projectId, createdAt: timestamp });
    yield* ledgerService.append({
      commandId: CommCommandId.make(`command:join:${participant.id}`),
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participant.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  }
  return { askerProjectId, replierProjectId };
});

/** Every event of one ledger in order; `readEvents` fails on a sequence gap. */
const ledgerEvents = Effect.fn("test.j5.a2a.ledgerEvents")(function* (projectId: LedgerProjectId) {
  const page = yield* (yield* A2ALedger).readEvents({
    projectId,
    cursor: { afterSeq: 0 },
    limit: 100,
  });
  assert.isTrue(page.complete);
  assert.deepStrictEqual(
    page.events.map((event) => event.seq),
    page.events.map((_, index) => index + 1),
  );
  return page.events.map((event) => event.kind);
});

it.effect("one reply from another project closes the asker's Exchange in the asker's ledger", () =>
  Effect.gen(function* () {
    const { askerProjectId, replierProjectId } = yield* setupTwoProjects();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;

    const opened = yield* service.send({
      commandId: CommCommandId.make("command:cross:open"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "What is the incident's status?",
      expectReply: true,
      intent: "Learn the incident status",
      acceptedAt: timestamp,
    });
    const followup = yield* service.send({
      commandId: CommCommandId.make("command:cross:followup"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Include the affected region.",
      exchangeId: opened.exchangeId!,
      acceptedAt: timestamp,
    });
    assert.equal(followup.exchangeId, opened.exchangeId);
    assert.isTrue(followup.joinedExistingExchange);
    assert.equal(followup.exchangeState, "open");

    const reply = yield* service.send({
      commandId: CommCommandId.make("command:cross:reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "Mitigated in eu-west.",
      exchangeId: opened.exchangeId!,
      acceptedAt: timestamp,
    });
    assert.equal(reply.exchangeId, opened.exchangeId);
    assert.equal(reply.exchangeState, "closed");
    assert.isFalse(reply.joinedExistingExchange);

    assert.deepStrictEqual(yield* ledgerEvents(askerProjectId), [
      "participant.joined",
      "exchange.opened",
      "message.sent",
      "message.sent",
      "exchange.closed",
    ]);
    assert.deepStrictEqual(yield* ledgerEvents(replierProjectId), [
      "participant.joined",
      "message.sent",
    ]);
    assert.equal(reply.durableAtSeq, 2);
    assert.deepStrictEqual(
      yield* sql<{
        readonly project_id: string;
        readonly status: string;
        readonly closed_seq: number;
      }>`
        SELECT project_id, status, closed_seq
        FROM j5_a2a_exchange
        WHERE exchange_id = ${opened.exchangeId}
      `,
      [{ project_id: askerProjectId, status: "closed", closed_seq: 5 }],
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly project_id: string; readonly receiver_project_id: string }>`
        SELECT project_id, receiver_project_id
        FROM j5_a2a_delivery
        WHERE exchange_id = ${opened.exchangeId} AND exchange_role = 'reply'
      `,
      [{ project_id: replierProjectId, receiver_project_id: askerProjectId }],
    );

    const secondReply = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:cross:second-reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "This duplicate must be refused.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(secondReply._tag, "A2AExchangeNotOpenError");
    const lateFollowup = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:cross:late-followup"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This follow-up is too late.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(lateFollowup._tag, "A2AExchangeNotOpenError");
    assert.lengthOf(yield* ledgerEvents(askerProjectId), 5);
    assert.lengthOf(yield* ledgerEvents(replierProjectId), 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replaying a reply to another project writes nothing to either ledger", () =>
  Effect.gen(function* () {
    const { askerProjectId, replierProjectId } = yield* setupTwoProjects();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const opened = yield* service.send({
      commandId: CommCommandId.make("command:cross-replay:open"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Can this reply be replayed?",
      expectReply: true,
      intent: "Exercise cross-project reply replay",
      acceptedAt: timestamp,
    });
    const replyInput = {
      commandId: CommCommandId.make("command:cross-replay:reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "This reply is already durable.",
      exchangeId: opened.exchangeId!,
      acceptedAt: timestamp,
    } as const;
    const reply = yield* service.send(replyInput);
    const written = Effect.gen(function* () {
      return {
        asker: yield* ledgerEvents(askerProjectId),
        replier: yield* ledgerEvents(replierProjectId),
        receipts: (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_comm_command_receipt
        `)[0]?.count,
        deliveries: (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_delivery
        `)[0]?.count,
      };
    });
    const before = yield* written;

    assert.deepStrictEqual(yield* service.send(replyInput), reply);
    assert.deepStrictEqual(yield* written, before);
    assert.deepStrictEqual(before.asker.slice(-1), ["exchange.closed"]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a second reply to another project while the closure is missing", () =>
  Effect.gen(function* () {
    yield* setupTwoProjects();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const opened = yield* service.send({
      commandId: CommCommandId.make("command:cross-answered:open"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Only one reply may land.",
      expectReply: true,
      intent: "Exercise the one-reply rule across projects",
      acceptedAt: timestamp,
    });
    yield* service.send({
      commandId: CommCommandId.make("command:cross-answered:first-reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "This is the accepted reply.",
      exchangeId: opened.exchangeId!,
      acceptedAt: timestamp,
    });
    // Reconstruct the defensive state: the reply is durable while the exchange projection is open.
    yield* sql`
      UPDATE j5_a2a_exchange
      SET status = 'open', closed_seq = NULL
      WHERE exchange_id = ${opened.exchangeId!}
    `;

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:cross-answered:second-reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "This duplicate must be refused.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(error._tag, "A2AExchangeAlreadyAnsweredError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("validates intent and human-only urgency at exchange open", () =>
  Effect.gen(function* () {
    yield* setupSameProject();
    const service = yield* A2ASendService;
    yield* registerPerson();

    const missingIntent = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:missing-intent"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Question",
        expectReply: true,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(missingIntent._tag, "A2AIntentRequiredError");

    const tooLong = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:too-long"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "x".repeat(A2A_MESSAGE_TEXT_MAX_CHARS + 1),
        acceptedAt: timestamp,
      }),
    );
    assert.equal(tooLong._tag, "A2AMessageTooLongError", "nothing a peer would refuse is recorded");

    const missingUrgency = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:missing-urgency"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "Human question",
        expectReply: true,
        intent: "Obtain a human ruling",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(missingUrgency._tag, "A2AUrgencyRequiredError");

    const wrongUrgency = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:wrong-urgency"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Agent question",
        expectReply: true,
        intent: "Ask an agent",
        urgency: "soon",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(wrongUrgency._tag, "A2AUrgencyNotAcceptedError");

    const oneShotUrgency = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:one-shot-urgency"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "One-shot human message",
        urgency: "fyi",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(oneShotUrgency._tag, "A2AHumanAskOrReplyRequiredError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses plain human sends while allowing human asks and replies", () =>
  Effect.gen(function* () {
    const projectId = yield* setupSameProject();
    yield* registerPerson();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;

    const plainSend = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:human-plain-send"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "This must not become ghost traffic.",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(plainSend._tag, "A2AHumanAskOrReplyRequiredError");
    assert.equal(
      plainSend.message,
      `A plain send to human participant ${person.id} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id. If nobody needs to act, say it in your own thread instead.`,
    );
    const rejectedWrites = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE command_id = 'command:human-plain-send'
    `;
    assert.deepStrictEqual(rejectedWrites, [{ count: 0 }]);

    const ask = yield* service.send({
      commandId: CommCommandId.make("command:human-ask"),
      senderThreadId: sender.threadId,
      to: person.id,
      message: "Please decide this visible question.",
      expectReply: true,
      intent: "Obtain a decision",
      urgency: "soon",
      acceptedAt: timestamp,
    });
    assert.equal(ask.exchangeState, "open");

    const explicitFollowup = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:human-explicit-followup"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "This must not follow up on the human ask.",
        exchangeId: ask.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(explicitFollowup._tag, "A2AHumanFollowupNotAllowedError");

    const implicitFollowup = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:human-implicit-followup"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "This also must not follow up on the human ask.",
        expectReply: true,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(implicitFollowup._tag, "A2AHumanFollowupNotAllowedError");
    assert.equal(
      implicitFollowup.message,
      `A follow-up to human participant ${person.id} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id; after an ask is open, wait for its reply, or j5_clear_own_ask on the open exchange and re-ask with the combined content. If nobody needs to act, say it in your own thread instead.`,
    );
    const followupWrites = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE command_id IN ('command:human-explicit-followup', 'command:human-implicit-followup')
    `;
    assert.deepStrictEqual(followupWrites, [{ count: 0 }]);

    const inboundExchangeId = ExchangeId.make("exchange:human-inbound");
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:human-inbound"),
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "exchange.opened",
        sender: person.id,
        receiver: sender.id,
        exchangeId: inboundExchangeId,
        correlationId: null,
        payload: { intent: "Request a reply", urgency: "soon" },
        createdAt: timestamp,
      },
    });
    const reply = yield* service.send({
      commandId: CommCommandId.make("command:human-reply"),
      senderThreadId: sender.threadId,
      to: person.id,
      message: "Here is the requested reply.",
      exchangeId: inboundExchangeId,
      acceptedAt: timestamp,
    });
    assert.equal(reply.exchangeState, "closed");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses an ask to a person's inbox from a shared conversation", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const projectId = yield* setupSameProject();
    yield* registerPerson();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    // A guest holds Collaborate on the sender's thread, and only View on the receiver's.
    yield* sql`
      INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at, kind, display_name)
      VALUES ('human:guest', 0, ${timestamp}, 'guest', 'Priya')
    `;
    for (const [threadId, level] of [
      [sender.threadId, "collaborate"],
      [receiver.threadId, "view"],
    ] as const) {
      yield* sql`
        INSERT INTO j5_a2a_person_grant (
          person_id, target_kind, target_id, level, created_at, updated_at
        ) VALUES ('human:guest', 'thread', ${threadId}, ${level}, ${timestamp}, ${timestamp})
      `;
    }
    const ask = (commandId: string, senderThreadId: ThreadId) =>
      service.send({
        commandId: CommCommandId.make(commandId),
        senderThreadId,
        to: person.id,
        message: "Should I go ahead?",
        expectReply: true,
        intent: "Obtain a decision",
        urgency: "soon",
        acceptedAt: timestamp,
      });

    const refused = yield* Effect.flip(ask("command:shared-ask", sender.threadId));
    assert.equal(refused._tag, "A2ASharedConversationAskError");
    assert.equal(
      refused.message,
      "This thread is a shared conversation, so an ask to a person's inbox is refused. Ask in this thread instead and name the person you are asking. Everyone on the thread sees the question and the answer.",
    );
    // A plain send is told the same, not to open an ask.
    const plain = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:shared-plain"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "FYI.",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(plain._tag, "A2ASharedConversationAskError");
    const writes = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_comm_event
      WHERE command_id IN ('command:shared-ask', 'command:shared-plain')
    `;
    assert.deepStrictEqual(writes, [{ count: 0 }]);

    // A thread a guest can only read is not a shared conversation: its agent asks as before.
    assert.equal((yield* ask("command:viewed-ask", receiver.threadId)).exchangeState, "open");
    // Agents in a shared conversation still message each other.
    const peer = yield* service.send({
      commandId: CommCommandId.make("command:shared-peer"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Over to you.",
      acceptedAt: timestamp,
    });
    assert.equal(peer.exchangeState, "none");
    // And a reply to something a person asked the agent is not an ask.
    const inbound = ExchangeId.make("exchange:shared-inbound");
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:shared-inbound"),
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "exchange.opened",
        sender: person.id,
        receiver: sender.id,
        exchangeId: inbound,
        correlationId: null,
        payload: { intent: "Request a reply", urgency: "soon" },
        createdAt: timestamp,
      },
    });
    const reply = yield* service.send({
      commandId: CommCommandId.make("command:shared-reply"),
      senderThreadId: sender.threadId,
      to: person.id,
      message: "Here it is.",
      exchangeId: inbound,
      acceptedAt: timestamp,
    });
    assert.equal(reply.exchangeState, "closed");

    // The guest's grant goes: the thread is one person's again, and its agent asks as before.
    yield* sql`DELETE FROM j5_a2a_person_grant WHERE target_id = ${sender.threadId}`;
    assert.equal((yield* ask("command:unshared-ask", sender.threadId)).exchangeState, "open");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rolls back the send receipt when its projection write fails", () =>
  Effect.gen(function* () {
    yield* setupSameProject();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const command = CommCommandId.make("command:receipt-rollback");
    yield* sql`
      CREATE TRIGGER j5_a2a_test_fail_exchange_projection
      BEFORE INSERT ON j5_a2a_exchange
      WHEN NEW.exchange_id LIKE 'exchange:j5:a2a:%'
      BEGIN
        SELECT RAISE(ABORT, 'forced projection failure');
      END
    `;

    yield* Effect.flip(
      service.send({
        commandId: command,
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This transaction must roll back.",
        expectReply: true,
        intent: "Prove receipt rollback",
        acceptedAt: timestamp,
      }),
    );
    const poisoned = yield* sql<{ readonly receipts: number; readonly events: number }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_command_receipt WHERE command_id = ${command}) AS receipts,
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE command_id = ${command}) AS events
    `;
    assert.deepStrictEqual(poisoned, [{ receipts: 0, events: 0 }]);

    yield* sql`DROP TRIGGER j5_a2a_test_fail_exchange_projection`;
    const retry = yield* service.send({
      commandId: command,
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "This transaction must roll back.",
      expectReply: true,
      intent: "Prove receipt rollback",
      acceptedAt: timestamp,
    });
    assert.equal(retry.exchangeState, "open");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails closed for a caller that is not a registrable thread", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const unknownThreadId = ThreadId.make("thread:native-without-home-project");
    const subagentThreadId = ThreadId.make("thread:subagent-without-home");
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode,
        interaction_mode, active_provider_thread_id, created_at, updated_at,
        archived_at, deleted_at, payload_json
      ) VALUES (
        ${subagentThreadId}, 'project:send-service', 'Subagent', 'codex', 'full-access',
        'default', NULL, ${timestamp}, ${timestamp}, NULL, NULL,
        '{"lineage":{"relationshipToParent":"subagent"}}'
      )
    `;

    for (const threadId of [unknownThreadId, subagentThreadId]) {
      const listError = yield* Effect.flip(service.listParticipants(threadId));
      assert.equal(listError._tag, "A2ASenderNotJoinedError");
      assert.include(listError.message, "it is a Subagent, and Subagents are not participants");
      assert.include(listError.message, "Return your result to the agent that started you");
      assert.notMatch(
        listError.message,
        /ask the user|product workflow|j5_list_participants again/i,
      );

      const sendError = yield* Effect.flip(
        service.send({
          commandId: CommCommandId.make(`command:not-registrable:${threadId}`),
          senderThreadId: threadId,
          to: receiver.id,
          message: "This must fail without provisioning.",
          acceptedAt: timestamp,
        }),
      );
      assert.equal(sendError._tag, "A2ASenderNotJoinedError");
    }

    const state = yield* sql<{ readonly projects: number; readonly events: number }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_project_ledger) AS projects,
        (SELECT COUNT(*) FROM j5_a2a_comm_event) AS events
    `;
    assert.deepStrictEqual(state, [{ projects: 0, events: 0 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails loudly when active membership diverges from the immutable home", () =>
  Effect.gen(function* () {
    const homeProjectId = yield* setupSameProject();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const corruptedProjectId = LedgerProjectId.make("project:corrupted-projection");
    yield* ledgerService.ensureProject({ projectId: corruptedProjectId, createdAt: timestamp });
    yield* sql`
      UPDATE j5_a2a_membership
      SET project_id = ${corruptedProjectId}
      WHERE project_id = ${homeProjectId}
        AND participant_id = ${sender.id}
    `;

    const error = yield* Effect.flip(service.listParticipants(sender.threadId));

    assert.equal(error._tag, "A2AHomeMembershipStateError");
    if (error._tag === "A2AHomeMembershipStateError") {
      assert.equal(error.expectedProjectId, homeProjectId);
      assert.equal(error.expectedParticipantId, sender.id);
      assert.deepStrictEqual(error.activeHomes, [`${corruptedProjectId}:${sender.id}`]);
      assert.include(error.message, `is registered as ${homeProjectId}:${sender.id}`);
      assert.include(error.message, `its active membership is ${corruptedProjectId}:${sender.id}`);
      assert.include(error.message, "Tell the human; do not retry");
      assert.notInclude(error.message, "no registered home squadron");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails closed when an extra active membership accompanies the correct home", () =>
  Effect.gen(function* () {
    const homeProjectId = yield* setupSameProject();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const extraProjectId = LedgerProjectId.make("project:additive-projection-corruption");
    yield* ledgerService.ensureProject({ projectId: extraProjectId, createdAt: timestamp });
    yield* sql`
      INSERT INTO j5_a2a_membership (
        project_id,
        participant_id,
        participant_kind,
        thread_id,
        joined_seq,
        updated_seq,
        payload
      )
      SELECT
        ${extraProjectId},
        participant_id,
        participant_kind,
        thread_id,
        joined_seq,
        updated_seq,
        payload
      FROM j5_a2a_membership
      WHERE project_id = ${homeProjectId}
        AND participant_id = ${sender.id}
    `;

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:additive-projection-corruption"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This sender has a conflicting extra active membership.",
        acceptedAt: timestamp,
      }),
    );

    assert.equal(error._tag, "A2AHomeMembershipStateError");
    if (error._tag === "A2AHomeMembershipStateError") {
      assert.deepStrictEqual([...error.activeHomes].sort(), [
        `${extraProjectId}:${sender.id}`,
        `${homeProjectId}:${sender.id}`,
      ]);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports a legitimately retired sender without prescribing projection repair", () =>
  Effect.gen(function* () {
    const projectId = yield* setupSameProject();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:sender:retired"),
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.left",
        sender: sender.id,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: sender },
        createdAt: timestamp,
      },
    });

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:sender:retired:send"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This retired sender must not send.",
        acceptedAt: timestamp,
      }),
    );

    assert.equal(error._tag, "A2ASenderRetiredError");
    if (error._tag === "A2ASenderRetiredError") {
      assert.equal(error.threadId, sender.threadId);
      assert.equal(error.projectId, projectId);
      assert.equal(error.participantId, sender.id);
      assert.include(error.message, `was retired from ${projectId}:${sender.id}`);
      assert.include(error.message, "participant.left");
      assert.include(error.message, "cannot send cross-agent messages");
      assert.include(error.message, "Do not repair the projection");
      assert.include(error.message, "stop this messaging attempt");
      assert.notInclude(error.message, "no registered home squadron");
    }
    assert.deepStrictEqual(yield* ledgerService.listMembership(projectId), [
      {
        projectId,
        participant: receiver,
        joinedSeq: 2,
        updatedSeq: 2,
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ignores left events that do not identify a later retirement of the exact home", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const homeProjectId = LedgerProjectId.make("project:retirement-decoys:home");
    const foreignProjectId = LedgerProjectId.make("project:retirement-decoys:foreign");
    yield* ledgerService.ensureProject({ projectId: homeProjectId, createdAt: timestamp });
    yield* ledgerService.ensureProject({ projectId: foreignProjectId, createdAt: timestamp });
    const appendAgentEvent = (
      projectId: LedgerProjectId,
      commandId: string,
      kind: "participant.joined" | "participant.left",
      participant: AgentParticipant,
    ) =>
      ledgerService.append({
        commandId: CommCommandId.make(commandId),
        projectId,
        acceptedAt: timestamp,
        event: {
          kind,
          sender: kind === "participant.left" ? participant.id : null,
          receiver: kind === "participant.joined" ? participant.id : null,
          exchangeId: null,
          correlationId: null,
          payload: { participant },
          createdAt: timestamp,
        },
      });

    yield* appendAgentEvent(
      homeProjectId,
      "command:retirement-decoys:pre-join-left",
      "participant.left",
      sender,
    );
    yield* appendAgentEvent(
      homeProjectId,
      "command:retirement-decoys:sender-join",
      "participant.joined",
      sender,
    );
    yield* appendAgentEvent(
      homeProjectId,
      "command:retirement-decoys:receiver-join",
      "participant.joined",
      receiver,
    );
    for (const index of [1, 2]) {
      yield* appendAgentEvent(
        foreignProjectId,
        `command:retirement-decoys:foreign-padding:${index}`,
        "participant.joined",
        {
          kind: "agent",
          id: ParticipantId.make(`agent:retirement-padding:${index}`),
          threadId: ThreadId.make(`thread:retirement-padding:${index}`),
        },
      );
    }
    yield* appendAgentEvent(
      foreignProjectId,
      "command:retirement-decoys:foreign-left",
      "participant.left",
      sender,
    );
    yield* appendAgentEvent(
      homeProjectId,
      "command:retirement-decoys:wrong-participant-left",
      "participant.left",
      {
        kind: "agent",
        id: ParticipantId.make("agent:retirement-decoy"),
        threadId: sender.threadId,
      },
    );
    const wrongThreadParticipant: AgentParticipant = {
      kind: "agent",
      id: sender.id,
      threadId: ThreadId.make("thread:retirement-decoy"),
    };
    const wrongThreadPayload = yield* encodeAgentParticipantPayload({
      participant: wrongThreadParticipant,
    });
    const sequenceRows = yield* sql<{ readonly next_seq: number }>`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM j5_a2a_comm_event
      WHERE project_id = ${homeProjectId}
    `;
    const decoySeq = sequenceRows[0]!.next_seq;
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
        ${decoySeq},
        ${homeProjectId},
        'participant.left',
        ${wrongThreadParticipant.id},
        NULL,
        NULL,
        NULL,
        ${wrongThreadPayload},
        ${timestamp},
        'command:retirement-decoys:wrong-thread-left'
      )
    `;

    const result = yield* service.send({
      commandId: CommCommandId.make("command:retirement-decoys:send"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "These unrelated left events must not retire the live sender.",
      acceptedAt: timestamp,
    });

    assert.equal(result.exchangeState, "none");
    assert.equal(result.durableAtSeq, decoySeq + 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists member agents and registry-derived person capabilities", () =>
  Effect.gen(function* () {
    yield* setupSameProject();
    yield* registerPerson();
    const secondPersonId = ParticipantId.make("human:send-person-two");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
      VALUES (${secondPersonId}, 0, ${timestamp})
    `;
    const rows = yield* (yield* A2ASendService).listParticipants(sender.threadId);
    assert.deepStrictEqual(
      rows.map((row) => ({
        id: row.participantId,
        canReceiveMessage: row.canReceiveMessage,
        canOpenExchange: row.canOpenExchange,
        acceptsUrgency: row.acceptsUrgency,
      })),
      [
        {
          id: receiver.id,
          canReceiveMessage: true,
          canOpenExchange: true,
          acceptsUrgency: false,
        },
        {
          id: sender.id,
          canReceiveMessage: true,
          canOpenExchange: true,
          acceptsUrgency: false,
        },
        {
          id: person.id,
          canReceiveMessage: false,
          canOpenExchange: true,
          acceptsUrgency: true,
        },
        {
          id: secondPersonId,
          canReceiveMessage: false,
          canOpenExchange: true,
          acceptsUrgency: true,
        },
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("marks duplicate participant identities unavailable before send", () =>
  Effect.gen(function* () {
    yield* setupSameProject();
    const ledgerService = yield* A2ALedger;
    const duplicateProjectId = LedgerProjectId.make("project:exchange:duplicate-receiver");
    const duplicateReceiver = {
      ...receiver,
      threadId: ThreadId.make("thread:receiver:duplicate-identity"),
    };
    yield* ledgerService.ensureProject({ projectId: duplicateProjectId, createdAt: timestamp });
    yield* ledgerService.appendEvents({
      commandId: CommCommandId.make("command:join:duplicate-receiver"),
      projectId: duplicateProjectId,
      acceptedAt: timestamp,
      events: [
        {
          kind: "participant.joined",
          sender: null,
          receiver: receiver.id,
          exchangeId: null,
          correlationId: null,
          payload: { participant: duplicateReceiver },
          createdAt: timestamp,
        },
      ],
    });

    const service = yield* A2ASendService;
    const rows = (yield* service.listParticipants(sender.threadId)).filter(
      (row) => row.participantId === receiver.id,
    );
    assert.lengthOf(rows, 2);
    assert.isTrue(rows.every((row) => !row.canReceiveMessage && !row.canOpenExchange));

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:ambiguous-receiver"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This must fail before append.",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(error._tag, "A2AAmbiguousParticipantError");
    assert.include(error.message, "choose a participantId with canReceiveMessage=true");
    assert.include(error.message, "tell the human");
  }).pipe(Effect.provide(testLayer)),
);
