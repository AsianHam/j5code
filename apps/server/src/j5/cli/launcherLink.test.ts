import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { repointCliLauncherToSelf } from "./launcherLink.ts";

// A home whose installer link still runs the version before an in-app update.
const makeUpdatedHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-launcher-link-" });
  const baseDir = path.join(home, ".j5code");
  const previous = path.join(baseDir, "runtime/versions/1.0.0/t3");
  const running = path.join(baseDir, "runtime/versions/2.0.0/j5");
  const link = path.join(home, ".local/bin/j5");
  for (const file of [previous, running]) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "");
  }
  yield* fs.makeDirectory(path.dirname(link), { recursive: true });
  yield* fs.symlink(previous, link);
  return { home, baseDir, previous, running, link };
});

it.layer(NodeServices.layer)("j5 launcher link", (it) => {
  it.effect("moves the installer's link to the service's new version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, baseDir, running, link } = yield* makeUpdatedHome;

      const repointed = yield* repointCliLauncherToSelf(baseDir).pipe(
        Effect.provideService(HostProcess.Environment, { HOME: home }),
        Effect.provideService(HostProcess.ExecutablePath, running),
      );

      assert.equal(Option.getOrUndefined(repointed), link);
      assert.equal(yield* fs.readLink(link), running);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.IsExecutable, true),
    ),
  );

  it.effect("leaves the link alone for a server running outside the home's runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, previous, link } = yield* makeUpdatedHome;

      const repointed = yield* repointCliLauncherToSelf(baseDir).pipe(
        Effect.provideService(HostProcess.Environment, { HOME: home }),
        Effect.provideService(HostProcess.ExecutablePath, path.join(home, "elsewhere/j5")),
      );

      assert.isTrue(Option.isNone(repointed));
      assert.equal(yield* fs.readLink(link), previous);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.IsExecutable, true),
    ),
  );
});
