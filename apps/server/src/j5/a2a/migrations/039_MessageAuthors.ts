import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who sent each message a person wrote in a shared conversation (#533): a
// thread a guest holds Collaborate on. The name is kept as it was when the
// message was sent, so a message stays under its author's name after that
// person is renamed, loses access or is removed. A thread only one person can
// write to records nothing here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // No foreign key to the person: a removed guest's messages keep their author.
  yield* sql`
    CREATE TABLE j5_a2a_message_author (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      person_kind TEXT NOT NULL CHECK (person_kind IN ('member', 'guest')),
      display_name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;
});
