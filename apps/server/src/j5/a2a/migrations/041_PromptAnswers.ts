import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who answered an agent's prompt in a shared conversation (#533): a thread a
// guest holds Collaborate on. The first answer settles a prompt, and the
// settled prompt shows who gave it. The name is kept as it was when they
// answered. A thread only one person can write to records nothing here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // An approval or a question, by upstream's request id. `decision` is what an approval was
  // answered with; a question has none. `settled` is set once upstream's log shows the answer
  // settled the prompt. An approval is told to the agent in the note at the top of the next
  // message a person sends: `told_message_id` is that message, and `told_delivered` is set
  // once the message is known to have reached the agent, and from the start for an approval
  // answered while the thread was not shared, which the agent is never told of. The row is written before upstream
  // takes the answer, so it is there when the prompt is seen to settle; `command_id` is the
  // answer it was written for, by which it is taken back if upstream refuses that answer.
  yield* sql`
    CREATE TABLE j5_a2a_prompt_answer (
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      person_kind TEXT NOT NULL CHECK (person_kind IN ('member', 'guest')),
      display_name TEXT,
      command_id TEXT NOT NULL,
      answered_at TEXT NOT NULL,
      decision TEXT,
      settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
      told_message_id TEXT,
      told_delivered INTEGER NOT NULL DEFAULT 0 CHECK (told_delivered IN (0, 1)),
      PRIMARY KEY (thread_id, request_id)
    )
  `;
  // A Crew roster: who approved or declined it, as the Captain is told.
  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN decided_by TEXT`;
});
