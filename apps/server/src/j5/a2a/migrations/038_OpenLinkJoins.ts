import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Each time a person joins a thread through an open link (#614). A guest already signed in who
// opens a second link joins that link's thread as themselves, so one person can come through
// several links, and each link's list of who came through it, and its cap, count them.
//
// `j5_a2a_human_person.joined_open_link_id` stays: it is the link a person first came to the
// server through, which is what made their name one they gave themselves. The joins recorded
// before this are that link's.
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
