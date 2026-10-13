import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who the agent of a shared conversation was last told can write to its thread
// (#533). When the people who can write differ from this record, a platform
// note goes at the top of the next message a person sends, and that message is
// recorded here as the note's carrier. If the carrier is withdrawn before it
// runs, the agent was never told: the record falls back to `previous_json`, what
// it had been told before. A thread that was never shared has no row.
//
// The note a message carries is kept with the message's author, so a client
// can show the message without it and an edit of the message keeps it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_shared_thread_told (
      thread_id TEXT PRIMARY KEY,
      writers_json TEXT NOT NULL,
      previous_json TEXT,
      carrier_message_id TEXT NOT NULL,
      told_at TEXT NOT NULL
    )
  `;
  yield* sql`ALTER TABLE j5_a2a_message_author ADD COLUMN note TEXT`;
});
