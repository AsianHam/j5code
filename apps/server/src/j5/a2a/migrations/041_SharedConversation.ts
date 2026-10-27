import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Shared conversations (docs/j5/product/features/shared-conversations.md): a thread more than one
// person can write to. A thread only one person has ever been able to write to records nothing
// here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The threads that have been shared conversations, which they stay (AC6). A row is written
  // when a change of access gives a thread a second writer, and when a person's message reaches
  // a thread that has one, so a thread started under a scope already shared is shared from its
  // first message.
  yield* sql`
    CREATE TABLE j5_a2a_shared_thread (
      thread_id TEXT PRIMARY KEY,
      shared_at TEXT NOT NULL
    )
  `;

  // Who sent each message written while the thread was shared, with their name and level then,
  // so it stays theirs after a rename or removal (hence no foreign key). `stored_prefix` is the
  // platform text a client strips (`''` for a command); `note` and `told_json` are what the agent
  // was told about who can write, the newest carrier that reached it winning.
  yield* sql`
    CREATE TABLE j5_a2a_message_author (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      display_name TEXT,
      level TEXT NOT NULL CHECK (level IN ('owner', 'collaborator')),
      edited_by TEXT,
      note TEXT,
      told_json TEXT,
      stored_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;

  // A person's answer to an approval or a question, by upstream's request id and the command
  // that carried it. Written as the answer is taken in, before upstream settles the prompt, so it
  // is a claim: who answered is the claim whose command upstream's event log shows settled it.
  // `stored_prefix` is the mark the platform put on a question's answer, `''` for none.
  yield* sql`
    CREATE TABLE j5_a2a_prompt_answer (
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      display_name TEXT,
      level TEXT NOT NULL CHECK (level IN ('owner', 'collaborator')),
      stored_prefix TEXT NOT NULL,
      answered_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, request_id, command_id)
    )
  `;

  // A Crew roster: who approved or declined it, as its Captain is told (AC10).
  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN decided_by TEXT`;
});
