import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The worktrees J5 itself created for Crew seats, one row per seat thread. The row outlives the
 * checkout: a seat that is unarchived, repaired and archived again is looked at again, and a
 * worktree with no row (every worktree from before this table) is never removed by J5.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_crew_worktree (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT,
      created_at TEXT NOT NULL
    )
  `;
});
