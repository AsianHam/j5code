// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a standalone Node CLI that manages one child process group and prints instructions.
/**
 * One command for an agent that needs to live-test J5 Code:
 *
 *   node scripts/j5/setup-agent-live-test.ts            build the test home if needed, start the server
 *   node scripts/j5/setup-agent-live-test.ts status     say whether it is running, and how to reach it
 *   node scripts/j5/setup-agent-live-test.ts restart    stop, then start on the same home
 *   node scripts/j5/setup-agent-live-test.ts stop       stop the server
 *   node scripts/j5/setup-agent-live-test.ts rebuild    stop, delete the test home and repository, build and start again
 *
 * A start and `rebuild` take a mode flag. With none, the home holds a test
 * project and pre-made threads. `--fresh` gives an empty home, so the first-run
 * wizard shows. A worktree has one live-test home at a time and its mode is
 * fixed when it is built: `rebuild` with another flag switches.
 *
 * The test repository, the J5 home that holds only that project, the server's
 * log and the record of its process group live in this worktree's gitignored
 * `.j5code/live-test`. (The dev server and the provider CLIs still write their
 * own caches and session files elsewhere.) Nothing there points at a real
 * repository, the developer's data or the live install. It refuses to run
 * outside a linked git worktree.
 *
 * It signals only the process group it started, and only after confirming
 * that the group's leader is still the process it spawned (same pid and start
 * time) running from this worktree. It never finds a process by name. Linux
 * only: it reads `/proc`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const COMMANDS = ["start", "status", "restart", "stop", "rebuild"] as const;
type LiveTestCommand = (typeof COMMANDS)[number];

/** The live install's port. A test server must never end up on it. */
const LIVE_SERVER_PORT = 5773;
/** Under the two minutes a shell call usually gets, so a failed start is cleaned up by this script. */
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 20_000;
/** `scripts/hold.sh` in the test repository waits for this file in the repository root. */
const HOLD_RELEASE_FILE = ".hold-release";
const RECOVERY_LOG_LINE = "V2 orchestration recovery completed";

/** A reason this script will not act, printed as-is. */
export class LiveTestRefusal extends Error {}

/** How the home is built: with the test project and pre-made threads, or empty. */
const MODE_FLAGS = { default: "", fresh: "--fresh" } as const;
export type LiveTestMode = keyof typeof MODE_FLAGS;

/** What the generator records about a default build. Paths are never read from it: see LiveTestPaths. */
interface DefaultManifest {
  /** Absent in the generator's file, which only ever describes a default build. */
  readonly mode?: "default";
  readonly project: { readonly title: string };
  readonly defaultModel: string;
  readonly personas: ReadonlyArray<{
    readonly id: string;
    readonly model: string;
    /** The second route. Absent in a home built before the generator recorded it. */
    readonly fallbackModel?: string;
  }>;
  readonly playbooks: ReadonlyArray<string>;
  readonly holdScript: string;
}
/** Marks a finished build and records its mode. */
type Manifest = DefaultManifest | { readonly mode: "fresh" };

/** Every path the script acts on, derived from the worktree and checked to stay inside it. */
export interface LiveTestPaths {
  readonly worktree: string;
  readonly root: string;
  readonly home: string;
  readonly testRepo: string;
  readonly manifest: string;
  readonly log: string;
  readonly record: string;
}

const isInside = (candidate: string, parent: string) => {
  const relative = NodePath.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** `target` with every symlink in its existing part resolved; the rest may not exist yet. */
const canonicalPath = (target: string): string => {
  let existing = NodePath.resolve(target);
  while (!NodeFS.existsSync(existing)) {
    const parent = NodePath.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return NodePath.resolve(
    NodeFS.realpathSync(existing),
    NodePath.relative(existing, NodePath.resolve(target)),
  );
};

/**
 * Where the live-test state for `checkout` lives, or a refusal. `checkout`
 * must be the root of a linked git worktree, and its `.j5code/live-test` must
 * really be inside it and must not be a live home's state.
 */
export async function resolveLiveTestPaths(input: {
  readonly checkout: string;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<LiveTestPaths> {
  const checkout = NodePath.resolve(input.checkout);
  // Loaded here, not at the top: a checkout with no dependencies installed must
  // reach the message in main() instead of failing on an import.
  const [NodeServices, { resolveGitWorktreePath }, Effect] = await Promise.all([
    import("@effect/platform-node/NodeServices"),
    import("@t3tools/shared/devHome"),
    import("effect/Effect"),
  ]);
  const worktree = await Effect.runPromise(
    resolveGitWorktreePath(checkout).pipe(Effect.provide(NodeServices.layer)),
  );
  if (worktree !== checkout) {
    throw new LiveTestRefusal(
      `${checkout} is not a linked git worktree. Live tests run only from a worktree, never from the main checkout: create one with \`git worktree add\` and run this script there.`,
    );
  }
  // The paths below are printed inside shell commands and read back from a log line.
  if (!/^[\w@%+=:,./-]+$/.test(worktree)) {
    throw new LiveTestRefusal(
      `${worktree} contains a space or a shell character. Use a worktree whose path has only letters, digits and @%+=:,./_-`,
    );
  }
  const root = NodePath.join(worktree, ".j5code", "live-test");
  const canonicalRoot = canonicalPath(root);
  if (!isInside(canonicalRoot, NodePath.join(NodeFS.realpathSync(worktree), ".j5code"))) {
    throw new LiveTestRefusal(
      `${root} resolves to ${canonicalRoot}, outside this worktree's .j5code. Remove the symlink; the test home must live inside the worktree.`,
    );
  }
  const liveHomes = [
    NodePath.join(input.homeDirectory, ".j5code"),
    ...(input.environment.J5CODE_HOME?.trim() ? [input.environment.J5CODE_HOME.trim()] : []),
  ].map(canonicalPath);
  for (const liveHome of liveHomes) {
    // A worktree's own .j5code may sit below ~/.j5code/worktrees. The live home
    // itself, and its state directory, are never a test home.
    if (
      isInside(liveHome, NodePath.dirname(canonicalRoot)) ||
      isInside(canonicalRoot, NodePath.join(liveHome, "userdata"))
    ) {
      throw new LiveTestRefusal(
        `${root} is the live home ${liveHome} or inside its state. Refusing to build or start a test server there.`,
      );
    }
  }
  // A finished build can be tampered with afterwards: the home and the
  // repository must still be real directories of this root, not links elsewhere.
  const home = NodePath.join(root, "home");
  const testRepo = NodePath.join(root, "test-repo");
  // The server keeps its database in <home>/userdata, so that must not be a link either.
  for (const inside of [home, NodePath.join(home, "userdata"), testRepo]) {
    if (!isInside(canonicalPath(inside), canonicalRoot)) {
      throw new LiveTestRefusal(
        `${inside} resolves to ${canonicalPath(inside)}, outside ${root}. Refusing to use it; remove the link.`,
      );
    }
  }
  return {
    worktree,
    root,
    home,
    testRepo,
    manifest: NodePath.join(root, "manifest.json"),
    log: NodePath.join(root, "server.log"),
    record: NodePath.join(root, "server.json"),
  };
}

/** The environment for anything started here: nothing inherited from the live server. */
export function liveTestEnvironment(
  environment: NodeJS.ProcessEnv,
  worktree: string,
): NodeJS.ProcessEnv {
  const {
    T3CODE_PORT: _port,
    T3CODE_HOST: _host,
    J5CODE_HOME: _home,
    J5CODE_SERVER_NAME: _name,
    ...rest
  } = environment;
  return {
    ...rest,
    // Without this the dev server registers <worktree>/apps/server as a project.
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    // The dev runner spawns `vp`, which is often not on an agent's PATH.
    PATH: [NodePath.join(worktree, "node_modules", ".bin"), rest.PATH ?? ""].join(
      NodePath.delimiter,
    ),
  };
}

export interface ServerLogFacts {
  readonly serverPort: number | undefined;
  readonly webPort: number | undefined;
  readonly baseDir: string | undefined;
  readonly pairingUrl: string | undefined;
  readonly recovered: boolean;
}

/** What the dev server's log says so far. The latest pairing URL wins: a file-watch restart mints a new one. */
export function readServerLog(log: string): ServerLogFacts {
  // eslint-disable-next-line no-control-regex -- the server's pretty logger colours its output.
  const text = log.replaceAll(/\u001B\[[0-9;]*m/g, "");
  const runner = /\[dev-runner\] .*serverPort=(\d+) webPort=(\d+) baseDir=(\S+)/.exec(text);
  const pairingUrls = [...text.matchAll(/pairingUrl: (\S+)/g)];
  return {
    serverPort: runner === null ? undefined : Number(runner[1]),
    webPort: runner === null ? undefined : Number(runner[2]),
    baseDir: runner?.[3],
    pairingUrl: pairingUrls.at(-1)?.[1],
    recovered: text.includes(RECOVERY_LOG_LINE),
  };
}

/**
 * Why a server that is coming up must be abandoned, or undefined when it may
 * continue: it must use the test home, and never the live server's port.
 */
export function startRefusal(input: {
  readonly facts: ServerLogFacts;
  readonly home: string;
  readonly inheritedPort: string | undefined;
}): string | undefined {
  const { facts } = input;
  if (facts.baseDir !== undefined && canonicalPath(facts.baseDir) !== canonicalPath(input.home)) {
    return `The dev server chose ${facts.baseDir}, not the test home ${input.home}.`;
  }
  if (
    facts.serverPort !== undefined &&
    (facts.serverPort === LIVE_SERVER_PORT || String(facts.serverPort) === input.inheritedPort)
  ) {
    return `The dev server chose the live server's port ${facts.serverPort}.`;
  }
  return undefined;
}

/** The fields of /proc/<pid>/stat after "pid (comm) ", or undefined when the process is gone. */
function statFieldsOf(pid: number): ReadonlyArray<string> | undefined {
  try {
    // comm may hold spaces and parentheses, so split after its closing one.
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined;
  }
}

/** The process group of `pid`, or undefined when it is gone. */
function processGroupOf(pid: number): number | undefined {
  const group = statFieldsOf(pid)?.[2];
  return group === undefined ? undefined : Number(group);
}

/**
 * When `pid` started, in clock ticks since boot. Together with the pid it
 * names one process for good: a recycled pid has a later start time.
 */
function startTimeOf(pid: number): string | undefined {
  return statFieldsOf(pid)?.[19];
}

function membersOfGroup(group: number): ReadonlyArray<number> {
  return NodeFS.readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => processGroupOf(pid) === group);
}

function listenerOn(port: number): number | undefined {
  const output = NodeChildProcess.execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], {
    encoding: "utf8",
  });
  const pid = /pid=(\d+)/.exec(output)?.[1];
  return pid === undefined ? undefined : Number(pid);
}

/** What `start` writes when it spawns the server, and all `stop` trusts. */
interface ServerRecord {
  /** The dev runner's pid. It is spawned detached, so this is also its process group id. */
  readonly processGroup: number;
  readonly leaderStartTime: string;
}

export type ServerState =
  | { readonly kind: "stopped" }
  | { readonly kind: "running"; readonly group: number; readonly facts: ServerLogFacts }
  /** Ours, but its port has no listener: still starting, or the server inside it crashed. */
  | { readonly kind: "notServing"; readonly group: number; readonly reason: string }
  | { readonly kind: "unverified"; readonly group: number; readonly reason: string };

/**
 * Decides whether the recorded process group is this worktree's test server,
 * and whether it is serving.
 *
 * The group is ours only when its leader is still the process that was spawned
 * (same pid and start time) and runs from the worktree. That needs no healthy
 * server, so a crashed or half-started one can still be stopped. A group that
 * is ours is "running" when the listener on the port its log reports is in the
 * group and runs from inside the worktree, and "notServing" otherwise. A live
 * group that is not ours is reported, never signalled.
 */
export function classifyServer(input: {
  readonly worktree: string;
  readonly record: ServerRecord | undefined;
  readonly facts: ServerLogFacts;
  readonly groupMembers: (group: number) => ReadonlyArray<number>;
  readonly listenerOn: (port: number) => number | undefined;
  readonly processGroupOf: (pid: number) => number | undefined;
  readonly startTimeOf: (pid: number) => string | undefined;
  readonly cwdOf: (pid: number) => string | undefined;
}): ServerState {
  const { record, facts } = input;
  if (record === undefined) return { kind: "stopped" };
  const group = record.processGroup;
  const members = input.groupMembers(group);
  if (members.length === 0) return { kind: "stopped" };

  const insideWorktree = (pid: number) => {
    const cwd = input.cwdOf(pid);
    return cwd !== undefined && isInside(cwd, input.worktree);
  };
  // Identity first: nothing below may call a group ours unless its leader is
  // still the process that was spawned, whatever is listening on the port.
  if (input.startTimeOf(group) !== record.leaderStartTime || !insideWorktree(group)) {
    return {
      kind: "unverified",
      group,
      reason: `Process group ${group} still has processes (${members.join(", ")}), but its leader is not the process this script started, so it will not signal them. Inspect with \`ps -o pid,pgid,args -g ${group}\`.`,
    };
  }
  const listener = facts.serverPort === undefined ? undefined : input.listenerOn(facts.serverPort);
  const notServing =
    facts.serverPort === undefined
      ? "The server log does not report a port yet."
      : listener === undefined
        ? `Nothing is listening on port ${facts.serverPort}.`
        : input.processGroupOf(listener) !== group
          ? `Port ${facts.serverPort} is owned by process ${listener}, which is not in the recorded group.`
          : !insideWorktree(listener)
            ? `The listener on port ${facts.serverPort} does not run from this worktree.`
            : undefined;
  return notServing === undefined
    ? { kind: "running", group, facts }
    : { kind: "notServing", group, reason: notServing };
}

function currentServerState(paths: LiveTestPaths): ServerState {
  return classifyServer({
    worktree: NodeFS.realpathSync(paths.worktree),
    record: NodeFS.existsSync(paths.record)
      ? (JSON.parse(NodeFS.readFileSync(paths.record, "utf8")) as ServerRecord)
      : undefined,
    facts: readServerLog(
      NodeFS.existsSync(paths.log) ? NodeFS.readFileSync(paths.log, "utf8") : "",
    ),
    groupMembers: membersOfGroup,
    listenerOn,
    processGroupOf,
    startTimeOf,
    cwdOf: (pid) => {
      try {
        return NodeFS.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return undefined;
      }
    },
  });
}

const selfCommand = (paths: LiveTestPaths, command: string) =>
  `node ${NodePath.join(paths.worktree, "scripts/j5/setup-agent-live-test.ts")} ${command}`.trimEnd();

/**
 * What only this script knows about the running server. How to test with it
 * is the j5-live-test skill's job and is not repeated here.
 */
export function formatInstructions(input: {
  readonly paths: LiveTestPaths;
  readonly manifest: Manifest;
  readonly facts: ServerLogFacts;
  /** A pairing URL nobody has used yet, or undefined when none could be minted. */
  readonly pairingUrl: string | undefined;
}): string {
  const { paths, manifest, facts } = input;
  const pairCommand = `node ${pairArguments(paths).join(" ")}`;
  return `J5 Code live-test server: RUNNING

  Pairing URL   ${input.pairingUrl ?? `none could be minted; run: ${pairCommand}`}
  Web           http://localhost:${facts.webPort}
  Server port   ${facts.serverPort}
  Home          ${paths.home}
  Log           ${paths.log}

The pairing URL works once. \`status\` prints a fresh one, and so does:
  ${pairCommand}

${
  manifest.mode === "fresh"
    ? `Mode: fresh. The home is empty and no default model is set. The first-run
wizard shows only in a browser profile that has not completed it: pair in an
incognito tab.

Project to add when the wizard or a test asks for one: a small TODO app (\`pnpm test\`)
  ${paths.testRepo}
  Add only this directory. Do not add a real repository: that is how a test
  reaches one.`
    : `Project to use: "${manifest.project.title}", a small TODO app (\`pnpm test\`)
  ${paths.testRepo}
  It is the only project in this home. Do not add another project: that is how
  a test reaches a real repository.

New threads default to ${manifest.defaultModel}.
Personas: ${manifest.personas
        .map(
          (persona) =>
            `${persona.id} (${persona.model}${persona.fallbackModel === undefined ? "" : `, or ${persona.fallbackModel} as its second route`})`,
        )
        .join("; ")}
Playbooks: ${manifest.playbooks.join(", ")}

Hold a turn open by asking the agent to run: ${manifest.holdScript}
Release it with: touch ${NodePath.join(paths.testRepo, HOLD_RELEASE_FILE)}`
}

Commands:
  ${selfCommand(paths, "status")}    say whether it is running
  ${selfCommand(paths, "restart")}   stop, then start on the same home
  ${selfCommand(paths, "stop")}      stop the server
  ${selfCommand(paths, "rebuild")}   stop, delete ${paths.root}, build and start again
                                      (add --fresh for an empty home, or no flag for the test project)

How to test is in .agents/skills/j5-live-test/SKILL.md.
`;
}

/**
 * The scopes of the server's startup pairing URL (`AuthAdministrativeScopes`
 * in packages/contracts/src/auth.ts). A URL minted with `pair` gets only the
 * standard client scopes unless every scope is named, and without the access
 * and relay scopes a tester cannot use Connections settings.
 */
export const PAIRING_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "environment:maintain",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
] as const;

/** The `pair` invocation for this home, as arguments to node. */
const pairArguments = (paths: LiveTestPaths): ReadonlyArray<string> => [
  NodePath.join(paths.worktree, "apps/server/src/bin.ts"),
  "pair",
  "--base-dir",
  paths.home,
  ...PAIRING_SCOPES.flatMap((scope) => ["--scope", scope]),
];

/**
 * A fresh pairing URL from the running server. The one in the log is the
 * startup URL, which works once and is usually spent by the time anyone asks again.
 */
function mintPairingUrl(paths: LiveTestPaths): string | undefined {
  const pair = NodeChildProcess.spawnSync(process.execPath, [...pairArguments(paths)], {
    cwd: paths.worktree,
    env: liveTestEnvironment(process.env, paths.worktree),
    encoding: "utf8",
  });
  return /Pairing URL: (\S+)/.exec(pair.stdout ?? "")?.[1];
}

function printRunning(paths: LiveTestPaths, facts: ServerLogFacts): void {
  console.log(
    formatInstructions({
      paths,
      manifest: readManifest(paths),
      facts,
      pairingUrl: mintPairingUrl(paths),
    }),
  );
}

function readManifest(paths: LiveTestPaths): Manifest {
  return JSON.parse(NodeFS.readFileSync(paths.manifest, "utf8")) as Manifest;
}

function logTail(paths: LiveTestPaths): string {
  return NodeFS.readFileSync(paths.log, "utf8").split("\n").slice(-40).join("\n");
}

function buildHome(paths: LiveTestPaths, mode: LiveTestMode): void {
  const rebuild = selfCommand(paths, `rebuild ${MODE_FLAGS[mode]}`);
  if (NodeFS.existsSync(paths.root)) {
    throw new LiveTestRefusal(
      `${paths.root} exists but holds no finished build. Start over with: ${rebuild}`,
    );
  }
  if (mode === "fresh") {
    NodeFS.mkdirSync(paths.home, { recursive: true });
    // The same test repository as the default mode, but not registered: it is
    // there to be added by hand when the wizard or a test asks for a project.
    const repo = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(paths.worktree, "apps/server/src/j5/test-support/liveTestRepo.ts"),
        paths.testRepo,
        NodePath.join(paths.root, "test-repo-origin.git"),
      ],
      { cwd: paths.worktree, stdio: ["ignore", "ignore", "inherit"] },
    );
    if (repo.status !== 0) {
      throw new LiveTestRefusal(`Building the test repository failed. Retry with: ${rebuild}`);
    }
    const manifest: Manifest = { mode: "fresh" };
    NodeFS.writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`);
    return;
  }
  console.log("Building the test repository and home (about 30 seconds, no model calls)...");
  const build = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(paths.worktree, "apps/server/src/j5/test-support/liveTestHome.ts"),
      "--root",
      paths.root,
    ],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  if (build.status !== 0) {
    throw new LiveTestRefusal(`Building the test home failed. Retry with: ${rebuild}`);
  }
}

/** What to tell an agent about a server that is ours but has no listener on its port. */
const notServingMessage = (paths: LiveTestPaths, reason: string) =>
  `J5 Code live-test server: NOT SERVING

${reason}
This script started it, but it is not answering. If it was started moments ago, check again with:
  ${selfCommand(paths, "status")}
Otherwise read the log, then start it again:
  ${paths.log}
  ${selfCommand(paths, "restart")}`;

/** Signals this script's own process group and waits for every member to exit. */
async function stopGroup(group: number): Promise<void> {
  const waitForExit = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (membersOfGroup(group).length > 0) {
      if (Date.now() > deadline) return false;
      await NodeTimersPromises.setTimeout(200);
    }
    return true;
  };
  process.kill(-group, "SIGTERM");
  if (await waitForExit(STOP_TIMEOUT_MS)) return;
  console.log(`Still running after ${STOP_TIMEOUT_MS / 1000} seconds; killing the group.`);
  process.kill(-group, "SIGKILL");
  if (!(await waitForExit(5_000))) {
    throw new LiveTestRefusal(
      `Process group ${group} survived SIGKILL: ${membersOfGroup(group).join(", ")}.`,
    );
  }
}

/**
 * Waits for a server this script started to be ready, then prints how to use
 * it. Returns inside START_TIMEOUT_MS either way: a server that is merely slow
 * is left running and reported as still starting.
 */
async function waitUntilReady(paths: LiveTestPaths): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const facts = readServerLog(NodeFS.readFileSync(paths.log, "utf8"));
    // Classify before anything else: a refusal below signals the group, and
    // only a group proven to be ours may be signalled.
    const state = currentServerState(paths);
    if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
    if (state.kind === "stopped") {
      NodeFS.rmSync(paths.record, { force: true });
      throw new LiveTestRefusal(
        `The dev server exited while starting.\nLast lines of ${paths.log}:\n${logTail(paths)}`,
      );
    }
    const refusal = startRefusal({
      facts,
      home: paths.home,
      inheritedPort: process.env.T3CODE_PORT,
    });
    if (refusal !== undefined) {
      await stopGroup(state.group);
      NodeFS.rmSync(paths.record, { force: true });
      throw new LiveTestRefusal(`${refusal} It has been stopped.`);
    }
    if (state.kind === "running" && facts.pairingUrl !== undefined && facts.recovered) {
      return printRunning(paths, state.facts);
    }
    if (Date.now() > deadline) {
      throw new LiveTestRefusal(
        `The dev server is not ready after ${START_TIMEOUT_MS / 1000} seconds. It has been left running.\nIf it is still starting, check again with: ${selfCommand(paths, "status")}\nIf it has failed (see ${paths.log}), start it again with: ${selfCommand(paths, "restart")}`,
      );
    }
    await NodeTimersPromises.setTimeout(250);
  }
}

/**
 * Why a start in `requested` mode must not use the home that is already
 * built, or undefined when it may. A home's mode is fixed when it is built,
 * so that nobody tests against data they did not ask for.
 */
export function modeRefusal(input: {
  readonly requested: LiveTestMode;
  readonly built: LiveTestMode;
  readonly startCommand: (mode: LiveTestMode) => string;
  readonly rebuildCommand: (mode: LiveTestMode) => string;
}): string | undefined {
  if (input.requested === input.built) return undefined;
  return `The live-test home here was built in ${input.built} mode, not ${input.requested} mode.\nUse it as built: ${input.startCommand(input.built)}\nOr replace it: ${input.rebuildCommand(input.requested)}`;
}

function builtMode(paths: LiveTestPaths): LiveTestMode | undefined {
  return NodeFS.existsSync(paths.manifest) ? (readManifest(paths).mode ?? "default") : undefined;
}

async function start(paths: LiveTestPaths, mode: LiveTestMode): Promise<void> {
  const built = builtMode(paths);
  const refusal =
    built === undefined
      ? undefined
      : modeRefusal({
          requested: mode,
          built,
          startCommand: (other) => selfCommand(paths, MODE_FLAGS[other]),
          rebuildCommand: (other) => selfCommand(paths, `rebuild ${MODE_FLAGS[other]}`),
        });
  if (refusal !== undefined) throw new LiveTestRefusal(refusal);
  const state = currentServerState(paths);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  // Already started, perhaps by a call that is still waiting: wait with it.
  if (state.kind !== "stopped") return waitUntilReady(paths);
  if (built === undefined) buildHome(paths, mode);

  const log = NodeFS.openSync(paths.log, "w");
  // Detached makes the child the leader of a new process group, so its pid is
  // the group id. That group is the only thing this script ever signals.
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(paths.worktree, "scripts/dev-runner.ts"), "dev", "--home-dir", paths.home],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  NodeFS.closeSync(log);
  const leaderStartTime = child.pid === undefined ? undefined : startTimeOf(child.pid);
  if (child.pid === undefined || leaderStartTime === undefined) {
    throw new LiveTestRefusal("The dev server could not be spawned.");
  }
  const record: ServerRecord = { processGroup: child.pid, leaderStartTime };
  NodeFS.writeFileSync(paths.record, `${JSON.stringify(record)}\n`);
  child.unref();

  console.log("Starting the dev server...");
  await waitUntilReady(paths);
}

async function stop(paths: LiveTestPaths): Promise<void> {
  const state = currentServerState(paths);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  if (state.kind === "stopped") {
    NodeFS.rmSync(paths.record, { force: true });
    console.log("J5 Code live-test server: STOPPED (it was not running)");
    return;
  }
  await stopGroup(state.group);
  NodeFS.rmSync(paths.record, { force: true });
  console.log("J5 Code live-test server: STOPPED");
}

function status(paths: LiveTestPaths): void {
  const state = currentServerState(paths);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  if (state.kind === "running") return printRunning(paths, state.facts);
  if (state.kind === "notServing") return console.log(notServingMessage(paths, state.reason));
  const built = builtMode(paths);
  console.log(
    `J5 Code live-test server: STOPPED\n\n${
      built === undefined
        ? "No test home is built yet."
        : `The test home is built at ${paths.root}, in ${built} mode.`
    }\nStart it with: ${selfCommand(paths, MODE_FLAGS[built ?? "default"])}`,
  );
}

const USAGE = `Usage: node scripts/j5/setup-agent-live-test.ts [--fresh]
       node scripts/j5/setup-agent-live-test.ts rebuild [--fresh]
       node scripts/j5/setup-agent-live-test.ts status | restart | stop`;

/**
 * The command and, for a start or `rebuild`, the mode its flags ask for.
 * `status`, `restart` and `stop` act on whatever is built and take no flags.
 */
export function parseCommand(args: ReadonlyArray<string>): {
  readonly command: LiveTestCommand;
  readonly mode: LiveTestMode;
} {
  const flags = args.filter((argument) => argument.startsWith("--"));
  const words = args.filter((argument) => !argument.startsWith("--"));
  const command = words[0] ?? "start";
  const takesMode = command === "start" || command === "rebuild";
  if (
    words.length > 1 ||
    !COMMANDS.some((known) => known === command) ||
    flags.some((flag) => flag !== MODE_FLAGS.fresh) ||
    flags.length > (takesMode ? 1 : 0)
  ) {
    throw new LiveTestRefusal(USAGE);
  }
  return { command: command as LiveTestCommand, mode: flags.length === 1 ? "fresh" : "default" };
}

async function main(): Promise<void> {
  const { command, mode } = parseCommand(process.argv.slice(2));
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
  if (NodeOS.platform() !== "linux") {
    throw new LiveTestRefusal("This script reads /proc and runs only on Linux.");
  }
  const checkout = NodePath.resolve(import.meta.dirname, "../..");
  if (!NodeFS.existsSync(NodePath.join(checkout, "node_modules"))) {
    throw new LiveTestRefusal(
      `${checkout} has no node_modules. Install the dependencies first: run \`pnpm install\` there (\`vp i\` is the same thing where \`vp\` is on PATH), then run this again.`,
    );
  }
  const paths = await resolveLiveTestPaths({
    checkout,
    homeDirectory: NodeOS.homedir(),
    environment: process.env,
  });
  if (command === "status") return status(paths);
  if (command === "stop") return stop(paths);
  if (command === "restart" || command === "rebuild") await stop(paths);
  // resolveLiveTestPaths has confirmed this directory is inside the worktree's own .j5code.
  if (command === "rebuild") NodeFS.rmSync(paths.root, { recursive: true, force: true });
  // A restart keeps the mode that is built; only a start or rebuild chooses one.
  await start(paths, command === "restart" ? (builtMode(paths) ?? "default") : mode);
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    if (!(cause instanceof LiveTestRefusal)) throw cause;
    console.error(cause.message);
    process.exitCode = 1;
  });
}
