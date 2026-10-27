import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One delivery row per step a Crew's playbook run lands on, keyed by the request that caused it,
 * so a retry never delivers twice. Not tied to `j5_playbook_request`, whose prune trigger drops
 * movement requests when a run ends: these rows stay for `j5_playbook_current` and Fleet.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN crew_instance_id TEXT`;
  yield* sql`CREATE INDEX j5_playbook_run_crew ON j5_playbook_run(crew_instance_id, status)`;
  yield* sql`CREATE TABLE j5_playbook_step_delivery (
    run_id TEXT NOT NULL REFERENCES j5_playbook_run(run_id),
    request_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    landed_at TEXT NOT NULL,
    target_seat TEXT,
    target_thread_id TEXT,
    outcome TEXT CHECK (outcome IN ('delivered', 'captain', 'skipped')),
    resolved_at TEXT,
    PRIMARY KEY (run_id, request_id)
  )`;
  yield* sql`CREATE INDEX j5_playbook_step_delivery_pending
    ON j5_playbook_step_delivery(landed_at) WHERE resolved_at IS NULL`;
  yield* sql`CREATE INDEX j5_playbook_step_delivery_run
    ON j5_playbook_step_delivery(run_id, landed_at)`;
});
