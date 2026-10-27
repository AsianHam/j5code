import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A peer is another server this one exchanges agent messages with: its origin, the credential it
// issued us, and when that expires. The session we issued it lives in the auth database, and
// removing the peer revokes it there.
// TODO(Jacksondr5/j5code#282): the credential is stored in clear text, like the session tokens.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_peer (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      origin TEXT NOT NULL,
      credential TEXT NOT NULL,
      credential_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
