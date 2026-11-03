import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The Inbox approval an archive files for the worktrees it kept: one row per item, open until
 * `decided_at` is set. An archive (the Crew's `archived_at`) has at most one item, so running it
 * again files nothing, while a Crew restored and archived again files its own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_crew_worktree_cleanup (
      id TEXT PRIMARY KEY,
      crew_instance_id TEXT NOT NULL,
      crew_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      captain_thread_id TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      filed_at TEXT NOT NULL,
      decided_at TEXT,
      entries_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX j5_crew_worktree_cleanup_crew
    ON j5_crew_worktree_cleanup (crew_instance_id, archived_at)
  `;
});
