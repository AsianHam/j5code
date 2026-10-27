import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergePathEntries } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The directory in a J5 home that holds only `j5`, for the server's agents. */
export const agentCliDirectory = (path: Path.Path, baseDir: string) => path.join(baseDir, "bin");

/**
 * Puts `<home>/bin` first on the PATH the server's agents and terminals inherit, so they run this
 * server's own `j5`. That directory holds only `j5`, so nothing else is shadowed. A release
 * server or the desktop app writes the link first; a server run from source has none and leaves
 * PATH alone.
 */
export const exposeOwnCliToAgents = Effect.fn("j5.cli.expose_own_cli_to_agents")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return;

  const directory = agentCliDirectory(path, baseDir);
  const command = path.join(directory, "j5");
  if (yield* HostProcess.IsExecutable) {
    // Link to a temporary name and rename it over, so `j5` never goes missing.
    const next = `${command}.next`;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.remove(next, { force: true });
    yield* fs.symlink(yield* HostProcess.ExecutablePath, next);
    yield* fs.rename(next, command);
  }
  if (!(yield* fs.exists(command))) return;
  const merged = mergePathEntries(directory, environment["PATH"], platform);
  if (merged !== undefined) environment["PATH"] = merged;
});

/**
 * Runs a lookup with `<home>/bin` left out of PATH. `j5 update` resolves the
 * link it was started through this way, so it finds the person's own link:
 * inside J5, `<home>/bin` is first on PATH, and repointing the agents' `j5`
 * would leave the installer's link on the old version.
 */
export const withoutAgentCliOnPath = Effect.fn("j5.cli.withoutAgentCliOnPath")(function* <A, E, R>(
  baseDir: string,
  lookup: Effect.Effect<A, E, R>,
) {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const delimiter = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
  const directory = agentCliDirectory(path, baseDir);
  return yield* lookup.pipe(
    Effect.provideService(HostProcess.Environment, {
      ...environment,
      PATH: (environment["PATH"] ?? "")
        .split(delimiter)
        .filter((entry) => entry !== directory)
        .join(delimiter),
    }),
  );
});
