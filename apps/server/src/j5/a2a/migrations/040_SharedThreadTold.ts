import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What the agent of a shared conversation has been told about who can write to
// its thread (#533). When the people who can write differ from what it was last
// told, a platform note goes at the top of the next message a person sends.
// That message is the note's carrier, and both are kept with the message's
// author: `note` is the text, so a client can show the message without it and
// an edit of the message keeps it; `told_json` is who the note said can write,
// and the carrier it was worked out against. What the agent was last told is
// the newest carrier that reached it, so a carrier withdrawn before it ran, or
// rewound past, is one the agent was never told by.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE j5_a2a_message_author ADD COLUMN note TEXT`;
  yield* sql`ALTER TABLE j5_a2a_message_author ADD COLUMN told_json TEXT`;
});
