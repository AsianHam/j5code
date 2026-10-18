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

  // Who sent each message a person wrote while the thread was shared, with the name and level
  // they had then (People and access AC47), so a message stays under its author after they are
  // renamed, lose access or are removed. No foreign key to the person for the same reason.
  // `stored_prefix` is exactly the platform's text the stored message begins with, for a client
  // to strip; `''` for a command, which goes on as typed. `note` is the platform's note this
  // message carries to the agent, and `told_json` who that note said can write: what the agent
  // was last told is the newest carrier that reached it.
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
  yield* sql`
    CREATE TABLE j5_a2a_prompt_answer (
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      display_name TEXT,
      level TEXT NOT NULL CHECK (level IN ('owner', 'collaborator')),
      answered_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, request_id, command_id)
    )
  `;

  // A Crew roster: who approved or declined it, as its Captain is told (AC11).
  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN decided_by TEXT`;
});
