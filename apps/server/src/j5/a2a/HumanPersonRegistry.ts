// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing for deterministic ids and digests.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ParticipantId } from "./contracts.ts";

interface HumanPersonRow {
  readonly person_id: string;
}

export class A2ALocalOperatorNotFoundError extends Schema.TaggedError<A2ALocalOperatorNotFoundError>()(
  "A2ALocalOperatorNotFoundError",
  {},
) {
  override get message(): string {
    return "The host-local human operator registry entry is missing.";
  }
}

// Who writes to every thread: the first owner, and the people who hold Collaborator or Owner at
// server scope.
const WIDE_WRITER = `
  j5_a2a_human_person.is_local_operator = 1 OR EXISTS (
    SELECT 1 FROM j5_a2a_person_level AS held
    WHERE held.person_id = j5_a2a_human_person.person_id
      AND held.scope_kind = 'server'
      AND held.level IN ('collaborator', 'owner')
  )
`;

/**
 * The people an agent can address and who have an inbox on this server: those who can write to
 * every thread (Inbox AC14). Someone whose scope is narrower is a person too, and is absent here.
 */
export const listRegisteredHumanPersonIds = Effect.fn(
  "j5.a2a.humanPersonRegistry.listRegisteredHumanPersonIds",
)(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<HumanPersonRow>`
    SELECT person_id
    FROM j5_a2a_human_person
    WHERE (${sql.literal(WIDE_WRITER)})
    ORDER BY person_id
  `;
  return rows.map((row) => ParticipantId.make(row.person_id));
});

/** The names of those people, by person id; none for one with no name. */
export const listRegisteredHumanPersonNames = Effect.fn(
  "j5.a2a.humanPersonRegistry.listRegisteredHumanPersonNames",
)(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{ readonly person_id: string; readonly display_name: string }>`
    SELECT person_id, display_name
    FROM j5_a2a_human_person
    WHERE (${sql.literal(WIDE_WRITER)}) AND display_name IS NOT NULL
  `;
  return new Map(rows.map((row) => [row.person_id, row.display_name]));
});

/** Whether the id is one of those people; false for anyone narrower, as for an unknown id. */
export const isRegisteredHumanPerson = Effect.fn(
  "j5.a2a.humanPersonRegistry.isRegisteredHumanPerson",
)(function* (sql: SqlClient.SqlClient, personId: ParticipantId) {
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_human_person
    WHERE person_id = ${personId} AND (${sql.literal(WIDE_WRITER)})
  `;
  return (rows[0]?.count ?? 0) === 1;
});

export const getLocalOperatorHumanPersonId = Effect.fn(
  "j5.a2a.humanPersonRegistry.getLocalOperatorHumanPersonId",
)(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<HumanPersonRow>`
    SELECT person_id
    FROM j5_a2a_human_person
    WHERE is_local_operator = 1
    LIMIT 2
  `;
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) return yield* new A2ALocalOperatorNotFoundError();
  return ParticipantId.make(row.person_id);
});

export const ensureLocalOperatorHumanPerson = Effect.fn(
  "j5.a2a.humanPersonRegistry.ensureLocalOperatorHumanPerson",
)(function* (sql: SqlClient.SqlClient) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql<HumanPersonRow>`
        SELECT person_id
        FROM j5_a2a_human_person
        WHERE is_local_operator = 1
        LIMIT 1
      `;
      if (existing[0] !== undefined) return ParticipantId.make(existing[0].person_id);

      const personId = ParticipantId.make(`human:${NodeCrypto.randomUUID()}`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${personId}, 1, ${createdAt})
        ON CONFLICT DO NOTHING
      `;
      const firstOwner = yield* getLocalOperatorHumanPersonId(sql);
      // The first owner is the server's Owner from the start (People and access AC2, AC51).
      yield* sql`
        INSERT INTO j5_a2a_person_level
          (person_id, scope_kind, scope_id, level, created_at, updated_at)
        VALUES (${firstOwner}, 'server', '', 'owner', ${createdAt}, ${createdAt})
        ON CONFLICT DO NOTHING
      `;
      return firstOwner;
    }),
  );
});

/** Runtime startup mints one durable host-local operator without project state. */
export const humanPersonRegistryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureLocalOperatorHumanPerson(sql);
  }),
);
