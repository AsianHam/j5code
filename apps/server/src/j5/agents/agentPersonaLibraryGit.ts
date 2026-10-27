import type { AgentPersonaFolderGitStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const GIT_TIMEOUT = "5 seconds";

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

/**
 * Read-only git signals for a library folder: the repository root, whether files under
 * the folder have uncommitted changes, and how far the tracked remote branch is ahead.
 * Anything that is not a clean answer (no git, no repository, timeout) yields null so
 * the library keeps working without git.
 */
export const agentPersonaFolderGitStatus = Effect.fn("j5.agentPersonaFolderGitStatus")(function* (
  folder: string,
) {
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  if (Option.isNone(spawner)) return null;
  const git = Effect.fn("j5.agents.agentPersonaLibraryGit.git")(function* (
    args: ReadonlyArray<string>,
  ) {
    const child = yield* spawner.value.spawn(ChildProcess.make("git", args, { cwd: folder }));
    const [stdout, exitCode] = yield* Effect.all([collect(child.stdout), child.exitCode], {
      concurrency: "unbounded",
    });
    return exitCode === 0 ? stdout : null;
  }, Effect.scoped);
  const status: AgentPersonaFolderGitStatus | null = yield* Effect.gen(function* () {
    const root = yield* git(["rev-parse", "--show-toplevel"]);
    if (root === null || root.trim() === "") return null;
    // Pathspec "." limits change detection to this folder; --branch adds the ahead/behind line.
    const status = yield* git(["status", "--porcelain=v2", "--branch", "--", "."]);
    if (status === null) return null;
    const lines = status.split("\n").filter((line) => line !== "");
    const aheadBehind = lines.find((line) => line.startsWith("# branch.ab "));
    const behind = aheadBehind?.match(/-(\d+)$/)?.[1];
    return {
      repositoryRoot: root.trim(),
      uncommittedChanges: lines.some((line) => !line.startsWith("#")),
      remoteAhead: behind === undefined ? null : Number(behind),
    };
  }).pipe(
    Effect.timeout(GIT_TIMEOUT),
    Effect.orElseSucceed(() => null),
  );
  return status;
});
