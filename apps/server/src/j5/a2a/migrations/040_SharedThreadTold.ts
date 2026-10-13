import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who the agent of a shared conversation was last told can write to its thread
// (#533). The agent is told again, in one platform note, when the people who
// can write differ from this record. A thread that was never shared has no row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_shared_thread_told (
      thread_id TEXT PRIMARY KEY,
      writers_json TEXT NOT NULL,
      told_at TEXT NOT NULL
    )
  `;
});
