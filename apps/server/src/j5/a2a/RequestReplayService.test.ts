import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "./migrations/039_RequestReplay.ts";
import { RequestReplayService, layer } from "./RequestReplayService.ts";

it.effect("persists the original request across database reopen and refuses changed reuse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(yield* fs.makeTempDirectoryScoped(), "replay.sqlite");
    const first = {
      id: "spawn:1",
      target: "agent:original",
      request: { brief: "first", workspace: { type: "shared" }, omitted: undefined },
      legacy: false,
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* migration;
        yield* (yield* RequestReplayService).bind(first);
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))))),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const replay = yield* RequestReplayService;
        yield* replay.bind({
          ...first,
          legacy: true,
          request: { workspace: { type: "shared" }, brief: "first" },
        });
        const changed = yield* replay
          .bind({ ...first, target: "agent:changed", request: { brief: "different" } })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(changed));
        if (Result.isFailure(changed)) {
          assert.equal(changed.failure._tag, "RequestReplayConflictError");
          assert.include(changed.failure.message, "agent:original");
          assert.include(changed.failure.message, "fresh client_request_id");
        }
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM j5_a2a_request_replay`;
        assert.equal(rows[0]?.count, 1);
        yield* replay.check("new-key", {});
        assert.isTrue(Result.isFailure(yield* replay.check(first.id, {}).pipe(Effect.result)));
        const legacy = yield* replay
          .bind({ ...first, id: "legacy", legacy: true })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(legacy));
        if (Result.isFailure(legacy))
          assert.include(legacy.failure.message, "predates replay verification");
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))))),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
