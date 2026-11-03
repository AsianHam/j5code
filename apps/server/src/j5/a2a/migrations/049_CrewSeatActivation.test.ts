import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runJ5A2AMigrations } from "../Migrations.ts";

const decodeRoster = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ seat: Schema.String, reason: Schema.String })),
  ),
);

it.effect(
  "existing members retain their observed roster and are not introduced again after migration",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations({ toMigrationInclusive: 48 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES ('project:test', '2026-10-27')`;
      yield* sql`INSERT INTO j5_agent_crew_instance
      (id, project_id, captain_participant_id, captain_thread_id, display_name, brief, version, created_at)
      VALUES ('crew:test', 'project:test', 'agent:captain', 'thread:captain', 'Crew', 'Brief', 1, '2026-10-27')`;
      for (const [ordinal, name] of ["builder", "reviewer"].entries())
        yield* sql`
      INSERT INTO j5_agent_crew_member
        (crew_instance_id, seat_name, agent_id, participant_id, thread_id, ordinal, added_version, reason)
      VALUES ('crew:test', ${name}, NULL, ${`agent:${name}`}, ${`thread:${name}`}, ${ordinal}, 1, ${`Responsibility of ${name}`})
    `;
      yield* runJ5A2AMigrations();
      yield* runJ5A2AMigrations();
      const contexts = yield* sql<{
        readonly delivered_roster: string;
        readonly first_turn_text: string;
        readonly delivered_conversation: string | null;
      }>`
      SELECT delivered_roster, first_turn_text, delivered_conversation FROM j5_crew_seat_context
    `;
      assert.lengthOf(contexts, 2);
      for (const row of contexts) {
        assert.equal(row.first_turn_text, "");
        assert.isNull(row.delivered_conversation);
        const roster = yield* decodeRoster(row.delivered_roster);
        assert.sameMembers(
          roster.map((member) => member.seat),
          ["builder", "reviewer"],
        );
        assert.include(
          roster.map((member) => member.reason),
          "Responsibility of builder",
        );
      }
      const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('j5_crew_seat_context') ORDER BY cid
    `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "thread_id",
          "first_turn_text",
          "workspace",
          "delivered_roster",
          "delivered_conversation",
          "agent_display_name",
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
