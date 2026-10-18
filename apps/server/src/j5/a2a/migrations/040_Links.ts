import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The one kind of link (People and access AC31 to AC43). Its token is kept as it was made, so an
// Owner can copy the link again until it expires, is revoked or, for one person, is used.
//
// A `device` link pairs one more device for someone already on the server, and stores no scope
// or level: their device follows what they hold. An `invite` brings someone in at its scope and
// level, which the join applies to the person it creates; a link for many is a Viewer's. The
// name an invite offers is only offered: the person is made when the link is used.
//
// Who joined with a link is kept beside it, a person once per link.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_link (
      link_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('device', 'invite')),
      scope_kind TEXT CHECK (scope_kind IN ('server', 'project', 'thread')),
      scope_id TEXT,
      level TEXT CHECK (level IN ('viewer', 'collaborator', 'owner')),
      use TEXT NOT NULL CHECK (use IN ('one', 'many')),
      person_id TEXT,
      offered_name TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      used_at TEXT,
      FOREIGN KEY (person_id) REFERENCES j5_a2a_human_person(person_id),
      CHECK (
        (kind = 'device' AND use = 'one' AND person_id IS NOT NULL AND scope_kind IS NULL
          AND scope_id IS NULL AND level IS NULL AND offered_name IS NULL)
        OR (kind = 'invite' AND person_id IS NULL AND scope_kind IS NOT NULL
          AND scope_id IS NOT NULL AND level IS NOT NULL)
      ),
      CHECK (scope_kind IS NULL OR (scope_kind = 'server') = (scope_id = '')),
      CHECK (level IS NULL OR level <> 'owner' OR scope_kind = 'server'),
      CHECK (use = 'one' OR (level = 'viewer' AND offered_name IS NULL))
    )
  `;
  yield* sql`CREATE INDEX j5_a2a_link_person_idx ON j5_a2a_link(person_id)`;

  // No foreign key to the link or the person: either may go while the record of the join stays.
  yield* sql`
    CREATE TABLE j5_a2a_link_join (
      link_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (link_id, person_id)
    )
  `;
});
