import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect("records each person who joined by an open link as one join of that link", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 37 });
    const person = (id: string, link: string | null, at: string) => sql`
      INSERT INTO j5_a2a_human_person (
        person_id, is_local_operator, created_at, kind, display_name, joined_open_link_id
      ) VALUES (${id}, 0, ${at}, 'guest', ${id}, ${link})
    `;
    yield* person("human:named", null, "2026-10-01T00:00:00.000Z");
    yield* person("human:joined", "link-a", "2026-10-02T00:00:00.000Z");

    yield* runJ5A2AMigrations();

    assert.deepStrictEqual(
      yield* sql`SELECT link_id, person_id, joined_at FROM j5_a2a_open_link_join`,
      [{ link_id: "link-a", person_id: "human:joined", joined_at: "2026-10-02T00:00:00.000Z" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
