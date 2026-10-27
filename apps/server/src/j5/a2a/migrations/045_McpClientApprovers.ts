import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who approved an MCP client, against the session upstream issued it, so lowering or removing
// that Owner ends those sessions. Keyed by upstream's session id like `j5_a2a_person_session`, not
// a column on `auth_sessions`. Clients approved before this, or by an unnamed code, have no row.
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
