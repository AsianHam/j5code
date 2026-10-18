import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { resolveLauncherPath } from "../../cli/update.ts";
import { exposeOwnCliToAgents, withoutAgentCliOnPath } from "./agentPath.ts";

// A home with two installed versions; returns each version's executable.
const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-agent-path-" });
  const executables = ["1.0.0", "2.0.0"].map((version) =>
    path.join(baseDir, "runtime/versions", version, "j5"),
  );
  for (const executable of executables) {
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
    yield* fs.writeFileString(executable, "");
  }
  return { baseDir, previous: executables[0]!, running: executables[1]! };
});

const startServer = (input: {
  readonly baseDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly isExecutable: boolean;
}) =>
  exposeOwnCliToAgents(input.baseDir).pipe(
    Effect.provideService(HostProcess.Environment, input.environment),
    Effect.provideService(HostProcess.ExecutablePath, input.executable),
    Effect.provideService(HostProcess.IsExecutable, input.isExecutable),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

it.layer(NodeServices.layer)("j5 for the server's agents", (it) => {
  it.effect("puts the home's bin first and points its j5 at the running server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, previous, running } = yield* makeHome;
      const bin = path.join(baseDir, "bin");

      // The version before an update left its link behind.
      yield* startServer({
        baseDir,
        environment: { PATH: "/usr/bin" },
        executable: previous,
        isExecutable: true,
      });
      const environment: NodeJS.ProcessEnv = { PATH: `/home/u/.local/bin:${bin}:/usr/bin` };
      yield* startServer({ baseDir, environment, executable: running, isExecutable: true });

      assert.equal(yield* fs.readLink(path.join(bin, "j5")), running);
      assert.deepStrictEqual(yield* fs.readDirectory(bin), ["j5"]);
      // First, and not repeated when a restart inherits it.
      assert.equal(environment["PATH"], `${bin}:/home/u/.local/bin:/usr/bin`);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing for a server run from source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* makeHome;
      const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

      yield* startServer({
        baseDir,
        environment,
        executable: "/usr/local/bin/node",
        isExecutable: false,
      });

      assert.equal(environment["PATH"], "/usr/bin");
      assert.isFalse(yield* fs.exists(path.join(baseDir, "bin")));
    }).pipe(Effect.scoped),
  );

  it.effect("puts the desktop app's script first for the app's server, after PATH hydration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* makeHome;
      const bin = path.join(baseDir, "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(path.join(bin, "j5"), "#!/bin/sh\n");
      // What the app's server has after rebuilding PATH from a profile that
      // prepends the person's own directories.
      const environment: NodeJS.ProcessEnv = { PATH: `/home/u/.local/bin:${bin}:/usr/bin` };

      yield* startServer({
        baseDir,
        environment,
        executable: "/Applications/J5 Code.app/Contents/MacOS/J5 Code",
        isExecutable: false,
      });

      assert.equal(environment["PATH"], `${bin}:/home/u/.local/bin:/usr/bin`);
      assert.equal(yield* fs.readFileString(path.join(bin, "j5")), "#!/bin/sh\n");
    }).pipe(Effect.scoped),
  );

  it.effect("j5 update finds the person's link, not the agents' one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, running } = yield* makeHome;
      const agents = path.join(baseDir, "bin/j5");
      const installer = path.join(baseDir, "local-bin/j5");
      for (const link of [agents, installer]) {
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(running, link);
      }

      // Typed as `j5` in a J5 terminal, where the agents' directory is first.
      const found = yield* withoutAgentCliOnPath(baseDir, resolveLauncherPath).pipe(
        Effect.provideService(HostProcess.Environment, {
          PATH: `${path.dirname(agents)}:${path.dirname(installer)}`,
        }),
        Effect.provideService(HostProcess.InvokedAs, "j5"),
        Effect.provideService(HostProcess.WorkingDirectory, baseDir),
        Effect.provideService(HostProcess.Platform, "linux"),
      );

      assert.equal(found, installer);
    }).pipe(Effect.scoped),
  );
});
