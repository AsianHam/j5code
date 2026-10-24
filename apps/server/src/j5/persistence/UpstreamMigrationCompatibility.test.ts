// @effect-diagnostics nodeBuiltinImport:off - fixtures read database files directly.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import { layerFromPath } from "../../persistence/Sqlite.ts";
import { migrationEntries as j5MigrationEntries, runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { migrationSnapshotPath } from "./MigrationSnapshot.ts";
import { runJ5CompatibleUpstreamMigrations } from "./UpstreamMigrationCompatibility.ts";
import {
  installPin,
  installRetired,
  pinMigrationHistory,
  retiredHistories,
} from "./test-support/historicalMigrations.ts";

const memory = () => NodeSqliteClient.layer({ filename: ":memory:" });
const atFile = (filename: string) => NodeSqliteClient.layer({ filename });
const ids = (rows: ReadonlyArray<readonly [number, string]>) => rows.map(([id]) => id);
/** A pin database runs upstream's new 054 and every migration after the renumbered 055–056. */
const pinUpgradeIds = [54, ...ids(migrationManifest).filter((id) => id > 56)];

const readHistory = Effect.fn("readHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});
const readManifest = Effect.fn("readManifest")(function* () {
  return (yield* readHistory()).map(({ migration_id, name }) => [migration_id, name] as const);
});

const readSchema = Effect.fn("readSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
});
const upstreamOnly = (rows: ReadonlyArray<Record<string, unknown>>) =>
  rows.filter((row) => !String(row.name).includes("j5_"));
const freshSchema = () =>
  Effect.gen(function* () {
    yield* runMigrations();
    return yield* readSchema();
  }).pipe(Effect.provide(memory()));

const assertRefused = Effect.fn("assertRefused")(function* (message: RegExp) {
  const before = yield* readSchema();
  const history = yield* readHistory();
  const exit = yield* Effect.exit(runJ5CompatibleUpstreamMigrations());
  assert.isTrue(Exit.isFailure(exit));
  if (Exit.isFailure(exit)) assert.match(Cause.pretty(exit.cause), message);
  assert.deepStrictEqual(yield* readHistory(), history);
  assert.deepStrictEqual(yield* readSchema(), before);
});

const PIN_CREATED_AT = "2026-09-26 20:29:48";

const seedJ5AndV2State = Effect.fn("seedJ5AndV2State")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runJ5A2AMigrations();
  yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at)
    VALUES ('project-keep', '2026-09-10T12:00:00Z')`;
  yield* sql`INSERT INTO j5_a2a_exchange
    (project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at)
    VALUES ('project-keep', 'exchange:keep', 'agent:sender', 'human:receiver', 'open',
      'Preserve this obligation', 1, '2026-09-10T12:00:00Z', '2026-09-10T12:00:00Z')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id)
    VALUES ('native:keep', 'thread:keep', 'codex', 'ready', '2026-09-10T12:00:00Z',
      '{"nativeThreadId":"native:keep"}', 'codex', 'codex')`;
  yield* sql`INSERT INTO orchestration_v2_events
    (event_id, thread_id, event_type, occurred_at, payload_json, driver, provider_instance_id)
    VALUES ('event:keep', 'thread:keep', 'test.keep', '2026-09-10', '{"keep":true}', 'codex', 'codex')`;
});

const snapshotRows = Effect.fn("snapshotRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    ledgers: yield* sql`SELECT * FROM j5_a2a_project_ledger ORDER BY project_id`,
    exchanges: yield* sql`SELECT * FROM j5_a2a_exchange ORDER BY exchange_id`,
    j5Migrations: yield* sql`SELECT * FROM j5_a2a_migrations ORDER BY migration_id`,
    nativeThreads: yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads`,
    v2Events: yield* sql`SELECT * FROM orchestration_v2_events ORDER BY sequence`,
  };
});

it.effect("installs a fresh database through the unchanged upstream runner", () =>
  Effect.gen(function* () {
    const executed = yield* runJ5CompatibleUpstreamMigrations();
    assert.deepStrictEqual(executed, migrationManifest);
    assert.deepStrictEqual(yield* readManifest(), migrationManifest);
    assert.deepStrictEqual(yield* runJ5CompatibleUpstreamMigrations(), []);
  }).pipe(Effect.provide(memory())),
);

it.effect.each([40, 47, 50, 53, 54, 55, 56, 59])(
  "sends the current migration prefix through %s to the ordinary migrator",
  (through) =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: through });
      const existing = yield* readHistory();
      const executed = yield* runJ5CompatibleUpstreamMigrations();
      assert.deepStrictEqual(
        executed,
        migrationManifest.filter(([id]) => id > through),
      );
      assert.deepStrictEqual((yield* readHistory()).slice(0, through), existing);
    }).pipe(Effect.provide(memory())),
);

// Pin 67a2be0fdb (`54 = OrchestrationV2`, `55 = RemoveRedundantProjectionIndexes`).

it.effect("the pin fixture records exactly the history J5 0.0.48 leaves", () =>
  Effect.gen(function* () {
    yield* installPin();
    assert.deepStrictEqual(yield* readManifest(), pinMigrationHistory);
  }).pipe(Effect.provide(memory())),
);

it.effect("upstream renumbers a pin database without replaying V2 or touching J5 rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installPin(PIN_CREATED_AT);
    yield* seedJ5AndV2State();
    const history = yield* readHistory();
    const rows = yield* snapshotRows();

    const executed = yield* runJ5CompatibleUpstreamMigrations();
    assert.deepStrictEqual(ids(executed), pinUpgradeIds);
    const upgraded = yield* readHistory();
    assert.deepStrictEqual(
      upgraded.map(({ migration_id, name }) => [migration_id, name] as const),
      migrationManifest,
    );
    assert.deepStrictEqual(upgraded.slice(0, 53), history.slice(0, 53));
    // The V2 and index rows moved by UPDATE, so their original completion times survive.
    assert.deepStrictEqual(upgraded.slice(54, 56), [
      { migration_id: 55, name: "OrchestrationV2", created_at: PIN_CREATED_AT },
      { migration_id: 56, name: "RemoveRedundantProjectionIndexes", created_at: PIN_CREATED_AT },
    ]);
    assert.deepStrictEqual(yield* snapshotRows(), rows);
    assert.deepStrictEqual(upstreamOnly(yield* readSchema()), upstreamOnly(yield* freshSchema()));
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);

    assert.deepStrictEqual(yield* runJ5CompatibleUpstreamMigrations(), []);
    assert.deepStrictEqual(yield* readHistory(), upgraded);
  }).pipe(Effect.provide(memory())),
);

it.effect("rolls the renumbering back when it fails, then a retry completes it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installPin();
    yield* sql`CREATE TRIGGER inject BEFORE INSERT ON effect_sql_migrations WHEN NEW.migration_id = 54
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
    yield* assertRefused(/injected failure/);
    assert.deepStrictEqual(yield* readManifest(), pinMigrationHistory);
    yield* sql`DROP TRIGGER inject`;
    assert.deepStrictEqual(ids(yield* runJ5CompatibleUpstreamMigrations()), pinUpgradeIds);
    assert.deepStrictEqual(yield* runJ5CompatibleUpstreamMigrations(), []);
  }).pipe(Effect.provide(memory())),
);

it.effect("never reruns a recorded 050 backfill when upgrading a pin database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installPin();
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project:links', 'Links', '/test/links', '[]', '2026-09-01', '2026-09-01')`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, linked_pull_request_json, created_at, updated_at)
      VALUES ('github', 'project:links', 'github', '{"instanceId":"codex","model":"gpt-5.6-sol"}',
        '{"repository":"Acme/Widgets","number":42,"url":"https://GitHub.com/Acme/Widgets/pull/42"}',
        '2026-09-01', '2026-09-02')`;
    yield* runJ5CompatibleUpstreamMigrations();
    assert.deepStrictEqual(yield* sql`SELECT thread_id FROM projection_thread_pull_requests`, []);
  }).pipe(Effect.provide(memory())),
);

// The snapshot taken before the renumbering.

const readContent = (filename: string) => {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        database
          .prepare(`SELECT * FROM "${String(name)}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .toSorted(),
      ]),
    );
  } finally {
    database.close();
  }
};

const withDatabasePath = <A, E>(
  body: (paths: {
    readonly dbPath: string;
    readonly snapshotPath: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-upstream-renumber-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    return yield* body({
      dbPath,
      // The pin's history ends at 55, and `seedJ5AndV2State` runs every J5 ledger migration.
      snapshotPath: migrationSnapshotPath(path, dbPath, {
        upstream: 55,
        j5: Math.max(...j5MigrationEntries.map(([id]) => id)),
      }),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("startup snapshots a pin database, upgrades it, and the second start is a no-op", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* installPin();
        yield* seedJ5AndV2State();
      }).pipe(Effect.provide(atFile(dbPath)));
      const beforeUpgrade = readContent(dbPath);

      const readStartup = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          upstream: yield* readHistory(),
          j5: yield* sql<{ readonly migration_id: number }>`
            SELECT migration_id FROM j5_a2a_migrations ORDER BY migration_id`,
        };
      }).pipe(Effect.provide(layerFromPath(dbPath)));

      const first = yield* readStartup;
      assert.deepStrictEqual(
        first.upstream.map(({ migration_id, name }) => [migration_id, name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        first.j5.map(({ migration_id }) => migration_id),
        j5MigrationEntries.map(([id]) => id),
      );
      // The copy beside the database is the database as it was.
      assert.deepStrictEqual(readContent(snapshotPath), beforeUpgrade);

      NodeFS.rmSync(snapshotPath);
      assert.deepStrictEqual(yield* readStartup, first);
      assert.isFalse(NodeFS.existsSync(snapshotPath));
    }),
  ),
);

// Histories whose upgrade arms ended with J5 0.0.48.

it.effect.each(retiredHistories)(
  "refuses the %s history and points at J5 0.0.48, without writes",
  ([, v2Id]) =>
    Effect.gen(function* () {
      yield* installRetired(v2Id);
      yield* assertRefused(/Run `j5 update 0\.0\.48` first, then update again\./);
    }).pipe(Effect.provide(memory())),
);

// Everything else is upstream's call.

it.effect("hands an upstream V2 preview database (53 = OrchestrationV2) to upstream", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installPin();
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (53, 55)`;
    yield* sql`UPDATE effect_sql_migrations SET migration_id = 53 WHERE migration_id = 54`;
    yield* runJ5CompatibleUpstreamMigrations();
    assert.deepStrictEqual(yield* readManifest(), migrationManifest);
  }).pipe(Effect.provide(memory())),
);

it.effect("fails as upstream does on a V2 preview history with unexpected later migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installPin();
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (56, 'Unknown')`;
    yield* assertRefused(/Cannot upgrade V2 preview with unexpected later migrations/);
  }).pipe(Effect.provide(memory())),
);
