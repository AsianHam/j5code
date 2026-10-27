// @effect-diagnostics nodeBuiltinImport:off - a per-attempt file suffix; this step must need nothing beyond FileSystem and Path.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { migrationManifest } from "../../persistence/Migrations.ts";
import { J5_A2A_MIGRATIONS_TABLE, migrationEntries } from "../a2a/Migrations.ts";

/**
 * How many pre-migration snapshots stay beside the database. Each is a full copy, so the number
 * is small: three lets a person go back across the last three builds that migrated, at three
 * times the database's size on disk.
 */
export const MIGRATION_SNAPSHOTS_KEPT = 3;

const UPSTREAM_MIGRATIONS_TABLE = "effect_sql_migrations";

/**
 * How long a read waits for another connection's lock: the server's own `busy_timeout`. A
 * rollback-journal database is locked against readers while a writer commits, and a read that
 * does not wait fails there with "database is locked". A WAL database never makes a reader wait.
 */
const BUSY_TIMEOUT_MS = 5000;

const openReadOnly = (filename: string) =>
  new NodeSqlite.DatabaseSync(filename, { readOnly: true, timeout: BUSY_TIMEOUT_MS });

export class MigrationSnapshotError extends Schema.TaggedError<MigrationSnapshotError>()(
  "MigrationSnapshotError",
  {
    databasePath: Schema.String,
    snapshotPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not snapshot ${this.databasePath} to ${this.snapshotPath} before its pending migrations. Nothing has been migrated.`;
  }
}

/** The newest migration id each lane has recorded; 0 where a lane has recorded none. */
export interface RecordedMigrations {
  readonly upstream: number;
  readonly j5: number;
}

export interface SnapshotBeforeMigrationsOptions {
  /** The upstream migration ids this build knows. Defaults to upstream's manifest. */
  readonly upstreamMigrationIds?: ReadonlyArray<number>;
  /** The J5 ledger migration ids this build knows. Defaults to `migrationEntries`. */
  readonly j5MigrationIds?: ReadonlyArray<number>;
  /** Defaults to `MIGRATION_SNAPSHOTS_KEPT`. */
  readonly keep?: number;
}

const snapshotSuffix = /\.pre-migration-u\d+-j\d+\.sqlite$/;
// An unpublished copy, and a journal SQLite may keep beside one while writing it.
const partialSuffix = /\.pre-migration-u\d+-j\d+\.sqlite\..+\.partial(-journal)?$/;
/**
 * A copy takes seconds, so a partial file this old belongs to a process that was killed. A newer
 * one may be another process's copy in progress and is left alone.
 */
const PARTIAL_STALE_AFTER_MS = Duration.toMillis(Duration.hours(1));

/**
 * `statev2.sqlite` → `statev2.pre-migration-u<upstream id>-j<J5 ledger id>.sqlite`, beside the
 * database: named for the migrations the database had when it was copied, ids padded to three
 * digits.
 */
export const migrationSnapshotPath = (
  path: Path.Path,
  dbPath: string,
  recorded: RecordedMigrations,
) => {
  const pad = (id: number) => String(id).padStart(3, "0");
  return path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath, ".sqlite")}.pre-migration-u${pad(recorded.upstream)}-j${pad(recorded.j5)}.sqlite`,
  );
};

const readRecordedMigrations = (filename: string): RecordedMigrations => {
  const database = openReadOnly(filename);
  try {
    const latest = (table: string) => {
      const exists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists === undefined) return 0;
      const row = database.prepare(`SELECT MAX(migration_id) AS latest FROM "${table}"`).get();
      return Number(row?.latest ?? 0);
    };
    return { upstream: latest(UPSTREAM_MIGRATIONS_TABLE), j5: latest(J5_A2A_MIGRATIONS_TABLE) };
  } finally {
    database.close();
  }
};

/**
 * Copies to `destinationPath`, which must not exist. `VACUUM INTO` reads one consistent snapshot
 * and never writes the source. Synchronous on purpose: on release executables' Node,
 * `node:sqlite`'s `backup()` rejects the one-step rate and settles only when the loop wakes.
 */
const copyDatabase = (sourcePath: string, destinationPath: string) => {
  const database = openReadOnly(sourcePath);
  try {
    database.prepare("VACUUM INTO ?").run(destinationPath);
  } finally {
    database.close();
  }
};

/**
 * Keeps `justWritten` and the most recently written others, `keep` in all, and deletes the partial
 * files that killed copies left behind.
 */
const removeOldSnapshots = Effect.fn("removeOldSnapshots")(function* (
  dbPath: string,
  justWritten: string,
  keep: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath, ".sqlite")}.pre-migration-`;
  const names = (yield* fs.readDirectory(directory)).filter((name) => name.startsWith(prefix));
  const writtenAt = (names: ReadonlyArray<string>) =>
    Effect.forEach(names, (name) => {
      const file = path.join(directory, name);
      return fs.stat(file).pipe(
        Effect.map((info) => ({
          file,
          at: Option.match(info.mtime, { onNone: () => 0, onSome: (time) => time.getTime() }),
        })),
      );
    });
  const snapshots = (yield* writtenAt(names.filter((name) => snapshotSuffix.test(name)))).filter(
    ({ file }) => file !== justWritten,
  );
  const expired = snapshots
    .toSorted((left, right) => right.at - left.at)
    .slice(Math.max(0, keep - 1));
  for (const { file } of expired) {
    yield* fs.remove(file);
    yield* Effect.logInfo("Removed an old pre-migration snapshot", { snapshotPath: file });
  }
  const staleBefore = (yield* Clock.currentTimeMillis) - PARTIAL_STALE_AFTER_MS;
  const partials = yield* writtenAt(names.filter((name) => partialSuffix.test(name)));
  for (const { file, at } of partials) {
    if (at >= staleBefore) continue;
    yield* fs.remove(file, { force: true });
    yield* Effect.logInfo("Removed an interrupted pre-migration snapshot", { partialPath: file });
  }
});

/**
 * Call before anything opens the database read-write. If it has history and a migration is
 * pending in either lane, copy it to `migrationSnapshotPath` first, or fail. The copy blocks
 * (about 2 s/GB), is published only if it still records the same migrations, and is removed if
 * interrupted; snapshots beyond `MIGRATION_SNAPSHOTS_KEPT` are pruned.
 */
export const snapshotBeforeMigrations = Effect.fn("snapshotBeforeMigrations")(function* (
  dbPath: string,
  options: SnapshotBeforeMigrationsOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const newestKnown = {
    upstream: Math.max(0, ...(options.upstreamMigrationIds ?? migrationManifest.map(([id]) => id))),
    j5: Math.max(0, ...(options.j5MigrationIds ?? migrationEntries.map(([id]) => id))),
  };
  const failAt = (snapshotPath: string) => (cause: unknown) =>
    new MigrationSnapshotError({ databasePath: dbPath, snapshotPath, cause });
  const failBeforeNaming = failAt(path.join(path.dirname(dbPath), "(not yet named)"));

  if (!(yield* fs.exists(dbPath).pipe(Effect.mapError(failBeforeNaming)))) return;
  const recorded = yield* Effect.try({
    try: () => readRecordedMigrations(dbPath),
    catch: failBeforeNaming,
  });
  if (recorded.upstream === 0 && recorded.j5 === 0) return;
  // Each migrator runs every id above the newest it has recorded, so that is what pending means.
  // Upstream's renumbering of an older history is covered: such a history ends below the manifest.
  if (recorded.upstream >= newestKnown.upstream && recorded.j5 >= newestKnown.j5) return;

  const snapshotPath = migrationSnapshotPath(path, dbPath, recorded);
  const fail = failAt(snapshotPath);
  // Per attempt: two processes starting together must each publish only their own complete copy.
  const partialPath = `${snapshotPath}.${process.pid}.${NodeCrypto.randomUUID()}.partial`;
  const { size } = yield* fs.stat(dbPath).pipe(Effect.mapError(fail));
  yield* Effect.logInfo("Snapshotting the database before its pending migrations", {
    databasePath: dbPath,
    databaseBytes: Number(size),
    snapshotPath,
    recorded,
    newestKnown,
  });
  const [elapsed, published] = yield* Effect.gen(function* () {
    // `VACUUM INTO` refuses a destination that already holds anything.
    yield* fs.remove(partialPath, { force: true }).pipe(Effect.mapError(fail));
    yield* Effect.try({ try: () => copyDatabase(dbPath, partialPath), catch: fail });
    const copied = yield* Effect.try({
      try: () => readRecordedMigrations(partialPath),
      catch: fail,
    });
    if (copied.upstream !== recorded.upstream || copied.j5 !== recorded.j5) {
      yield* fs.remove(partialPath, { force: true }).pipe(Effect.mapError(fail));
      return false;
    }
    yield* fs.rename(partialPath, snapshotPath).pipe(Effect.mapError(fail));
    return true;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : fs.remove(partialPath, { force: true }).pipe(Effect.ignore),
    ),
    Effect.timed,
  );
  yield* Effect.logInfo(
    published
      ? "Snapshot written before the pending migrations"
      : "Snapshot discarded: another process already migrated the database",
    { snapshotPath, durationMs: Duration.toMillis(elapsed) },
  );
  if (!published) return;

  // The snapshot that matters exists; a leftover old one is not worth refusing to start over.
  yield* removeOldSnapshots(dbPath, snapshotPath, options.keep ?? MIGRATION_SNAPSHOTS_KEPT).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not remove old pre-migration snapshots", cause).pipe(
        Effect.annotateLogs({ databasePath: dbPath }),
      ),
    ),
  );
});
