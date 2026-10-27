import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A queued message can be edited by a person or by its sending agent. The delivery row carries
// the new text, its editor, and the orchestration event that carried it, so a replayed earlier
// event never overwrites it; a claim names the command's issuer, since the queue's own event names
// no one. The event log is rebuilt to widen its CHECK, no row changed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const indexes = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'j5_a2a_comm_event' AND sql IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE j5_a2a_comm_event_edits_new (
      seq INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'exchange.opened',
        'message.sent',
        'message.received',
        'message.delivered',
        'message.delivery_failed',
        'message.cancelled',
        'message.edited',
        'exchange.closed',
        'exchange.dropped',
        'silence.notice',
        'participant.joined',
        'participant.left',
        'participant.archived',
        'participant.unarchived',
        'participant.deleted'
      )),
      sender TEXT,
      receiver TEXT,
      exchange_id TEXT,
      correlation_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      command_id TEXT,
      PRIMARY KEY (project_id, seq),
      FOREIGN KEY (project_id) REFERENCES j5_a2a_project_ledger(project_id) ON DELETE RESTRICT,
      CHECK (kind <> 'message.received' OR correlation_id IS NOT NULL)
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_comm_event_edits_new (
      seq, project_id, kind, sender, receiver, exchange_id, correlation_id, payload, created_at,
      command_id
    )
    SELECT
      seq, project_id, kind, sender, receiver, exchange_id, correlation_id, payload, created_at,
      command_id
    FROM j5_a2a_comm_event
  `;
  yield* sql`DROP TABLE j5_a2a_comm_event`;
  yield* sql`ALTER TABLE j5_a2a_comm_event_edits_new RENAME TO j5_a2a_comm_event`;
  for (const index of indexes) {
    yield* sql.unsafe(index.sql);
  }

  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN edited_by TEXT`;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN edited_at TEXT`;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN edit_source_sequence INTEGER`;

  yield* sql`
    CREATE TABLE j5_a2a_queued_edit_claim (
      command_id TEXT PRIMARY KEY,
      editor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
