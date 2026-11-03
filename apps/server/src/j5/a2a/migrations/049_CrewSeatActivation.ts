import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_crew_seat_context (
      thread_id TEXT PRIMARY KEY,
      first_turn_text TEXT NOT NULL,
      workspace TEXT NOT NULL,
      delivered_roster TEXT,
      delivered_conversation TEXT,
      agent_display_name TEXT
    )
  `;
  yield* sql`
    INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace, delivered_roster)
    SELECT member.thread_id, '', '{"type":"shared"}', (
      SELECT json_group_array(json_object(
        'seat', roster.seat_name, 'participantId', roster.participant_id,
        'agentDisplayName', coalesce(roster.agent_id, 'custom'), 'reason', roster.reason
      )) FROM j5_agent_crew_member AS roster WHERE roster.crew_instance_id = member.crew_instance_id
    ) FROM j5_agent_crew_member AS member
  `;
});
