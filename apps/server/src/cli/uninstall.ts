// @effect-diagnostics nodeBuiltinImport:off
// Windows cleanup must outlive this executable to delete its directory; scoped ChildProcess kills children on exit.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import {
  launcherOwnsVersionsDir,
  pinnedRuntimeVersionsDir,
  windowsShimTarget,
} from "../cloud/pinnedRuntime.ts";
import { planShellCleanup, removeAppLinks, removeJ5PathLines } from "../j5/cli/shellProfile.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";
import { findWindowsShim, resolveLauncherPath } from "./update.ts";

export class CliUninstallError extends Schema.TaggedError<CliUninstallError>()(
  "CliUninstallError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface UninstallPlan {
  readonly service: boolean;
  readonly launcher: string | undefined;
  readonly runtimeDir: string | undefined;
  readonly userdataDir: string;
}

/** Delete only launchers targeting this home's runtime/versions. */
export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return undefined;
  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return undefined;
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const target = Option.isSome(contents) ? windowsShimTarget(contents.value) : undefined;
    return target !== undefined && launcherOwnsVersionsDir(path, input.versionsDir, target)
      ? shimPath
      : undefined;
  }
  const linkTarget = yield* fs.readLink(input.launchedAs).pipe(Effect.option);
  if (Option.isNone(linkTarget)) return undefined;
  const resolved = path.resolve(path.dirname(input.launchedAs), linkTarget.value);
  return launcherOwnsVersionsDir(path, input.versionsDir, resolved) ? input.launchedAs : undefined;
});

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const plan: UninstallPlan = {
    service: status.supported && status.installed && servesThisHome,
    launcher: yield* findOwnedLauncher({ launchedAs, versionsDir }),
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
  };
  return plan;
});

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove j5 from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({ baseDir: config.baseDir, assumeYes: flags.yes }).pipe(
        Effect.provide(CliService.layer(config)),
      );
    }),
  ),
);

const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir });
  // J5: the PATH line the installer added to shell startup files (#397, FORK.md case 52).
  const cleanup = yield* planShellCleanup(input.baseDir).pipe(
    Effect.mapError(
      (error) =>
        new CliUninstallError({ reason: `Could not read a shell startup file: ${error.message}` }),
    ),
  );
  const profiles = cleanup.profiles;
  // The installer's link, when uninstall wasn't started through it.
  const installerLink = cleanup.installerLink === plan.launcher ? undefined : cleanup.installerLink;

  if (
    !plan.service &&
    plan.launcher === undefined &&
    plan.runtimeDir === undefined &&
    profiles.length === 0 &&
    installerLink === undefined &&
    cleanup.appLinks.length === 0
  ) {
    yield* Console.log(`Nothing to remove: j5 is not installed for ${input.baseDir}.`);
    if (!(yield* HostProcess.IsExecutable)) {
      yield* Console.log(
        "  This j5 runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g @jacksondr5/j5code`, or delete the checkout).",
      );
    }
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  if (plan.launcher !== undefined) yield* Console.log(`  the launcher at ${plan.launcher}`);
  if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
  }
  if (installerLink !== undefined) yield* Console.log(`  the launcher at ${installerLink}`);
  for (const link of cleanup.appLinks) yield* Console.log(`  the desktop app's link at ${link}`);
  for (const profile of profiles) yield* Console.log(`  the PATH line J5 added to ${profile}`);
  yield* Console.log(
    `Your projects, threads, and settings under ${plan.userdataDir} are kept. Delete that directory yourself if you want them gone too.`,
  );

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Remove j5 from this machine?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  if (plan.launcher !== undefined) {
    yield* fs
      .remove(plan.launcher, { force: true })
      .pipe(
        Effect.mapError(
          () =>
            new CliUninstallError({ reason: `Could not remove the launcher at ${plan.launcher}.` }),
        ),
      );
    yield* Console.log(`Removed ${plan.launcher}.`);
  }
  if (installerLink !== undefined) {
    yield* fs
      .remove(installerLink, { force: true })
      .pipe(
        Effect.mapError(
          () =>
            new CliUninstallError({ reason: `Could not remove the launcher at ${installerLink}.` }),
        ),
      );
    yield* Console.log(`Removed ${installerLink}.`);
  }
  yield* removeAppLinks(cleanup.appLinks);
  if (profiles.length > 0) {
    yield* removeJ5PathLines(profiles).pipe(
      Effect.mapError(
        () => new CliUninstallError({ reason: `Could not edit ${profiles.join(", ")}.` }),
      ),
    );
    yield* Console.log(`Removed the PATH line from ${profiles.join(", ")}.`);
  }
  if (plan.runtimeDir !== undefined) {
    // Windows refuses to unlink this running executable; a detached shell removes it after exit.
    if (platform === "win32") {
      const runtimeDir = plan.runtimeDir;
      const comspec = environment["ComSpec"] ?? environment["COMSPEC"] ?? "cmd.exe";
      yield* Effect.try({
        try: () => {
          const child = NodeChildProcess.spawn(
            comspec,
            ["/d", "/c", `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${runtimeDir}"`],
            { detached: true, stdio: "ignore", windowsHide: true },
          );
          child.unref();
        },
        catch: () =>
          new CliUninstallError({
            reason: `Could not schedule removal of ${runtimeDir}. Delete it yourself once this window is closed.`,
          }),
      });
      yield* Console.log(`${runtimeDir} will be removed once j5 exits.`);
    } else {
      yield* fs
        .remove(plan.runtimeDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            () => new CliUninstallError({ reason: `Could not remove ${plan.runtimeDir}.` }),
          ),
        );
      yield* Console.log(`Removed ${plan.runtimeDir}.`);
    }
  }
  yield* Console.log("");
  yield* Console.log("j5 is uninstalled. Thanks for trying J5 Code.");
});
