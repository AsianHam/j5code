import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Both CHECKs below reserve participant.reparented for a future human-reparent surface; nothing
  // produces it yet. Recovery from the frozen chain 8fb7139d16 follows R21 and the A6 ticket.
  yield* sql`
    CREATE TABLE j5_a2a_placement_event (
      seq INTEGER NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      squadron_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'participant.placement_created',
        'participant.reparented'
      )),
      actor TEXT NOT NULL CHECK (actor IN ('human', 'agent', 'platform')),
      actor_session_id TEXT,
      actor_subject TEXT,
      auth_method TEXT CHECK (auth_method IN (
        'browser-session-cookie',
        'bearer-access-token',
        'dpop-access-token'
      )),
      provenance_kind TEXT CHECK (provenance_kind IN (
        'spawned-by',
        'forked-from',
        'unknown'
      )),
      provenance_participant_id TEXT,
      provenance_source TEXT CHECK (provenance_source IN (
        'upstream_lineage',
        'j5_spawn'
      )),
      previous_parent_id TEXT,
      placement_parent_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (squadron_id, seq),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE RESTRICT,
      CHECK (
        (kind = 'participant.reparented'
          AND actor = 'human'
          AND actor_session_id IS NOT NULL
          AND actor_subject IS NOT NULL
          AND length(trim(actor_subject)) > 0
          AND auth_method = 'browser-session-cookie'
          AND provenance_kind IS NULL
          AND provenance_participant_id IS NULL
          AND provenance_source IS NULL)
        OR
        (kind = 'participant.placement_created'
          AND actor_session_id IS NULL
          AND actor_subject IS NULL
          AND auth_method IS NULL
          AND previous_parent_id IS NULL
          AND provenance_kind IS NOT NULL
          AND (
            (provenance_kind = 'unknown'
              AND provenance_participant_id IS NULL
              AND provenance_source IS NULL)
            OR
            (provenance_kind = 'spawned-by'
              AND provenance_participant_id IS NOT NULL
              AND provenance_source IN ('upstream_lineage', 'j5_spawn'))
            OR
            (provenance_kind = 'forked-from'
              AND provenance_participant_id IS NOT NULL
              AND provenance_source = 'upstream_lineage')
          ))
      )
    )
  `;
  yield* sql`
    CREATE INDEX j5_a2a_placement_event_participant_idx
    ON j5_a2a_placement_event(squadron_id, participant_id, seq)
  `;

  yield* sql`
    CREATE TABLE j5_a2a_participant_placement (
      squadron_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      provenance_kind TEXT NOT NULL CHECK (provenance_kind IN (
        'spawned-by',
        'forked-from',
        'unknown'
      )),
      provenance_participant_id TEXT,
      provenance_source TEXT CHECK (provenance_source IN ('upstream_lineage', 'j5_spawn')),
      placement_parent_id TEXT,
      created_event_seq INTEGER NOT NULL CHECK (created_event_seq > 0),
      updated_event_seq INTEGER NOT NULL CHECK (updated_event_seq >= created_event_seq),
      PRIMARY KEY (squadron_id, participant_id),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE,
      CHECK (
        (provenance_kind = 'unknown'
          AND provenance_participant_id IS NULL
          AND provenance_source IS NULL)
        OR
        (provenance_kind = 'spawned-by'
          AND provenance_participant_id IS NOT NULL
          AND provenance_source IN ('upstream_lineage', 'j5_spawn'))
        OR
        (provenance_kind = 'forked-from'
          AND provenance_participant_id IS NOT NULL
          AND provenance_source = 'upstream_lineage')
      )
    )
  `;
  yield* sql`
    CREATE INDEX j5_a2a_participant_placement_parent_idx
    ON j5_a2a_participant_placement(squadron_id, placement_parent_id)
  `;
});
