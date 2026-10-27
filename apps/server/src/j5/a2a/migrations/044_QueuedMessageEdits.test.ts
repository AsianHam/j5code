import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect("keeps every ledger event and index while the log learns edits", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 43 });
    yield* sql`
      INSERT INTO j5_a2a_project_ledger (project_id, created_at)
      VALUES ('project:edits', '2026-10-24T00:00:00.000Z')
    `;
    const event = (seq: number, kind: string) => sql`
      INSERT INTO j5_a2a_comm_event (
        seq, project_id, kind, sender, receiver, exchange_id, correlation_id, payload, created_at,
        command_id
      ) VALUES (
        ${seq}, 'project:edits', ${kind}, 'agent:a', 'agent:b', NULL, 'correlation:edits',
        '{}', '2026-10-24T00:00:00.000Z', 'command:edits'
      )
    `;
    yield* event(1, "message.sent");
    const before = yield* sql`SELECT * FROM j5_a2a_comm_event ORDER BY seq`;
    const indexesBefore = yield* sql`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'j5_a2a_comm_event' ORDER BY name
    `;
    assert.strictEqual((yield* Effect.exit(event(2, "message.edited")))._tag, "Failure");

    yield* runJ5A2AMigrations();

    assert.deepStrictEqual(yield* sql`SELECT * FROM j5_a2a_comm_event ORDER BY seq`, before);
    assert.deepStrictEqual(
      yield* sql`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'j5_a2a_comm_event' ORDER BY name
      `,
      indexesBefore,
    );
    yield* event(2, "message.edited");
    assert.strictEqual((yield* Effect.exit(event(3, "message.rewritten")))._tag, "Failure");
    const deliveryColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('j5_a2a_delivery')
      WHERE name IN ('edited_by', 'edited_at') ORDER BY name
    `;
    assert.deepStrictEqual(
      deliveryColumns.map((column) => column.name),
      ["edited_at", "edited_by"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
