import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect("folds the names already recorded, and from then on a folded name has one holder", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 35 });
    const person = (id: string, name: string | null, at: string, kind = "guest") => sql`
      INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at, kind, display_name)
      VALUES (${id}, ${kind === "member" ? 1 : 0}, ${at}, ${kind}, ${name})
    `;
    yield* person("human:operator", null, "2026-10-01T00:00:00.000Z", "member");
    yield* person("human:first", " SAM  Okafor ", "2026-10-02T00:00:00.000Z");
    yield* person("human:second", null, "2026-10-03T00:00:00.000Z");
    yield* person("human:other", "Marco", "2026-10-05T00:00:00.000Z");

    yield* runJ5A2AMigrations();

    assert.deepStrictEqual(
      yield* sql`
        SELECT person_id, display_name, name_key FROM j5_a2a_human_person ORDER BY created_at
      `,
      [
        { person_id: "human:operator", display_name: null, name_key: null },
        { person_id: "human:first", display_name: " SAM  Okafor ", name_key: "sam okafor" },
        { person_id: "human:second", display_name: null, name_key: null },
        { person_id: "human:other", display_name: "Marco", name_key: "marco" },
      ],
    );
    // From here the index refuses a second holder of a folded name, and allows any number of
    // people with none.
    const claim = (id: string, key: string | null) =>
      Effect.exit(sql`UPDATE j5_a2a_human_person SET name_key = ${key} WHERE person_id = ${id}`);
    assert.strictEqual((yield* claim("human:second", "sam okafor"))._tag, "Failure");
    assert.strictEqual((yield* claim("human:second", "marco"))._tag, "Failure");
    assert.strictEqual((yield* claim("human:second", "samuel"))._tag, "Success");
    assert.strictEqual((yield* claim("human:other", null))._tag, "Success");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
