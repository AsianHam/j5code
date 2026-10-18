import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// People and access (docs/j5/product/features/people-and-access.md): members and guests become
// people who each hold a level at a scope.
//
// `j5_a2a_person_level` replaces the guest's grant. A grant on a project or thread becomes a level
// at the same scope, View as Viewer and Collaborate as Collaborator; the line a member wrote when
// sharing goes, as the definitions retired it. The server's own operator, `is_local_operator`, is
// the first owner and holds Owner at server scope; nothing lowers or removes it.
//
// Every live session upstream holds that no guest was paired with belongs to the first owner
// (AC7). Its permissions as they stand become its ceiling, which a new session for it never
// exceeds (AC18). The sessions of agents, peer servers and the CLI are no one's device, and stay
// unbound. Upstream's auth tables are read and not changed, except that the guest links nobody
// used are revoked there: they are retired, and would otherwise look live in Connections.
//
// Unused links of either old kind stop working, and their count is kept for a notice Owners see.
// Whoever already joined keeps what they had.
//
// The fold of a name and its unique index (037) stay as they were.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const table = (name: string) =>
    sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}
    `.pipe(Effect.map((rows) => rows.length > 0));
  const hasSessions = yield* table("auth_sessions");
  const hasPairingLinks = yield* table("auth_pairing_links");

  yield* sql`
    CREATE TABLE j5_a2a_person_level (
      person_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('server', 'project', 'thread')),
      scope_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('viewer', 'collaborator', 'owner')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (person_id, scope_kind, scope_id),
      FOREIGN KEY (person_id) REFERENCES j5_a2a_human_person(person_id) ON DELETE CASCADE,
      CHECK ((scope_kind = 'server') = (scope_id = '')),
      CHECK (level <> 'owner' OR scope_kind = 'server')
    )
  `;
  // Who reaches a project or a thread is read by scope.
  yield* sql`
    CREATE INDEX j5_a2a_person_level_scope_idx
    ON j5_a2a_person_level(scope_kind, scope_id)
  `;

  // The first owner. Every server that has run since migration 006 recorded one at startup; one
  // that never ran gets theirs, with its level, when it first starts (`HumanPersonRegistry`).
  const operators = yield* sql<{ readonly person_id: string }>`
    SELECT person_id FROM j5_a2a_human_person WHERE is_local_operator = 1
  `;
  const firstOwner = operators[0]?.person_id;
  if (firstOwner !== undefined) {
    yield* sql`
      INSERT INTO j5_a2a_person_level
        (person_id, scope_kind, scope_id, level, created_at, updated_at)
      VALUES (${firstOwner}, 'server', '', 'owner', ${now}, ${now})
    `;
  }

  yield* sql`
    INSERT INTO j5_a2a_person_level
      (person_id, scope_kind, scope_id, level, created_at, updated_at)
    SELECT grant_row.person_id, grant_row.target_kind, grant_row.target_id,
      CASE grant_row.level WHEN 'view' THEN 'viewer' ELSE 'collaborator' END,
      grant_row.created_at, grant_row.updated_at
    FROM j5_a2a_person_grant AS grant_row
    JOIN j5_a2a_human_person AS person
      ON person.person_id = grant_row.person_id AND person.kind = 'guest'
  `;

  // A device's binding gains the ceiling it was paired with, and the mark J5 sets when it ends
  // the session so that the device can renew it.
  yield* sql`ALTER TABLE j5_a2a_person_session ADD COLUMN ceiling_scopes TEXT`;
  yield* sql`ALTER TABLE j5_a2a_person_session ADD COLUMN renew_pending_since TEXT`;
  if (hasSessions && firstOwner !== undefined) {
    yield* sql`
      INSERT INTO j5_a2a_person_session (session_id, person_id, bound_at, ceiling_scopes)
      SELECT session.session_id, ${firstOwner}, ${now}, session.scopes
      FROM auth_sessions AS session
      WHERE session.revoked_at IS NULL
        AND session.expires_at > ${now}
        AND session.subject NOT LIKE 'peer:%'
        AND session.subject NOT IN ('mcp-client', 'cli-issued-session', 'j5:guest')
        AND NOT EXISTS (
          SELECT 1 FROM j5_a2a_person_session AS bound
          WHERE bound.session_id = session.session_id
        )
    `;
  }

  // The links nobody used, retired: share links still waiting upstream, and open links still
  // open. Open links are J5's own token and need nothing more than their record going.
  const unusedShareLinks = hasPairingLinks
    ? yield* sql<{ readonly id: string }>`
        SELECT link.id
        FROM j5_a2a_guest_link AS guest_link
        JOIN auth_pairing_links AS link ON link.id = guest_link.pairing_link_id
        WHERE link.consumed_at IS NULL AND link.revoked_at IS NULL AND link.expires_at > ${now}
      `
    : [];
  const openLinks = yield* sql<{ readonly link_id: string }>`
    SELECT link_id FROM j5_a2a_open_link WHERE revoked_at IS NULL AND expires_at > ${now}
  `;
  for (const link of unusedShareLinks) {
    yield* sql`UPDATE auth_pairing_links SET revoked_at = ${now} WHERE id = ${link.id}`;
  }
  yield* sql`
    CREATE TABLE j5_a2a_sharing_notice (
      kind TEXT PRIMARY KEY CHECK (kind IN ('links_retired')),
      count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  const retired = unusedShareLinks.length + openLinks.length;
  if (retired > 0) {
    yield* sql`
      INSERT INTO j5_a2a_sharing_notice (kind, count, created_at)
      VALUES ('links_retired', ${retired}, ${now})
    `;
  }

  // Which person a pairing credential pairs, found when upstream issues the session from it, by
  // a hash of the credential, as the guest's link was. Written for a J5 link as it is opened, for
  // a link made in Connections, and by `j5 pair --person`.
  yield* sql`
    CREATE TABLE j5_a2a_pairing_intent (
      pairing_link_id TEXT PRIMARY KEY,
      credential_hash TEXT NOT NULL UNIQUE,
      person_id TEXT NOT NULL,
      link_id TEXT,
      ceiling_scopes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (person_id) REFERENCES j5_a2a_human_person(person_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX j5_a2a_pairing_intent_person_idx ON j5_a2a_pairing_intent(person_id)
  `;

  yield* sql`DROP TABLE j5_a2a_person_grant`;
  yield* sql`DROP TABLE j5_a2a_guest_link`;
  yield* sql`DROP TABLE j5_a2a_open_link_join`;
  yield* sql`DROP TABLE j5_a2a_open_link`;
  yield* sql`ALTER TABLE j5_a2a_human_person DROP COLUMN kind`;
  yield* sql`ALTER TABLE j5_a2a_human_person DROP COLUMN name_self_given`;
  yield* sql`ALTER TABLE j5_a2a_human_person DROP COLUMN joined_open_link_id`;
  // A person an Owner removed stays, so the messages they wrote keep their name (AC21, AC47),
  // but holds nothing, and their name is free for someone else.
  yield* sql`ALTER TABLE j5_a2a_human_person ADD COLUMN removed_at TEXT`;
});
