import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

it("reads the served T3 home back out of a rendered unit or plist", () => {
  const plan = (baseDir: string) => ({
    program: [`${baseDir}/runtime/versions/1.2.3/j5`, "__service-launcher"],
    baseDir,
    logPath: `${baseDir}/userdata/logs/boot-service.log`,
    unitPath: "/home/theo/.config/systemd/user/j5code.service",
  });

  expect(
    BootService.bootServiceBaseDirOf(BootService.renderBootServiceUnit(plan("/home/theo/.t3"))),
  ).toBe("/home/theo/.t3");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceUnit(plan("/home/theo/T3 Data/100%")),
    ),
  ).toBe("/home/theo/T3 Data/100%");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServicePlist(plan("/Users/theo/a&b"), {
        homeDir: "/Users/theo",
        environmentPath: "/usr/bin",
      }),
    ),
  ).toBe("/Users/theo/a&b");
  expect(BootService.bootServiceBaseDirOf("[Service]\nExecStart=/x\n")).toBeUndefined();
  // An upstream T3 Code unit never reads as serving a J5 home.
  expect(
    BootService.bootServiceBaseDirOf("[Service]\nEnvironment=T3CODE_HOME=/home/theo/.t3\n"),
  ).toBeUndefined();
});

it.each([
  ["a unit", '/home/theo/T3 "Data"/100%\\x', BootService.renderBootServiceUnit],
  [
    "a plist",
    "/Users/theo/a&b <c>",
    (plan: BootService.BootServicePlan) =>
      BootService.renderBootServicePlist(plan, { homeDir: "/Users/theo", environmentPath: "" }),
  ],
] as const)("reads the launcher back out of %s", (_, baseDir, render) => {
  const program = `${baseDir}/runtime/versions/1.2.3/t3`;
  expect(
    BootService.bootServiceProgramOf(
      render({ program: [program, "__service-launcher"], baseDir, logPath: "/log", unitPath: "" }),
    ),
  ).toBe(program);
});

// J5: the rendered unit and launch agent carry J5's names and home (FORK.md case 41).
const linuxRuntime = "/home/theo/.t3/runtime/versions/1.2.3/t3";
const linuxPlan = {
  program: [linuxRuntime, "__service-launcher"],
  baseDir: "/home/theo/.t3",
  logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
  unitPath: "/home/theo/.config/systemd/user/j5code.service",
};

it("runs the pinned runtime's own executable as the systemd launcher", () => {
  const unit = BootService.renderBootServiceUnit(linuxPlan);

  expect(unit).toContain(`ExecStart=${linuxRuntime} __service-launcher`);
  expect(unit).toContain("Environment=J5CODE_HOME=/home/theo/.t3");
  expect(unit).toContain("Environment=T3_BOOT_SERVICE_UNIT=j5code.service");
  expect(unit).not.toContain("T3CODE_HOME");
  expect(unit).toContain("KillMode=mixed");
  expect(unit).not.toContain("node");
});

const macRuntime = "/Users/theo/.t3/runtime/versions/1.2.3/t3";
const macPlan = {
  program: [macRuntime, "__service-launcher"],
  baseDir: "/Users/theo/.t3",
  logPath: "/Users/theo/.t3/userdata/logs/boot-service.log",
  unitPath: "/Users/theo/Library/LaunchAgents/codes.jackson.j5code.service.plist",
};
const macInstallerPath =
  "/opt/homebrew/bin:/Users/theo/.npm-global/bin:/Users/theo/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin";
const macRenderOptions = { homeDir: "/Users/theo", environmentPath: macInstallerPath };

it("runs the pinned runtime's own executable as the launch agent", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain(
    `  <array>\n    <string>${macRuntime}</string>\n    <string>__service-launcher</string>\n  </array>`,
  );
  expect(plist).not.toContain("node</string>");
  expect(plist).toContain("<key>J5CODE_HOME</key>");
  expect(plist).toContain("<string>codes.jackson.j5code.service</string>");
  expect(plist).not.toContain("T3CODE_HOME");
});

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  installerPath = macInstallerPath,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
  const baseDir = path.join(home, ".t3");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", platform);
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "#!/bin/sh\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const commands: string[] = [];
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const timeouts = new Map<string, unknown>();
  const control: {
    failCommand: string | undefined;
    stateAfterStop?: string;
    linger: string;
    enabled: boolean;
    active: boolean;
    /** What `systemctl is-active` prints while not active. */
    inactiveState?: string;
    /** `launchctl print` state lines, consumed one per call; "running" after. */
    launchdStates?: string[];
    /** Exact non-zero results for specific commands. */
    results?: Map<string, { code: number; stdout?: string; stderr?: string }>;
  } = {
    failCommand: undefined,
    linger: "yes",
    enabled: true,
    active: true,
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("test.run_boot_service_command")(function* (
      input: ProcessRunner.ProcessRunInput,
    ) {
      const command = `${input.command} ${input.args.join(" ")}`;
      commands.push(command);
      invocations.push(input);
      timeouts.set(command, input.timeout);
      const scripted = control.results?.get(command);
      const failed = command === control.failCommand || scripted !== undefined;
      if (!failed && command === "loginctl enable-linger --no-ask-password 501")
        control.linger = "yes";
      if (!failed && command === "systemctl --user enable j5code.service") control.enabled = true;
      if (!failed && command === "systemctl --user restart j5code.service") control.active = true;
      // A stop that fails (a timeout, say) has still stopped the service.
      if (command === "systemctl --user stop j5code.service") control.active = false;
      if (
        control.stateAfterStop !== undefined &&
        (command === "systemctl --user stop j5code.service" ||
          command.startsWith("launchctl bootout --wait "))
      ) {
        yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
      }
      if (scripted !== undefined) {
        return {
          stdout: scripted.stdout ?? "",
          stderr: scripted.stderr ?? "",
          code: ChildProcessSpawner.ExitCode(scripted.code),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }
      return {
        stdout:
          input.args[0] === "--version"
            ? `t3 v${/versions\/([^/]+)\//.exec(input.command)?.[1] ?? "1.2.3"}\n`
            : input.command === "loginctl" && input.args[0] === "show-user"
              ? `${control.linger}\n`
              : input.args[1] === "is-enabled"
                ? control.enabled
                  ? "enabled\n"
                  : "disabled\n"
                : input.args[1] === "is-active"
                  ? `${control.active ? "active" : (control.inactiveState ?? "inactive")}\n`
                  : input.command === "launchctl" && input.args[0] === "print"
                    ? `\tstate = ${control.launchdStates?.shift() ?? "running"}\n`
                    : "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(
          failed ||
            (input.args[1] === "is-active" && !control.active) ||
            (input.args[1] === "is-enabled" && !control.enabled)
            ? 1
            : 0,
        ),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
  });
  const makeService = (
    environmentPath: string | undefined = installerPath,
    cliVersion = "1.2.3",
    serviceBaseDir = baseDir,
    insideService = false,
  ) =>
    Effect.gen(function* () {
      const paths = pinnedRuntimePaths(path, serviceBaseDir, cliVersion, platform);
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(paths.sentinelPath, `${cliVersion}\n`);
      return yield* BootService.make({
        baseDir: serviceBaseDir,
        logsDir: path.join(serviceBaseDir, "userdata", "logs"),
        cliVersion,
        host: { execPath: "/usr/bin/t3" },
      });
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(HostProcess.UserId, 501),
          Layer.succeed(HostProcess.ExecutablePath, "/usr/bin/t3"),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no release download expected")),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: home,
                ...(environmentPath === undefined || environmentPath === ""
                  ? {}
                  : { PATH: environmentPath }),
                ...(insideService ? { T3_BOOT_SERVICE_UNIT: "j5code.service" } : {}),
              },
            }),
          ),
        ),
      ),
    );
  const service = yield* makeService();
  return {
    service,
    makeService,
    fs,
    baseDir,
    statePath,
    commands,
    invocations,
    timeouts,
    control,
    runtime,
  };
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect(
    "fails before installing files or validating a runtime when lingering needs an administrator",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, runtime } = yield* makeHarness();
        const before = yield* service.status;
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";
        yield* fs.remove(runtime.sentinelPath);

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServicePrerequisiteError",
          problem: "linger-disabled",
        });
        expect(error.message).toContain('sudo loginctl enable-linger "$(id -un)"');
        expect(error.message).toContain("last login session ends");
        expect(yield* fs.exists(before.unitPath)).toBe(false);
        expect(yield* fs.exists(statePath)).toBe(false);
        expect(commands.some((command) => command.includes("--version"))).toBe(false);
        expect(
          commands.some(
            (command) => command.includes("daemon-reload") || command.includes("restart"),
          ),
        ).toBe(false);
        expect(yield* fs.readFileString(before.logPath)).toContain("[linger-disabled]");
      }),
  );

  it.effect(
    "detects a partial install and preserves the running service when repair lacks permission",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness();
        const plan = yield* service.install();
        const before = yield* fs.readFileString(statePath);
        const unit = yield* fs.readFileString(plan.unitPath);
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";

        expect(yield* service.status).toMatchObject({
          current: false,
          problems: ["linger-disabled"],
        });
        commands.length = 0;
        expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
          "BootServicePrerequisiteError",
        );
        expect(yield* fs.readFileString(statePath)).toBe(before);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(commands).not.toContain("systemctl --user stop j5code.service");
      }),
  );

  it.effect("enables lingering before installing and repairs stopped or disabled services", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      control.linger = "no";
      yield* service.install();
      expect(control.linger).toBe("yes");
      expect(commands.indexOf("loginctl enable-linger --no-ask-password 501")).toBeLessThan(
        commands.indexOf("systemctl --user daemon-reload"),
      );

      control.enabled = false;
      control.active = false;
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["service-disabled", "service-stopped"],
      });
      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect.each([
    { command: "systemctl --user show-environment", problem: "user-manager-unavailable" },
    { command: "loginctl show-user 501 --property=Linger --value", problem: "linger-unavailable" },
  ])("reports failed prerequisite probes without installing: $command", ({ command, problem }) =>
    Effect.gen(function* () {
      const { service, fs, statePath, control } = yield* makeHarness();
      control.failCommand = command;
      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem,
      });
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, timeouts, runtime } = yield* makeHarness();
      const plan = yield* service.install();

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(plan.program).toEqual([runtime.entryPath, "__service-launcher"]);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `ExecStart=${runtime.entryPath} __service-launcher`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      expect((yield* service.status).current).toBe(false);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      // The stop can block up to systemd's 90s TimeoutStopSec; the runner's
      // 60s default would cancel it mid-shutdown.
      expect(timeouts.get("systemctl --user disable --now j5code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "reports the installed version across launcher protocols on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath } = yield* makeHarness(platform);
        yield* service.install();

        for (const protocol of [SERVICE_LAUNCHER_PROTOCOL - 1, SERVICE_LAUNCHER_PROTOCOL + 1]) {
          yield* fs.writeFileString(
            statePath,
            `{"protocol":${protocol},"activeVersion":"1.2.4-nightly.1","update":{"status":"unknown"}}`,
          );
          expect(yield* service.status).toMatchObject({
            current: false,
            installedVersion: "1.2.4-nightly.1",
          });
        }
      }),
  );

  // regression: #5302 prevent accidental service downgrades
  it.effect("reports an unknown version for invalid service state", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();

      for (const stateText of [
        "{",
        '{"activeVersion":"latest"}',
        '{"activeVersion":"1.2"}',
        '{"activeVersion":123}',
      ]) {
        yield* fs.writeFileString(statePath, stateText);
        const status = yield* service.status;
        expect(status.current).toBe(false);
        expect(status.installedVersion).toBeUndefined();
      }
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "preserves a newer version that finishes updating during stop on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness(platform);
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        control.stateAfterStop = `{"protocol":${SERVICE_LAUNCHER_PROTOCOL + 1},"activeVersion":"1.2.4"}`;
        commands.length = 0;

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "1.2.4",
          targetVersion: "1.2.3",
        });
        expect(yield* fs.readFileString(statePath)).toBe(control.stateAfterStop);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(
          commands.filter(
            (command) =>
              command.startsWith(platform === "linux" ? "systemctl " : "launchctl ") &&
              !command.includes("show-environment"),
          ),
        ).toEqual(
          platform === "linux"
            ? ["systemctl --user stop j5code.service", "systemctl --user restart j5code.service"]
            : [
                "launchctl bootout --wait gui/501/codes.jackson.j5code.service",
                `launchctl bootstrap gui/501 ${plan.unitPath}`,
              ],
        );
      }),
  );

  // regression: #5302 prevent accidental service downgrades
  it.effect("allows an explicit downgrade", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.4"}`,
      );

      yield* service.install({ allowDowngrade: true });

      expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe("1.2.3");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("repairs versions with equal SemVer precedence without an override", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.3+previous-build"}`,
      );

      yield* service.install();

      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "install with start=false rewrites files, preserves service.env, and marks a restart pending on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, commands, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const envPath = path.join(baseDir, SERVICE_ENV_FILE);
        const envBytes = new TextEncoder().encode(
          '# user configuration\r\nT3CODE_TOKEN="literal $HOME # token"',
        );
        yield* fs.writeFile(envPath, envBytes);
        yield* service.install();
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);
        yield* service.install();
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);
        commands.length = 0;

        const newer = yield* makeService(undefined, "1.2.4");
        const plan = yield* newer.install({ start: false });
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);

        expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.4",
        });
        expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/j5");
        expect(
          commands.filter(
            (command) =>
              /^(systemctl|launchctl) /.test(command) && !command.includes("show-environment"),
          ),
        ).toEqual([]);
        const status = yield* newer.status;
        expect(status.current).toBe(false);
        expect(status.problems).toContain("restart-pending");

        commands.length = 0;
        expect(yield* newer.restart).toBe("restarted");
        expect((yield* newer.status).problems).not.toContain("restart-pending");
        expect((yield* newer.status).current).toBe(true);
      }),
  );

  it.effect("install with start=false keeps the marker when a later write fails", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* service.install();
      const newer = yield* makeService(undefined, "1.2.4");
      const unitPath = (yield* service.status).unitPath;
      yield* fs.remove(unitPath);
      yield* fs.makeDirectory(unitPath);
      yield* fs.writeFileString(path.join(unitPath, "occupied"), "");

      const error = yield* newer.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceInstallError");
      expect(
        yield* fs.exists(path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE)),
      ).toBe(true);
    }),
  );

  it.effect("install with start=false refuses while a remote update is pending", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);

      const error = yield* service.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceUpdatePendingError");
      expect(yield* fs.readFileString(statePath)).toBe(pendingState);
    }),
  );

  it.effect("pauses only this home's running service for maintenance, even when it fails", () =>
    Effect.gen(function* () {
      const { service, commands, control, makeService } = yield* makeHarness();
      yield* service.install();
      const failure = yield* service
        .withStopped(
          Effect.suspend(() => Effect.fail(control.active ? "running" : "repair failed")),
        )
        .pipe(Effect.flip);
      expect(failure).toBe("repair failed");
      expect(control.active).toBe(true);

      // A failed stop skips the operation but still starts the service again.
      control.failCommand = "systemctl --user stop j5code.service";
      let ran = false;
      const stopFailure = yield* service
        .withStopped(
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.flip);
      expect(stopFailure).toMatchObject({
        _tag: "BootServiceCommandError",
        step: "stopping the installed service",
      });
      expect(ran).toBe(false);
      expect(control.active).toBe(true);
      control.failCommand = undefined;

      // An enabled unit that is not active (crash-looping in auto-restart, say)
      // is still stopped for the repair and started again afterwards.
      control.active = false;
      commands.length = 0;
      yield* service.withStopped(Effect.sync(() => commands.push("repair")));
      expect(commands).toEqual([
        "systemctl --user is-enabled j5code.service",
        "systemctl --user is-active j5code.service",
        "systemctl --user stop j5code.service",
        "repair",
        "systemctl --user restart j5code.service",
      ]);
      expect(control.active).toBe(true);
      // A running unit the user disabled is started again but stays disabled.
      control.enabled = false;
      yield* service.withStopped(Effect.void);
      expect(control).toMatchObject({ active: true, enabled: false });
      // A unit that was neither enabled nor active stays stopped.
      control.active = false;
      control.enabled = false;
      commands.length = 0;
      yield* service.withStopped(Effect.sync(() => commands.push("repair")));
      expect(commands).toContain("systemctl --user stop j5code.service");
      expect(commands).not.toContain("systemctl --user restart j5code.service");
      expect(control.active).toBe(false);
      control.enabled = true;
      control.active = true;

      const fs = yield* FileSystem.FileSystem;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-doctor-other-" });
      const other = yield* makeService(undefined, "1.2.3", otherHome);
      commands.length = 0;
      expect(yield* other.withStopped(Effect.sync(() => control.active))).toBe(true);
      expect(commands).toEqual([]);
    }),
  );

  it.effect("restart leaves a service that serves another T3 home alone", () =>
    Effect.gen(function* () {
      const { service, fs, commands, makeService } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-home-" });

      const other = yield* makeService(undefined, "1.2.3", path.join(otherHome, ".t3"));
      expect(yield* other.restart).toBe("skipped");
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([]);
    }),
  );

  it.effect("hands the whole install to systemd without changing the running service", () =>
    Effect.gen(function* () {
      const { fs, commands, invocations, control, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoff-" });
      const baseDir = path.join(home, "T3 Data 100%", "${UNSET}", "$literal");
      const outside = yield* makeService(undefined, "1.2.3", baseDir);
      const plan = yield* outside.install();
      const statePath = path.join(baseDir, "runtime", "service-state.json");
      const state = yield* fs.readFileString(statePath);
      const unit = yield* fs.readFileString(plan.unitPath);
      const inside = yield* makeService(undefined, "1.2.4", baseDir, true);
      commands.length = 0;
      invocations.length = 0;

      const result = yield* inside.install({ allowDowngrade: true });

      expect(yield* fs.readFileString(statePath)).toBe(state);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(commands).not.toContain("systemctl --user stop j5code.service");
      expect(result).toMatchObject({ handedOff: true, logPath: plan.logPath });
      const handoffs = invocations.filter(({ command }) => command === "systemd-run");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]?.args).toEqual([
        "--user",
        "--collect",
        "--quiet",
        `--property=StandardOutput=append:${plan.logPath}`,
        `--property=StandardError=append:${plan.logPath}`,
        "--setenv=T3_BOOT_SERVICE_UNIT=",
        pinnedRuntimePaths(path, baseDir, "1.2.4", "linux").entryPath,
        "service",
        "install",
        "--base-dir",
        path.join(home, "T3 Data 100%", "$${UNSET}", "$$literal"),
        "--allow-downgrade",
      ]);

      const handoff = handoffs[0]!;
      control.failCommand = `${handoff.command} ${handoff.args.join(" ")}`;
      const error = yield* inside.install({ allowDowngrade: true }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BootServiceCommandError", exitCode: 1 });
      expect(yield* fs.readFileString(statePath)).toBe(state);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(control.active).toBe(true);
      expect(commands).not.toContain("systemctl --user stop j5code.service");
    }),
  );

  it.effect(
    "queues an in-service restart without stopping the caller, even on handoff failure",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, makeService } = yield* makeHarness();
        const plan = yield* service.install();
        const state = yield* fs.readFileString(statePath);
        const marker = `${plan.baseDir}/runtime/${SERVICE_RESTART_PENDING_FILE}`;
        yield* fs.writeFileString(marker, "1.2.3\n");
        const inside = yield* makeService(undefined, "1.2.3", undefined, true);
        commands.length = 0;
        control.failCommand = "systemctl --user daemon-reload";

        const error = yield* inside.restart.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "BootServiceCommandError", exitCode: 1 });
        expect(commands).toEqual(["systemctl --user daemon-reload"]);
        expect(control.active).toBe(true);

        control.failCommand = undefined;
        commands.length = 0;
        const outcome = yield* inside.restart;
        expect(commands).toEqual([
          "systemctl --user daemon-reload",
          "systemctl --user enable j5code.service",
          "systemctl --user restart --no-block j5code.service",
        ]);
        expect(outcome).toBe("queued");
        expect(yield* fs.readFileString(statePath)).toBe(state);
        expect(yield* fs.readFileString(marker)).toBe("1.2.3\n");
      }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop j5code.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart j5code.service",
      ]);
    }),
  );

  it.effect("restarts without overwriting a pending remote update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      yield* service.install();
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      for (const allowDowngrade of [false, true]) {
        commands.length = 0;

        expect((yield* service.install({ allowDowngrade }).pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );
        expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
        expect(
          commands.filter(
            (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
          ),
        ).toEqual([
          "systemctl --user stop j5code.service",
          "systemctl --user restart j5code.service",
        ]);
      }
    }),
  );

  // J5: a zero exit from the start command does not prove the unit runs.
  it.effect("fails a fresh install whose unit systemd skipped starting", () =>
    Effect.gen(function* () {
      const { service, fs, commands, control } = yield* makeHarness();
      control.active = false;
      control.results = new Map([
        // A failed Condition*= skips the start; restart still exits 0.
        ["systemctl --user restart j5code.service", { code: 0 }],
      ]);

      const error = yield* service.install().pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "BootServiceNotRunningError", state: "inactive" });
      expect(commands.filter((command) => command.includes("is-active"))).toHaveLength(1);
      expect(yield* fs.readFileString((yield* service.status).logPath)).toContain(
        "not running (inactive)",
      );
    }),
  );

  it.effect("waits a bounded time for a unit that is still activating", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness("darwin");
      // Settle sleeps are recorded and return at once: the wait is read from what
      // install asked to sleep, so no clock has to be stepped around its file I/O.
      const clock = yield* Clock.Clock;
      const sleeps: Array<number> = [];
      const settle = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.provideService(effect, Clock.Clock, {
          ...clock,
          sleep: (duration) => Effect.sync(() => void sleeps.push(Duration.toMillis(duration))),
        });

      control.launchdStates = ["spawn scheduled", "spawn scheduled"];
      yield* settle(service.install());
      expect(commands.filter((command) => command.startsWith("launchctl print"))).toHaveLength(3);
      expect(sleeps).toEqual([500, 500]);

      sleeps.length = 0;
      control.launchdStates = Array.from({ length: 20 }, () => "not running");
      expect(yield* settle(service.install().pipe(Effect.flip))).toMatchObject({
        _tag: "BootServiceNotRunningError",
        state: "not running",
      });
      // Bounded: ten probes with a half-second between each, then it gives up.
      expect(control.launchdStates).toHaveLength(10);
      expect(sleeps).toEqual(Array.from({ length: 9 }, () => 500));
    }),
  );

  it.effect("refuses to install under a drop-in that gates starting, and reports it", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const path = yield* Path.Path;
      const unitPath = (yield* service.status).unitPath;
      const dropInDir = `${unitPath}.d`;
      yield* fs.makeDirectory(dropInDir, { recursive: true });
      // An operator's port override is fine and stays.
      yield* fs.writeFileString(
        path.join(dropInDir, "10-port.conf"),
        "[Service]\nEnvironment=T3CODE_PORT=5773\n",
      );
      const gating = path.join(dropInDir, "90-managed-migration.conf");
      yield* fs.writeFileString(gating, `[Unit]\nConditionPathExists=!${statePath}\n`);

      expect(yield* service.status).toMatchObject({
        installed: false,
        problems: ["service-dropin-conditions"],
      });
      const error = yield* service.install().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem: "service-dropin-conditions",
        paths: [gating],
      });
      expect(error.message).toContain(gating);
      expect(error.message).not.toContain("10-port.conf");
      expect(yield* fs.exists(unitPath)).toBe(false);
      expect(yield* fs.exists(statePath)).toBe(false);
      expect(commands.some((command) => command.includes("daemon-reload"))).toBe(false);

      yield* fs.remove(gating);
      yield* service.install();
      expect((yield* service.status).current).toBe(true);
      yield* fs.writeFileString(
        path.join(dropInDir, "20-assert.conf"),
        "[Unit]\nAssertPathExists=/nowhere\n",
      );
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["service-dropin-conditions"],
      });
    }),
  );

  it.effect("installs, reports current state, and uninstalls on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, timeouts, runtime } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();

      expect(
        plan.unitPath.endsWith(
          path.join("Library", "LaunchAgents", "codes.jackson.j5code.service.plist"),
        ),
      ).toBe(true);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <key>PATH</key>\n    <string>${macInstallerPath}:/usr/local/bin:/usr/sbin:/sbin</string>`,
      );
      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <string>${runtime.entryPath}</string>\n    <string>__service-launcher</string>`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("systemctl "))).toBe(false);
      // A bootout can block up to the plist's 90s ExitTimeOut; the runner's
      // 60s default would cancel it and let bootstrap race a loaded job.
      expect(timeouts.get("launchctl bootout --wait gui/501/codes.jackson.j5code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  // regression: #8173 keep provider CLIs available in the macOS service
  it.effect("reconstructs a launch agent search path when the installer has no PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("adds missing provider directories to a minimal installer PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "/usr/bin:/bin");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps an installed launch agent current when the process PATH changes", () =>
    Effect.gen(function* () {
      const { service, makeService } = yield* makeHarness("darwin");
      yield* service.install();

      const restartedService = yield* makeService("/usr/local/bin:/usr/bin:/bin");
      expect((yield* restartedService.status).current).toBe(true);
    }),
  );

  it.effect("drops PATH directories that cannot be represented in a launch agent plist", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness(
        "darwin",
        "/opt/homebrew/bin:/Users/theo/\u0001invalid:/usr/bin",
      );
      const plan = yield* service.install();
      const plist = yield* fs.readFileString(plan.unitPath);

      expect(plist).toContain(
        "    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect(plist).not.toContain("\u0001");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("ignores a bootout for an agent that is not loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.failCommand = "launchctl bootout --wait gui/501/codes.jackson.j5code.service";

      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps failed launch agent installs pending until activation succeeds", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();
      const markerPath = path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE);
      const bootstrap = `launchctl bootstrap gui/501 ${plan.unitPath}`;
      control.failCommand = bootstrap;

      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["restart-pending"],
      });
      expect(yield* fs.readFileString(markerPath)).toBe("1.2.3\n");

      control.failCommand = undefined;
      commands.length = 0;
      yield* service.install();

      expect(commands).toContain(bootstrap);
      expect(yield* fs.exists(markerPath)).toBe(false);
      expect((yield* service.status).current).toBe(true);
    }),
  );
});

// J5: the npm-era (0.0.43 and earlier) J5 unit used upstream's names. It is
// retired only when it names J5CODE_HOME; an upstream T3 Code unit at the same
// path is never touched.
it.layer(NodeServices.layer)("legacy J5 service handover", (it) => {
  const legacySystemdUnit = (home: string) =>
    [
      "[Service]",
      `Environment=J5CODE_HOME=${home}/.t3`,
      `ExecStart=/usr/bin/node ${home}/.t3/runtime/service-launcher.mjs`,
      "",
    ].join("\n");
  const upstreamSystemdUnit = (home: string) =>
    [
      "[Service]",
      `Environment=T3CODE_HOME=${home}/.t3`,
      `ExecStart=/usr/bin/node ${home}/.t3/runtime/service-launcher.mjs`,
      "",
    ].join("\n");
  const legacyPaths = Effect.fn("test.legacy_paths")(function* (statePath: string) {
    const path = yield* Path.Path;
    const home = path.dirname(path.dirname(path.dirname(statePath)));
    return {
      home,
      systemd: path.join(home, ".config", "systemd", "user", "t3code.service"),
      launchd: path.join(home, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
    };
  });
  const oldState = `${JSON.stringify({ protocol: 2, activeVersion: "0.0.42" })}\n`;
  const legacyPlist = (home: string) =>
    `<plist><dict><key>EnvironmentVariables</key><dict><key>J5CODE_HOME</key><string>${home}/.t3</string></dict></dict></plist>\n`;

  it.effect("replaces a J5-owned t3code.service and removes it once j5code.service runs", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.systemd)), {
        recursive: true,
      });
      yield* fs.writeFileString(legacy.systemd, legacySystemdUnit(legacy.home));
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(statePath)), {
        recursive: true,
      });
      yield* fs.writeFileString(statePath, oldState);

      expect(yield* service.status).toMatchObject({
        installed: false,
        problems: ["legacy-service-present"],
      });

      const plan = yield* service.install();

      const systemctl = commands.filter(
        (command) =>
          command.startsWith("systemctl ") &&
          !command.includes("show-environment") &&
          !command.includes(" is-"),
      );
      expect(systemctl).toEqual([
        "systemctl --user disable --now t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user enable j5code.service",
        "systemctl --user restart j5code.service",
        "systemctl --user daemon-reload",
      ]);
      expect(yield* fs.exists(legacy.systemd)).toBe(false);
      expect(yield* fs.readFileString(plan.unitPath)).toContain("Environment=J5CODE_HOME=");
      expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe("1.2.3");
      const status = yield* service.status;
      expect(status.problems ?? []).not.toContain("legacy-service-present");
      expect(status.current).toBe(true);
    }),
  );

  it.effect("never touches an upstream T3 Code unit at the old name", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.systemd)), {
        recursive: true,
      });
      const upstream = upstreamSystemdUnit(legacy.home);
      yield* fs.writeFileString(legacy.systemd, upstream);

      expect((yield* service.status).problems).toBeUndefined();
      yield* service.install();
      expect(yield* service.uninstall).toBe(true);

      expect(commands.some((command) => command.includes("t3code.service"))).toBe(false);
      expect(yield* fs.readFileString(legacy.systemd)).toBe(upstream);
    }),
  );

  it.effect("refuses to take over a j5code.service that J5 did not write", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const legacy = yield* legacyPaths(statePath);
      const path = yield* Path.Path;
      const foreignPath = path.join(path.dirname(legacy.systemd), "j5code.service");
      yield* fs.makeDirectory(path.dirname(foreignPath), { recursive: true });
      const foreign = [
        "[Unit]",
        "Description=J5 Code dogfood server (source checkout)",
        "[Service]",
        "Environment=J5CODE_HOME=%h/.j5code",
        "ExecStart=/usr/bin/env bash -lc 'exec node apps/server/dist/bin.mjs serve'",
        "",
      ].join("\n");
      yield* fs.writeFileString(foreignPath, foreign);

      const error = yield* service.install().pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem: "foreign-service-present",
      });
      expect(yield* fs.readFileString(foreignPath)).toBe(foreign);
      expect(
        commands.some(
          (command) =>
            command.startsWith("systemctl ") &&
            !command.includes("show-environment") &&
            !command.includes(" is-"),
        ),
      ).toBe(false);
    }),
  );

  it.effect("brings the J5 legacy service back when the new unit fails to start", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness();
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.systemd)), {
        recursive: true,
      });
      yield* fs.writeFileString(legacy.systemd, legacySystemdUnit(legacy.home));
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(statePath)), {
        recursive: true,
      });
      yield* fs.writeFileString(statePath, oldState);
      control.failCommand = "systemctl --user restart j5code.service";

      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");

      expect(
        commands.filter(
          (command) =>
            command.includes("t3code.service") || command.includes("disable --now j5code"),
        ),
      ).toEqual([
        "systemctl --user disable --now t3code.service",
        "systemctl --user disable --now j5code.service",
        "systemctl --user enable --now t3code.service",
      ]);
      expect(yield* fs.exists(legacy.systemd)).toBe(true);
      // The legacy launcher gets back the state file it understands.
      expect(yield* fs.readFileString(statePath)).toBe(oldState);
    }),
  );

  it.effect("refuses a deferred-start install while the legacy J5 service runs", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.systemd)), {
        recursive: true,
      });
      yield* fs.writeFileString(legacy.systemd, legacySystemdUnit(legacy.home));

      const error = yield* service.install({ start: false }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem: "legacy-service-present",
      });
      expect(commands.some((command) => command.includes("t3code.service"))).toBe(false);
      expect(yield* fs.exists(legacy.systemd)).toBe(true);
    }),
  );

  it.effect("uninstall also removes a J5-owned legacy unit", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.systemd)), {
        recursive: true,
      });
      yield* fs.writeFileString(legacy.systemd, legacySystemdUnit(legacy.home));

      expect(yield* service.uninstall).toBe(true);
      expect(commands).toContain("systemctl --user disable --now t3code.service");
      expect(yield* fs.exists(legacy.systemd)).toBe(false);
      expect((yield* service.status).problems).toBeUndefined();
    }),
  );

  it.effect("replaces a J5-owned com.t3tools.t3code.service launch agent on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness("darwin");
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.launchd)), {
        recursive: true,
      });
      yield* fs.writeFileString(
        legacy.launchd,
        `<plist><dict><key>EnvironmentVariables</key><dict><key>J5CODE_HOME</key><string>${legacy.home}/.t3</string></dict></dict></plist>\n`,
      );

      const plan = yield* service.install();

      expect(commands.filter((command) => command.startsWith("launchctl "))).toEqual([
        "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
        "launchctl enable gui/501/codes.jackson.j5code.service",
        `launchctl bootstrap gui/501 ${plan.unitPath}`,
        "launchctl print gui/501/codes.jackson.j5code.service",
      ]);
      expect(yield* fs.exists(legacy.launchd)).toBe(false);
      expect((yield* service.status).current).toBe(true);
    }),
  );
  const seedLegacySystemd = Effect.fn("test.seed_legacy_systemd")(function* (statePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const legacy = yield* legacyPaths(statePath);
    yield* fs.makeDirectory(path.dirname(legacy.systemd), { recursive: true });
    yield* fs.writeFileString(legacy.systemd, legacySystemdUnit(legacy.home));
    yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
    yield* fs.writeFileString(statePath, oldState);
    return legacy;
  });
  const handoverCommands = (commands: ReadonlyArray<string>) =>
    commands.filter(
      (command) =>
        (command.startsWith("systemctl ") || command.startsWith("launchctl ")) &&
        !command.includes("show-environment") &&
        !command.includes(" is-enabled"),
    );

  it.effect.each([
    { name: "exit 5", result: { code: 5 } },
    { name: "not loaded", result: { code: 1, stderr: "Unit t3code.service not loaded." } },
  ])("treats a legacy systemd unit that is not running as stopped: $name", ({ result }) =>
    Effect.gen(function* () {
      const { service, fs, statePath, control } = yield* makeHarness();
      const legacy = yield* seedLegacySystemd(statePath);
      control.results = new Map([["systemctl --user disable --now t3code.service", result]]);

      yield* service.install();

      expect(yield* fs.exists(legacy.systemd)).toBe(false);
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("fails closed when the legacy systemd unit cannot be stopped", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness();
      const legacy = yield* seedLegacySystemd(statePath);
      control.results = new Map([
        [
          "systemctl --user disable --now t3code.service",
          { code: 1, stderr: "Failed to disable unit: Access denied" },
        ],
      ]);

      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServiceCommandError",
        step: "stopping the previous J5 service (t3code.service)",
      });

      // Nothing started, nothing of the legacy service touched past the failed stop.
      expect(handoverCommands(commands)).toEqual(["systemctl --user disable --now t3code.service"]);
      expect(yield* fs.readFileString(legacy.systemd)).toBe(legacySystemdUnit(legacy.home));
      expect(yield* fs.readFileString(statePath)).toBe(oldState);
      expect((yield* service.status).problems).toContain("legacy-service-present");

      // A retry after the stop failure must not start the new unit next to the legacy one.
      commands.length = 0;
      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
      expect(handoverCommands(commands)).toEqual([
        "systemctl --user stop j5code.service",
        "systemctl --user disable --now t3code.service",
      ]);
      expect(yield* fs.readFileString(statePath)).toBe(oldState);
    }),
  );

  it.effect("rolls back to the legacy service when systemd skips the new unit's start", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness();
      const legacy = yield* seedLegacySystemd(statePath);
      control.active = false;
      control.results = new Map([["systemctl --user restart j5code.service", { code: 0 }]]);

      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServiceNotRunningError",
        state: "inactive",
      });
      expect(handoverCommands(commands)).toEqual([
        "systemctl --user disable --now t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user enable j5code.service",
        "systemctl --user restart j5code.service",
        "systemctl --user is-active j5code.service",
        "systemctl --user disable --now j5code.service",
        "systemctl --user enable --now t3code.service",
      ]);
      expect(yield* fs.exists(legacy.systemd)).toBe(true);
      expect(yield* fs.readFileString(statePath)).toBe(oldState);
    }),
  );

  it.effect.each([
    { name: "exit 3", result: { code: 3, stderr: "Boot-out failed: 3: No such process" } },
    {
      name: "exit 113",
      result: { code: 113, stderr: "Boot-out failed: 113: Could not find specified service" },
    },
  ])("treats a legacy launch agent that is not loaded as stopped: $name", ({ result }) =>
    Effect.gen(function* () {
      const { service, fs, statePath, control } = yield* makeHarness("darwin");
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.launchd)), {
        recursive: true,
      });
      yield* fs.writeFileString(legacy.launchd, legacyPlist(legacy.home));
      control.results = new Map([
        ["launchctl bootout --wait gui/501/com.t3tools.t3code.service", result],
      ]);

      yield* service.install();

      expect(yield* fs.exists(legacy.launchd)).toBe(false);
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("fails closed when the legacy launch agent cannot be booted out", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness("darwin");
      const legacy = yield* legacyPaths(statePath);
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(legacy.launchd)), {
        recursive: true,
      });
      yield* fs.writeFileString(legacy.launchd, legacyPlist(legacy.home));
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (p) => p.dirname(statePath)), {
        recursive: true,
      });
      yield* fs.writeFileString(statePath, oldState);
      control.results = new Map([
        [
          "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
          { code: 1, stderr: "Boot-out failed: 1: Operation not permitted" },
        ],
      ]);

      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
      expect(handoverCommands(commands)).toEqual([
        "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
      ]);
      expect(yield* fs.readFileString(legacy.launchd)).toBe(legacyPlist(legacy.home));
      expect(yield* fs.readFileString(statePath)).toBe(oldState);
    }),
  );
});
