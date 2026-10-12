import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// An outside agent (an MCP client signed in through OAuth) joins no ledger, so
// no `participant.joined` event carries its name. This keeps the label it
// signed in with beside its participant id, for the envelope that names it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_a2a_outside_agent (
      participant_id TEXT PRIMARY KEY CHECK (participant_id LIKE 'outside:_%'),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
