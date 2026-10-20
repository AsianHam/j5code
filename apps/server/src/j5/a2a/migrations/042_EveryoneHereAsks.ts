import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// An agent's ask to everyone here (Inbox AC15, AC16): its receiver is one reserved person id, and
// it is in the inbox of everyone who can write to the asking agent's thread when it is read. The
// first reply closes it for all of them. This keeps who gave that reply, by the name they had
// then, for the others' Replied shelf; its key is what refuses a second reply.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_everyone_answer (
      project_id TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      display_name TEXT,
      answered_at TEXT NOT NULL,
      PRIMARY KEY (project_id, exchange_id)
    )
  `;
});
