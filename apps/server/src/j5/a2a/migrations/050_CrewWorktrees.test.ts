import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect("adds the worktree record without touching the seat context it follows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 49 });
    yield* sql`
      INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace)
      VALUES ('thread:seat', '', '{"type":"worktree","baseRef":"main"}')
    `;
    const before = yield* sql`SELECT * FROM j5_crew_seat_context`;

    yield* runJ5A2AMigrations();
    yield* runJ5A2AMigrations();

    assert.deepStrictEqual(yield* sql`SELECT * FROM j5_crew_seat_context`, before);
    assert.deepStrictEqual(yield* sql`SELECT * FROM j5_crew_worktree`, []);
    yield* sql`
      INSERT INTO j5_crew_worktree (thread_id, project_id, path, branch, created_at)
      VALUES ('thread:seat', 'project:one', '/wt/seat', 'j5/seat', '2026-10-27T00:00:00.000Z')
    `;
    const duplicate = yield* Effect.exit(sql`
        INSERT INTO j5_crew_worktree (thread_id, project_id, path, branch, created_at)
        VALUES ('thread:seat', 'project:one', '/wt/other', NULL, '2026-10-27T00:00:01.000Z')
      `);
    assert.strictEqual(duplicate._tag, "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
