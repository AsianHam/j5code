import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A link several people can join one thread with, view only (#541). It is J5's
// own token, kept as a hash: each person who opens it becomes a new guest with
// a View grant on the thread and an ordinary single-use share link of their own.
// It expires, and a member can revoke it, which stops new people joining.
//
// A person who joined this way typed their own name. It is marked as given by
// themselves until a member confirms or changes it, and the link they came
// through is kept so the people list can say who joined with it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_open_link (
      link_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;
  yield* sql`
    ALTER TABLE j5_a2a_human_person
    ADD COLUMN name_self_given INTEGER NOT NULL DEFAULT 0 CHECK (name_self_given IN (0, 1))
  `;
  // No foreign key: a link's record may go while the people who joined with it stay.
  yield* sql`ALTER TABLE j5_a2a_human_person ADD COLUMN joined_open_link_id TEXT`;
});
