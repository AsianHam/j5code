import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Share links: bringing a guest in.
//
// `j5_a2a_guest_link` says which guest a pairing link was made for. Upstream's
// pairing link carries a subject and scopes and nothing about a person, and J5
// adds no column to upstream's table, so the person is recorded here beside it.
// The row is found again when the link is used, by a hash of the credential the
// person presents: that is what upstream's pairing code holds at the moment it
// issues the session. The link's own id is kept so the people list can show a
// link that has not been used yet. A row whose link upstream has since used,
// expired or revoked is inert, since that credential pairs nothing.
//
// A grant also keeps the optional line a member writes when sharing, saying
// what the guest is there for (Shared conversations AC6).
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
