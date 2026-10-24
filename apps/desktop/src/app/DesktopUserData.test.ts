import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

// J5 keeps one profile per channel on every platform (merge decision #4) and
// never reads or seeds from an installed T3 Code's profiles.
it.effect.each(["darwin", "linux", "win32"] as const)(
  "uses the J5 profiles on %s and never a T3 Code profile",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-profile-" });
      for (const t3Profile of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        yield* fs.makeDirectory(path.join(directory, t3Profile), { recursive: true });
        yield* fs.writeFileString(path.join(directory, t3Profile, "Local State"), "t3 keys");
      }
      const resolve = (isDevelopment: boolean) =>
        resolveUserDataPath({ appDataDirectory: directory, isDevelopment, platform });

      assert.equal(yield* resolve(false), path.join(directory, "j5code"));
      assert.equal(yield* resolve(true), path.join(directory, "j5code-dev"));
      assert.isFalse(yield* fs.exists(path.join(directory, "j5code")));

      yield* fs.makeDirectory(path.join(directory, "J5 Code"));
      yield* fs.makeDirectory(path.join(directory, "J5 Code (Dev)"));
      assert.equal(yield* resolve(false), path.join(directory, "J5 Code"));
      assert.equal(yield* resolve(true), path.join(directory, "J5 Code (Dev)"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
