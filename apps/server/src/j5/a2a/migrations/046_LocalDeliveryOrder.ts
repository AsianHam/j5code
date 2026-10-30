import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Messages reach a local agent in accept order across projects. `sent_seq` is per ledger and
// `created_at` ties within a millisecond, so each row takes the next `accept_order`. A recheck
// while held is not a transport failure, so it is counted apart from the attempts that alarm.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN accept_order INTEGER`;
  yield* sql`
    WITH ordered AS (
      SELECT project_id, message_id,
        ROW_NUMBER() OVER (ORDER BY created_at, sent_seq, project_id, message_id) AS ordinal
      FROM j5_a2a_delivery
    )
    UPDATE j5_a2a_delivery SET accept_order = ordered.ordinal
    FROM ordered
    WHERE ordered.project_id = j5_a2a_delivery.project_id
      AND ordered.message_id = j5_a2a_delivery.message_id
  `;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_delivery_accept_order_idx ON j5_a2a_delivery (accept_order)
  `;
  yield* sql`
    CREATE INDEX j5_a2a_delivery_local_waiting_idx
    ON j5_a2a_delivery (receiver_id, accept_order)
    WHERE receiver_environment_id IS NULL AND status IN ('pending', 'retry_scheduled')
  `;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN held_attempts INTEGER NOT NULL DEFAULT 0`;
  // Whether the latest attempt was held, so a wake retries it early and leaves a row backing off
  // after a transport failure to its schedule. Rows from before this wait for their recheck.
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN last_held INTEGER NOT NULL DEFAULT 0`;
  // A row already waiting may have spent attempts on rechecks while held, which earlier counted
  // toward its alarm. It starts with a fresh transport budget instead.
  yield* sql`
    UPDATE j5_a2a_delivery SET held_attempts = attempts
    WHERE status IN ('pending', 'retry_scheduled')
  `;
});
