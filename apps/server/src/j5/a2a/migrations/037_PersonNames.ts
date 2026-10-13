import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A person's name is theirs alone on a server (Jackson, 2026-10-13).
//
// `name_key` is the name folded for comparing: compatibility-normalised, lower-cased, trimmed,
// with runs of whitespace made one space, so "jackson", " Jackson ", "JACKSON" and fullwidth
// letters are one name. The name is stored and shown as typed in `display_name`; a unique index
// on the key is what makes two people with one name impossible, however close together they are
// written. Look-alike letters across scripts are not caught.
//
// Names recorded before this are folded here. No release had a way to make a second person, so
// two people sharing a folded name is not provided for: the index would refuse to be created.
// The index leaves out people with no name.
//
// The fold is written out here and not imported, so this migration does the same thing whatever
// the server's own fold becomes.
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
