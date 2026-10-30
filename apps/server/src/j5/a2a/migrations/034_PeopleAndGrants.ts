import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every person recorded before this is the operator, so a person defaults to `member`. One grant
// row per person and target keeps two grants on a thread from disagreeing; a reader takes the
// higher of a thread and a project grant. `j5_a2a_person_session` lives here, not on upstream's
// `auth_sessions`, because upstream has dropped and recreated its auth tables before.
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
