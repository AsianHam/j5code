import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  type AgentParticipant,
  CommCommandId,
  LedgerProjectId,
  type MachineParticipant,
  outsideAgentParticipantId,
  ParticipantId,
} from "./contracts.ts";

const timestamp = "2026-10-12T12:00:00.000Z";
const receiverProjectId = LedgerProjectId.make("project:billing");
const otherProjectId = LedgerProjectId.make("project:support");

const receiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:billing"),
  threadId: ThreadId.make("thread:billing"),
};
const bystander: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:support"),
  threadId: ThreadId.make("thread:support"),
};
const watchdog: MachineParticipant = {
  kind: "machine",
  id: ParticipantId.make("machine:watchdog"),
  name: "watchdog",
};
const person = ParticipantId.make("human:outside-person");
const outside = outsideAgentParticipantId("session-1");

const makeTestLayer = () => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  return Layer.mergeAll(database, ledger, send);
};

const setup = Effect.fn("test.j5.a2a.outsideSend.setup")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  const sql = yield* SqlClient.SqlClient;
  const members = [
    [receiverProjectId, receiver],
    [otherProjectId, bystander],
    [otherProjectId, watchdog],
  ] as const;
  for (const projectId of [receiverProjectId, otherProjectId]) {
    yield* ledger.ensureProject({ projectId, createdAt: timestamp });
  }
  for (const [index, [projectId, participant]] of members.entries()) {
    yield* ledger.append({
      commandId: CommCommandId.make(`command:join:${String(index)}`),
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
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES (${person}, 1, ${timestamp})
  `;
});

const input = {
  commandId: CommCommandId.make("command:outside:send:1"),
  senderParticipantId: outside,
  senderName: "Claude Code (laptop)",
  to: receiver.id,
  receiverProjectId,
  message: "The deploy is red.",
  acceptedAt: timestamp,
};

it.effect(
  "records an outside agent's plain send in the receiver's project, keeps its name, and replays it",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const service = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;

      const sent = yield* service.sendAsOutsideAgent(input);
      assert.equal(sent.exchangeState, "none");
      assert.isNull(sent.exchangeId);

      const deliveries = yield* sql<{
        readonly project_id: string;
        readonly sender_id: string;
        readonly receiver_id: string;
        readonly exchange_role: string;
      }>`SELECT project_id, sender_id, receiver_id, exchange_role
         FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`;
      assert.deepStrictEqual(deliveries, [
        {
          project_id: receiverProjectId,
          sender_id: outside,
          receiver_id: receiver.id,
          exchange_role: "none",
        },
      ]);
      // It joins no ledger and is listed for nobody.
      const joined = yield* sql`
        SELECT 1 FROM j5_a2a_comm_event
        WHERE kind = 'participant.joined' AND receiver = ${outside}
      `;
      assert.lengthOf(joined, 0);
      assert.notInclude(
        (yield* service.listParticipantsWithoutCaller({ peopleProjectId: receiverProjectId })).map(
          (row) => row.participantId,
        ),
        outside,
      );

      // A retry with the same command replays. A sign-in's label never changes, so the stored
      // name is the first one.
      const replay = yield* service.sendAsOutsideAgent({ ...input, senderName: "Claude Code" });
      assert.deepStrictEqual(replay, sent);
      const sentEvents = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE kind = 'message.sent'
      `;
      assert.equal(sentEvents[0]?.count, 1);
      const names = yield* sql<{ readonly participant_id: string; readonly name: string }>`
        SELECT participant_id, name FROM j5_a2a_outside_agent
      `;
      assert.deepStrictEqual(names, [{ participant_id: outside, name: "Claude Code (laptop)" }]);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("refuses an outside agent's send to anything but an agent on this server", () =>
  Effect.gen(function* () {
    yield* setup();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    // The receiver is resolved before the send, which is where these refusals come from.
    const refusal = (to: ParticipantId) => service.outsideAgentReceiver(to).pipe(Effect.flip);

    const toPerson = yield* refusal(person);
    assert.equal(toPerson._tag, "A2AOutsideAgentCannotAskError");
    assert.include(toPerson.message, "an outside agent cannot ask");

    // Unknown here: it may live on a peer server, and peers are not resolved for it.
    const toPeer = yield* refusal(ParticipantId.make("agent:j5:a2a:thread:on-a-peer"));
    assert.equal(toPeer._tag, "A2AOutsideAgentLocalOnlyError");
    assert.include(toPeer.message, "sign in to that server's own MCP URL");

    const toOutside = yield* refusal(outsideAgentParticipantId("session-2"));
    assert.equal(toOutside._tag, "A2AOutsideAgentCannotReceiveError");

    assert.equal((yield* refusal(watchdog.id))._tag, "A2AMachineCannotReceiveError");

    // A send that skips that step is still refused, and records nothing, the sender's name
    // included.
    yield* service.sendAsOutsideAgent({ ...input, to: person }).pipe(Effect.flip);
    assert.lengthOf(yield* sql`SELECT 1 FROM j5_a2a_delivery`, 0);
    assert.lengthOf(yield* sql`SELECT 1 FROM j5_a2a_outside_agent`, 0);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("refuses an agent's message to an outside agent, naming the legal move", () =>
  Effect.gen(function* () {
    yield* setup();
    const service = yield* A2ASendService;
    yield* service.sendAsOutsideAgent(input);

    const refused = yield* service
      .send({
        commandId: CommCommandId.make("command:agent:to-outside"),
        senderThreadId: receiver.threadId,
        to: outside,
        message: "Thanks, looking now.",
        acceptedAt: timestamp,
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "A2AOutsideAgentCannotReceiveError");
    assert.include(refused.message, "so j5_send_message cannot reach it");
  }).pipe(Effect.provide(makeTestLayer())),
);
