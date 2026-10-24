import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as Schema from "effect/Schema";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  compareExactServiceVersions,
  parseServiceState,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";
import {
  isLegacyJ5BootServiceUnit,
  isRenderedJ5BootServiceUnit,
  legacyJ5BootService,
} from "./j5/legacyBootService.ts";

// J5 names (FORK.md): never upstream's `t3code.service` / `com.t3tools.t3code.service`,
// which an installed T3 Code owns. See ./j5/legacyBootService.ts for the retired J5 unit.
const BOOT_SERVICE_NAME = "j5code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (codes.jackson.j5code), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = "codes.jackson.j5code.service";
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
export const BOOT_SERVICE_LOG_FILE = "boot-service.log";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

const unquoteSystemdValue = (raw: string) =>
  (raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : raw
  ).replaceAll("%%", "%");

const unescapeXmlText = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export function bootServiceBaseDirOf(contents: string): string | undefined {
  const systemd = /^Environment=J5CODE_HOME=(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = /<key>J5CODE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

/** The executable an installed unit or plist starts: the launcher's runtime. */
export function bootServiceProgramOf(contents: string): string | undefined {
  const systemd = /^ExecStart=("(?:\\.|[^"\\])*"|\S+)/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd);
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
    contents,
  )?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

export interface BootServicePlan {
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
  /** The manager accepted a detached install; its outcome is written to `logPath`. */
  readonly handedOff?: boolean;
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=J5 Code server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=J5CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${plan.program.map(quoteSystemdValue).join(" ")}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Agents and terminals run in their own scopes in app-j5code-agents.slice
    // (see process/agentScope.ts). Short helper commands still share this
    // cgroup, and with the systemd default of OOMPolicy=stop, the kernel
    // killing one of them stops the whole unit.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    // The agents slice is a sibling in app.slice, so these weights keep the
    // server responsive while agents saturate CPU or disk.
    "CPUWeight=1000",
    "IOWeight=1000",
    // systemd-oomd only honors this when the cgroup it watches is owned by the
    // same user. Distros watch user-1000.slice, which root owns, so there it is
    // ignored.
    "ManagedOOMPreference=avoid",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pure renderer: launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string; readonly environmentPath: string },
): string {
  // ExitTimeOut 90 matches systemd's default TimeoutStopSec. A plain stop
  // completes within the launcher's 5s child grace, but a stop that queues
  // behind an in-flight update transition can take much longer; launchd's
  // system-defined default (5s on current macOS) would SIGKILL the launcher
  // (and, with it, the process group) mid-handoff.
  // ProcessType Interactive opts out of background-job resource throttling.
  // AbandonProcessGroup stays at its default (false): launchd reaps leftover
  // process-group members only when the launcher itself exits — the analog of
  // KillMode=mixed's final cgroup kill — and not when the launcher restarts its
  // child, so agent children survive server updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...plan.program.map((argument) => `    <string>${escapeXmlText(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXmlText(options.environmentPath)}</string>`,
    `    <key>J5CODE_HOME</key>`,
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_PLIST_FILE}</string>`,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export interface BootServiceStep {
  readonly step: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Non-zero exit is logged and ignored.
   */
  readonly optional?: boolean;
  /**
   * A non-zero exit this accepts counts as success, for steps whose goal can
   * already hold (a stop of a service that is not loaded). Every other failure
   * stays strict, unlike `optional`.
   */
  readonly acceptFailure?: (result: ProcessRunner.ProcessRunOutput) => boolean;
  readonly timeout?: Duration.Input;
}

/**
 * J5: how a started unit is confirmed to be running. A zero exit from
 * `systemctl restart` or `launchctl bootstrap` does not prove it: a unit whose
 * `Condition*=` fails is skipped with exit 0.
 */
export interface BootServiceRunningProbe {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly state: (result: ProcessRunner.ProcessRunOutput) => "running" | "starting" | "stopped";
}

/** J5: bounded settle after activation; `activating` can outlast the start command briefly. */
const ACTIVATION_SETTLE_ATTEMPTS = 10;
const ACTIVATION_SETTLE_INTERVAL = Duration.millis(500);

/**
 * Stop commands block until the service manager gives up: 90s by default for
 * systemd's TimeoutStopSec, and ExitTimeOut=90 in the rendered plist. This
 * must stay above both, or the runner cancels the stop mid-shutdown and the
 * next step races a still-loaded service.
 */
const STOP_STEP_TIMEOUT = Duration.seconds(120);

export interface BootServiceManager {
  readonly kind: "systemd" | "launchd";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  readonly stop: ReadonlyArray<BootServiceStep>;
  readonly activate: ReadonlyArray<BootServiceStep>;
  /** J5: checked after `activate`; activation fails unless the unit is running. */
  readonly running: BootServiceRunningProbe;
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Queue a restart owned by the manager, since stopping would kill the caller. */
  readonly handoff?: ReadonlyArray<BootServiceStep>;
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

function systemdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    ".config",
    "systemd",
    "user",
    BOOT_SERVICE_UNIT_FILE,
  );
  const prepareActivation = [
    {
      step: "reloading systemd user units",
      command: "systemctl",
      args: ["--user", "daemon-reload"],
    },
    {
      step: "enabling the service",
      command: "systemctl",
      args: ["--user", "enable", BOOT_SERVICE_UNIT_FILE],
    },
  ];
  return {
    kind: "systemd",
    unitPath,
    render: renderBootServiceUnit,
    stop: [
      {
        step: "stopping the installed service",
        command: "systemctl",
        args: ["--user", "stop", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      ...prepareActivation,
      {
        step: "starting the service",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    running: {
      command: "systemctl",
      args: ["--user", "is-active", BOOT_SERVICE_UNIT_FILE],
      state: (result) => {
        const state = result.stdout.trim();
        if (state === "active") return "running";
        return state === "activating" || state === "reloading" ? "starting" : "stopped";
      },
    },
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    handoff: [
      ...prepareActivation,
      {
        step: "restarting the service",
        command: "systemctl",
        args: ["--user", "restart", "--no-block", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    deactivate: [
      {
        step: "stopping the service",
        command: "systemctl",
        args: ["--user", "disable", "--now", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ],
  };
}

function launchdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly uid: number;
  readonly environmentPath: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    "Library",
    "LaunchAgents",
    BOOT_SERVICE_PLIST_FILE,
  );
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`;
  // bootout/enable are optional: they fail on not-loaded states that are fine
  // to proceed from. The strict `bootstrap` runs last and is also the start:
  // loading a RunAtLoad/KeepAlive plist starts the job, so a separate kickstart
  // would kill and restart a server it just booted.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) =>
      renderBootServicePlist(plan, {
        homeDir: input.homeDir,
        environmentPath: input.environmentPath,
      }),
    // Without --wait, bootout returns in milliseconds while the job drains
    // for up to ExitTimeOut, and a bootstrap during the drain fails EIO.
    // --wait (present on modern macOS, absent from the man page) blocks until
    // the job is removed from the domain; STOP_STEP_TIMEOUT outlives it.
    stop: [
      {
        step: "stopping the installed launch agent",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      // A persisted `launchctl disable` override refuses bootstrap; clear it.
      {
        step: "enabling the launch agent",
        command: "launchctl",
        args: ["enable", serviceTarget],
        optional: true,
      },
      {
        step: "starting the service",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    // A loaded RunAtLoad job can sit in "spawn scheduled" for a moment, and a
    // crash-looping one in "not running" between throttled respawns.
    running: {
      command: "launchctl",
      args: ["print", serviceTarget],
      state: (result) => {
        if (result.code !== 0) return "stopped";
        return /^\s*state = running\s*$/m.test(result.stdout) ? "running" : "starting";
      },
    },
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    // No `launchctl disable` here: a persisted override would sabotage a later
    // reinstall.
    deactivate: [
      {
        step: "stopping the service",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [],
  };
}

function selectBootServiceManager(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly uid: number | undefined;
  readonly path: Path.Path;
  readonly environmentPath: string;
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }
  if (input.platform === "linux") {
    return systemdManager({ path: input.path, homeDir: input.homeDir });
  }
  if (input.platform === "darwin" && input.uid !== undefined) {
    return launchdManager({
      path: input.path,
      homeDir: input.homeDir,
      uid: input.uid,
      environmentPath: input.environmentPath,
    });
  }
  return undefined;
}

export class BootServiceUnsupportedError extends Schema.TaggedError<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedError<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedError<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the J5 Code background service.";
  }
}

const BootServiceProblem = Schema.Literals([
  "user-manager-unavailable",
  "linger-unavailable",
  "linger-disabled",
  "service-disabled",
  "service-stopped",
  "restart-pending",
  "legacy-service-present",
  "foreign-service-present",
  "service-dropin-conditions",
]);
type BootServiceProblem = typeof BootServiceProblem.Type;

export function formatBootServiceProblem(problem: BootServiceProblem): string {
  switch (problem) {
    case "user-manager-unavailable":
      return "Cannot reach the systemd user manager. Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if it is missing; do not run J5 Code with sudo.";
    case "linger-unavailable":
      return 'Cannot check whether this user can run services after logout. Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.';
    case "linger-disabled":
      return 'Lingering is disabled. J5 Code will stop when your last login session ends and will not start at boot. Run `sudo loginctl enable-linger "$(id -un)"` on this machine, then retry the service command as your normal user.';
    case "service-disabled":
      return "The service is not enabled to start automatically. Run `j5 service install` to repair it.";
    case "service-stopped":
      return "The service is not running. Check the service log and `systemctl --user status j5code.service`, then run `j5 service install`.";
    case "restart-pending":
      return "A newer version is installed but the service is still running the previous one. Run `j5 service restart` to switch.";
    case "legacy-service-present":
      return "The previous J5 service (t3code.service / com.t3tools.t3code.service) is still installed. Run `j5 service install` to replace it with j5code.service / codes.jackson.j5code.service.";
    case "foreign-service-present":
      return "A j5code.service / codes.jackson.j5code.service unit that J5 did not write already exists. It was left untouched; remove or rename it yourself, then run `j5 service install` again.";
    case "service-dropin-conditions":
      return "A drop-in in ~/.config/systemd/user/j5code.service.d/ sets a Condition or Assert directive, which can make systemd skip starting the service while reporting success. Nothing was changed; review and remove that drop-in yourself, then run `j5 service install` again.";
  }
}

export class BootServicePrerequisiteError extends Schema.TaggedError<BootServicePrerequisiteError>()(
  "BootServicePrerequisiteError",
  {
    problem: BootServiceProblem,
    // J5: the files behind the problem, when there are specific ones.
    paths: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const files = this.paths === undefined ? "" : ` Files: ${this.paths.join(", ")}`;
    return `[${this.problem}] ${formatBootServiceProblem(this.problem)}${files}`;
  }
}

/** J5: the started unit did not reach a running state (see BootServiceRunningProbe). */
export class BootServiceNotRunningError extends Schema.TaggedError<BootServiceNotRunningError>()(
  "BootServiceNotRunningError",
  { state: Schema.String },
) {
  override get message(): string {
    return `The service manager accepted the start, but the service is not running (${this.state}). Check the service log and \`j5 service status\`.`;
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedError<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  {},
) {
  override get message(): string {
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export class BootServiceDowngradeRefusedError extends Schema.TaggedError<BootServiceDowngradeRefusedError>()(
  "BootServiceDowngradeRefusedError",
  {
    installedVersion: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to replace j5@${this.installedVersion} with older j5@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServicePrerequisiteError
  | BootServiceUpdatePendingError
  | BootServiceDowngradeRefusedError
  | BootServiceNotRunningError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly installedVersion?: string;
  readonly installedBaseDir?: string;
  readonly problems?: ReadonlyArray<BootServiceProblem>;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: (options?: {
      readonly allowDowngrade?: boolean;
      readonly start?: boolean;
    }) => Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Only when the unit serves this base dir: the unit name is per user, so
     * another home's service is left alone, which resolves `skipped`. From
     * inside the service the restart can only be `queued` with the service
     * manager, since the stop ends this process.
     */
    readonly restart: Effect.Effect<"restarted" | "queued" | "skipped", BootServiceError>;
    /**
     * Run `operation` while this home's installed service is stopped, then
     * start it again when it was enabled (systemd) or loaded (launchd)
     * beforehand. A service that belongs to another home is left alone. The
     * service is started again even when stopping it failed; the operation's
     * own failure is reported ahead of a failure to restart.
     */
    readonly withStopped: <A, E, R>(
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | BootServiceError, R>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const uid = yield* HostProcess.UserId;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const homeDir = yield* Config.String("HOME").pipe(Config.withDefault(""));
  const installerPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const runningInsideService =
    (yield* Config.String(BOOT_SERVICE_UNIT_ENV).pipe(Config.withDefault(""))) ===
    BOOT_SERVICE_UNIT_FILE;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };
  const xmlSafeInstallerDirectories = installerPath.split(":").filter(
    (directory) =>
      directory.length > 0 &&
      Array.from(directory).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
      }),
  );
  const environmentPath = Array.from(
    new Set([
      ...xmlSafeInstallerDirectories,
      path.dirname(host.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ).join(":");

  const detectedManager = selectBootServiceManager({
    platform,
    homeDir,
    uid,
    path,
    environmentPath,
  });
  const unitPath = detectedManager?.unitPath ?? "";
  const logPath = path.join(input.logsDir, BOOT_SERVICE_LOG_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const restartPendingPath = path.join(input.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion, platform);
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        // Opened read-write: Windows refuses to flush a handle without write access.
        yield* (yield* fs.open(tempPath, { flag: "r+" })).sync;
        yield* fs.rename(tempPath, filePath);
        // Windows has no directory fsync (EPERM); NTFS journals the rename.
        yield* (yield* fs.open(directory, { flag: "r" })).sync.pipe(
          Effect.catchIf(
            (error) => (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EPERM",
            () => Effect.void,
          ),
        );
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  const plan: BootServicePlan = {
    program: [runtimePaths.entryPath, "__service-launcher"],
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireManager = Effect.suspend(() =>
    detectedManager === undefined
      ? new BootServiceUnsupportedError({ platform })
      : Effect.succeed(detectedManager),
  );

  const logFailure = (error: { readonly message: string }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, { flag: "a" }),
      ),
      Effect.ignore,
    );

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly timeout?: Duration.Input;
      readonly acceptFailure?: BootServiceStep["acceptFailure"];
    },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0 || options?.acceptFailure?.(result) === true,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError(logFailure),
    );
  });

  const runSteps = (steps: ReadonlyArray<BootServiceStep>) =>
    Effect.forEach(
      steps,
      (entry) => {
        const run = runStep(entry.step, entry.command, entry.args, {
          ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
          ...(entry.acceptFailure === undefined ? {} : { acceptFailure: entry.acceptFailure }),
        });
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

  const probe = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: Duration.seconds(5) }).pipe(Effect.option);
  const succeeded = (result: Option.Option<ProcessRunner.ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;
  /**
   * J5: runs `activate`, then waits (bounded) for the unit to be running. A
   * start the service manager skipped (a failed `Condition*=`) or a unit that
   * never comes up fails here, so callers roll back instead of reporting success.
   */
  const activateAndVerify = Effect.fn("cloud.boot_service.activate_and_verify")(function* (
    manager: BootServiceManager,
  ) {
    yield* runSteps(manager.activate);
    let detail = "no answer from the service manager";
    for (let attempt = 1; attempt <= ACTIVATION_SETTLE_ATTEMPTS; attempt++) {
      const result = yield* probe(manager.running.command, manager.running.args);
      const observed = Option.isSome(result) ? manager.running.state(result.value) : "starting";
      if (observed === "running") return;
      if (Option.isSome(result)) {
        const stdout = result.value.stdout;
        detail =
          manager.kind === "launchd"
            ? (/^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim() ?? "not loaded")
            : stdout.trim() || `exit code ${result.value.code}`;
      }
      if (observed === "stopped") break;
      if (attempt < ACTIVATION_SETTLE_ATTEMPTS) yield* Effect.sleep(ACTIVATION_SETTLE_INTERVAL);
    }
    const error = new BootServiceNotRunningError({ state: detail });
    yield* logFailure(error);
    return yield* error;
  });

  /**
   * J5: systemd drop-ins in `<unit>.d/` that gate starting (`Condition*=`,
   * `Assert*=`). Operator drop-ins that only set Environment= and the like are
   * fine; one that gates the start can make `restart` succeed while nothing
   * runs, so install refuses and status reports it. launchd has no drop-ins.
   */
  const gatingDropIns = Effect.gen(function* () {
    if (detectedManager?.kind !== "systemd") return [];
    const dropInDir = `${detectedManager.unitPath}.d`;
    const entries = yield* fs.readDirectory(dropInDir).pipe(Effect.orElseSucceed(() => []));
    const gating: string[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".conf")).toSorted()) {
      const filePath = path.join(dropInDir, entry);
      const contents = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
      if (/^\s*(Condition|Assert)\w+\s*=/m.test(contents)) gating.push(filePath);
    }
    return gating;
  });

  // J5: the npm-era (0.0.43 and earlier) J5 unit this machine may still run
  // (./j5/legacyBootService.ts).
  const legacyService =
    detectedManager === undefined
      ? undefined
      : legacyJ5BootService({ kind: detectedManager.kind, path, homeDir, uid });
  const legacyUnitPresent = Effect.gen(function* () {
    if (legacyService === undefined) return false;
    const contents = yield* fs.readFileString(legacyService.unitPath).pipe(Effect.option);
    return Option.isSome(contents) && isLegacyJ5BootServiceUnit(contents.value);
  });
  /**
   * Starts the new unit in place of the legacy J5 one. Both would serve the
   * same home and port, so the legacy service stops first, strictly: a stop
   * that fails for any reason other than "not running" ends the handover
   * before the new unit starts, leaving the legacy service as it was. The
   * legacy unit is removed only once the new unit is verified running, and
   * brought back (with the state file it understands) if it is not.
   */
  const activateReplacingLegacy = Effect.fn("cloud.boot_service.activate_replacing_legacy")(
    function* (manager: BootServiceManager, previousStateText: Option.Option<string>) {
      if (legacyService === undefined) return yield* activateAndVerify(manager);
      const restoreState = Option.isSome(previousStateText)
        ? writeDurably(statePath, previousStateText.value)
        : Effect.void;
      yield* runSteps(legacyService.deactivate).pipe(
        Effect.tapError(() => restoreState.pipe(Effect.ignore)),
      );
      yield* activateAndVerify(manager).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* runSteps(manager.deactivate).pipe(Effect.ignore);
            yield* restoreState;
            yield* runSteps(legacyService.restore);
          }).pipe(Effect.ignore),
        ),
      );
      yield* fs
        .remove(legacyService.unitPath, { force: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      yield* runSteps(legacyService.finalize);
    },
  );

  const lingerArgs = [
    "show-user",
    ...(uid === undefined ? [] : [String(uid)]),
    "--property=Linger",
    "--value",
  ];
  const readSystemdProblems = Effect.fn("cloud.boot_service.read_systemd_problems")(function* (
    includeService: boolean,
  ) {
    const [manager, linger] = yield* Effect.all(
      [probe("systemctl", ["--user", "show-environment"]), probe("loginctl", lingerArgs)],
      { concurrency: "unbounded" },
    );
    const problems: BootServiceProblem[] = [];
    if (!succeeded(manager)) problems.push("user-manager-unavailable");
    const lingering = succeeded(linger) && Option.isSome(linger) ? linger.value.stdout.trim() : "";
    if (lingering !== "yes") {
      problems.push(lingering === "no" ? "linger-disabled" : "linger-unavailable");
    }
    if (includeService && succeeded(manager)) {
      const [enabled, active] = yield* Effect.all(
        [
          probe("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]),
          probe("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]),
        ],
        { concurrency: "unbounded" },
      );
      if (
        !succeeded(enabled) ||
        (Option.isSome(enabled) && enabled.value.stdout.trim() !== "enabled")
      ) {
        problems.push("service-disabled");
      }
      if (!succeeded(active)) problems.push("service-stopped");
    }
    return problems;
  });

  const requireSystemdPrerequisites = Effect.gen(function* () {
    const problems = yield* readSystemdProblems(false);
    const unavailable = problems.find((problem) => problem !== "linger-disabled");
    if (unavailable) return yield* new BootServicePrerequisiteError({ problem: unavailable });
    if (!problems.includes("linger-disabled")) return;
    yield* runStep("enabling lingering for this user", "loginctl", [
      "enable-linger",
      "--no-ask-password",
      ...(uid === undefined ? [] : [String(uid)]),
    ]).pipe(
      Effect.mapError(
        (cause) => new BootServicePrerequisiteError({ problem: "linger-disabled", cause }),
      ),
    );
    const remaining = yield* readSystemdProblems(false);
    if (remaining[0]) return yield* new BootServicePrerequisiteError({ problem: remaining[0] });
  });

  const install = Effect.fn("cloud.boot_service.install")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    const manager = yield* requireManager;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    const existingUnit = yield* fs.readFileString(manager.unitPath).pipe(Effect.option);
    if (Option.isSome(existingUnit) && !isRenderedJ5BootServiceUnit(existingUnit.value)) {
      return yield* new BootServicePrerequisiteError({ problem: "foreign-service-present" });
    }
    const dropIns = yield* gatingDropIns;
    if (dropIns.length > 0) {
      const error = new BootServicePrerequisiteError({
        problem: "service-dropin-conditions",
        paths: dropIns,
      });
      yield* logFailure(error);
      return yield* error;
    }
    const replacesLegacy = yield* legacyUnitPresent;
    if (replacesLegacy && options?.start === false) {
      // Rewriting the shared state file under a running legacy launcher would
      // break its next restart; the handover has to start the new unit.
      return yield* new BootServicePrerequisiteError({ problem: "legacy-service-present" });
    }

    if (manager.kind === "systemd") {
      yield* requireSystemdPrerequisites.pipe(Effect.tapError(logFailure));
    }

    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      httpClient,
      platform,
      arch,
      releaseBaseUrl,
      validate: (runtime) =>
        runner
          .run({
            command: pinnedRuntimeCommand(runtime).command,
            args: [...pinnedRuntimeCommand(runtime).args, "--version"],
            timeout: Duration.seconds(30),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned t3 runtime",
                  cause,
                }),
            ),
            Effect.flatMap((result) => {
              const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];
              return result.code === 0 && reportedVersion === input.cliVersion
                ? Effect.void
                : Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the pinned t3 runtime",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
            }),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimeInstallError"
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
    );
    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    // With start=false the service keeps running while its files change. The
    // launcher reads the state file once at startup and the unit only matters
    // on the next start, so that is safe as long as the launcher is not in the
    // middle of a remote update, which is the one time it writes the state file
    // itself.
    const start = options?.start !== false;
    if (installed && start && runningInsideService && manager.kind === "systemd") {
      // Stopping the unit from inside it kills this process before the start.
      // A transient unit runs the same install from outside, stop first, so it
      // still serialises with a remote update the launcher may be starting.
      yield* runStep("handing the install to a transient unit", "systemd-run", [
        "--user",
        "--collect",
        "--quiet",
        // Transient properties reach systemd literally, unlike unit-file specifiers.
        `--property=StandardOutput=append:${logPath}`,
        `--property=StandardError=append:${logPath}`,
        `--setenv=${BOOT_SERVICE_UNIT_ENV}=`,
        runtimePaths.entryPath,
        "service",
        "install",
        "--base-dir",
        // systemd expands $VAR in arguments (not in the executable path).
        input.baseDir.replaceAll("$", () => "$$"),
        ...(options?.allowDowngrade === true ? ["--allow-downgrade"] : []),
      ]);
      return { ...plan, handedOff: true };
    }
    if (installed && start) {
      yield* runSteps(manager.stop);
    }

    yield* Effect.gen(function* () {
      const previousStateText =
        installed || replacesLegacy
          ? yield* fs.readFileString(statePath).pipe(Effect.option)
          : Option.none<string>();
      if (installed || replacesLegacy) {
        if (Option.isSome(previousStateText)) {
          if (serviceStateHasPendingUpdate(previousStateText.value)) {
            return yield* new BootServiceUpdatePendingError();
          }
          // A remote update can finish after the CLI checks status. Read its
          // final version after the launcher stops and before changing files.
          const installedVersion = serviceStateActiveVersion(previousStateText.value);
          if (
            installedVersion !== undefined &&
            options?.allowDowngrade !== true &&
            compareExactServiceVersions(input.cliVersion, installedVersion) < 0
          ) {
            return yield* new BootServiceDowngradeRefusedError({
              installedVersion,
              targetVersion: input.cliVersion,
            });
          }
        }
      }
      yield* fs
        .makeDirectory(path.dirname(unitPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      // Files can match the new version even when activation fails; keep that install retryable.
      yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
      yield* writeDurably(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
        `${JSON.stringify(
          {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: input.cliVersion,
          } satisfies ServiceState,
          null,
          2,
        )}\n`,
      );
      if (!start && installed) {
        // The launcher only writes this file while a remote update is in
        // flight. One that began after the check above lands either before
        // this write (then the launcher's copy in memory is what it keeps
        // acting on, and its next write puts its own outcome back) or after
        // it, which this read catches: the file no longer says what was just
        // written, so stop here before repointing the unit.
        const written = yield* fs.readFileString(statePath);
        if (serviceStateActiveVersion(written) !== input.cliVersion) {
          return yield* new BootServiceUpdatePendingError();
        }
      }
      yield* writeDurably(unitPath, manager.render(plan));

      if (start) {
        yield* replacesLegacy
          ? activateReplacingLegacy(manager, previousStateText)
          : activateAndVerify(manager);
        yield* fs.remove(restartPendingPath, { force: true });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
      ),
      // J5: never while a legacy unit is present. The handover either left the
      // legacy service running or brought it back; starting the new unit too
      // would put two servers on one home.
      Effect.tapError(() =>
        installed && start && !replacesLegacy
          ? runSteps(manager.restart).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    return plan;
  });

  const restart: BootService["Service"]["restart"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    const unit = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(unit)) return "skipped" as const;
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (
      installedBaseDir === undefined ||
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
    ) {
      return "skipped" as const;
    }
    // Writes no state, and the launcher lets an update transition in flight
    // finish before the queued stop tears it down.
    if (runningInsideService && manager.handoff !== undefined) {
      yield* runSteps(manager.handoff);
      return "queued" as const;
    }
    yield* runSteps(manager.stop);
    const replacesLegacy = yield* legacyUnitPresent;
    yield* (
      replacesLegacy ? activateReplacingLegacy(manager, Option.none()) : activateAndVerify(manager)
    ).pipe(
      // J5: no restart recovery when the legacy unit is present (see install).
      Effect.tapError(() =>
        replacesLegacy ? Effect.void : runSteps(manager.restart).pipe(Effect.ignore),
      ),
    );
    yield* fs.remove(restartPendingPath, { force: true });
    return "restarted" as const;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
    ),
    Effect.withSpan("cloud.boot_service.restart"),
  );

  const withStopped = Effect.fn("cloud.boot_service.with_stopped")(function* <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | BootServiceError, R> {
    if (detectedManager === undefined) return yield* operation;
    const manager = detectedManager;
    const unit = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(unit)) return yield* operation;
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (
      installedBaseDir === undefined ||
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
    ) {
      return yield* operation;
    }
    // `is-active` fails while a crash-looping unit sits in `activating
    // (auto-restart)`, and a throttled launchd job is loaded without a pid;
    // both would start the server mid-repair. So the unit is always
    // stopped, and started again when it was active, enabled or loaded
    // before; a disabled unit caught crash-looping stays stopped.
    const restore =
      manager.kind === "systemd"
        ? yield* Effect.map(
            Effect.all(
              [
                probe("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]),
                probe("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]),
              ],
              { concurrency: "unbounded" },
            ),
            ([enabled, active]) => succeeded(active) || succeeded(enabled),
          )
        : succeeded(
            yield* probe("launchctl", ["print", `gui/${uid}/${BOOT_SERVICE_LAUNCHD_LABEL}`]),
          );
    return yield* Effect.acquireUseRelease(
      // Every stop step is required when the service is to be restored: a
      // step that was fine to skip during uninstall would leave the server
      // holding the database. A stop that fails (a timeout, say) may still
      // have stopped the service, so the restore below runs either way.
      // Nothing to restore means nothing is expected to be loaded, and the
      // stop is best-effort (launchd's bootout fails on an unloaded job).
      runSteps(manager.stop.map((step) => ({ ...step, optional: !restore }))).pipe(Effect.exit),
      (stopped): Effect.Effect<A, E | BootServiceError, R> =>
        Exit.isSuccess(stopped) ? operation : Effect.failCause(stopped.cause),
      (_, exit) => {
        if (!restore) return Effect.void;
        // Start only: `activate` would also enable a unit the user disabled.
        // When the operation itself failed, its error is the one worth reporting.
        const start = runSteps(manager.restart);
        return Exit.isFailure(exit) ? Effect.ignore(start) : start;
      },
    );
  });

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    // J5: a leftover npm-era (0.0.43 and earlier) J5 unit goes too; a T3 Code
    // unit never matches.
    const removedLegacy = yield* Effect.gen(function* () {
      if (legacyService === undefined || !(yield* legacyUnitPresent)) return false;
      yield* runSteps(legacyService.deactivate);
      yield* fs
        .remove(legacyService.unitPath, { force: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      yield* runSteps(legacyService.finalize);
      return true;
    });
    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return removedLegacy;
    yield* runSteps(manager.deactivate);
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* runSteps(manager.finalize);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (detectedManager === undefined) {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    const legacyPresent = yield* legacyUnitPresent;
    const dropInsGate = (yield* gatingDropIns).length > 0;
    if (!(yield* fs.exists(unitPath))) {
      const problems: BootServiceProblem[] = [
        ...(legacyPresent ? ["legacy-service-present" as const] : []),
        ...(dropInsGate ? ["service-dropin-conditions" as const] : []),
      ];
      return {
        supported: true,
        installed: false,
        current: false,
        ...(problems.length > 0 ? { problems } : {}),
        unitPath,
        logPath,
      };
    }
    const [unit, runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all([
      fs.readFileString(unitPath),
      fs.exists(runtimePaths.entryPath),
      fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
      fs.readFileString(statePath).pipe(Effect.option),
    ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    const installedVersion = Option.isSome(stateText)
      ? serviceStateActiveVersion(stateText.value)
      : undefined;
    const installedBaseDir = bootServiceBaseDirOf(unit);
    const normalizeUnit = (contents: string) =>
      detectedManager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;
    const problems: BootServiceProblem[] =
      detectedManager.kind === "systemd" ? [...(yield* readSystemdProblems(true))] : [];
    if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
    if (legacyPresent) problems.push("legacy-service-present");
    if (dropInsGate) problems.push("service-dropin-conditions");
    return {
      supported: true,
      installed: true,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
      problems,
      current:
        problems.length === 0 &&
        normalizeUnit(unit) === normalizeUnit(detectedManager.render(plan)) &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  return BootService.of({ install, restart, withStopped, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
