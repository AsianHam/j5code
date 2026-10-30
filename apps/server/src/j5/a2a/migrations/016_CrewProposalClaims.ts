import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A resolution claims its proposal (`approving`, `declining`) before writing the final status, so
// two devices resolving one gate cannot undo each other; `reported_at` lets a boot sweep find a
// launch report never posted. The table is rebuilt to widen the CHECK, and proposals approved
// before this count as reported, so the sweep does not re-announce every past launch.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_agent_crew_proposal_next (
      id TEXT PRIMARY KEY,
      squadron_id TEXT NOT NULL,
      captain_participant_id TEXT NOT NULL,
      captain_thread_id TEXT NOT NULL,
      crew_instance_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('roster', 'addition')),
      status TEXT NOT NULL
        CHECK (status IN ('open', 'approving', 'declining', 'approved', 'declined')),
      brief TEXT NOT NULL,
      display_name TEXT NOT NULL,
      requested_seats TEXT NOT NULL,
      approved_seats TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      reported_at TEXT,
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO j5_agent_crew_proposal_next (
      id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind, status,
      brief, display_name, requested_seats, approved_seats, created_at, resolved_at, reported_at
    )
    SELECT
      id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind, status,
      brief, display_name, requested_seats, approved_seats, created_at, resolved_at,
      CASE WHEN status = 'approved' THEN resolved_at ELSE NULL END
    FROM j5_agent_crew_proposal
  `;
  yield* sql`DROP TABLE j5_agent_crew_proposal`;
  yield* sql`ALTER TABLE j5_agent_crew_proposal_next RENAME TO j5_agent_crew_proposal`;
  yield* sql`
    CREATE INDEX j5_agent_crew_proposal_open_idx
    ON j5_agent_crew_proposal(status, created_at)
  `;
});
