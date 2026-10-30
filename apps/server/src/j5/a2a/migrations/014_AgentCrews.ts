import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A Crew groups the seats a Captain proposed and a human approved, so they archive as one unit;
// every later seat passes the same gate and bumps the instance version. A participant sits in at
// most one Crew. An earlier cut of these tables existed on one development database, so this
// first drops any earlier-shaped crews tables to land that database on the same schema.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS j5_agent_crew_proposal`;
  yield* sql`DROP TABLE IF EXISTS j5_agent_crew_member`;
  yield* sql`DROP TABLE IF EXISTS j5_agent_crew_instance`;

  yield* sql`
    CREATE TABLE j5_agent_crew_instance (
      id TEXT PRIMARY KEY,
      squadron_id TEXT NOT NULL,
      captain_participant_id TEXT NOT NULL,
      captain_thread_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      brief TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      created_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX j5_agent_crew_instance_captain_idx
    ON j5_agent_crew_instance(squadron_id, captain_participant_id)
  `;

  yield* sql`
    CREATE TABLE j5_agent_crew_member (
      crew_instance_id TEXT NOT NULL,
      seat_name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      participant_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      added_version INTEGER NOT NULL CHECK (added_version >= 1),
      reason TEXT,
      PRIMARY KEY (crew_instance_id, seat_name),
      FOREIGN KEY (crew_instance_id) REFERENCES j5_agent_crew_instance(id) ON DELETE CASCADE
    )
  `;

  // A proposal is the human gate: the Captain's requested seats, the decision, and what was
  // actually approved (the human may add seats). Initial rosters have no instance yet.
  yield* sql`
    CREATE TABLE j5_agent_crew_proposal (
      id TEXT PRIMARY KEY,
      squadron_id TEXT NOT NULL,
      captain_participant_id TEXT NOT NULL,
      captain_thread_id TEXT NOT NULL,
      crew_instance_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('roster', 'addition')),
      status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'declined')),
      brief TEXT NOT NULL,
      display_name TEXT NOT NULL,
      requested_seats TEXT NOT NULL,
      approved_seats TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX j5_agent_crew_proposal_open_idx
    ON j5_agent_crew_proposal(status, created_at)
  `;
});
