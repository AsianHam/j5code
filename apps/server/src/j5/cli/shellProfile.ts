import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  hasJ5PathLine,
  shellProfilePaths,
  withoutJ5PathLines,
} from "@t3tools/shared/j5/shellProfile";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { agentCliDirectory } from "./agentPath.ts";
import { launcherOwnsVersionsDir, pinnedRuntimeVersionsDir } from "../../cloud/pinnedRuntime.ts";

// Profiles needn't be UTF-8. Reading each byte as one latin1 character keeps
// every byte through the edit; the marker itself is ASCII.
const asBytes = (contents: Uint8Array) => Buffer.from(contents).toString("latin1");

/**
 * The other folders the desktop app's "j5 command" install can link into
 * (`unixCandidates` in `apps/desktop/src/app/DesktopCliCommand.ts`, which also
 * lists `~/.local/bin`, handled by the installer's link below). Keep the two in
 * step.
 */
const appLinkFolders = (home: string) => ["/opt/homebrew/bin", "/usr/local/bin", `${home}/bin`];

/**
 * What `j5 uninstall` removes besides a home: the `j5` link and PATH line, when the link belongs
 * to this home or is missing (an orphaned line), and the desktop app's links to this home's
 * launcher. Anything that belongs elsewhere, such as another home, is left alone. An unreadable
 * startup file fails the uninstall rather than being skipped. `folders` is for tests.
 */
export const planShellCleanup = Effect.fn("j5.cli.plan_shell_cleanup")(function* (
  baseDir: string,
  folders?: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = environment["HOME"];
  const nothing = {
    profiles: [] as Array<string>,
    installerLink: undefined as string | undefined,
    appLinks: [] as Array<string>,
  };
  if ((yield* HostProcess.Platform) === "win32" || !home) return nothing;

  const launcher = path.join(agentCliDirectory(path, baseDir), "j5");
  const appLinks: Array<string> = [];
  for (const folder of folders ?? appLinkFolders(home)) {
    const candidate = path.join(folder, "j5");
    const linked = yield* fs.readLink(candidate).pipe(Effect.option);
    if (Option.isSome(linked) && path.resolve(folder, linked.value) === launcher) {
      appLinks.push(candidate);
    }
  }

  const command = path.join(home, ".local/bin/j5");
  const target = yield* fs.readLink(command).pipe(Effect.option);
  const resolved = Option.map(target, (link) => path.resolve(path.dirname(command), link));
  // The installer links into this home's runtime; the desktop app's install
  // command links to its script in this home's `bin`.
  const owned =
    Option.isSome(resolved) &&
    (launcherOwnsVersionsDir(path, pinnedRuntimeVersionsDir(path, baseDir), resolved.value) ||
      resolved.value === launcher);
  if (!owned && (Option.isSome(target) || (yield* fs.exists(command)))) {
    return { ...nothing, appLinks };
  }

  const profiles: Array<string> = [];
  const files = shellProfilePaths({
    home,
    zdotdir: environment["ZDOTDIR"],
    xdgConfigHome: environment["XDG_CONFIG_HOME"],
  });
  for (const file of files) {
    const contents = yield* fs.readFile(file).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<Uint8Array>())
            : Effect.fail(error),
      }),
    );
    if (Option.isSome(contents) && hasJ5PathLine(asBytes(contents.value))) profiles.push(file);
  }
  return { profiles, installerLink: owned ? command : undefined, appLinks };
});

/** Removes J5's PATH line from each file, leaving every other byte as it was. */
export const removeJ5PathLines = Effect.fn("j5.cli.remove_path_lines")(function* (
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of files) {
    const contents = asBytes(yield* fs.readFile(file));
    yield* fs.writeFile(file, Buffer.from(withoutJ5PathLines(contents), "latin1"));
  }
});

/**
 * Removes the app's links. A folder the person can't write to is named in the
 * output as left behind and does not fail the uninstall.
 */
export const removeAppLinks = Effect.fn("j5.cli.remove_app_links")(function* (
  links: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const link of links) {
    const removed = yield* fs.remove(link, { force: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    yield* Console.log(
      removed
        ? `Removed ${link}.`
        : `Could not remove ${link}; the desktop app's j5 link is left behind. Delete it yourself.`,
    );
  }
});
