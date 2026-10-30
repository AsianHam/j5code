import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ALedger } from "./LedgerService.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { PlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import { CREW_ALERT_EXCHANGE_PREFIX } from "./crewFailureAlert.ts";
import { makeFleetRead } from "./fleetRead.ts";
import { LedgerProjectId, ParticipantId } from "./contracts.ts";
import type { ParticipantPlacementView } from "./placementContracts.ts";
import { readFleetLedgerFacts } from "./fleetFacts.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const sender = "agent:sender";
const receiver = "agent:receiver";
const at = "2026-10-19T10:00:00.000Z";

it.effect("bounds both Fleet ask summaries without changing the stored intent", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES ('p', ${at})`;
    for (const [intent, summary] of [
      ["Review the diff", "Review the diff"],
      ["a".repeat(200), "a".repeat(200)],
      ["a".repeat(10_000), `${"a".repeat(199)}…`],
      ["🚀".repeat(5_000), `${"🚀".repeat(199)}…`],
    ]) {
      yield* sql`INSERT INTO j5_a2a_exchange (
        project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at
      ) VALUES ('p', 'ask', ${sender}, ${receiver}, 'open', ${intent}, 1, ${at}, ${at})
      ON CONFLICT (project_id, exchange_id) DO UPDATE SET intent = excluded.intent`;
      const facts = yield* readFleetLedgerFacts(sql, "p", [sender, receiver], () => null);
      assert.equal(facts.awaited.get(sender)?.[0]?.intent, summary);
      assert.equal(facts.owed.get(receiver)?.[0]?.intent, summary);
      const stored = yield* sql<{ intent: string }>`
        SELECT intent FROM j5_a2a_exchange WHERE project_id = 'p' AND exchange_id = 'ask'
      `;
      assert.equal(stored[0]?.intent, intent);
    }
  }).pipe(Effect.provide(database)),
);

it.effect(
  "reads both ask directions across projects and keeps local/remote alarms on their sender",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const sql = yield* SqlClient.SqlClient;
      for (const project of ["p", "other"])
        yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES (${project}, ${at})`;
      const exchange = Effect.fnUntraced(function* (
        id: string,
        project: string,
        from: string,
        to: string,
      ) {
        yield* sql`INSERT INTO j5_a2a_exchange (
        project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at
      ) VALUES (${project}, ${id}, ${from}, ${to}, 'open', ${id}, 1, ${at}, ${at})`;
      });
      yield* exchange("outgoing", "p", sender, receiver);
      yield* exchange("incoming", "other", "human:operator", sender);
      const alarm = Effect.fnUntraced(function* (
        id: string,
        channel: string,
        exchangeId: string | null,
        remote: string | null = null,
        status = "alarmed",
        receiverId = receiver,
      ) {
        yield* sql`INSERT INTO j5_a2a_delivery (
        project_id, message_id, command_id, sent_seq, sender_id, receiver_id, receiver_project_id,
        exchange_id, exchange_role, correlation_id, message_text, status, attempts, last_error,
        created_at, updated_at, envelope_channel, receiver_environment_id
      ) VALUES ('p', ${id}, ${id}, 1, ${sender}, ${receiverId}, 'p', ${exchangeId},
        ${exchangeId === null ? "none" : "followup"}, ${id}, 'hello', ${status}, 3, 'transport unavailable',
        ${at}, ${at}, ${channel}, ${remote})`;
      });
      const platformExchange = `${CREW_ALERT_EXCHANGE_PREFIX}crew/run`;
      yield* exchange(platformExchange, "p", sender, "human:operator");
      yield* alarm("platform-alert", "peer", platformExchange, null, "alarmed", "human:operator");
      yield* alarm("local-ask", "peer", "outgoing");
      yield* alarm("remote-ask", "peer", "outgoing", "remote-env");
      yield* alarm("plain", "peer", null);
      yield* alarm("silence", "silence_notice", null);
      yield* alarm("lifecycle", "lifecycle_notice", null);
      yield* alarm("retry", "peer", null, null, "retry_scheduled");
      yield* alarm("delivered", "peer", null, null, "delivered");
      yield* alarm("accepted-peer", "peer", "outgoing", "receiver-env", "delivered");
      yield* sql`UPDATE j5_a2a_delivery SET exchange_role = 'ask' WHERE message_id = 'accepted-peer'`;
      yield* alarm("inbound-peer", "peer", "outgoing");
      yield* sql`UPDATE j5_a2a_delivery SET origin_environment_id = 'origin-env'
        WHERE message_id = 'inbound-peer'`;
      yield* alarm("inbound-platform", "lifecycle_notice", null);
      yield* sql`UPDATE j5_a2a_delivery SET origin_environment_id = 'origin-env'
        WHERE message_id = 'inbound-platform'`;
      const read = () =>
        readFleetLedgerFacts(sql, "p", [sender, receiver], (id) =>
          id === receiver ? "Receiver" : null,
        );
      const before = yield* read();
      assert.equal(before.owed.get(sender)?.length, 1);
      assert.equal(before.owed.get(receiver)?.length, 1);
      assert.deepStrictEqual(before.awaited.get(sender), [
        {
          exchangeId: "outgoing",
          counterpartyId: receiver,
          counterpartyName: "Receiver",
          intent: "outgoing",
          openedAt: at,
        },
      ]);
      assert.deepStrictEqual(
        before.problems
          .get(sender)
          ?.map(
            (problem) =>
              problem.kind === "delivery-failed" && [problem.messageId, problem.exchangeOpen],
          ),
        [
          ["local-ask", true],
          ["plain", false],
          ["remote-ask", true],
        ],
      );
      assert.isUndefined(before.problems.get(receiver));
      assert.deepStrictEqual(before.deliveryEnvironmentIds.get(sender), ["receiver-env"]);
      assert.deepStrictEqual(before.remoteDeliveryAlarms, [
        {
          originEnvironmentId: "origin-env",
          senderId: sender,
          problem: {
            kind: "delivery-failed",
            messageId: "inbound-peer",
            exchangeId: "outgoing",
            receiverId: receiver,
            receiverName: "Receiver",
            at,
            reason: "transport unavailable",
            exchangeOpen: true,
          },
        },
      ]);
      assert.equal(
        (yield* readFleetLedgerFacts(sql, "p", [], () => null)).remoteDeliveryAlarms.length,
        1,
      );
      yield* sql`UPDATE j5_a2a_exchange SET status = 'closed' WHERE exchange_id = 'outgoing'`;
      const closed = yield* read();
      assert.isUndefined(closed.awaited.get(sender));
      assert.isUndefined(closed.deliveryEnvironmentIds.get(sender));
      assert.equal(closed.problems.get(sender)?.length, 3);
      assert.isTrue(
        closed.problems
          .get(sender)!
          .every((problem) => problem.kind === "delivery-failed" && !problem.exchangeOpen),
      );
      yield* sql`UPDATE j5_a2a_delivery SET status = 'cancelled' WHERE message_id = 'local-ask'`;
      assert.equal((yield* read()).problems.get(sender)?.length, 2);
      assert.equal(
        (yield* readFleetLedgerFacts(sql, "other", [sender], () => null)).problems.size,
        0,
      );
      yield* sql`INSERT INTO j5_a2a_human_person
        (person_id, is_local_operator, created_at, display_name, name_key)
        VALUES ('human:operator', 1, ${at}, 'Operator', 'operator')`;
      const participant = (id: string, project: string): ParticipantPlacementView => ({
        projectId: LedgerProjectId.make(project),
        participantId: ParticipantId.make(id),
        participant: {
          kind: "agent",
          id: ParticipantId.make(id),
          threadId: ThreadId.make(id),
        },
        threadId: ThreadId.make(id),
        provenance: { kind: "unrecorded" },
        placementParentId: null,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (${receiver}, 'other', 'Remote receiver', 'codex', 'full-access', 'default',
        NULL, ${at}, ${at}, NULL, NULL, '{}')`;
      const fleetRead = yield* makeFleetRead.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(A2ALedger)({
              listProjectLedgers: () =>
                Effect.succeed([
                  { id: LedgerProjectId.make("p"), name: "P", createdAt: at },
                  { id: LedgerProjectId.make("other"), name: "Other", createdAt: at },
                ]),
            }),
            Layer.mock(ParticipantPlacementService)({
              listParticipants: (project) =>
                Effect.succeed([
                  project === "p" ? participant(sender, "p") : participant(receiver, "other"),
                ]),
            }),
            Layer.mock(AgentCrewInstanceService)({ listForProject: () => Effect.succeed([]) }),
            Layer.mock(PlaybookCrewRelay)({}),
          ),
        ),
      );
      const snapshot = yield* fleetRead(false);
      assert.equal(snapshot.remoteDeliveryAlarms?.[0]?.originEnvironmentId, "origin-env");
      assert.equal(snapshot.remoteDeliveryAlarms?.[0]?.senderId, sender);
      assert.equal(snapshot.remoteDeliveryAlarms?.[0]?.problem.exchangeOpen, false);
      assert.deepStrictEqual(snapshot.projects[0]?.agents[0]?.facts?.deliveryEnvironmentIds, []);
      assert.equal(snapshot.asOf, "1970-01-01T00:00:00.000Z");
      assert.equal(snapshot.projects[0]?.agents[0]?.facts?.asks.owed.length, 1);
      assert.equal(
        snapshot.projects[0]?.agents[0]?.facts?.asks.owed[0]?.counterpartyName,
        "Operator",
      );
      assert.equal(snapshot.projects[0]?.agents[0]?.facts?.problems.length, 2);
      assert.deepStrictEqual(
        snapshot.projects[0]?.agents[0]?.facts?.problems.map(
          (problem) => problem.kind === "delivery-failed" && problem.receiverName,
        ),
        ["Remote receiver", "Remote receiver"],
      );
      yield* sql`INSERT INTO j5_a2a_human_person
        (person_id, is_local_operator, created_at, display_name, name_key, removed_at)
        VALUES ('human:viewer', 0, ${at}, 'Viewer', 'viewer', NULL),
               ('human:removed', 0, ${at}, 'Removed person', NULL, ${at})`;
      yield* sql`INSERT INTO j5_a2a_person_level
        (person_id, scope_kind, scope_id, level, created_at, updated_at)
        VALUES ('human:viewer', 'project', 'p', 'viewer', ${at}, ${at})`;
      yield* exchange("viewer-ask", "other", "human:viewer", sender);
      yield* exchange("removed-ask", "other", "human:removed", sender);
      const withPeople = yield* fleetRead(false);
      assert.deepStrictEqual(
        withPeople.projects[0]?.agents[0]?.facts?.asks.owed.map((ask) => ask.counterpartyName),
        ["Operator", "Removed person", "Viewer"],
      );
    }).pipe(Effect.provide(database)),
);

it.effect(
  "reads beyond SQLite's unbatched bind limit without duplicating cross-project Exchanges",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const sql = yield* SqlClient.SqlClient;
      const agents = Array.from({ length: 17_000 }, (_, index) => `agent:${index}`);
      for (const project of ["p", "other"]) {
        yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES (${project}, ${at})`;
        yield* sql`INSERT INTO j5_a2a_exchange (
        project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at
      ) VALUES (${project}, 'shared', ${agents[0]!}, ${agents[900]!}, 'open', ${project}, 1, ${at}, ${at})`;
      }
      for (const id of [agents[0]!, agents.at(-1)!]) {
        yield* sql`INSERT INTO j5_a2a_delivery (
        project_id, message_id, command_id, sent_seq, sender_id, receiver_id, receiver_project_id,
        exchange_id, exchange_role, correlation_id, message_text, status, attempts, last_error,
        created_at, updated_at, envelope_channel
      ) VALUES ('p', ${id}, ${id}, 1, ${id}, 'agent:remote', 'other', NULL,
        'none', ${id}, 'hello', 'alarmed', 3, 'transport unavailable', ${at}, ${at}, 'peer')`;
      }
      // Binding these ids in both directions together would exceed SQLite's 32,766 variable ceiling.
      const facts = yield* readFleetLedgerFacts(sql, "p", agents, () => null);
      assert.equal(facts.awaited.get(agents[0]!)?.length, 2);
      assert.equal(facts.owed.get(agents[900]!)?.length, 2);
      assert.equal(facts.problems.get(agents[0]!)?.length, 1);
      assert.equal(facts.problems.get(agents.at(-1)!)?.length, 1);
      assert.isNull(facts.awaited.get(agents[0]!)?.[0]?.counterpartyName);
    }).pipe(Effect.provide(database)),
);

it.effect("tracks only open origin-owned ask destinations across projects before acceptance", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const project of ["p", "other"])
      yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES (${project}, ${at})`;
    yield* sql`INSERT INTO j5_a2a_peer (environment_id, label, link_mode, origin, credential, created_at, updated_at)
      VALUES ('removed-peer', 'Removed', 'push', 'https://removed.example', 'test-token', ${at}, ${at})`;
    const add = Effect.fnUntraced(function* (
      id: string,
      status: "open" | "closed",
      role: "ask" | "followup" | "none",
      destination: string,
      originEnvironment: string | null = null,
      channel = "peer",
      from = sender,
    ) {
      const to = `agent:receiver:${id}`;
      const exchangeId = role === "none" ? null : id;
      if (exchangeId !== null)
        yield* sql`INSERT INTO j5_a2a_exchange
          (project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at)
          VALUES ('other', ${id}, ${from}, ${to}, ${status}, ${id}, 1, ${at}, ${at})`;
      yield* sql`INSERT INTO j5_a2a_delivery
        (project_id, message_id, command_id, sent_seq, sender_id, receiver_id, receiver_project_id,
          exchange_id, exchange_role, correlation_id, message_text, status, attempts,
          created_at, updated_at, envelope_channel, receiver_environment_id, origin_environment_id)
        VALUES ('other', ${id}, ${id}, 1, ${from}, ${to}, 'remote-project', ${exchangeId}, ${role},
          ${id}, 'hello', 'pending', 0, ${at}, ${at}, ${channel}, ${destination}, ${originEnvironment})`;
    });
    yield* add("open-ask", "open", "ask", "active-peer");
    yield* add("old-ask", "closed", "ask", "removed-peer");
    yield* add("plain", "closed", "none", "plain-peer");
    yield* add("followup", "open", "followup", "followup-peer");
    yield* add("received-ask", "open", "ask", "inbound-peer", "foreign-origin");
    yield* add(`${CREW_ALERT_EXCHANGE_PREFIX}notice`, "open", "ask", "platform-peer");
    yield* add("lifecycle", "open", "ask", "notice-peer", null, "lifecycle_notice");
    yield* add("other-sender", "open", "ask", "other-peer", null, "peer", "agent:other");
    const read = () => readFleetLedgerFacts(sql, "p", [sender], () => null);
    const pending = yield* read();
    assert.deepStrictEqual(pending.deliveryEnvironmentIds.get(sender), ["active-peer"]);
    assert.isTrue(pending.awaited.get(sender)?.some((ask) => ask.exchangeId === "open-ask"));
    for (const status of ["retry_scheduled", "delivered"]) {
      yield* sql`UPDATE j5_a2a_delivery SET status = ${status} WHERE message_id = 'open-ask'`;
      assert.deepStrictEqual((yield* read()).deliveryEnvironmentIds.get(sender), ["active-peer"]);
    }
    yield* sql`UPDATE j5_a2a_delivery SET status = 'delivered' WHERE message_id = 'old-ask'`;
    yield* sql`DELETE FROM j5_a2a_peer WHERE environment_id = 'removed-peer'`;
    yield* sql`UPDATE j5_a2a_exchange SET status = 'closed' WHERE exchange_id = 'open-ask'`;
    assert.isUndefined((yield* read()).deliveryEnvironmentIds.get(sender));
    assert.equal(
      (yield* sql`SELECT 1 FROM j5_a2a_delivery WHERE message_id = 'old-ask' AND status = 'delivered'`)
        .length,
      1,
    );
  }).pipe(Effect.provide(database)),
);
