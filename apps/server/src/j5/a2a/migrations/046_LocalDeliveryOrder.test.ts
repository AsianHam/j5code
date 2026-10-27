import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect(
  "orders existing deliveries by acceptance and gives waiting ones a fresh retry budget",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runJ5A2AMigrations({ toMigrationInclusive: 45 });
      for (const project of ["project:busy", "project:fresh"]) {
        yield* sql`
        INSERT INTO j5_a2a_project_ledger (project_id, created_at)
        VALUES (${project}, '2026-10-24T00:00:00.000Z')
      `;
      }
      const delivery = (row: {
        readonly project: string;
        readonly message: string;
        readonly seq: number;
        readonly status: string;
        readonly attempts: number;
        readonly createdAt: string;
      }) => sql`
      INSERT INTO j5_a2a_delivery (
        project_id, message_id, command_id, sent_seq, sender_id, receiver_id, receiver_project_id,
        exchange_role, correlation_id, message_text, status, attempts, created_at, updated_at,
        envelope_channel
      ) VALUES (
        ${row.project}, ${row.message}, 'command:upgrade', ${row.seq}, 'agent:sender',
        'agent:receiver', 'project:busy', 'none', 'correlation:upgrade', 'An update',
        ${row.status}, ${row.attempts}, ${row.createdAt}, ${row.createdAt}, 'peer'
      )
    `;
      // Held twice before the upgrade, which counted toward its alarm then.
      yield* delivery({
        project: "project:busy",
        message: "message:held",
        seq: 11,
        status: "retry_scheduled",
        attempts: 2,
        createdAt: "2026-10-24T00:00:01.000Z",
      });
      yield* delivery({
        project: "project:fresh",
        message: "message:delivered",
        seq: 1,
        status: "delivered",
        attempts: 1,
        createdAt: "2026-10-24T00:00:00.000Z",
      });
      yield* delivery({
        project: "project:fresh",
        message: "message:later",
        seq: 2,
        status: "pending",
        attempts: 0,
        createdAt: "2026-10-24T00:00:02.000Z",
      });

      yield* runJ5A2AMigrations();

      assert.deepStrictEqual(
        yield* sql<{
          readonly message_id: string;
          readonly accept_order: number;
          readonly held_attempts: number;
        }>`
        SELECT message_id, accept_order, held_attempts FROM j5_a2a_delivery ORDER BY accept_order
      `,
        [
          { message_id: "message:delivered", accept_order: 1, held_attempts: 0 },
          { message_id: "message:held", accept_order: 2, held_attempts: 2 },
          { message_id: "message:later", accept_order: 3, held_attempts: 0 },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
