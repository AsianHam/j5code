import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { prunePinnedRuntimes } from "../../cloud/pinnedRuntime.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { agentCliDirectory } from "./agentPath.ts";

const noRunningRuntime = ProcessRunner.ProcessRunner.of({
  run: () =>
    Effect.succeed({
      stdout: "p1\nftxt\nn/sbin/launchd\n",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

it.layer(NodeServices.layer)("prunePinnedRuntimes with J5's launchers", (it) => {
  it.effect("keeps the runtimes the installer's j5 and the agents' j5 point at", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-pinned-launchers-" });
      const baseDir = path.join(root, "j5-home");
      const home = path.join(root, "person");
      const versionsDir = path.join(baseDir, "runtime", "versions");
      yield* TestClock.setTime(Duration.toMillis(Duration.days(1)));
      for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
        const directory = path.join(versionsDir, version);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "j5"), "");
        const sentinel = path.join(directory, ".install-complete");
        yield* fs.writeFileString(sentinel, `${version}\n`);
        yield* fs.utimes(sentinel, 0, 0);
      }
      // The installer's default link (scripts/install.sh) and a release server's link for its
      // agents (agentPath.ts); neither is recorded in runtime/launchers by the server.
      yield* fs.makeDirectory(path.join(home, ".local", "bin"), { recursive: true });
      yield* fs.symlink(
        path.join(versionsDir, "1.0.0", "j5"),
        path.join(home, ".local", "bin", "j5"),
      );
      yield* fs.makeDirectory(agentCliDirectory(path, baseDir), { recursive: true });
      yield* fs.symlink(
        path.join(versionsDir, "1.1.0", "j5"),
        path.join(agentCliDirectory(path, baseDir), "j5"),
      );

      const removed = yield* prunePinnedRuntimes({ baseDir, keep: [] }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, noRunningRuntime),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );

      assert.deepEqual(removed, ["1.2.0"]);
    }),
  );
});
