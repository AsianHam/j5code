import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { repointLauncher } from "../../cli/update.ts";
import { launcherOwnsVersionsDir, pinnedRuntimeVersionsDir } from "../../cloud/pinnedRuntime.ts";

/**
 * Points `~/.local/bin/j5` at the running executable once a service's server is committed, so an
 * in-app update moves the command too. The service never sees a custom `T3CODE_INSTALL_BIN_DIR`,
 * and a link not already into this home's runtime is not ours. Returns the link if repointed.
 */
export const repointCliLauncherToSelf = Effect.fn("j5.cli.repoint_launcher_to_self")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const executable = yield* HostProcess.ExecutablePath;
  const versionsDir = pinnedRuntimeVersionsDir(path, baseDir);
  if (
    !(yield* HostProcess.IsExecutable) ||
    (yield* HostProcess.Platform) === "win32" ||
    !launcherOwnsVersionsDir(path, versionsDir, executable)
  ) {
    return Option.none<string>();
  }
  const home = environment["HOME"];
  if (!home) return Option.none<string>();
  return yield* repointLauncher({
    launchedAs: path.join(home, ".local/bin/j5"),
    versionsDir,
    targetEntryPath: executable,
  });
});
