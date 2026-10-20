// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing keeps request comparison deterministic.
// @effect-diagnostics preferSchemaOverJson:off - canonical JSON is a digest input, not a persisted payload codec.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export class RequestReplayConflictError extends Schema.TaggedError<RequestReplayConflictError>()(
  "RequestReplayConflictError",
  { target: Schema.String, legacy: Schema.Boolean },
) {
  override get message() {
    return this.legacy
      ? `The original request for ${this.target} predates replay verification and cannot be compared. Inspect that target and use a fresh client_request_id for new work.`
      : `client_request_id is already bound to a different request for ${this.target}. Retry the original request, or use a fresh client_request_id for new work.`;
  }
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
};

export class RequestReplayService extends Context.Service<
  RequestReplayService,
  {
    readonly check: (
      id: string,
      request: unknown,
    ) => Effect.Effect<void, SqlError | RequestReplayConflictError>;
    /** Binds before side effects; an existing target without a binding cannot prove its intent. */
    readonly bind: (input: {
      readonly id: string;
      readonly target: string;
      readonly request: unknown;
      readonly legacy: boolean;
    }) => Effect.Effect<void, SqlError | RequestReplayConflictError>;
  }
>()("t3/j5/a2a/RequestReplayService") {}

export const layer = Layer.effect(
  RequestReplayService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const digestOf = (request: unknown) =>
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(canonical(request)))
        .digest("hex");
    const check: RequestReplayService["Service"]["check"] = Effect.fn("j5.requestReplay.check")(
      function* (id, request) {
        const rows = yield* sql<{ readonly target: string; readonly request_digest: string }>`
          SELECT target, request_digest FROM j5_a2a_request_replay WHERE id = ${id}
        `;
        const original = rows[0];
        if (original !== undefined && original.request_digest !== digestOf(request))
          return yield* new RequestReplayConflictError({ target: original.target, legacy: false });
      },
    );
    const bind: RequestReplayService["Service"]["bind"] = Effect.fn("j5.requestReplay.bind")(
      function* (input) {
        const digest = digestOf(input.request);
        if (!input.legacy) {
          yield* sql`
            INSERT INTO j5_a2a_request_replay (id, target, request_digest)
            VALUES (${input.id}, ${input.target}, ${digest})
            ON CONFLICT (id) DO NOTHING
          `;
        }
        const rows = yield* sql<{ readonly target: string; readonly request_digest: string }>`
          SELECT target, request_digest FROM j5_a2a_request_replay WHERE id = ${input.id}
        `;
        const original = rows[0];
        if (original === undefined || original.request_digest !== digest)
          return yield* new RequestReplayConflictError({
            target: original?.target ?? input.target,
            legacy: original === undefined,
          });
      },
      sql.withTransaction,
    );
    return RequestReplayService.of({ bind, check });
  }),
);
