import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who answered an agent's prompt in a shared conversation (#533): a thread a
// guest holds Collaborate on. The first answer settles a prompt, and the
// settled prompt shows who gave it. The name is kept as it was when they
// answered. A thread only one person can write to records nothing here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A person's answer to an approval or a question, by upstream's request id and the command
  // that carried the answer. It is written as the answer is taken in, before upstream settles
  // the prompt, so it is a claim: who answered a prompt is the claim whose command upstream's
  // event log shows settled it. `decision` is what an approval was answered with; a question
  // has none. An approval is told to the agent in the note at the top of the next message a
  // person sends: `told_message_id` is that message. `silent` marks one answered while the
  // thread was not shared, which the agent is never told of.
  yield* sql`
    CREATE TABLE j5_a2a_prompt_answer (
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      person_kind TEXT NOT NULL CHECK (person_kind IN ('member', 'guest')),
      display_name TEXT,
      answered_at TEXT NOT NULL,
      decision TEXT,
      silent INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1)),
      told_message_id TEXT,
      PRIMARY KEY (thread_id, request_id, command_id)
    )
  `;
  // A Crew roster: who approved or declined it, as the Captain is told.
  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN decided_by TEXT`;
});
