import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshTunnel from "../tunnel.ts";

// J5 (FORK.md case 15 and the release-archive case): a remote J5 server installs J5's release
// archive under ~/.j5code, runs its `j5` executable, and keeps its state in ~/.j5code, for archive
// and node-script runners alike, never in an upstream T3 home.

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const NODE_SCRIPT = { nodeScriptPath: "/opt/j5/bin.mjs" } as const;
const TARGET = {
  alias: "devbox",
  hostname: "devbox.example.com",
  username: "julius",
  port: 2222,
} as const;

const makeProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

function stdinOf(
  command: ChildProcess.Command,
): Stream.Stream<Uint8Array, PlatformError.PlatformError> {
  const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
  const input = typeof stdin === "object" && !Stream.isStream(stdin) ? stdin.stream : stdin;
  return input !== undefined && typeof input !== "string" ? input : Stream.empty;
}

/** Runs one SSH operation against a fake `ssh` and returns the script it sent on stdin. */
const scriptSentBy = <A, E>(
  stdout: string,
  operation: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | NodeServices.NodeServices
  >,
) =>
  Effect.gen(function* () {
    const sent: Array<Stream.Stream<Uint8Array, PlatformError.PlatformError>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        sent.push(stdinOf(command));
        return makeProcess(stdout);
      }),
    );
    yield* operation.pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    assert.lengthOf(sent, 1);
    return yield* sent[0]!.pipe(Stream.decodeText(), Stream.mkString);
  });

const PAIRING_STDOUT = JSON.stringify({ credential: "LCL4R2TPHDKQ" });

describe("J5 remote server home", () => {
  it("installs and runs J5's release archive under ~/.j5code", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/Jacksondr5/j5code/releases/download'",
    );
    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.j5code/runtime/versions/$T3_ARCHIVE_VERSION"');
    assert.include(
      script,
      'T3_LOCK="$HOME/.j5code/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    assert.include(script, '"$T3_STAGING/j5" --version');
    assert.include(script, 'exec "$T3_RUNTIME_DIR/j5" "$@"');
    assert.notInclude(script, "$HOME/.t3/runtime");
  });

  for (const [name, runner] of [
    ["archive", ARCHIVE],
    ["node-script", NODE_SCRIPT],
  ] as const) {
    it.effect(`launches a ${name} runner with ~/.j5code as its home`, () =>
      Effect.gen(function* () {
        const launch = yield* scriptSentBy(
          '{"remotePort":3774}\n',
          SshTunnel.launchOrReuseRemoteServer(TARGET, undefined, runner),
        );

        assert.include(launch, 'DEFAULT_SERVER_HOME="$HOME/.j5code"');
        assert.include(launch, '--base-dir "$DEFAULT_SERVER_HOME"');
        assert.notInclude(launch, 'DEFAULT_SERVER_HOME="$HOME/.t3"');
        assert.notInclude(launch, "$HOME/.t3/runtime");
        assert.include(launch, "Remote J5 server did not become ready");
      }),
    );
  }

  it.effect("pairs against the ~/.j5code home", () =>
    Effect.gen(function* () {
      const pairing = yield* scriptSentBy(
        PAIRING_STDOUT,
        SshTunnel.issueRemotePairingToken(TARGET, undefined, ARCHIVE),
      );

      assert.include(pairing, 'DEFAULT_SERVER_HOME="$HOME/.j5code"');
      assert.include(pairing, 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
      assert.notInclude(pairing, 'DEFAULT_SERVER_HOME="$HOME/.t3"');
    }),
  );
});
