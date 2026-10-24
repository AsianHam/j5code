import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runSqliteState } from "./t3-sqlite-state.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const createFixtureDatabase = Effect.fn("createSqliteStateFixtureDatabase")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;
    yield* sql`INSERT INTO fixtures (id, label) VALUES (1, 'existing')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
});

it.layer(NodeServices.layer)("t3-sqlite-state", (it) => {
  it.effect("enables checkpoint_fullfsync on its direct connection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-fsync-" });
      yield* createFixtureDatabase(baseDir);

      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "PRAGMA checkpoint_fullfsync",
      });

      assert.equal(result.operation, "query");
      if (result.operation === "query") {
        assert.deepStrictEqual(result.rows, [{ checkpoint_fullfsync: 1 }]);
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "backs up isolated state before writes and refuses the shared home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-exec-" });
        yield* createFixtureDatabase(baseDir);

        const mutation = yield* runSqliteState({
          operation: "exec",
          baseDir,
          sql: "INSERT INTO fixtures (id, label) VALUES (2, 'seeded')",
        });
        assert.equal(mutation.operation, "exec");
        if (mutation.operation === "exec" && (yield* HostProcess.Platform) !== "win32") {
          assert.equal((yield* fs.stat(mutation.backup)).mode & 0o777, 0o600);
        }

        const error = yield* runSqliteState(
          {
            operation: "exec",
            baseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "SqliteStateSharedHomeMutationError");

        const aliasParent = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-sqlite-state-alias-",
        });
        const aliasBaseDir = path.join(aliasParent, "shared-home-alias");
        yield* fs.symlink(baseDir, aliasBaseDir);
        const aliasError = yield* runSqliteState(
          {
            operation: "exec",
            baseDir: aliasBaseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(aliasError._tag, "SqliteStateSharedHomeMutationError");
      }),
  );

  it.effect("refuses mutation of either installed T3 or J5 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-homes-" });
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      try {
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        for (const name of [".t3", ".j5code"]) {
          const baseDir = path.join(home, name);
          yield* createFixtureDatabase(baseDir);
          const error = yield* runSqliteState({
            operation: "exec",
            baseDir,
            sql: "DELETE FROM fixtures",
          }).pipe(Effect.flip);
          assert.equal(error._tag, "SqliteStateSharedHomeMutationError");
        }
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
          delete process.env.USERPROFILE;
        } else {
          process.env.USERPROFILE = originalUserProfile;
        }
      }
    }),
  );
});
