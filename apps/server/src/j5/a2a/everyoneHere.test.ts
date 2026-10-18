import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { live as deliveryTransportLive } from "./DeliveryTransport.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALifecycleService, manualLayer as lifecycleLayer } from "./LifecycleService.ts";
import { SharedThreads, layer as sharedThreadsLayer } from "../sharing/SharedThreads.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  type AgentParticipant,
  CommCommandId,
  EVERYONE_HERE_PERSON_ID,
  LedgerProjectId,
  ParticipantId,
} from "./contracts.ts";

/**
 * Asks in a thread several people can write to (Inbox AC14 to AC16): whom an agent may ask,
 * whose inbox an ask reaches, and that the first reply to everyone here closes it for all.
 */

const AT = "2026-10-18T00:00:00.000Z";
const projectId = LedgerProjectId.make("project:support");
const threadId = ThreadId.make("thread:support-agent");
const agent: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:support"),
  threadId,
};
const person = (name: string) => ParticipantId.make(`human:${name.toLowerCase()}`);
const JACKSON = person("Jackson");
const PRIYA = person("Priya");
const SAM = person("Sam");
const VIC = person("Vic");
const OLGA = person("Olga");

const testLayer = (() => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transport = deliveryTransportLive.pipe(
    Layer.provide(database),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(PeerRegistryService)({})),
    Layer.provide(Layer.mock(ThreadManagementService)({})),
    Layer.provide(Layer.mock(OrchestratorV2)({})),
    Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const lifecycle = lifecycleLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(worker),
    Layer.provide(Layer.mock(ThreadManagementService)({})),
  );
  const shared = sharedThreadsLayer.pipe(Layer.provide(database));
  return Layer.mergeAll(database, ledger, send, inbox, worker, lifecycle, shared);
})();

/**
 * Jackson owns the server. Priya and Sam write to the support agent's thread; Vic only reads it;
 * Olga writes to another project.
 */
const seed = Effect.gen(function* () {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${threadId}, ${projectId}, 'Support', 'codex', 'full-access', 'default', NULL, ${AT}, ${AT},
      NULL, NULL, '{}'
    )
  `;
  const levels = [
    [JACKSON, "server", "", "owner"],
    [PRIYA, "thread", threadId, "collaborator"],
    [SAM, "project", projectId, "collaborator"],
    [VIC, "thread", threadId, "viewer"],
    [OLGA, "project", "project:elsewhere", "collaborator"],
  ] as const;
  for (const [personId, scopeKind, scopeId, level] of levels) {
    const name = personId.slice("human:".length);
    yield* sql`
      INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at, display_name)
      VALUES (${personId}, ${personId === JACKSON ? 1 : 0}, ${AT},
        ${name[0]!.toUpperCase() + name.slice(1)})
    `;
    yield* sql`
      INSERT INTO j5_a2a_person_level
        (person_id, scope_kind, scope_id, level, created_at, updated_at)
      VALUES (${personId}, ${scopeKind}, ${scopeId}, ${level}, ${AT}, ${AT})
    `;
  }
  const ledger = yield* A2ALedger;
  yield* ledger.ensureProject({ projectId, createdAt: AT });
  yield* ledger.appendEvents({
    commandId: CommCommandId.make("command:join:support"),
    projectId,
    acceptedAt: AT,
    events: [
      {
        kind: "participant.joined",
        sender: null,
        receiver: agent.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: agent },
        createdAt: AT,
      },
    ],
  });
});

const ask = (to: ParticipantId, key: string) =>
  Effect.gen(function* () {
    const sent = yield* (yield* A2ASendService).send({
      commandId: CommCommandId.make(`command:ask:${key}`),
      senderThreadId: threadId,
      to,
      message: "Which customer do we call back first?",
      expectReply: true,
      intent: "Call-back order",
      urgency: "soon",
      acceptedAt: AT,
    });
    yield* (yield* A2ADeliveryWorker).drain;
    return sent.exchangeId!;
  });

const answer = (personId: ParticipantId, exchangeId: string, message: string) =>
  A2AHumanInbox.use((inbox) =>
    inbox.answer({
      commandId: CommCommandId.make(`command:answer:${personId}:${exchangeId}`),
      personId,
      exchangeId: exchangeId as never,
      message,
      acceptedAt: AT,
    }),
  );

const intents = (personId: ParticipantId, status: "open" | "answered" = "open") =>
  A2AHumanInbox.use((inbox) => inbox.list(personId, status)).pipe(
    Effect.map((items) =>
      items.map((item) => ({ for: item.forEveryone === true, answeredBy: item.answeredBy })),
    ),
  );

it.effect(
  "an agent's address book holds the people who can write to its thread, and everyone here",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const rows = yield* (yield* A2ASendService).listParticipants(threadId);
      assert.deepStrictEqual(
        rows
          .filter((row) => row.participant.kind === "human")
          .map((row) => [row.participantId, row.displayName]),
        [
          [JACKSON, "Jackson"],
          [PRIYA, "Priya"],
          [SAM, "Sam"],
          [EVERYONE_HERE_PERSON_ID, "everyone here"],
        ],
      );
      // Someone who cannot write to the agent's thread cannot be asked, Viewer or not.
      for (const outsider of [VIC, OLGA]) {
        const refused = yield* Effect.flip(ask(outsider, `outsider:${outsider}`));
        assert.strictEqual(refused._tag, "A2AParticipantNotFoundError");
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "an ask to everyone here reaches every writer, and the first reply closes it for all",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const exchangeId = yield* ask(EVERYONE_HERE_PERSON_ID, "everyone");
      for (const writer of [JACKSON, PRIYA, SAM]) {
        assert.deepStrictEqual(yield* intents(writer), [{ for: true, answeredBy: null }], writer);
      }
      // A Viewer has no inbox here, and Olga cannot write to the agent's thread.
      assert.deepStrictEqual(yield* intents(VIC), []);
      assert.deepStrictEqual(yield* intents(OLGA), []);
      const refused = yield* Effect.flip(answer(VIC, exchangeId, "Acme."));
      assert.strictEqual(refused._tag, "A2AAskNotYoursError");

      yield* answer(PRIYA, exchangeId, "Acme first.");
      const later = yield* Effect.flip(answer(SAM, exchangeId, "Globex first."));
      assert.strictEqual(later.message, "Priya already answered this.");
      // The others' Replied shelf names who answered; nothing is left open.
      for (const writer of [JACKSON, PRIYA, SAM]) {
        assert.deepStrictEqual(yield* intents(writer), []);
        assert.deepStrictEqual(
          yield* intents(writer, "answered"),
          [{ for: true, answeredBy: "Priya" }],
          writer,
        );
      }
      // The agent hears the one reply.
      const sql = yield* SqlClient.SqlClient;
      const replies = yield* sql<{ readonly sender_id: string }>`
      SELECT sender_id FROM j5_a2a_delivery
      WHERE exchange_id = ${exchangeId} AND exchange_role = 'reply'
    `;
      assert.deepStrictEqual(replies, [{ sender_id: PRIYA }]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "an ask to one person reaches only them, while they can write to the agent's thread",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* ask(PRIYA, "priya");
      assert.deepStrictEqual(yield* intents(PRIYA), [{ for: false, answeredBy: undefined }]);
      assert.deepStrictEqual(yield* intents(SAM), []);
      // Lowered to Viewer, she no longer has it.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE j5_a2a_person_level SET level = 'viewer' WHERE person_id = ${PRIYA}`;
      assert.deepStrictEqual(yield* intents(PRIYA), []);
    }).pipe(Effect.provide(testLayer)),
);

/** What the access core's subscriber runs for a person whose access changed. */
const endUnanswerableAsks = (personId: ParticipantId) =>
  Effect.gen(function* () {
    const shared = yield* SharedThreads;
    return yield* (yield* A2ALifecycleService).endAsksOf({
      personId,
      endedAt: AT,
      mayAnswer: (asker) =>
        shared.writesTo(personId, {
          threadId: asker.threadId === null ? null : ThreadId.make(asker.threadId),
          projectId: asker.projectId,
        }),
    });
  });

const exchangeStatus = (exchangeId: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}
      `,
    ),
    Effect.map((rows) => rows[0]?.status),
  );

it.effect(
  "an ask to someone who can no longer write to the agent's thread ends, and the agent is told",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const toPriya = yield* ask(PRIYA, "priya-lowered");
      const toSam = yield* ask(SAM, "sam-stays");
      const toEveryone = yield* ask(EVERYONE_HERE_PERSON_ID, "everyone-stays");
      // Lowered to Viewer: her ask can never be answered, so it ends.
      yield* sql`UPDATE j5_a2a_person_level SET level = 'viewer' WHERE person_id = ${PRIYA}`;
      assert.deepStrictEqual(yield* endUnanswerableAsks(PRIYA), [toPriya]);
      assert.strictEqual(yield* exchangeStatus(toPriya), "dropped");
      // The asking agent is told, so it does not wait for her.
      const notices = yield* sql<{ readonly receiver_id: string; readonly message_text: string }>`
      SELECT receiver_id, message_text FROM j5_a2a_delivery
      WHERE exchange_id = ${toPriya} AND exchange_role = 'terminal_notice'
    `;
      assert.lengthOf(notices, 1);
      assert.strictEqual(notices[0]!.receiver_id, agent.id);
      assert.include(notices[0]!.message_text, `${PRIYA} can no longer write to your thread`);
      // Others' asks, and the ask to everyone here, stay open; telling it again ends nothing more.
      assert.strictEqual(yield* exchangeStatus(toSam), "open");
      assert.strictEqual(yield* exchangeStatus(toEveryone), "open");
      assert.deepStrictEqual(yield* endUnanswerableAsks(PRIYA), []);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("an ask to someone removed from the server ends", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const toSam = yield* ask(SAM, "sam-removed");
    // As the access core removes a person: their levels go, and they are marked removed.
    yield* sql`DELETE FROM j5_a2a_person_level WHERE person_id = ${SAM}`;
    yield* sql`UPDATE j5_a2a_human_person SET removed_at = ${AT} WHERE person_id = ${SAM}`;
    assert.deepStrictEqual(yield* endUnanswerableAsks(SAM), [toSam]);
    assert.strictEqual(yield* exchangeStatus(toSam), "dropped");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("where only one person can write to the agent's thread, there is no everyone here", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    // The thread was shared once; what counts is who can write to it now: Jackson alone.
    yield* sql`
      INSERT INTO j5_a2a_shared_thread (thread_id, shared_at) VALUES (${threadId}, ${AT})
    `;
    yield* sql`
      UPDATE j5_a2a_person_level SET level = 'viewer' WHERE person_id IN (${PRIYA}, ${SAM})
    `;
    const rows = yield* (yield* A2ASendService).listParticipants(threadId);
    assert.deepStrictEqual(
      rows.filter((row) => row.participant.kind === "human").map((row) => row.participantId),
      [JACKSON],
    );
    // An ask to everyone here is refused, naming the one person to ask.
    const refused = yield* Effect.flip(ask(EVERYONE_HERE_PERSON_ID, "everyone-alone"));
    assert.strictEqual(refused._tag, "A2AEveryoneHereNotSharedError");
    assert.include(refused.message, `to="${JACKSON}"`);
    // Asking that person goes on.
    yield* ask(JACKSON, "jackson-directly");
  }).pipe(Effect.provide(testLayer)),
);
