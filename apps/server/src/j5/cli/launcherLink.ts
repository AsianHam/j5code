import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { repointLauncher } from "../../cli/update.ts";
import { launcherOwnsVersionsDir, pinnedRuntimeVersionsDir } from "../../cloud/pinnedRuntime.ts";

/**
 * Points the `j5` command at the running executable. Called once a background
 * service's server is the committed version, so an in-app update moves the
 * command along with the service (#398). Only the installer's default link,
 * `~/.local/bin/j5`, is considered (the service's environment never carries a
 * custom `T3CODE_INSTALL_BIN_DIR`), and only when it already points into this
 * home's runtime tree; anything else is not ours to touch. Returns the link
 * path when it was repointed.
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
