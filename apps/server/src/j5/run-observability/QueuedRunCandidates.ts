import { OrchestrationV2RunJson, type OrchestrationV2Run, type RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";

export interface CandidateCursor {
  readonly requestedAt: DateTime.Utc;
  readonly runId: RunId;
}
export interface CandidateQuery {
  readonly status: "starting";
  readonly requestedBefore: DateTime.Utc;
  readonly after?: CandidateCursor;
  readonly limit: number;
}
export class CandidateReadError extends Schema.TaggedError<CandidateReadError>()(
  "CandidateReadError",
  { cause: Schema.Defect() },
) {}
export class QueuedRunCandidates extends Context.Service<
  QueuedRunCandidates,
  {
    readonly list: (
      input: CandidateQuery,
    ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, CandidateReadError>;
  }
>()("t3/j5/run-observability/QueuedRunCandidates") {}

type PayloadRow = { readonly payload_json: string };

export const candidateStatement = (sql: SqlClient.SqlClient, input: CandidateQuery) => {
  const requestedBefore = DateTime.formatIso(input.requestedBefore);
  if (input.after === undefined) {
    return sql<PayloadRow>`
      SELECT r.payload_json
      FROM orchestration_v2_projection_runs AS r
      INNER JOIN orchestration_v2_projection_threads AS t ON t.thread_id = r.thread_id
      WHERE r.status = ${input.status}
        AND r.requested_at <= ${requestedBefore}
        AND t.archived_at IS NULL
        AND t.deleted_at IS NULL
      ORDER BY r.requested_at ASC, r.run_id ASC
      LIMIT ${input.limit}
    `;
  }
  const afterRequestedAt = DateTime.formatIso(input.after.requestedAt);
  return sql<PayloadRow>`
    SELECT r.payload_json
    FROM orchestration_v2_projection_runs AS r
    INNER JOIN orchestration_v2_projection_threads AS t ON t.thread_id = r.thread_id
    WHERE r.status = ${input.status}
      AND r.requested_at <= ${requestedBefore}
      AND (r.requested_at > ${afterRequestedAt}
        OR (r.requested_at = ${afterRequestedAt} AND r.run_id > ${input.after.runId}))
      AND t.archived_at IS NULL
      AND t.deleted_at IS NULL
    ORDER BY r.requested_at ASC, r.run_id ASC
    LIMIT ${input.limit}
  `;
};

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
export const layer = Layer.effect(
  QueuedRunCandidates,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    return QueuedRunCandidates.of({
      list: Effect.fn("QueuedRunCandidates.list")(function (input) {
        return candidateStatement(sql, input).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.payload_json))),
          Effect.mapError((cause) => new CandidateReadError({ cause })),
        );
      }),
    });
  }),
);
