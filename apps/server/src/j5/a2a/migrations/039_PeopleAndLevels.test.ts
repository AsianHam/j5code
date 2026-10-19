import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ensureLocalOperatorHumanPerson } from "../HumanPersonRegistry.ts";
import { runJ5A2AMigrations } from "../Migrations.ts";

const AT = "2026-10-01T00:00:00.000Z";
const LIVE = "2999-01-01T00:00:00.000Z";
const GONE = "2000-01-01T00:00:00.000Z";

// Upstream's two auth tables as the 3238 advance has them, with the columns this migration reads.
const upstreamAuthTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY, subject TEXT NOT NULL, scopes TEXT NOT NULL,
      method TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE auth_pairing_links (
      id TEXT PRIMARY KEY, credential TEXT NOT NULL UNIQUE, method TEXT NOT NULL,
      scopes TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT
    )
  `;
});

it.effect("moves people, grants, devices and links onto levels", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-10-18T00:00:00.000Z"));
    yield* upstreamAuthTables;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 38 });

    const person = (id: string, operator: 0 | 1, kind: "member" | "guest", name: string) => sql`
      INSERT INTO j5_a2a_human_person (
        person_id, is_local_operator, created_at, kind, display_name, name_key
      ) VALUES (${id}, ${operator}, ${AT}, ${kind}, ${name}, ${name.toLowerCase()})
    `;
    yield* person("human:owner", 1, "member", "Jackson");
    // A person migration 006 found in the ledger, a member with an inbox.
    yield* person("human:member", 0, "member", "Maria");
    yield* person("human:viewer", 0, "guest", "Priya");
    yield* person("human:collaborator", 0, "guest", "Sam");
    const grant = (id: string, kind: string, target: string, level: string) => sql`
      INSERT INTO j5_a2a_person_grant (
        person_id, target_kind, target_id, level, created_at, updated_at, note
      ) VALUES (${id}, ${kind}, ${target}, ${level}, ${AT}, ${AT}, 'here for the plan')
    `;
    yield* grant("human:viewer", "thread", "thread:billing", "view");
    yield* grant("human:collaborator", "project", "project:website", "collaborate");

    const session = (
      id: string,
      subject: string,
      expiresAt = LIVE,
      revokedAt: string | null = null,
    ) =>
      sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
        VALUES (${id}, ${subject}, '["orchestration:read"]', 'browser-session-cookie', ${AT},
          ${expiresAt}, ${revokedAt})
      `;
    yield* session("session:laptop", "one-time-token");
    yield* session("session:desktop", "desktop-bootstrap");
    yield* session("session:revoked", "one-time-token", LIVE, AT);
    yield* session("session:expired", "one-time-token", GONE);
    yield* session("session:peer", "peer:environment-1");
    yield* session("session:agent", "mcp-client");
    yield* session("session:bot", "cli-issued-session");
    yield* session("session:machine", "machine:ci-runner");
    yield* session("session:guest", "j5:guest");
    yield* sql`
      INSERT INTO j5_a2a_person_session (session_id, person_id, bound_at)
      VALUES ('session:guest', 'human:viewer', ${AT})
    `;

    const pairingLink = (id: string, consumedAt: string | null) => sql`
      INSERT INTO auth_pairing_links (
        id, credential, method, scopes, subject, created_at, expires_at, consumed_at
      ) VALUES (${id}, ${id}, 'one-time-token', '[]', 'j5:guest', ${AT}, ${LIVE}, ${consumedAt})
    `;
    yield* pairingLink("pairing:unused", null);
    yield* pairingLink("pairing:used", AT);
    for (const id of ["pairing:unused", "pairing:used"]) {
      yield* sql`
        INSERT INTO j5_a2a_guest_link (pairing_link_id, credential_hash, person_id, created_at)
        VALUES (${id}, ${id}, 'human:collaborator', ${AT})
      `;
    }
    const openLink = (id: string, revokedAt: string | null) => sql`
      INSERT INTO j5_a2a_open_link (link_id, token_hash, thread_id, created_at, expires_at, revoked_at)
      VALUES (${id}, ${id}, 'thread:billing', ${AT}, ${LIVE}, ${revokedAt})
    `;
    yield* openLink("open:live", null);
    yield* openLink("open:revoked", AT);

    yield* runJ5A2AMigrations();

    assert.deepStrictEqual(
      yield* sql`
        SELECT person_id, scope_kind, scope_id, level FROM j5_a2a_person_level
        ORDER BY person_id
      `,
      [
        {
          person_id: "human:collaborator",
          scope_kind: "project",
          scope_id: "project:website",
          level: "collaborator",
        },
        { person_id: "human:member", scope_kind: "server", scope_id: "", level: "owner" },
        { person_id: "human:owner", scope_kind: "server", scope_id: "", level: "owner" },
        {
          person_id: "human:viewer",
          scope_kind: "thread",
          scope_id: "thread:billing",
          level: "viewer",
        },
      ],
    );
    // Live devices that were nobody's guest are the first owner's, with what they hold as their
    // ceiling; the guest's device stays theirs; agents, peers and the CLI belong to no one.
    assert.deepStrictEqual(
      yield* sql`
        SELECT session_id, person_id, ceiling_scopes, renew_pending_since
        FROM j5_a2a_person_session ORDER BY session_id
      `,
      [
        {
          session_id: "session:desktop",
          person_id: "human:owner",
          ceiling_scopes: '["orchestration:read"]',
          renew_pending_since: null,
        },
        {
          session_id: "session:guest",
          person_id: "human:viewer",
          ceiling_scopes: null,
          renew_pending_since: null,
        },
        {
          session_id: "session:laptop",
          person_id: "human:owner",
          ceiling_scopes: '["orchestration:read"]',
          renew_pending_since: null,
        },
      ],
    );
    // People keep their names; the old kinds of person and link are gone.
    assert.deepStrictEqual(
      yield* sql`SELECT person_id, display_name FROM j5_a2a_human_person ORDER BY person_id`,
      [
        { person_id: "human:collaborator", display_name: "Sam" },
        { person_id: "human:member", display_name: "Maria" },
        { person_id: "human:owner", display_name: "Jackson" },
        { person_id: "human:viewer", display_name: "Priya" },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'j5_a2a_person_grant', 'j5_a2a_guest_link', 'j5_a2a_open_link', 'j5_a2a_open_link_join'
        )
      `,
      [],
    );
    // The share link nobody used is revoked upstream; the used one is left as it was.
    assert.deepStrictEqual(
      yield* sql`SELECT id, revoked_at IS NOT NULL AS revoked FROM auth_pairing_links ORDER BY id`,
      [
        { id: "pairing:unused", revoked: 1 },
        { id: "pairing:used", revoked: 0 },
      ],
    );
    // One unused share link and one open link were retired.
    assert.deepStrictEqual(yield* sql`SELECT kind, count FROM j5_a2a_sharing_notice`, [
      { kind: "links_retired", count: 2 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves a server that never ran to record its first owner when it starts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations();
    assert.lengthOf(yield* sql`SELECT 1 FROM j5_a2a_human_person`, 0);
    yield* ensureLocalOperatorHumanPerson(sql);
    assert.deepStrictEqual(
      yield* sql`
        SELECT person.is_local_operator, held.scope_kind, held.level
        FROM j5_a2a_human_person AS person
        JOIN j5_a2a_person_level AS held ON held.person_id = person.person_id
      `,
      [{ is_local_operator: 1, scope_kind: "server", level: "owner" }],
    );
    assert.lengthOf(yield* sql`SELECT 1 FROM j5_a2a_sharing_notice`, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
