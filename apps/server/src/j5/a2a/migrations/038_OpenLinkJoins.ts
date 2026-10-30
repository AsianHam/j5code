import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per join through an open link: a signed-in guest who opens a second link joins as
// themselves, so each link's list and cap count joins, not people. `joined_open_link_id` stays as
// the link that made a person's name self-given; earlier joins are that link's.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // No foreign key to the link: a link's record may go while the people who joined with it stay.
  yield* sql`
    CREATE TABLE j5_a2a_open_link_join (
      link_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (link_id, person_id)
    )
  `;
  yield* sql`
    CREATE INDEX j5_a2a_open_link_join_person_idx ON j5_a2a_open_link_join(person_id)
  `;
  yield* sql`
    INSERT INTO j5_a2a_open_link_join (link_id, person_id, joined_at)
    SELECT joined_open_link_id, person_id, created_at FROM j5_a2a_human_person
    WHERE joined_open_link_id IS NOT NULL
  `;
});
