import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "./migrations/047_RequestReplay.ts";
import * as RequestReplayService from "./RequestReplayService.ts";

it.effect("persists the original request across database reopen and refuses changed reuse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(yield* fs.makeTempDirectoryScoped(), "replay.sqlite");
    const first = {
      id: "spawn:1",
      target: "agent:original",
      request: { brief: "first", workspace: { type: "shared" }, omitted: undefined },
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* migration;
        yield* (yield* RequestReplayService.RequestReplayService).bind(first);
      }).pipe(
        Effect.provide(
          RequestReplayService.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))),
        ),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const replay = yield* RequestReplayService.RequestReplayService;
        yield* replay.bind({
          ...first,
          request: { workspace: { type: "shared" }, brief: "first" },
        });
        const changed = yield* replay
          .bind({ ...first, target: "agent:changed", request: { brief: "different" } })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(changed));
        if (Result.isFailure(changed)) {
          assert.equal(changed.failure._tag, "RequestReplayConflictError");
          assert.equal(
            changed.failure.message,
            "client_request_id is already bound to a different request for agent:original. Retry the original request, or use a fresh client_request_id for new work.",
          );
        }
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM j5_a2a_request_replay`;
        assert.equal(rows[0]?.count, 1);
        yield* replay.check("new-key", {});
        assert.isTrue(Result.isFailure(yield* replay.check(first.id, {}).pipe(Effect.result)));
        // A key from before binding existed binds its first retry, then holds it like any other.
        const legacy = { ...first, id: "pre-upgrade", target: "agent:pre-upgrade" };
        yield* replay.check(legacy.id, legacy.request);
        yield* replay.bind(legacy);
        yield* replay.bind(legacy);
        const changedLegacy = yield* replay
          .bind({ ...legacy, request: { brief: "different" } })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(changedLegacy));
        if (Result.isFailure(changedLegacy))
          assert.equal(changedLegacy.failure._tag, "RequestReplayConflictError");
      }).pipe(
        Effect.provide(
          RequestReplayService.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
