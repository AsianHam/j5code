import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest } from "../../../persistence/Migrations.ts";

const run = Migrator.make({});

/**
 * Upstream keeps its migration effects private, so load each by the file name its manifest entry
 * implies (`Migrations/<id padded to 3>_<name>.ts`). `recordedId` is the id the history records.
 */
const upstreamLoader = (
  entries: ReadonlyArray<readonly [number, string]>,
  recordedId: (id: number) => number = (id) => id,
): Migrator.Loader =>
  Effect.succeed(
    entries.map(([id, name]): Migrator.ResolvedMigration => [
      recordedId(id),
      name,
      Effect.promise(
        () => import(`../../../persistence/Migrations/${String(id).padStart(3, "0")}_${name}.ts`),
      ),
    ]),
  );

/**
 * The history J5 0.0.48 leaves behind (upstream pin `67a2be0fdb`): upstream's 1–53, then V2 at 54
 * and the index cleanup at 55. Upstream's `reconcileV2PreviewMigration` moves those two up by one
 * and records the new 054.
 */
export const pinMigrationHistory: ReadonlyArray<readonly [number, string]> = [
  ...migrationManifest.filter(([id]) => id <= 53),
  [54, "OrchestrationV2"],
  [55, "RemoveRedundantProjectionIndexes"],
];

/**
 * A database created at pin 67a2be0fdb: upstream's 1–53, then `54 = OrchestrationV2` and
 * `55 = RemoveRedundantProjectionIndexes`. Upstream's 055 and 056 are those two migrations
 * unchanged (the migration audit enforces this), so they reproduce the pin schema exactly.
 */
export const installPin = Effect.fn("test.installPin")(function* (
  createdAt = "2026-09-26 20:29:48",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* run({
    loader: upstreamLoader(
      migrationManifest.filter(([id]) => id <= 53 || id === 55 || id === 56),
      (id) => (id >= 55 ? id - 1 : id),
    ),
  });
  yield* sql`UPDATE effect_sql_migrations SET created_at = ${createdAt}`;
});

/** Where each retired history recorded V2, after upstream's migrations below that id. */
export const retiredHistories = [
  ["August", 41],
  ["September", 48],
  ["pin 62aef8587c", 51],
] as const;

/** The recorded history of a retired database. Its V2 tables are not rebuilt: it is only refused. */
export const installRetired = Effect.fn("test.installRetired")(function* (v2Id: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* run({ loader: upstreamLoader(migrationManifest.filter(([id]) => id < v2Id)) });
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${v2Id}, 'OrchestrationV2')`;
});
