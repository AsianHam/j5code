import packageJson from "../../package.json" with { type: "json" };
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  // J5: a pre-rename server (protocol 3). `j5 update` on its machine installs
  // this version and replaces its launcher in one step (FORK.md case 50).
  if (input.launcherProtocol === 3) {
    return {
      status: "blocked",
      version,
      reason: "Run `j5 update` on the server's machine to finish it.",
    };
  }
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      // A stale `j5` earlier on PATH (an old npm/nvm global) makes `j5 service install`
      // reinstall itself and report success, so name the exact install and the path check.
      reason: [
        `The installed service launcher speaks protocol ${input.launcherProtocol}, but j5@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, install this exact CLI: \`curl -fsSL https://github.com/Jacksondr5/j5code/releases/download/v${version}/install.sh | T3CODE_VERSION=${version} sh\`.`,
        `Check that \`j5 --version\` prints ${version} and that \`which -a j5\` lists no older j5 (such as an npm or nvm install) first, then run \`~/.local/bin/j5 service install\` (the installer's default path).`,
        "Updating the desktop app does not update this CLI, and `j5 service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
