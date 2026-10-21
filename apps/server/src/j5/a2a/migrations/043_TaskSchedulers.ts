import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who scheduled a task (Shared conversations, scheduled runs): the person who created it, or who
// last changed its prompt, with the prompt as they left it. A run of the task on a shared thread
// is named as theirs only while the task's prompt is still that one, so a prompt an agent changed
// over MCP since names no one. A task an agent scheduled, or one from before this, has no row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_task_scheduler (
      task_id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
});
