import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Shared server: members, guests and grants. A person is a member unless a
// member brought them in as a guest; every person recorded before this is the
// server's own operator, so the default is `member`. A guest has a display
// name, given by the member who made their share link.
//
// A grant is what gives a guest access: one project or one thread, at one
// level. One row per person and target, so two grants on the same thread
// cannot disagree; a thread grant and a project grant can overlap, and the
// reader takes the higher.
//
// `j5_a2a_person_session` ties an upstream auth session to a person. It is
// keyed by upstream's session id and lives here, not as a column on
// `auth_sessions`: J5 migrations never run in upstream's lane, and upstream
// has dropped and recreated its auth tables before (its migration 031). A row
// whose session upstream has since removed is inert, since that session can no
// longer connect.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE j5_a2a_human_person
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'guest'))
  `;
  yield* sql`ALTER TABLE j5_a2a_human_person ADD COLUMN display_name TEXT`;

  yield* sql`
    CREATE TABLE j5_a2a_person_grant (
      person_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'thread')),
      target_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('view', 'collaborate')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (person_id, target_kind, target_id),
      FOREIGN KEY (person_id) REFERENCES j5_a2a_human_person(person_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE j5_a2a_person_session (
      session_id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      FOREIGN KEY (person_id) REFERENCES j5_a2a_human_person(person_id) ON DELETE CASCADE
    )
  `;
  // A person's devices are read by person.
  yield* sql`
    CREATE INDEX j5_a2a_person_session_person_idx
    ON j5_a2a_person_session(person_id)
  `;

  // Access to a thread walks up from it to the thread a grant names, one
  // membership read by thread per step.
  yield* sql`
    CREATE INDEX IF NOT EXISTS j5_a2a_membership_thread_idx
    ON j5_a2a_membership(thread_id)
  `;
});
