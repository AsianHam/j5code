import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A person's name is theirs alone on a server: a unique index on `name_key` (the name folded:
// NFKC, lower-cased, whitespace collapsed) refuses a second person with it; look-alike letters
// across scripts are not caught. No release could make a second person, so existing names are
// not de-duplicated. The fold is inlined so this migration never follows the server's own.
const fold = (name: string) =>
  name.normalize("NFKC").toLowerCase().normalize("NFKC").trim().replace(/\s+/gu, " ");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE j5_a2a_human_person ADD COLUMN name_key TEXT`;

  const named = yield* sql<{ readonly person_id: string; readonly display_name: string }>`
    SELECT person_id, display_name FROM j5_a2a_human_person
    WHERE display_name IS NOT NULL
  `;
  for (const person of named) {
    yield* sql`
      UPDATE j5_a2a_human_person SET name_key = ${fold(person.display_name)}
      WHERE person_id = ${person.person_id}
    `;
  }

  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_human_person_name_key_idx
    ON j5_a2a_human_person(name_key)
    WHERE name_key IS NOT NULL
  `;
});
