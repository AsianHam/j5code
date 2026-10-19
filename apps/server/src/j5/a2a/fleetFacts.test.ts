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
      yield* sql`UPDATE j5_a2a_exchange SET status = 'closed' WHERE exchange_id = 'outgoing'`;
      const closed = yield* read();
      assert.isUndefined(closed.awaited.get(sender));
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
        (person_id, is_local_operator, created_at, kind, display_name, name_key)
        VALUES ('human:operator', 1, ${at}, 'member', 'Operator', 'operator')`;
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
