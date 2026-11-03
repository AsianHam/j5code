import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'human' CHECK (approval_mode IN ('human', 'automatic'))`;
  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN refusal_detail TEXT`;
});
