/**
 * Records `j5.fleet.snapshot` every fifteen minutes: how many threads are working at once, how
 * many of them an agent started, how big the live Crews are, how many asks are waiting, how many
 * agents and pull requests the open threads have, and how much the server is shared and peered.
 * The boot heartbeat only counts threads and projects, which says nothing about a fleet.
 *
 * Every number is a count read from the projections and J5's own tables; no ids or names.
 *
 * @module FleetSnapshot
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";

const SNAPSHOT_INTERVAL = Duration.minutes(15);

const Snapshot = Schema.Struct({
  openThreads: Schema.Number,
  workingThreads: Schema.Number,
  workingAgentStartedThreads: Schema.Number,
  queuedRuns: Schema.Number,
  liveCrews: Schema.Number,
  largestCrewSeats: Schema.Number,
  openAsksToPerson: Schema.Number,
  openAsksToAgents: Schema.Number,
  threadsWithChildren: Schema.Number,
  children: Schema.Number,
  mostChildren: Schema.Number,
  threadsWithPullRequests: Schema.Number,
  pullRequests: Schema.Number,
  mostPullRequests: Schema.Number,
  guests: Schema.Number,
  sharedThreads: Schema.Number,
  sharedProjects: Schema.Number,
  liveOpenLinks: Schema.Number,
  peerServers: Schema.Number,
});
const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot);

export interface FleetSnapshotShape {
  /** Reads the fleet's current counts and records them. */
  readonly record: Effect.Effect<void>;
}

export class FleetSnapshot extends Context.Service<FleetSnapshot, FleetSnapshotShape>()(
  "t3/j5/analytics/FleetSnapshot",
) {}

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    FleetSnapshot,
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      const sql = yield* SqlClient.SqlClient;

      const record = Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        // A run holds its thread from `preparing` until it ends; `queued` waits behind another.
        // A thread's children are the subagents in its lineage (delegated tasks and the
        // provider's own) and the agents it spawned, Crew seats included.
        const rows = yield* sql`
          WITH open_thread AS (
            SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
            WHERE archived_at IS NULL AND deleted_at IS NULL
          ),
          working AS (
            SELECT DISTINCT run.thread_id
            FROM orchestration_v2_projection_runs AS run
            WHERE run.status IN ('preparing', 'starting', 'running', 'waiting')
          ),
          crew_seats AS (
            SELECT COUNT(*) AS seats
            FROM j5_agent_crew_member AS member
            JOIN j5_agent_crew_instance AS crew ON crew.id = member.crew_instance_id
            WHERE crew.archived_at IS NULL
            GROUP BY member.crew_instance_id
          ),
          child AS (
            SELECT json_extract(payload_json, '$.lineage.parentThreadId') AS parent_id, thread_id
            FROM orchestration_v2_projection_threads
            WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
            UNION
            SELECT
              substr(provenance_participant_id, length('agent:j5:a2a:') + 1),
              substr(participant_id, length('agent:j5:a2a:') + 1)
            FROM j5_a2a_participant_placement
            WHERE provenance_kind = 'spawned-by'
              AND provenance_participant_id LIKE 'agent:j5:a2a:%'
              AND participant_id LIKE 'agent:j5:a2a:%'
          ),
          children AS (
            SELECT COUNT(*) AS n
            FROM child JOIN open_thread ON open_thread.thread_id = child.parent_id
            GROUP BY child.parent_id
          ),
          pull_requests AS (
            SELECT json_array_length(payload_json, '$.pullRequests') AS n
            FROM open_thread
            WHERE json_array_length(payload_json, '$.pullRequests') > 0
          )
          SELECT
            (SELECT COUNT(*) FROM open_thread) AS "openThreads",
            (SELECT COUNT(*) FROM working) AS "workingThreads",
            (
              SELECT COUNT(*)
              FROM working
              JOIN orchestration_v2_projection_threads AS thread
                ON thread.thread_id = working.thread_id
              WHERE json_extract(thread.payload_json, '$.createdBy') = 'agent'
            ) AS "workingAgentStartedThreads",
            (
              SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status = 'queued'
            ) AS "queuedRuns",
            (
              SELECT COUNT(*) FROM j5_agent_crew_instance WHERE archived_at IS NULL
            ) AS "liveCrews",
            (SELECT COALESCE(MAX(seats), 0) FROM crew_seats) AS "largestCrewSeats",
            (
              SELECT COUNT(*) FROM j5_a2a_exchange
              WHERE status = 'open' AND receiver_id LIKE 'human:%'
            ) AS "openAsksToPerson",
            (
              SELECT COUNT(*) FROM j5_a2a_exchange
              WHERE status = 'open' AND receiver_id NOT LIKE 'human:%'
            ) AS "openAsksToAgents",
            (SELECT COUNT(*) FROM children) AS "threadsWithChildren",
            (SELECT COALESCE(SUM(n), 0) FROM children) AS "children",
            (SELECT COALESCE(MAX(n), 0) FROM children) AS "mostChildren",
            (SELECT COUNT(*) FROM pull_requests) AS "threadsWithPullRequests",
            (SELECT COALESCE(SUM(n), 0) FROM pull_requests) AS "pullRequests",
            (SELECT COALESCE(MAX(n), 0) FROM pull_requests) AS "mostPullRequests",
            (SELECT COUNT(*) FROM j5_a2a_human_person WHERE kind = 'guest') AS "guests",
            (
              SELECT COUNT(DISTINCT target_id) FROM j5_a2a_person_grant
              WHERE target_kind = 'thread'
            ) AS "sharedThreads",
            (
              SELECT COUNT(DISTINCT target_id) FROM j5_a2a_person_grant
              WHERE target_kind = 'project'
            ) AS "sharedProjects",
            (
              SELECT COUNT(*) FROM j5_a2a_open_link
              WHERE revoked_at IS NULL AND expires_at > ${now}
            ) AS "liveOpenLinks",
            (SELECT COUNT(*) FROM j5_a2a_peer) AS "peerServers"
        `;
        yield* analytics.record("j5.fleet.snapshot", yield* decodeSnapshot(rows[0]));
      }).pipe(
        Effect.withSpan("j5.analytics.fleetSnapshot"),
        Effect.catchCause((cause) => Effect.logWarning("J5 fleet snapshot skipped", { cause })),
      );

      if (daemon)
        yield* Effect.sleep(SNAPSHOT_INTERVAL).pipe(
          Effect.andThen(record),
          Effect.forever,
          Effect.forkScoped,
        );

      return FleetSnapshot.of({ record });
    }),
  );

/** For tests, which take the snapshot themselves. */
export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
