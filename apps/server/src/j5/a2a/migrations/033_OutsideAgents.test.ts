import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

const AT = "2026-10-12T00:00:00.000Z";

it.effect("keeps one name per outside agent, keyed by its participant id", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 32 });
    assert.lengthOf(yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'j5_a2a_outside_agent'`, 0);

    yield* runJ5A2AMigrations();

    const insert = (participantId: string, name: string) => sql`
      INSERT INTO j5_a2a_outside_agent (participant_id, name, created_at)
      VALUES (${participantId}, ${name}, ${AT})
    `;
    yield* insert("outside:session-1", "Claude Code");
    // Two sign-ins with the same label are two participants with the same name.
    yield* insert("outside:session-2", "Claude Code");
    assert.isTrue((yield* Effect.exit(insert("outside:session-1", "Again")))._tag === "Failure");
    // Only an outside agent's id is kept here.
    assert.isTrue((yield* Effect.exit(insert("machine:watchdog", "watchdog")))._tag === "Failure");
    assert.isTrue((yield* Effect.exit(insert("outside:", "No session")))._tag === "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT participant_id, name FROM j5_a2a_outside_agent ORDER BY participant_id`,
      [
        { participant_id: "outside:session-1", name: "Claude Code" },
        { participant_id: "outside:session-2", name: "Claude Code" },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
