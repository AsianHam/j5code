import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who approved an MCP client (People and access, D33): the person whose device or pairing code
// approved it, against the session upstream issued it. Lowering or removing that person as an
// Owner ends the sessions recorded for them. Keyed by upstream's session id, as
// `j5_a2a_person_session` is, rather than a column on upstream's `auth_sessions`. A client
// approved before this, or by a code that names no one, has no row and is ended by hand.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_mcp_client_approver (
      session_id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX j5_a2a_mcp_client_approver_person
    ON j5_a2a_mcp_client_approver (person_id)
  `;
});
