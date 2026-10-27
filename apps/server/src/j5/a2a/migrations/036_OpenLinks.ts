import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A view-only link several people can join one thread with. J5's own token, kept as a hash: each
// joiner becomes a guest with a View grant and a single-use share link of their own. A joiner's
// name is marked self-given until a member confirms it, and their link is kept for the people
// list.
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
