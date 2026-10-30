import { afterEach, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";

import * as ServerEnvironmentLabel from "../environment/ServerEnvironmentLabel.ts";
import * as ProcessRunner from "../processRunner.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const layerLinuxBuildbox = (env: Readonly<Record<string, string>>) =>
  Layer.mergeAll(
    Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: (input) => runMock(input) }),
    ),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(path === "/etc/machine-info"),
      readFileString: (path) =>
        path === "/etc/machine-info"
          ? Effect.succeed('PRETTY_HOSTNAME="Build Agent 01"\nICON_NAME="computer-vm"\n')
          : Effect.succeed(""),
    }),
    // The server's own environment reaches the agents it runs, so a named server's
    // J5CODE_SERVER_NAME must not leak into these tests.
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Hostname, "buildbox"),
  );

afterEach(() => {
  runMock.mockReset();
});

// J5: `J5CODE_SERVER_NAME` names the server ahead of the host's names (register D32).
describe("J5CODE_SERVER_NAME", () => {
  it.effect("uses J5CODE_SERVER_NAME ahead of the host's friendly name", () =>
    Effect.gen(function* () {
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(layerLinuxBuildbox({ J5CODE_SERVER_NAME: " Remote " })));

      expect(result).toBe("Remote");
      expect(runMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("ignores a blank J5CODE_SERVER_NAME", () =>
    Effect.gen(function* () {
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(layerLinuxBuildbox({ J5CODE_SERVER_NAME: "   " })));

      expect(result).toBe("Build Agent 01");
    }),
  );
});
