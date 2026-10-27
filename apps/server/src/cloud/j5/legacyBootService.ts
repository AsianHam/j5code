import type * as Path from "effect/Path";
import * as Duration from "effect/Duration";

import type { ProcessRunOutput } from "../../processRunner.ts";
import type { BootServiceStep } from "../bootService.ts";

/**
 * The service names J5 releases up to 0.0.43 installed under, which collide with an installed
 * T3 Code. `j5 service install` retires such a unit only when it is provably J5's: it names
 * `J5CODE_HOME` and never `T3CODE_HOME`. A T3 Code unit is never touched.
 */
export const LEGACY_J5_SYSTEMD_UNIT_FILE = "t3code.service";
export const LEGACY_J5_LAUNCHD_LABEL = "com.t3tools.t3code.service";

/** Whether a unit or plist at a legacy path was written by a J5 CLI. */
export function isLegacyJ5BootServiceUnit(contents: string): boolean {
  const namesJ5Home =
    /^Environment=J5CODE_HOME=/m.test(contents) || /<key>J5CODE_HOME<\/key>/.test(contents);
  return namesJ5Home && !contents.includes("T3CODE_HOME");
}

/**
 * Whether an existing unit or plist at J5's own service path was rendered by a
 * J5 CLI (it carries the `T3_BOOT_SERVICE_UNIT` marker the renderer writes).
 * Anything else there, such as a hand-written checkout unit, belongs to the
 * owner: `j5 service install` refuses rather than stopping or overwriting it.
 */
export function isRenderedJ5BootServiceUnit(contents: string): boolean {
  return (
    /^Environment=T3_BOOT_SERVICE_UNIT=/m.test(contents) ||
    /<key>T3_BOOT_SERVICE_UNIT<\/key>/.test(contents)
  );
}

/**
 * Whether a failed legacy stop only means the service was not running. Anything else (permission
 * denied, bus unreachable, a timeout) is a real failure: the old server may still be running, so
 * the handover must stop before a second writer starts on the same home.
 */
export function legacyStopMeansNotRunning(
  kind: "systemd" | "launchd",
  result: ProcessRunOutput,
): boolean {
  if (result.timedOut) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  if (kind === "systemd") {
    return result.code === 5 || /not loaded|does not exist|not found/i.test(output);
  }
  return (
    result.code === 3 ||
    result.code === 113 ||
    /No such process|Could not find (specified )?service/i.test(output)
  );
}

export interface LegacyJ5BootService {
  readonly unitPath: string;
  /**
   * Stops the legacy service and keeps it from starting again. Strict: only
   * a failure that means "was not running" passes (legacyStopMeansNotRunning).
   */
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  /** Best-effort: brings the legacy service back when the new one failed to start. */
  readonly restore: ReadonlyArray<BootServiceStep>;
  /** After the legacy unit file is removed. */
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

/** Same bound as bootService's stop steps: above systemd's and launchd's 90s stop timeouts. */
const LEGACY_STOP_TIMEOUT = Duration.seconds(120);

export function legacyJ5BootService(input: {
  readonly kind: "systemd" | "launchd";
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly uid: number | undefined;
}): LegacyJ5BootService {
  if (input.kind === "systemd") {
    return {
      unitPath: input.path.join(
        input.homeDir,
        ".config",
        "systemd",
        "user",
        LEGACY_J5_SYSTEMD_UNIT_FILE,
      ),
      deactivate: [
        {
          step: "stopping the previous J5 service (t3code.service)",
          command: "systemctl",
          args: ["--user", "disable", "--now", LEGACY_J5_SYSTEMD_UNIT_FILE],
          timeout: LEGACY_STOP_TIMEOUT,
          acceptFailure: (result) => legacyStopMeansNotRunning("systemd", result),
        },
      ],
      restore: [
        {
          step: "restarting the previous J5 service (t3code.service)",
          command: "systemctl",
          args: ["--user", "enable", "--now", LEGACY_J5_SYSTEMD_UNIT_FILE],
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
  const unitPath = input.path.join(
    input.homeDir,
    "Library",
    "LaunchAgents",
    `${LEGACY_J5_LAUNCHD_LABEL}.plist`,
  );
  const domainTarget = `gui/${input.uid ?? ""}`;
  return {
    unitPath,
    deactivate: [
      {
        step: "stopping the previous J5 launch agent (com.t3tools.t3code.service)",
        command: "launchctl",
        args: ["bootout", "--wait", `${domainTarget}/${LEGACY_J5_LAUNCHD_LABEL}`],
        // Not loaded is fine: removing the plist is what keeps it from loading again.
        timeout: LEGACY_STOP_TIMEOUT,
        acceptFailure: (result) => legacyStopMeansNotRunning("launchd", result),
      },
    ],
    restore: [
      {
        step: "restarting the previous J5 launch agent (com.t3tools.t3code.service)",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    finalize: [],
  };
}
