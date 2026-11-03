import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect(
  "adds the cleanup table with one item per archive of a Crew, and is safe to run again",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runJ5A2AMigrations({ toMigrationInclusive: 50 });
      yield* runJ5A2AMigrations();
      yield* runJ5A2AMigrations();

      assert.deepStrictEqual(yield* sql`SELECT * FROM j5_crew_worktree_cleanup`, []);
      const file = (id: string, crew: string, archivedAt = "2026-10-26T00:00:00.000Z") => sql`
      INSERT INTO j5_crew_worktree_cleanup (
        id, crew_instance_id, crew_name, project_id, captain_thread_id, archived_at, filed_at,
        entries_json
      )
      VALUES (
        ${id}, ${crew}, 'Crew', 'project:one', 'thread:captain', ${archivedAt},
        '2026-10-27T00:00:00.000Z', '[]'
      )
    `;
      yield* file("cleanup:1", "crew:one");
      yield* file("cleanup:2", "crew:two");
      yield* sql`UPDATE j5_crew_worktree_cleanup SET decided_at = '2026-10-27T01:00:00.000Z' WHERE id = 'cleanup:1'`;
      const again = yield* Effect.exit(file("cleanup:3", "crew:one"));
      assert.strictEqual(again._tag, "Failure");
      // The Crew archived a second time is a new archive.
      yield* file("cleanup:4", "crew:one", "2026-10-28T00:00:00.000Z");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
