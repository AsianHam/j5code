import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A machine participant is a registered non-agent sender (a cron job, a watchdog, a script). It
// sends and never receives, and has no thread, so it stays out of the agent-only membership
// projection. The ledger's `participant.joined` stays the source of truth; the send path reads
// this projection.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_machine_participant (
      participant_id TEXT PRIMARY KEY CHECK (participant_id LIKE 'machine:%'),
      squadron_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      joined_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX j5_a2a_machine_participant_squadron_idx
    ON j5_a2a_machine_participant(squadron_id, participant_id)
  `;
});
