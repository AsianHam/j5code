import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// J5 adds no column to upstream's pairing link, so the guest a link was made for is recorded
// here, found again by a hash of the presented credential (what upstream holds when it issues the
// session). A row whose link upstream used, expired or revoked is inert. A grant keeps the
// optional line a member writes on what the guest is there for.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_guest_link (
      pairing_link_id TEXT PRIMARY KEY,
      credential_hash TEXT NOT NULL UNIQUE,
      person_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (person_id) REFERENCES j5_a2a_human_person(person_id) ON DELETE CASCADE
    )
  `;
  // A person's unused links are read by person.
  yield* sql`
    CREATE INDEX j5_a2a_guest_link_person_idx
    ON j5_a2a_guest_link(person_id)
  `;

  yield* sql`ALTER TABLE j5_a2a_person_grant ADD COLUMN note TEXT`;
});
