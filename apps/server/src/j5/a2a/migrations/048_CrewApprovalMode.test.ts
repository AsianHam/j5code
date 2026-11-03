import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect("preserves pre-upgrade addition decisions as human gates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 47 });
    yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES ('project:legacy', '2026-10-27T00:00:00Z')`;
    yield* sql`INSERT INTO j5_agent_crew_proposal (id, project_id, captain_participant_id, captain_thread_id, crew_instance_id, kind, status, brief, display_name, requested_seats, created_at) VALUES ('legacy', 'project:legacy', 'captain', 'thread:captain', NULL, 'addition', 'open', 'Review', 'Legacy', '[]', '2026-10-27T00:00:00Z')`;
    const before = yield* sql`SELECT status, requested_seats FROM j5_agent_crew_proposal`;
    yield* runJ5A2AMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT status, requested_seats FROM j5_agent_crew_proposal`,
      before,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT approval_mode, refusal_detail FROM j5_agent_crew_proposal`,
      [{ approval_mode: "human", refusal_detail: null }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
