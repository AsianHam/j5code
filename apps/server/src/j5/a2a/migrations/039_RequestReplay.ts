import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No target foreign key: deleting an operation must not free its retry key for other work.
  yield* sql`
    CREATE TABLE j5_a2a_request_replay (
      id TEXT PRIMARY KEY NOT NULL,
      target TEXT NOT NULL,
      request_digest TEXT NOT NULL
    )
  `;
});
