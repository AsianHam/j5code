import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The peer wire now names a project where it named a Squadron (peer protocol 2). Stored roster
// snapshots are the JSON the peer sent, so they are renamed in place to keep the peer's agents
// listed until it next sends its roster.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE j5_a2a_peer
    SET roster_json = (
      SELECT json_group_array(
        json(
          json_remove(
            json_set(
              agent.value,
              '$.projectId', json_extract(agent.value, '$.squadronId'),
              '$.projectTitle', json_extract(agent.value, '$.squadronName')
            ),
            '$.squadronId', '$.squadronName'
          )
        )
      )
      FROM json_each(j5_a2a_peer.roster_json) AS agent
    )
    WHERE roster_json IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM json_each(j5_a2a_peer.roster_json) AS agent
        WHERE json_type(agent.value, '$.squadronId') IS NOT NULL
      )
  `;
});
