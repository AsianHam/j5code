// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - a standalone Node CLI that manages one child process group and prints instructions.
/**
 * One command for an agent that needs to live-test J5 Code:
 *
 *   node scripts/j5/setup-agent-live-test.ts            build the test home if needed, start the server
 *   node scripts/j5/setup-agent-live-test.ts status     say whether it is running, and how to reach it
 *   node scripts/j5/setup-agent-live-test.ts restart    stop, then start on the same home
 *   node scripts/j5/setup-agent-live-test.ts stop       stop the server
 *   node scripts/j5/setup-agent-live-test.ts rebuild    stop, delete the test home and repository, build and start again
 *   node scripts/j5/setup-agent-live-test.ts guest "<name>"   add a person, or a device for one, to the running server, with its pairing URL
 *   node scripts/j5/setup-agent-live-test.ts upgrade    in a --base build, run this worktree's build on the base's home, at its address
 *
 * A start and `rebuild` take a mode flag. With none, the home holds a test
 * project and pre-made threads. `--fresh` gives an empty home, so the first-run
 * wizard shows. `--peer` runs two servers, Local and Remote, each with its own
 * home and test project, peered so their agents can message each other;
 * `--peer --poll` has Remote poll Local instead of being reached by it.
 * `--for-dev` is different in kind: a server for the developer to use, on a
 * copy of their data, shared on the tailnet. Agents take no turns on it.
 * `--base <ref>` runs a second server from a checkout of this repository at
 * `<ref>`, on a home built by that checkout's own generator with the same
 * clock, for before and after screenshots. `upgrade` then stops both and
 * starts this worktree's build on the base's home, at the base's ports, as an
 * install upgrades; the home as the base left it is kept, and each `upgrade`
 * starts over from that copy. A
 * worktree has one live-test build at a time and its mode is fixed when it is
 * built: `rebuild` with another flag switches.
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
 * time) running from this worktree. It never finds a process by name. It runs
 * on Linux, where it reads `/proc`, and on macOS, where it asks `ps` and `lsof`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

const COMMANDS = ["start", "status", "restart", "stop", "rebuild", "upgrade"] as const;
type LiveTestCommand = (typeof COMMANDS)[number];

/** The live install's port. A test server must never end up on it. */
const LIVE_SERVER_PORT = 5773;
/**
 * How long one start may take from the moment it is asked for, builds included.
 * Every wait and every peering call in it shares this budget. What follows it
 * is printing, which mints a pairing URL per server and takes some seconds
 * more, so the command returns inside the two minutes a shell call usually
 * gets even when it starts two servers and peers them.
 */
const START_BUDGET_MS = 100_000;
const STOP_TIMEOUT_MS = 20_000;
/** How long `status` waits for both servers' peer lists together. Each read takes about four seconds on a busy host. */
const PEER_LIST_TIMEOUT_MS = 20_000;
/** How long `guest` waits for each CLI command it runs to make a link. */
const GUEST_TIMEOUT_MS = 30_000;
/** `scripts/hold.sh` in the test repository waits for this file in the repository root. */
const HOLD_RELEASE_FILE = ".hold-release";
const RECOVERY_LOG_LINE = "V2 orchestration recovery completed";

/** A reason this script will not act, printed as-is. */
export class LiveTestRefusal extends Error {}

/** How the home is built: with the test project and pre-made threads, or empty. */
const MODE_FLAGS = {
  default: "",
  fresh: "--fresh",
  peer: "--peer",
  "peer-poll": "--peer --poll",
  "for-dev": "--for-dev",
  base: "--base",
} as const;
export type LiveTestMode = keyof typeof MODE_FLAGS;
const isPeerMode = (mode: LiveTestMode) => mode === "peer" || mode === "peer-poll";
/** The flags that ask for `mode`; the base mode's flag carries the ref it was given. */
const modeFlags = (mode: LiveTestMode, baseRef: string | undefined) =>
  mode === "base" ? `${MODE_FLAGS.base} ${baseRef ?? "<ref>"}` : MODE_FLAGS[mode];

/** What the generator records about a default build. Paths are never read from it: see LiveTestPaths. */
interface DefaultManifest {
  /** Absent in the generator's file; the script adds it for the peer and base modes. */
  readonly mode?: "default" | "peer" | "peer-poll" | "base";
  /** In base mode: the ref as it was given, and the commit it named then. */
  readonly baseRef?: string;
  readonly baseCommit?: string;
  /** In base mode: the clock both builds are given, in epoch milliseconds. */
  readonly baseClock?: number;
  /** Set by the first `upgrade`: the base's address, which the upgraded server keeps. */
  readonly upgrade?: UpgradePorts;
  readonly project: { readonly id: string; readonly title: string };
  /** The name the home's owner was built with. Absent in a home built before the generator set one. */
  readonly ownerName?: string;
  readonly defaultModel: string;
  readonly personas: ReadonlyArray<{
    readonly id: string;
    readonly model: string;
    /** The second route. Absent in a home built before the generator recorded it. */
    readonly fallbackModel?: string;
  }>;
  readonly playbooks: ReadonlyArray<string>;
  readonly holdScript: string;
  /** Titles of the threads left in a pre-made state. Absent in a home built before the generator made any. */
  readonly stateThreads?: ReadonlyArray<string>;
}
/** The ports a server listens on: the dev runner's API server and its web server. */
export interface UpgradePorts {
  readonly serverPort: number;
  readonly webPort: number;
}
/** Marks a finished build and records its mode. */
type Manifest = DefaultManifest | { readonly mode: "fresh" } | { readonly mode: "for-dev" };

/** What one server uses: its home, its test repository, its log and its process record. */
export interface ServerPaths {
  readonly worktree: string;
  readonly home: string;
  readonly testRepo: string;
  readonly log: string;
  readonly record: string;
}

/**
 * Every path the script acts on, derived from the worktree and checked to stay
 * inside it. The top-level server is the only one outside the peer modes, and
 * is Local in them; `remote` is the second server's.
 */
export interface LiveTestPaths extends ServerPaths {
  readonly root: string;
  readonly manifest: string;
  /** In base mode, a git worktree of this repository at the base ref. */
  readonly base: string;
  readonly remote: ServerPaths & { readonly root: string };
  /**
   * After `upgrade`, the server this worktree runs on the base's own home.
   * Its log and record are the head's; the home and repository are the base's.
   */
  readonly upgrade: ServerPaths & {
    readonly root: string;
    /** The base's own server log, which says the address the base used. */
    readonly baseLog: string;
    /** The base's home as it was before the first upgrade. */
    readonly before: string;
  };
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
  const remoteRoot = NodePath.join(root, "remote");
  const remote = {
    worktree,
    root: remoteRoot,
    home: NodePath.join(remoteRoot, "home"),
    testRepo: NodePath.join(remoteRoot, "test-repo"),
    log: NodePath.join(remoteRoot, "server.log"),
    record: NodePath.join(remoteRoot, "server.json"),
  };
  const baseRoot = NodePath.join(root, "base", ".j5code", "live-test");
  const upgradeRoot = NodePath.join(root, "upgrade");
  const upgrade = {
    worktree,
    root: upgradeRoot,
    home: NodePath.join(baseRoot, "home"),
    testRepo: NodePath.join(baseRoot, "test-repo"),
    log: NodePath.join(upgradeRoot, "server.log"),
    record: NodePath.join(upgradeRoot, "server.json"),
    baseLog: NodePath.join(baseRoot, "server.log"),
    before: NodePath.join(upgradeRoot, "home-before"),
  };
  // Two servers on one database would corrupt it, so Remote's home must be its own.
  for (const [mine, theirs] of [
    [home, remote.home],
    [NodePath.join(home, "userdata"), NodePath.join(remote.home, "userdata")],
    [testRepo, remote.testRepo],
  ] as const) {
    if (canonicalPath(mine) === canonicalPath(theirs)) {
      throw new LiveTestRefusal(
        `${theirs} resolves to ${mine}. Local and Remote must have separate homes and repositories; remove the link.`,
      );
    }
  }
  // The server keeps its database in <home>/userdata, so that must not be a link either.
  for (const inside of [
    home,
    NodePath.join(home, "userdata"),
    testRepo,
    remote.home,
    NodePath.join(remote.home, "userdata"),
    remote.testRepo,
    NodePath.join(root, "base"),
    // `upgrade` replaces the base's home with its kept copy, so both must be this build's.
    upgrade.home,
    NodePath.join(upgrade.home, "userdata"),
    upgrade.root,
    upgrade.before,
  ]) {
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
    remote,
    base: NodePath.join(root, "base"),
    upgrade,
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
    // Every node child here opens SQLite, and each process warns once that it is experimental:
    // dozens of lines that bury what a command prints. Only that kind of warning is silenced.
    NODE_OPTIONS: [rest.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"]
      .filter((option) => option !== undefined && option !== "")
      .join(" "),
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
  /** The tailnet URL the dev runner shared the web server at, with `--share`. */
  readonly sharedUrl: string | undefined;
  /** Why sharing failed. The dev runner only warns and carries on unshared. */
  readonly shareFailure: string | undefined;
}

// eslint-disable-next-line no-control-regex -- the server's pretty logger colours its output.
const plainLog = (log: string) => log.replaceAll(/\u001B\[[0-9;]*m/g, "");

/** What the dev server's log says so far. The latest pairing URL wins: a file-watch restart mints a new one. */
export function readServerLog(log: string): ServerLogFacts {
  const text = plainLog(log);
  const runner = /\[dev-runner\] .*serverPort=(\d+) webPort=(\d+) baseDir=(\S+)/.exec(text);
  const pairingUrls = [...text.matchAll(/pairingUrl: (\S+)/g)];
  return {
    serverPort: runner === null ? undefined : Number(runner[1]),
    webPort: runner === null ? undefined : Number(runner[2]),
    baseDir: runner?.[3],
    pairingUrl: pairingUrls.at(-1)?.[1],
    recovered: text.includes(RECOVERY_LOG_LINE),
    sharedUrl: /\[dev-runner\] shared on tailnet: (\S+)/.exec(text)?.[1],
    shareFailure: /\[dev-runner\] could not share on the tailnet: (.*)/.exec(text)?.[1],
  };
}

/**
 * The log's last lines up to the server's exit, when the server has exited
 * since it last minted a pairing URL; undefined while it has not. `node
 * --watch` prints "Failed running" when the server it runs exits, then waits
 * for a file to change, so the dev runner stays up with nothing serving. The
 * lines after it are the web proxy failing to reach the server.
 */
export function serverExit(log: string): string | undefined {
  const lines = plainLog(log).split("\n");
  const exit = lines.findLastIndex((line) => line.startsWith("Failed running '"));
  const pairing = lines.findLastIndex((line) => line.includes("pairingUrl: "));
  return exit === -1 || exit < pairing
    ? undefined
    : lines.slice(Math.max(0, exit - 30), exit + 1).join("\n");
}

/**
 * Why a server that is coming up must be abandoned, or undefined when it may
 * continue: it must use the test home, and never the live server's port.
 */
export function startRefusal(input: {
  readonly facts: ServerLogFacts;
  readonly home: string;
  readonly inheritedPort: string | undefined;
  /** Set for a server that must be shared on the tailnet: an unshared one is no use to the developer. */
  readonly requireShare?: boolean;
}): string | undefined {
  const { facts } = input;
  if (input.requireShare === true && facts.shareFailure !== undefined) {
    return `The dev server could not share on the tailnet: ${facts.shareFailure}`;
  }
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

/** macOS has no /proc, so there the probes below ask `ps` and `lsof`. */
// oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
const IS_MACOS = NodeOS.platform() === "darwin";

/** A probe's stdout, or undefined when it fails, as `ps` and `lsof` do when nothing matches. */
function probeOutput(command: string, args: ReadonlyArray<string>): string | undefined {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    // lstart's format follows the locale.
    env: { ...process.env, LC_ALL: "C" },
  });
  return result.status === 0 ? result.stdout : undefined;
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
  const group = IS_MACOS
    ? probeOutput("ps", ["-o", "pgid=", "-p", String(pid)])?.trim()
    : statFieldsOf(pid)?.[2];
  return group === undefined || group === "" ? undefined : Number(group);
}

/**
 * When `pid` started: clock ticks since boot on Linux, the start time to the
 * second on macOS. Together with the pid it names one process for good: a
 * recycled pid has a later start time.
 */
function startTimeOf(pid: number): string | undefined {
  if (!IS_MACOS) return statFieldsOf(pid)?.[19];
  return probeOutput("ps", ["-o", "lstart=", "-p", String(pid)])?.trim() || undefined;
}

/** Pids in `group`, from `ps -A -o pid=,pgid=` output. */
export function groupMembersFromPs(output: string, group: number): ReadonlyArray<number> {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => pgid === group && Number.isInteger(pid))
    .map(([pid]) => pid!);
}

function membersOfGroup(group: number): ReadonlyArray<number> {
  if (IS_MACOS) {
    // `ps -A` always lists something, so a failure must throw: read as an empty
    // group, it would let stop and rebuild drop a server that is still running.
    const output = NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,pgid="], {
      encoding: "utf8",
    });
    return groupMembersFromPs(output, group);
  }
  return NodeFS.readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => processGroupOf(pid) === group);
}

function listenerOn(port: number): number | undefined {
  if (IS_MACOS) {
    const pid = probeOutput("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])?.split("\n")[0];
    return pid ? Number(pid) : undefined;
  }
  const output = NodeChildProcess.execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], {
    encoding: "utf8",
  });
  const pid = /pid=(\d+)/.exec(output)?.[1];
  return pid === undefined ? undefined : Number(pid);
}

/** The path in `lsof -Fn` output, whose name field is the line that starts with "n". */
export function pathFromLsofFields(output: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

function cwdOf(pid: number): string | undefined {
  if (IS_MACOS) {
    return pathFromLsofFields(
      probeOutput("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]) ?? "",
    );
  }
  try {
    return NodeFS.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
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

function currentServerState(paths: ServerPaths): ServerState {
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
    cwdOf,
  });
}

const selfCommand = (paths: ServerPaths, command: string) =>
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
  /** The second server in the peer modes. */
  readonly remote?: {
    readonly facts: ServerLogFacts;
    /** The name Remote's owner was built with, from Remote's own manifest. */
    readonly ownerName: string | undefined;
    /** Opened in a browser paired with Local, it adds Remote there. Works once. */
    readonly addToBrowserUrl: string | undefined;
    /** Whether each server's own peer list names the other. */
    readonly peered: boolean;
  };
}): string {
  const { paths, manifest, facts, remote } = input;
  const owner = "ownerName" in manifest ? manifest.ownerName : undefined;
  const pairCommand = pairCommandLine(paths, owner ?? "<the name the owner gave>");
  const ownerLine = (ownerName: string | undefined) =>
    ownerName === undefined ? "" : `\n  Owner         ${ownerName}`;
  return `J5 Code live-test server${remote === undefined ? "" : "s"}: RUNNING
${remote === undefined ? "" : "\nLocal, where the browser pairs:"}
  Pairing URL   ${input.pairingUrl ?? `none could be minted; run: ${pairCommand}`}
  Web           http://localhost:${facts.webPort}
  Server port   ${facts.serverPort}
  Home          ${paths.home}
  Log           ${paths.log}${ownerLine("ownerName" in manifest ? manifest.ownerName : undefined)}
${
  remote === undefined
    ? ""
    : `
Remote, which has no web server of its own:
  Server port   ${remote.facts.serverPort}
  Home          ${paths.remote.home}
  Log           ${paths.remote.log}${ownerLine(remote.ownerName)}
  Project       ${paths.remote.testRepo}
  Add to the browser, after pairing with Local (works once):
    ${remote.addToBrowserUrl ?? "none could be minted"}
  A rebuild gives both servers new ids. If the browser still lists a Remote from
  an earlier build, remove that one first (Settings > Connections).

${
  remote.peered
    ? `The two are peered${manifest.mode === "peer-poll" ? ": Remote polls Local for its messages, and Local never connects to Remote" : " and send to each other directly"}.`
    : `The two are NOT peered yet: each server's peer list does not name the other. Finish with: ${selfCommand(paths, MODE_FLAGS[manifest.mode === "peer-poll" ? "peer-poll" : "peer"])}`
}
`
}
${
  owner === undefined
    ? `The pairing URL is the server's startup link. It works once, and pairs the
owner, who gives their name on it. After that, pair another device with:`
    : "The pairing URL works once. `status` prints a fresh one, and so does:"
}
  ${pairCommand}

${
  manifest.mode === "fresh" || manifest.mode === "for-dev"
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
Playbooks: ${manifest.playbooks.join(", ")}${
        manifest.stateThreads === undefined || manifest.stateThreads.length === 0
          ? ""
          : `\nThreads in a pre-made state: ${manifest.stateThreads.map((title) => `"${title}"`).join(", ")}`
      }

Hold a turn open by asking the agent to run: ${manifest.holdScript}
Release it with: touch ${NodePath.join(paths.testRepo, HOLD_RELEASE_FILE)}`
}

Commands:
  ${selfCommand(paths, "status")}    say whether it is running
  ${selfCommand(paths, "restart")}   stop, then start on the same home
  ${selfCommand(paths, "stop")}      stop the server${
    manifest.mode === "for-dev"
      ? ""
      : `\n  ${selfCommand(paths, 'guest "<name>"')}   add a person, or a device for someone already here
                                      (flags: --server, --project <id> or --thread <id>,
                                      --level viewer|collaborator|owner; owner with --server only)
  ${selfCommand(paths, "guest --unknown")}   a link for a device the server does not know`
  }
  ${selfCommand(paths, "rebuild")}   stop, delete ${paths.root}, build and start again
                                      (flags: none for the test project, --fresh for an empty home,
                                      --peer or --peer --poll for two peered servers,
                                      --for-dev for a server the developer uses,
                                      --base <ref> for a second server at that ref)

How to test is in .agents/skills/j5-live-test/SKILL.md.
`;
}

/**
 * Every scope a client can be given (`AuthStandardClientScopes` in
 * packages/contracts/src/auth.ts). A bare `pair` grants them all since upstream
 * #20432, but a `--base` server built before it grants no access or relay
 * scopes, and without those a tester cannot use Connections settings.
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

/**
 * The `pair` invocation for this home, as arguments to node. A link names the
 * person it pairs a device for (register D36): the owner the home was built
 * with, or a person `guest` adds.
 */
const pairArguments = (paths: ServerPaths, person: string): ReadonlyArray<string> => [
  NodePath.join(paths.worktree, "apps/server/src/bin.ts"),
  "pair",
  "--base-dir",
  paths.home,
  "--person",
  person,
  ...PAIRING_SCOPES.flatMap((scope) => ["--scope", scope]),
];

/** `pairArguments` as a command a person can paste. */
const pairCommandLine = (paths: ServerPaths, person: string) =>
  `node ${pairArguments(paths, person)
    .map((argument) => (/^[\w./:=-]+$/.test(argument) ? argument : JSON.stringify(argument)))
    .join(" ")}`;

/**
 * The address a pairing link opens on, as `pair` builds its own from the running server's
 * runtime file (`resolveDirectPairingBaseUrl` in `apps/server/src/cli/pair.ts`): the dev web
 * URL. `guest --unknown` gives it to `auth pairing create`, so both links open on one address.
 */
function pairingBaseUrl(paths: ServerPaths): string {
  for (const variant of ["userdata", "dev"]) {
    const file = NodePath.join(paths.home, variant, "server-runtime.json");
    if (!NodeFS.existsSync(file)) continue;
    const state = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
      readonly devUrl?: string;
      readonly origin: string;
    };
    return state.devUrl ?? state.origin;
  }
  throw new LiveTestRefusal(
    `The running server wrote no runtime file under ${paths.home}, so there is no address to pair on.`,
  );
}

/**
 * A fresh pairing URL for the home's owner from the running server. The one in
 * the log is the startup URL, which works once and is usually spent by the time
 * anyone asks again.
 */
function mintPairingUrl(paths: ServerPaths, owner: string): string | undefined {
  const pair = NodeChildProcess.spawnSync(process.execPath, [...pairArguments(paths, owner)], {
    cwd: paths.worktree,
    env: liveTestEnvironment(process.env, paths.worktree),
    encoding: "utf8",
  });
  return /Pairing URL: (\S+)/.exec(pair.stdout ?? "")?.[1];
}

/**
 * The link that adds Remote to a browser already paired with Local: Local's
 * web app takes a `host` and a pairing token for that host and saves it as an
 * environment (apps/web/src/hostedPairing.ts).
 */
export function addRemoteUrl(input: {
  readonly localWebPort: number | undefined;
  readonly remoteServerPort: number | undefined;
  readonly remotePairingUrl: string | undefined;
}): string | undefined {
  const token = input.remotePairingUrl?.split("#token=")[1];
  if (token === undefined) return undefined;
  const url = new URL(`http://localhost:${input.localWebPort}/pair`);
  url.searchParams.set("host", `http://localhost:${input.remoteServerPort}`);
  url.searchParams.set("label", "Remote");
  url.hash = `token=${token}`;
  return url.toString();
}

function printRunning(
  paths: LiveTestPaths,
  facts: ServerLogFacts,
  remoteFacts: ServerLogFacts | undefined,
  /** Set by a start that has just peered them, which need not ask the servers again. */
  justPeered = false,
): void {
  const manifest = readManifest(paths);
  const owner = "ownerName" in manifest ? manifest.ownerName : undefined;
  const remoteOwner =
    remoteFacts === undefined ? undefined : readDefaultManifest(paths.remote.root).ownerName;
  console.log(
    formatInstructions({
      paths,
      manifest,
      facts,
      // An owner with no name yet pairs with the startup URL, and gives their name there (AC6).
      pairingUrl: owner === undefined ? facts.pairingUrl : mintPairingUrl(paths, owner),
      ...(remoteFacts === undefined
        ? {}
        : {
            remote: {
              facts: remoteFacts,
              ownerName: remoteOwner,
              peered: justPeered || arePeered(paths, facts.serverPort, remoteFacts.serverPort),
              addToBrowserUrl: addRemoteUrl({
                localWebPort: facts.webPort,
                remoteServerPort: remoteFacts.serverPort,
                remotePairingUrl:
                  remoteOwner === undefined ? undefined : mintPairingUrl(paths.remote, remoteOwner),
              }),
            },
          }),
    }),
  );
}

function readManifest(paths: LiveTestPaths): Manifest {
  return JSON.parse(NodeFS.readFileSync(paths.manifest, "utf8")) as Manifest;
}

/** The generator's own manifest for one server: Local's, or Remote's under its own root. */
function readDefaultManifest(root: string): DefaultManifest {
  return JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, "manifest.json"), "utf8"),
  ) as DefaultManifest;
}

/** The name the upgraded base's owner was built with, from the base's own manifest. */
function upgradedOwner(paths: LiveTestPaths): string | undefined {
  return readDefaultManifest(NodePath.dirname(paths.upgrade.home)).ownerName;
}

/**
 * A pairing URL for the upgraded base's owner, as `printRunning` mints one: an owner with no
 * name yet, from a base built before the generator gave one, pairs with the startup URL.
 */
function upgradedPairingUrl(paths: LiveTestPaths, facts: ServerLogFacts): string | undefined {
  const owner = upgradedOwner(paths);
  return owner === undefined ? facts.pairingUrl : mintPairingUrl(paths.upgrade, owner);
}

function logTail(paths: ServerPaths): string {
  return NodeFS.readFileSync(paths.log, "utf8").split("\n").slice(-40).join("\n");
}

function buildHome(paths: LiveTestPaths, mode: LiveTestMode, base: BaseTarget | undefined): void {
  const rebuild = selfCommand(paths, `rebuild ${modeFlags(mode, base?.ref)}`);
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
  if (mode === "for-dev") {
    console.log(
      "Copying a slice of the developer's data into a new home (the live database is only read)...",
    );
    // migrate-dev-db reads ~/.j5code/userdata read-only and writes only below --base-dir.
    const copy = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(paths.worktree, "apps/server/scripts/migrate-dev-db.ts"),
        "--base-dir",
        paths.home,
      ],
      {
        cwd: paths.worktree,
        env: liveTestEnvironment(process.env, paths.worktree),
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (copy.status !== 0) {
      throw new LiveTestRefusal(`Copying the developer's data failed. Retry with: ${rebuild}`);
    }
    const manifest: Manifest = { mode: "for-dev" };
    NodeFS.writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`);
    return;
  }
  const generate = (root: string, ownerName: string) => {
    const build = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(paths.worktree, "apps/server/src/j5/test-support/liveTestHome.ts"),
        "--root",
        root,
        "--owner-name",
        ownerName,
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
  };
  if (!isPeerMode(mode)) {
    console.log("Building the test repository and home (about 30 seconds, no model calls)...");
    generate(paths.root, "Test owner");
    if (base !== undefined) {
      const manifest: Manifest = {
        ...(readManifest(paths) as DefaultManifest),
        mode: "base",
        baseRef: base.ref,
        baseCommit: base.commit,
        baseClock: Number(process.env.J5_LIVE_TEST_NOW),
      };
      NodeFS.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return;
  }
  console.log("Building two test repositories and homes (about a minute, no model calls)...");
  // Remote first: Local's manifest is the mark of a finished build, so it comes last.
  generate(paths.remote.root, "Remote owner");
  generate(paths.root, "Local owner");
  const manifest: Manifest = { ...(readManifest(paths) as DefaultManifest), mode };
  NodeFS.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The block for `--for-dev`. The pairing URL is the server's startup URL from
 * its log: `pair` would mint a localhost one, which is no use off this
 * machine. Nothing here opens it.
 */
export function formatForDeveloper(paths: LiveTestPaths, facts: ServerLogFacts): string {
  return `J5 Code server for the developer: RUNNING

  Pairing URL   ${facts.pairingUrl}
  Shared at     ${facts.sharedUrl}
  Server port   ${facts.serverPort}
  Home          ${paths.home}
  Log           ${paths.log}

This server is for the developer, not for testing. Give them the pairing URL.
Do not open it yourself: it works once. If it has been used, \`restart\` prints a new one.
Take no agent turns here. The home is a copy of the developer's data, so its
threads point at real checkouts and resume real provider sessions.
Whether another device can reach the shared address was not checked; only the
developer can confirm that.

Commands:
  ${selfCommand(paths, "status")}    say whether it is running
  ${selfCommand(paths, "restart")}   stop, then start and share on the same home
  ${selfCommand(paths, "stop")}      stop the server and remove its tailnet mapping
  ${selfCommand(paths, "rebuild --for-dev")}   stop, delete ${paths.root}, copy the data again and start
`;
}

/** The live install's tailnet port. A `--for-dev` server must never share on it. */
const LIVE_TAILNET_PORT = 8444;
/** The dev runner's server port is its web port plus this (scripts/dev-runner.ts base ports). */
const SERVER_PORT_ABOVE_WEB = 8040;

export interface TailnetMapping {
  readonly port: number;
  /** Where the mapping proxies to, such as "http://localhost:7594". */
  readonly targets: ReadonlyArray<string>;
}

/**
 * The mappings in `tailscale serve status` output, which prints each as
 *   https://host.ts.net:8444 (tailnet only)
 *   |-- / proxy http://127.0.0.1:5773
 */
export function tailnetMappings(serveStatus: string): ReadonlyArray<TailnetMapping> {
  const mappings: Array<{ port: number; targets: Array<string> }> = [];
  for (const line of serveStatus.split("\n")) {
    const mapping = /^https:\/\/\S+?:(\d+)\b/.exec(line);
    if (mapping !== null) {
      mappings.push({ port: Number(mapping[1]), targets: [] });
      continue;
    }
    const target = /^\|--.*\bproxy\s+(\S+)/.exec(line);
    if (target !== null) mappings.at(-1)?.targets.push(target[1] ?? "");
  }
  return mappings;
}

/** Whether a mapping is one this server made: it proxies only to this server's web port on loopback. */
export function isOwnMapping(mapping: TailnetMapping, webPort: number): boolean {
  const own = new RegExp(`^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${webPort}/?$`);
  return (
    mapping.port === webPort &&
    mapping.targets.length > 0 &&
    mapping.targets.every((target) => own.test(target))
  );
}

/**
 * Why this server must not be shared on `webPort`, or undefined when it may.
 * `--share` replaces whatever is mapped on the port, so the port must not be
 * the live install's and must not carry a mapping this server did not make.
 */
export function shareRefusal(
  webPort: number,
  mappings: ReadonlyArray<TailnetMapping>,
  /** The dev runner's own test for ports browsers refuse to open. Pinning the port skips the runner's use of it. */
  isBrowserAllowedPort: (port: number) => boolean,
): string | undefined {
  if (!isBrowserAllowedPort(webPort)) {
    return `This worktree's web port is ${webPort}, which browsers refuse to open, so a shared URL on it would be useless. Use a different worktree for --for-dev.`;
  }
  if (webPort === LIVE_TAILNET_PORT) {
    return `This worktree's web port is ${LIVE_TAILNET_PORT}, the live install's tailnet port. Sharing would replace the live mapping. Use a different worktree for --for-dev.`;
  }
  const foreign = mappings.find(
    (mapping) => mapping.port === webPort && !isOwnMapping(mapping, webPort),
  );
  return foreign === undefined
    ? undefined
    : `Tailnet port ${webPort} is already mapped to ${foreign.targets.join(", ") || "something else"}, which this server did not set up. Sharing would replace it. Use a different worktree for --for-dev.`;
}

/**
 * The mappings from a finished `tailscale serve status`. A failed read is an
 * error, never "nothing is mapped": acting on that would be acting blind.
 */
export function mappingsFromStatus(result: {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): ReadonlyArray<TailnetMapping> {
  if (result.status !== 0) {
    throw new LiveTestRefusal(
      `\`tailscale serve status\` failed, so the tailnet mappings cannot be read:\n${result.stderr.trim() || "no output"}`,
    );
  }
  return tailnetMappings(result.stdout);
}

/** How long one `tailscale` read may take outside a start, which has its own deadline. */
const TAILSCALE_TIMEOUT_MS = 15_000;

function readTailnetMappings(deadline?: number): ReadonlyArray<TailnetMapping> {
  const status = NodeChildProcess.spawnSync("tailscale", ["serve", "status"], {
    encoding: "utf8",
    timeout: Math.max(1, (deadline ?? Date.now() + TAILSCALE_TIMEOUT_MS) - Date.now()),
  });
  return mappingsFromStatus({
    status: status.status,
    stdout: status.stdout ?? "",
    stderr: status.stderr ?? String(status.error ?? ""),
  });
}

/**
 * The flags that pin the dev runner to this worktree's own ports and share
 * it. Unpinned, the runner moves to the next free port pair, which could be
 * one that was never checked; with both ports given it uses exactly these.
 * Refuses before anything is started if the web port must not be shared.
 */
async function pinnedShareArgs(
  paths: LiveTestPaths,
  deadline: number,
): Promise<ReadonlyArray<string>> {
  const environment = liveTestEnvironment(process.env, paths.worktree);
  // Each child here is given only the time the start has left.
  const timeLeft = () => ({ timeout: Math.max(1, deadline - Date.now()) });
  const { isBrowserAllowedPort } = await import("../dev-runner.ts");
  // With both ports explicit the runner skips its search, so this prints the
  // web port derived from the worktree path and nothing else.
  const dryRun = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(paths.worktree, "scripts/dev-runner.ts"),
      "dev",
      "--dry-run",
      "--home-dir",
      paths.home,
      "--port",
      "1",
      "--dev-url",
      "http://localhost:1",
    ],
    { cwd: paths.worktree, env: environment, encoding: "utf8", ...timeLeft() },
  );
  const webPort = readServerLog(`${dryRun.stdout}${dryRun.stderr}`).webPort;
  if (webPort === undefined) {
    throw new LiveTestRefusal(`The dev runner did not report its web port:\n${dryRun.stderr}`);
  }
  const refusal = shareRefusal(webPort, readTailnetMappings(deadline), isBrowserAllowedPort);
  if (refusal !== undefined) throw new LiveTestRefusal(refusal);
  if (listenerOn(webPort) !== undefined) {
    throw new LiveTestRefusal(
      `Something is already listening on port ${webPort}; sharing it would publish that instead of this server.`,
    );
  }
  const status = NodeChildProcess.spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    ...timeLeft(),
  });
  const dnsName =
    status.status === 0
      ? (JSON.parse(status.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(
          /\.$/,
          "",
        )
      : undefined;
  if (dnsName === undefined || dnsName === "") {
    throw new LiveTestRefusal("This machine has no tailnet name, so the server cannot be shared.");
  }
  return [
    "--port",
    String(webPort + SERVER_PORT_ABOVE_WEB),
    // The address --share will publish; given here so the web port stays the one checked above.
    "--dev-url",
    `https://${dnsName}:${webPort}/`,
    "--share",
  ];
}

/**
 * What a stopped `--for-dev` server should do about the tailnet: nothing,
 * remove its own mapping, or leave a foreign one alone and say so. It acts
 * only when this run's log recorded a share, and only on a mapping that
 * proxies to this server's own web port.
 */
export function mappingCleanup(
  facts: ServerLogFacts,
  mappings: ReadonlyArray<TailnetMapping>,
):
  | { readonly kind: "nothing" }
  | { readonly kind: "remove"; readonly port: number }
  | { readonly kind: "foreign"; readonly port: number; readonly targets: ReadonlyArray<string> } {
  const { webPort } = facts;
  if (facts.sharedUrl === undefined || webPort === undefined) return { kind: "nothing" };
  const mapping = mappings.find((candidate) => candidate.port === webPort);
  if (mapping === undefined) return { kind: "nothing" };
  return isOwnMapping(mapping, webPort)
    ? { kind: "remove", port: webPort }
    : { kind: "foreign", port: webPort, targets: mapping.targets };
}

/**
 * After a stop, makes sure this server's tailnet mapping is gone. The dev
 * runner removes it on a normal exit; this covers a runner that was killed.
 */
function removeOwnTailnetMapping(facts: ServerLogFacts): void {
  if (facts.sharedUrl === undefined) return;
  const cleanup = mappingCleanup(facts, readTailnetMappings());
  if (cleanup.kind === "nothing") return;
  if (cleanup.kind === "foreign") {
    // Said and passed over, not refused: a refusal here would stop every later
    // rebuild too, and the mapping is not this server's to act on.
    console.log(
      `Tailnet port ${cleanup.port} is mapped to ${cleanup.targets.join(", ")}, which this server did not set up. It has been left alone.`,
    );
    return;
  }
  NodeChildProcess.spawnSync("tailscale", ["serve", `--https=${cleanup.port}`, "off"], {
    timeout: TAILSCALE_TIMEOUT_MS,
  });
  if (mappingCleanup(facts, readTailnetMappings()).kind !== "nothing") {
    throw new LiveTestRefusal(
      `The tailnet mapping for port ${cleanup.port} is still there. Remove it with: tailscale serve --https=${cleanup.port} off`,
    );
  }
}

/** What to tell an agent about a server that is ours but has no listener on its port. */
const notServingMessage = (paths: ServerPaths, name: string, reason: string) =>
  `J5 Code live-test server${name}: NOT SERVING

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
 * Waits for a server this script started to be ready and returns what its log
 * says. Returns by `deadline` either way: a server that is merely
 * slow is left running and reported as still starting.
 */
async function waitUntilReady(
  paths: ServerPaths,
  deadline: number,
  requireShare: boolean,
): Promise<ServerLogFacts> {
  for (;;) {
    const log = NodeFS.readFileSync(paths.log, "utf8");
    const facts = readServerLog(log);
    // Classify before anything else: a refusal below signals the group, and
    // only a group proven to be ours may be signalled.
    const state = currentServerState(paths);
    if (state.kind === "unverified") {
      // A leader gone with members left is a group on its way out, most often
      // because another command, such as `stop`, is ending it.
      if (startTimeOf(state.group) !== undefined) throw new LiveTestRefusal(state.reason);
      throw new LiveTestRefusal(
        "The dev server stopped while this command waited for it to start; another command, such as `stop`, may have ended it.",
      );
    }
    if (state.kind === "stopped") {
      if (!NodeFS.existsSync(paths.record)) {
        throw new LiveTestRefusal(
          "The dev server was stopped by another command while this one waited for it to start.",
        );
      }
      NodeFS.rmSync(paths.record, { force: true });
      throw new LiveTestRefusal(
        `The dev server exited while starting.\nLast lines of ${paths.log}:\n${logTail(paths)}`,
      );
    }
    const exit = state.kind === "running" ? undefined : serverExit(log);
    if (exit !== undefined) {
      throw new LiveTestRefusal(
        `The dev server exited while starting. Its file watcher is still running and starts it again when a file changes.\nLast lines of ${paths.log} up to the exit:\n${exit}\nTo stop it: ${selfCommand(paths, "stop")}`,
      );
    }
    const refusal = startRefusal({
      facts,
      home: paths.home,
      inheritedPort: process.env.T3CODE_PORT,
      requireShare,
    });
    if (refusal !== undefined) {
      await stopGroup(state.group);
      NodeFS.rmSync(paths.record, { force: true });
      throw new LiveTestRefusal(`${refusal} It has been stopped.`);
    }
    if (
      state.kind === "running" &&
      facts.pairingUrl !== undefined &&
      facts.recovered &&
      (!requireShare || facts.sharedUrl !== undefined)
    ) {
      return state.facts;
    }
    if (Date.now() > deadline) {
      throw new LiveTestRefusal(
        `The dev server was not ready in time. It has been left running.\nIf it is still starting, check again with: ${selfCommand(paths, "status")}\nIf it has failed (see ${paths.log}), start it again with: ${selfCommand(paths, "restart")}`,
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

/** The ref a base build was given, or undefined for any other build. */
function builtBaseRef(paths: LiveTestPaths): string | undefined {
  if (!NodeFS.existsSync(paths.manifest)) return undefined;
  const manifest = readManifest(paths);
  return "baseRef" in manifest ? manifest.baseRef : undefined;
}

function builtMode(paths: LiveTestPaths): LiveTestMode | undefined {
  return NodeFS.existsSync(paths.manifest) ? (readManifest(paths).mode ?? "default") : undefined;
}

/**
 * Starts one dev server on its home, or joins one that is already starting,
 * and waits until it is ready.
 */
async function startServer(
  paths: ServerPaths,
  runnerMode: "dev" | "dev:server",
  environment: Readonly<Record<string, string>>,
  deadline: number,
  runnerArgs: ReadonlyArray<string> = [],
): Promise<ServerLogFacts> {
  const share = runnerArgs.includes("--share");
  const state = currentServerState(paths);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  // Already started, perhaps by a call that is still waiting: wait with it.
  if (state.kind !== "stopped") return waitUntilReady(paths, deadline, share);

  const log = NodeFS.openSync(paths.log, "w");
  // Detached makes the child the leader of a new process group, so its pid is
  // the group id. That group is the only thing this script ever signals.
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(paths.worktree, "scripts/dev-runner.ts"),
      runnerMode,
      "--home-dir",
      paths.home,
      ...runnerArgs,
    ],
    {
      cwd: paths.worktree,
      env: { ...liveTestEnvironment(process.env, paths.worktree), ...environment },
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
  return waitUntilReady(paths, deadline, share);
}

/** Runs the server's own `j5` CLI against one of the two homes. */
function peerCli(
  paths: LiveTestPaths,
  args: ReadonlyArray<string>,
  /** When the call must have returned; it is killed then. Unbounded when absent. */
  deadline?: number,
): { readonly ok: boolean; readonly output: string; readonly error: string } {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(paths.worktree, "apps/server/src/bin.ts"), "a2a", "peer", ...args],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      encoding: "utf8",
      ...(deadline === undefined ? {} : { timeout: Math.max(1, deadline - Date.now()) }),
    },
  );
  return {
    ok: result.status === 0,
    output: (result.stdout ?? "").trim(),
    // Node's own warnings go to stderr too; the CLI's reason is what is left.
    error: (result.stderr ?? "")
      .split("\n")
      .filter((line) => !/ExperimentalWarning|--trace-warnings/.test(line))
      .join("\n")
      .trim(),
  };
}

/**
 * The `peer credential` and `peer add` arguments that let `holder` deliver to
 * `issuer`: the issuer mints a credential for the holder's environment id, and
 * the holder records the issuer at its origin, proving the credential there.
 * With `poll`, the issuer stores the holder's messages and the holder polls
 * for them, so the issuer never connects to the holder.
 */
export function peerSteps(input: {
  readonly issuer: { readonly home: string; readonly origin: string };
  readonly holder: {
    readonly home: string;
    readonly origin: string;
    readonly environmentId: string;
    readonly name: string;
  };
  readonly poll: boolean;
}): {
  readonly credential: ReadonlyArray<string>;
  readonly add: (credential: string) => ReadonlyArray<string>;
} {
  const { issuer, holder, poll } = input;
  return {
    credential: [
      "credential",
      "--base-dir",
      issuer.home,
      "--origin",
      issuer.origin,
      "--for",
      holder.environmentId,
      "--label",
      holder.name,
      "--credential-only",
      ...(poll ? ["--store"] : []),
    ],
    add: (credential) => [
      "add",
      "--base-dir",
      holder.home,
      "--origin",
      holder.origin,
      "--peer-origin",
      issuer.origin,
      "--credential",
      credential,
      ...(poll ? ["--poll"] : []),
    ],
  };
}

/**
 * The command that finishes a peering that did not complete. With both
 * servers up, the same start peers them. A start only joins a server that is
 * already there, so one that is not serving has to be stopped and started
 * again first, which is `restart`.
 */
export function peerRepairCommand(mode: LiveTestMode, local: string, remote: string): string {
  return local === "RUNNING" && remote === "RUNNING" ? MODE_FLAGS[mode] : "restart";
}

/**
 * Peers the two running servers, as `scripts/j5/pr-env.sh --peer` does. Safe
 * to repeat: issuing again rotates the credential and re-adding rotates the
 * record, so every start leaves one clean pair.
 */
async function peerServers(
  paths: LiveTestPaths,
  mode: LiveTestMode,
  ports: { readonly local: number; readonly remote: number },
  deadline: number,
): Promise<void> {
  const local = { home: paths.home, origin: `http://127.0.0.1:${ports.local}`, name: "Local" };
  const remote = {
    home: paths.remote.home,
    origin: `http://127.0.0.1:${ports.remote}`,
    name: "Remote",
  };
  // Says what each server is doing now, not what it was doing when the start began:
  // peering often fails because one of them has just gone.
  const stateNow = (server: ServerPaths) => {
    const { kind } = currentServerState(server);
    return {
      running: "RUNNING",
      notServing: "NOT SERVING",
      stopped: "STOPPED",
      unverified: "UNVERIFIED",
    }[kind];
  };
  const notPeeredYet = (detail: string) => {
    const local = stateNow(paths);
    const remote = stateNow(paths.remote);
    return new LiveTestRefusal(
      `NOT peered yet: ${detail}\nLocal is ${local} and Remote is ${remote}.\nFinish with: ${selfCommand(paths, peerRepairCommand(mode, local, remote))}`,
    );
  };
  if (Date.now() > deadline) {
    throw notPeeredYet("the time for this start ran out before peering began.");
  }
  const environmentId = async (origin: string) => {
    // A server that accepts and never answers must not hold the command past its budget.
    const response = await fetch(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    }).catch(() => undefined);
    if (response === undefined) throw notPeeredYet(`${origin} did not say who it is in time.`);
    return ((await response.json()) as { readonly environmentId: string }).environmentId;
  };
  const withIds = {
    local: { ...local, environmentId: await environmentId(local.origin) },
    remote: { ...remote, environmentId: await environmentId(remote.origin) },
  };
  if (withIds.local.environmentId === withIds.remote.environmentId) {
    throw new LiveTestRefusal(
      "Both servers report the same environment id; their homes are not separate.",
    );
  }
  const poll = mode === "peer-poll";
  // In poll mode only Remote holds a credential: it polls Local, which stores its messages.
  const directions = poll
    ? [{ issuer: withIds.local, holder: withIds.remote }]
    : [
        { issuer: withIds.remote, holder: withIds.local },
        { issuer: withIds.local, holder: withIds.remote },
      ];
  for (const { issuer, holder } of directions) {
    const steps = peerSteps({ issuer, holder, poll });
    // A server that is seconds old can miss the first hello; pr-env.sh retries the same way.
    for (let attempt = 1; ; attempt++) {
      // Checked before every call, so a direction is never begun on spent time.
      if (Date.now() > deadline) {
        throw notPeeredYet(
          `the time for this start ran out before ${holder.name} recorded ${issuer.name}.`,
        );
      }
      const credential = peerCli(paths, steps.credential, deadline);
      const added = credential.ok
        ? peerCli(paths, steps.add(credential.output), deadline)
        : credential;
      if (added.ok) break;
      if (attempt === 5) {
        throw notPeeredYet(
          `${holder.name} could not record ${issuer.name} as a peer after 5 attempts.\nThe peer command said:\n${added.error || "(nothing)"}`,
        );
      }
      await NodeTimersPromises.setTimeout(3_000);
    }
  }
}

/**
 * Whether a server's own peer list, as `peer list --json` prints it, names
 * the other server with no error against it.
 */
export function listsPeer(peerListJson: string | undefined, name: string): boolean {
  try {
    const { peers } = JSON.parse(peerListJson ?? "") as {
      readonly peers?: ReadonlyArray<{ readonly label: string; readonly lastError: unknown }>;
    };
    return (peers ?? []).some((peer) => peer.label === name && peer.lastError === null);
  } catch {
    return false;
  }
}

/**
 * The evidence that the two servers are peered: each one's peer list names
 * the other. Two listening ports say nothing about it.
 */
function arePeered(
  paths: LiveTestPaths,
  localPort: number | undefined,
  remotePort: number | undefined,
): boolean {
  // One deadline for both reads, so a server that accepts and never answers
  // cannot hang `status`. A list that does not arrive in time counts as no evidence.
  const deadline = Date.now() + PEER_LIST_TIMEOUT_MS;
  const peerList = (home: string, port: number | undefined) =>
    peerCli(
      paths,
      ["list", "--json", "--base-dir", home, "--origin", `http://127.0.0.1:${port}`],
      deadline,
    ).output;
  return (
    listsPeer(peerList(paths.home, localPort), "Remote") &&
    listsPeer(peerList(paths.remote.home, remotePort), "Local")
  );
}

async function start(
  paths: LiveTestPaths,
  mode: LiveTestMode,
  baseRef: string | undefined,
): Promise<void> {
  const deadline = Date.now() + START_BUDGET_MS;
  const built = builtMode(paths);
  const builtManifest = built === undefined ? undefined : readManifest(paths);
  const builtRef = builtBaseRef(paths);
  const refusal =
    built === undefined
      ? undefined
      : modeRefusal({
          requested: mode,
          built,
          startCommand: (other) => selfCommand(paths, modeFlags(other, builtRef)),
          rebuildCommand: (other) => selfCommand(paths, `rebuild ${modeFlags(other, baseRef)}`),
        });
  if (refusal !== undefined) throw new LiveTestRefusal(refusal);
  // After `upgrade` the base build never starts again: it would open a home a newer build has migrated.
  const upgraded = upgradeOf(paths);
  if (upgraded !== undefined) return startUpgraded(paths, upgraded, deadline, undefined);
  const base = mode === "base" ? resolveBase(paths, baseRef ?? builtRef ?? "") : undefined;
  if (
    base !== undefined &&
    builtManifest !== undefined &&
    "baseCommit" in builtManifest &&
    builtManifest.baseCommit !== base.commit
  ) {
    throw new LiveTestRefusal(
      `The base here was built at ${builtManifest.baseCommit?.slice(0, 10)}, and ${base.ref} is now ${base.commit.slice(0, 10)}.\nReplace it: ${selfCommand(paths, `rebuild ${modeFlags("base", base.ref)}`)}`,
    );
  }
  if (base !== undefined && built === undefined) {
    // The head's generator reads this now; the manifest keeps it for every base start.
    process.env.J5_LIVE_TEST_NOW = String(Date.now());
  }
  if (built === undefined && currentServerState(paths).kind === "stopped") {
    buildHome(paths, mode, base);
  }

  if (base !== undefined) {
    console.log(`Starting the head server here and the base server at ${base.ref}...`);
    // The head server boots in its own process while the base's steps run here.
    const headStarting = startServer(paths, "dev", {}, deadline);
    headStarting.catch(() => undefined);
    let baseOutput: string | undefined;
    let baseFailure: unknown;
    try {
      baseOutput = await advanceBase(paths, deadline);
    } catch (cause) {
      baseFailure = cause;
    }
    printRunning(paths, await headStarting, undefined);
    if (baseFailure !== undefined) throw baseFailure;
    if (baseOutput !== undefined) {
      return console.log(`${baseHeading(paths)}\n\n${baseOutput}\n${baseCheckoutNote(paths)}`);
    }
    throw new LiveTestRefusal(
      `${formatBaseProgress(paths, readBaseProgress(paths, false).progress)}\nThe time for this command ran out before the base was ready. The step that was running has been ended, with everything it started.\nRun the same command again to continue: ${selfCommand(paths, modeFlags("base", base.ref))}`,
    );
  }
  if (mode === "for-dev") {
    console.log("Starting the dev server and sharing it on the tailnet...");
    return console.log(
      formatForDeveloper(
        paths,
        // Pinned and checked only when this call is the one that starts it.
        await startServer(
          paths,
          "dev",
          {},
          deadline,
          currentServerState(paths).kind === "stopped"
            ? await pinnedShareArgs(paths, deadline)
            : ["--share"],
        ),
      ),
    );
  }
  if (!isPeerMode(mode)) {
    console.log("Starting the dev server...");
    return printRunning(paths, await startServer(paths, "dev", {}, deadline), undefined);
  }
  console.log("Starting the two dev servers...");
  const local = await startServer(paths, "dev", { J5CODE_SERVER_NAME: "Local" }, deadline);
  const remote = await startServer(
    paths.remote,
    "dev:server",
    {
      J5CODE_SERVER_NAME: "Remote",
      // Without an instance of its own, Remote would derive Local's ports from the worktree path.
      T3CODE_DEV_INSTANCE: `${paths.worktree}#remote`,
      // The browser reaches Remote from Local's web origin.
      T3CODE_DEV_ALLOWED_ORIGINS: `http://localhost:${local.webPort}`,
    },
    deadline,
  );
  if (local.serverPort === undefined || remote.serverPort === undefined) {
    throw new LiveTestRefusal("A server is running without a reported port; cannot peer.");
  }
  await peerServers(paths, mode, { local: local.serverPort, remote: remote.serverPort }, deadline);
  printRunning(paths, local, remote, true);
}

/** A base ref as the caller gave it, and the commit it names now. */
interface BaseTarget {
  readonly ref: string;
  readonly commit: string;
}

const LIVE_TEST_SCRIPT = "scripts/j5/setup-agent-live-test.ts";

/**
 * Resolves `ref` in this repository and checks the base can run at all: it
 * needs this script, which starts its server and carries its own generator.
 */
function resolveBase(paths: LiveTestPaths, ref: string): BaseTarget {
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.spawnSync("git", args, { cwd: paths.worktree, encoding: "utf8" });
  const commit = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  if (commit.status !== 0) {
    throw new LiveTestRefusal(`${ref} does not name a commit in this repository. Fetch it first.`);
  }
  const target = { ref, commit: commit.stdout.trim() };
  if (git("cat-file", "-e", `${target.commit}:${LIVE_TEST_SCRIPT}`).status !== 0) {
    throw new LiveTestRefusal(
      `${ref} (${target.commit.slice(0, 10)}) has no ${LIVE_TEST_SCRIPT}, so it cannot build a test home or start a server on one. Pick a base that contains it.`,
    );
  }
  return target;
}

/**
 * The environment for the base checkout's script: the head's cleaned one,
 * plus the clock the head was built with, so a base that reads it dates its
 * threads the same. Given on every base start, not only the first.
 */
export function baseEnvironment(
  environment: NodeJS.ProcessEnv,
  worktree: string,
  manifest: { readonly baseClock?: number },
): NodeJS.ProcessEnv {
  return {
    ...liveTestEnvironment(environment, worktree),
    ...(manifest.baseClock === undefined ? {} : { J5_LIVE_TEST_NOW: String(manifest.baseClock) }),
  };
}

/*
 * The base is a linked worktree, so its own copy of this script gives it its
 * own ports, its own `.j5code/live-test`, its own generator and its own
 * process record, with the rules of its version. The head adds no second way
 * to start, stop or prove a server.
 */

/** What the base's steps leave on disk. Nothing else knows their state: no step runs in the background. */
const baseFiles = (paths: LiveTestPaths) => ({
  /** Written last by the install step, so its presence means the install finished. */
  installed: NodePath.join(paths.root, "base-installed"),
  /** The step that last failed and what it said. Removed when that step next succeeds. */
  failure: NodePath.join(paths.root, "base-failure.json"),
});

/** The base is made ready in these steps, in this order. Each can be run again. */
export const BASE_STEPS = ["checkout", "install", "server"] as const;
export type BaseStep = (typeof BASE_STEPS)[number];
export type BaseProgress = Readonly<Record<BaseStep, "done" | "not done" | "failed">>;

/**
 * Each step's state, from what is on disk and what the base's own script
 * says about its server. A later step is never "done" on top of an earlier
 * one that is not.
 */
export function baseProgress(input: {
  /** The base checkout's HEAD, or undefined when there is no checkout. */
  readonly checkoutHead: string | undefined;
  readonly sameRepository: boolean;
  readonly commit: string;
  readonly installed: boolean;
  readonly serverRunning: boolean;
  readonly failedStep: BaseStep | undefined;
}): BaseProgress {
  const checkout =
    input.checkoutHead === undefined
      ? input.failedStep === "checkout"
        ? "failed"
        : "not done"
      : input.checkoutHead === input.commit && input.sameRepository
        ? "done"
        : "failed";
  const install =
    input.failedStep === "install"
      ? "failed"
      : checkout === "done" && input.installed
        ? "done"
        : "not done";
  const server =
    input.failedStep === "server"
      ? "failed"
      : install === "done" && input.serverRunning
        ? "done"
        : "not done";
  return { checkout, install, server };
}

/**
 * Refuses unless `<root>/base` is a worktree of this repository checked out
 * at the commit the build recorded. A checkout that was moved, or a stale
 * directory, would otherwise be served as the "before". It is never reset.
 */
function assertBaseCheckout(paths: LiveTestPaths, commit: string): void {
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim();
  const commonDir = (cwd: string) =>
    git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const head = git(paths.base, "rev-parse", "HEAD");
  if (head !== commit || commonDir(paths.base) !== commonDir(paths.worktree)) {
    throw new LiveTestRefusal(
      `${paths.base} is not this repository checked out at ${commit.slice(0, 10)} (it is at ${head?.slice(0, 10) || "no commit"}). It has not been changed. Replace the build: ${selfCommand(paths, `rebuild ${modeFlags("base", builtBaseRef(paths))}`)}`,
    );
  }
}

/** Whether the base's generator reads the shared clock; one from before that change dates its threads itself. */
function baseHonoursClock(paths: LiveTestPaths, commit: string): boolean {
  return (
    NodeChildProcess.spawnSync(
      "git",
      ["grep", "--quiet", "J5_LIVE_TEST_NOW", commit, "--", "apps/server/src/j5/test-support"],
      { cwd: paths.worktree },
    ).status === 0
  );
}

const gitIn = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim();

const sameRepository = (paths: LiveTestPaths) =>
  gitIn(paths.base, "rev-parse", "--path-format=absolute", "--git-common-dir") ===
  gitIn(paths.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");

/** Runs the base checkout's own copy of this script and waits, for no longer than `timeoutMs`. */
function baseScriptNow(paths: LiveTestPaths, args: ReadonlyArray<string>, timeoutMs: number) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(paths.base, LIVE_TEST_SCRIPT), ...args],
    {
      cwd: paths.base,
      env: baseEnvironment(process.env, paths.worktree, readManifest(paths) as DefaultManifest),
      encoding: "utf8",
      timeout: Math.max(1, timeoutMs),
    },
  );
}

/** How long `status` waits for the base's own status. */
const BASE_STATUS_TIMEOUT_MS = 30_000;

function readBaseProgress(
  paths: LiveTestPaths,
  /** False when there is no time left to ask the base about its server: its step then reads "not done". */
  askServer = true,
): {
  readonly progress: BaseProgress;
  /** What the base's own `status` printed, when its install is finished. */
  readonly serverStatus: string | undefined;
  readonly failure: { readonly step: BaseStep; readonly said: string } | undefined;
} {
  const files = baseFiles(paths);
  const commit = (readManifest(paths) as DefaultManifest).baseCommit ?? "";
  const failure = NodeFS.existsSync(files.failure)
    ? (JSON.parse(NodeFS.readFileSync(files.failure, "utf8")) as {
        readonly step: BaseStep;
        readonly said: string;
      })
    : undefined;
  const checkedOut = NodeFS.existsSync(paths.base);
  const installed = NodeFS.existsSync(files.installed);
  const status =
    askServer && checkedOut && installed
      ? baseScriptNow(paths, ["status"], BASE_STATUS_TIMEOUT_MS)
      : undefined;
  return {
    progress: baseProgress({
      checkoutHead: checkedOut ? gitIn(paths.base, "rev-parse", "HEAD") : undefined,
      sameRepository: checkedOut && sameRepository(paths),
      commit,
      installed,
      serverRunning:
        status?.status === 0 && /^J5 Code live-test server: RUNNING/m.test(status.stdout),
      failedStep: failure?.step,
    }),
    serverStatus: status?.stdout,
    failure,
  };
}

const formatBaseProgress = (paths: LiveTestPaths, progress: BaseProgress) => {
  const manifest = readManifest(paths) as DefaultManifest;
  return `Base server, at ${manifest.baseRef} (${manifest.baseCommit?.slice(0, 10)}), step by step:\n${BASE_STEPS.map(
    (step) => `  ${step.padEnd(10)} ${progress[step]}`,
  ).join("\n")}`;
};

/** How long a step's group has to end after SIGTERM before it is killed. */
const STEP_KILL_GRACE_MS = 5_000;

/**
 * Runs a command in the foreground, in a process group of its own, and waits
 * for it. If `timeoutMs` passes first, the whole group is ended and waited for
 * before this returns, so nothing the command started is left running. The
 * group was spawned here a moment ago, so signalling it needs no further proof.
 */
export async function runInOwnGroup(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<{
  readonly status: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}> {
  // Output goes to a file, not a pipe: a grandchild holding a pipe open would
  // keep this waiting after the command itself had gone.
  const capture = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-live-test-step-")),
    "output",
  );
  const sink = NodeFS.openSync(capture, "w");
  const child = NodeChildProcess.spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", sink, sink],
  });
  NodeFS.closeSync(sink);
  const group = child.pid;
  let timedOut = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (group === undefined) return;
    try {
      process.kill(-group, signal);
    } catch {
      // Already gone.
    }
  };
  // A command that ignores SIGTERM never exits on its own, so the hard kill is
  // armed when the deadline passes, not after waiting for an exit.
  let hardKill: NodeJS.Timeout | undefined;
  const timer = setTimeout(
    () => {
      timedOut = true;
      signalGroup("SIGTERM");
      hardKill = setTimeout(() => signalGroup("SIGKILL"), STEP_KILL_GRACE_MS);
    },
    Math.max(0, options.timeoutMs),
  );
  // If this command is itself told to stop, the step it is waiting on goes too:
  // the step is in its own group and would otherwise carry on.
  const endWithUs = (signal: NodeJS.Signals) => {
    signalGroup("SIGKILL");
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGTERM", endWithUs);
  process.once("SIGINT", endWithUs);
  const status = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code));
  });
  clearTimeout(timer);
  if (timedOut && group !== undefined) {
    // The command is gone; wait until what it started is gone too. The hard
    // kill stays armed until then.
    const until = Date.now() + 2 * STEP_KILL_GRACE_MS;
    while (membersOfGroup(group).length > 0 && Date.now() < until) {
      await NodeTimersPromises.setTimeout(100);
    }
    if (membersOfGroup(group).length > 0) signalGroup("SIGKILL");
  }
  clearTimeout(hardKill);
  process.removeListener("SIGTERM", endWithUs);
  process.removeListener("SIGINT", endWithUs);
  const output = NodeFS.readFileSync(capture, "utf8");
  NodeFS.rmSync(NodePath.dirname(capture), { recursive: true, force: true });
  return { status, output, timedOut };
}

/**
 * Takes the base as far towards a running server as fits before `deadline`:
 * check it out, install it, start its server. Every step runs in the
 * foreground, in its own process group, and leaves its result on disk. A run
 * that is out of time ends the step's whole group and stops, and the same
 * command picks up at the first step that is not done. Returns the base's own
 * start output once its server is up, or undefined when time ran out first.
 * A step that fails is recorded and refused.
 */
async function advanceBase(paths: LiveTestPaths, deadline: number): Promise<string | undefined> {
  const files = baseFiles(paths);
  const manifest = readManifest(paths) as DefaultManifest;
  const commit = manifest.baseCommit;
  if (commit === undefined) throw new LiveTestRefusal("This build has no base.");
  const environment = baseEnvironment(process.env, paths.worktree, manifest);
  const again = selfCommand(paths, modeFlags("base", manifest.baseRef));

  /** Runs one step's command within the time left. Undefined means it ran out of time. */
  const step = async (
    name: BaseStep,
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ): Promise<string | undefined> => {
    if (Date.now() >= deadline) return undefined;
    const result = await runInOwnGroup(command, args, {
      cwd,
      env: environment,
      timeoutMs: deadline - Date.now(),
    });
    // Ended by the deadline: not a failure, just not finished.
    if (result.timedOut) return undefined;
    if (result.status !== 0) {
      const said = result.output.split("\n").slice(-40).join("\n");
      NodeFS.writeFileSync(files.failure, `${JSON.stringify({ step: name, said })}\n`);
      throw new LiveTestRefusal(
        `The base's ${name} step failed:\n${said}\nWhen that is fixed, run the same command again: ${again}`,
      );
    }
    NodeFS.rmSync(files.failure, { force: true });
    return result.output;
  };

  if (!NodeFS.existsSync(paths.base)) {
    const added = await step(
      "checkout",
      "git",
      ["worktree", "add", "--detach", paths.base, commit],
      paths.worktree,
    );
    if (added === undefined) return undefined;
  }
  assertBaseCheckout(paths, commit);
  if (!NodeFS.existsSync(files.installed)) {
    const installed = await step("install", "pnpm", ["install", "--frozen-lockfile"], paths.base);
    if (installed === undefined) return undefined;
    NodeFS.writeFileSync(files.installed, "");
  }
  // Its own script builds its home if needed and starts or rejoins its server.
  // A build that an earlier run cut off part-way leaves a directory with no
  // manifest, which that script refuses to build over, so it is rebuilt.
  const baseRoot = NodePath.join(paths.base, ".j5code", "live-test");
  const cutOff =
    NodeFS.existsSync(baseRoot) && !NodeFS.existsSync(NodePath.join(baseRoot, "manifest.json"));
  return step(
    "server",
    process.execPath,
    [NodePath.join(paths.base, LIVE_TEST_SCRIPT), ...(cutOff ? ["rebuild"] : [])],
    paths.base,
  );
}

/** What to print above the base's own output: which commit it is, and whether its dates match. */
function baseHeading(paths: LiveTestPaths): string {
  const manifest = readManifest(paths) as DefaultManifest;
  const commit = manifest.baseCommit ?? "";
  return `Base server, at ${manifest.baseRef} (${commit.slice(0, 10)}), as its own script reports it:${
    baseHonoursClock(paths, commit)
      ? ""
      : "\nThis base predates the shared clock, so its threads are dated from its own build and differ from the head's by the time between the two builds."
  }`;
}

/** The base checkout stays registered in the real repository until it is removed. */
const baseCheckoutNote = (paths: LiveTestPaths) =>
  `The base checkout is a git worktree of this repository (detached, no branch) at ${paths.base}.\nTo run this worktree's build on the base's home, at the base's address: ${selfCommand(paths, "upgrade")}\nWhen the before and after work is done, remove it with: ${selfCommand(paths, "rebuild")}`;

/**
 * Removes the base checkout through git, so the repository keeps no stale
 * worktree entry. Not forced: if git will not remove it, say why and stop.
 */
function removeBaseCheckout(paths: LiveTestPaths): void {
  if (!NodeFS.existsSync(paths.base)) return;
  // Asked before anything is deleted, so a refusal leaves the base's home, or
  // an upgraded one, in place. Ignored files, such as that home, are not listed.
  const edited = gitIn(paths.base, "status", "--porcelain");
  if (edited !== undefined && edited !== "") {
    throw new LiveTestRefusal(
      `The base checkout at ${paths.base} has files that were edited or added:\n${edited}\nNothing was deleted. Undo those changes, then run the command again.`,
    );
  }
  // The base's own test home is ignored there, but a nested repository's
  // worktrees are not something `git worktree remove` will delete for us.
  NodeFS.rmSync(NodePath.join(paths.base, ".j5code"), { recursive: true, force: true });
  const removed = NodeChildProcess.spawnSync("git", ["worktree", "remove", paths.base], {
    cwd: paths.worktree,
    encoding: "utf8",
  });
  if (removed.status !== 0) {
    throw new LiveTestRefusal(
      `git would not remove the base checkout at ${paths.base}:\n${removed.stderr.trim()}\nNothing else was deleted. Fix that, then run the command again.`,
    );
  }
}

/** The dev runner's first web port (BASE_WEB_PORT in scripts/dev-runner.ts); its offset counts from here. */
const RUNNER_BASE_WEB_PORT = 5733;

/**
 * The address the upgraded server takes: the one the first upgrade recorded,
 * or else the one the base's own log reports. Refuses a build with no base,
 * a base that never started, and the live server's port.
 */
export function upgradeTarget(input: {
  readonly built: LiveTestMode | undefined;
  readonly recorded: UpgradePorts | undefined;
  readonly baseFacts: ServerLogFacts;
  readonly baseHome: string;
  readonly baseHomeExists: boolean;
  readonly inheritedPort: string | undefined;
  /** What builds a base: `rebuild --base <ref>`. */
  readonly rebuildCommand: string;
  /** What starts this build's base. */
  readonly startCommand: string;
}): UpgradePorts {
  if (input.built !== "base") {
    throw new LiveTestRefusal(
      `\`upgrade\` runs only in a --base build: it starts this worktree's build on the base server's home. Build one with: ${input.rebuildCommand}`,
    );
  }
  if (input.recorded !== undefined) return input.recorded;
  const { serverPort, webPort, baseDir } = input.baseFacts;
  if (!input.baseHomeExists || serverPort === undefined || webPort === undefined) {
    throw new LiveTestRefusal(
      `The base server has never been started here, so there is no home of its own to upgrade. Start it with: ${input.startCommand}\nThen make the old state on it and run \`upgrade\` again.`,
    );
  }
  if (baseDir !== undefined && canonicalPath(baseDir) !== canonicalPath(input.baseHome)) {
    throw new LiveTestRefusal(
      `The base's log says its server ran on ${baseDir}, not on its home ${input.baseHome}. Replace the build: ${input.rebuildCommand}`,
    );
  }
  if (serverPort === LIVE_SERVER_PORT || String(serverPort) === input.inheritedPort) {
    throw new LiveTestRefusal(`The base's log reports the live server's port ${serverPort}.`);
  }
  return { serverPort, webPort };
}

/**
 * The dev runner settings that put a server on exactly these ports. An
 * explicit server port and dev URL stop the runner looking for free ones, and
 * its web port is always its first one plus the offset.
 */
export function upgradeRunner(ports: UpgradePorts): {
  readonly environment: Readonly<Record<string, string>>;
  readonly args: ReadonlyArray<string>;
} {
  return {
    environment: { T3CODE_PORT_OFFSET: String(ports.webPort - RUNNER_BASE_WEB_PORT) },
    args: ["--port", String(ports.serverPort), "--dev-url", `http://localhost:${ports.webPort}`],
  };
}

/**
 * What `upgrade`, `restart` and `status` print about the upgraded server while
 * it runs. Only the command that upgraded says so in its heading.
 */
export function formatUpgrade(input: {
  readonly paths: LiveTestPaths;
  readonly facts: ServerLogFacts;
  readonly pairingUrl: string | undefined;
  /** The head commit, and whether the worktree has changes on top of it. */
  readonly head: { readonly commit: string; readonly changed: boolean };
  /**
   * Set right after an upgrade, when a tab that was open on the base needs a
   * reload. After a repeat, that tab has also cached state the put-back copy
   * does not have, and keeps showing it until its cache is cleared.
   */
  readonly justUpgraded: "first" | "again" | undefined;
  /** The name the base's owner was built with, from the base's own manifest. */
  readonly ownerName?: string | undefined;
}): string {
  const { paths, facts } = input;
  const revision = `${input.head.commit.slice(0, 10)}${input.head.changed ? " with this worktree's uncommitted changes" : ""}`;
  const heading =
    input.justUpgraded === undefined
      ? ""
      : `UPGRADED  Base's home now runs ${revision}, at Base's address
Before    a copy of the home before the upgrade is kept at ${paths.upgrade.before}
Next      ${
          input.justUpgraded === "first"
            ? "reload the tab you had on Base"
            : "clear the tab's cached state (IndexedDB t3code:connection-runtime), then reload it; otherwise it keeps showing what happened after the copy was made"
        }

`;
  return `${heading}J5 Code live-test server: RUNNING
  Runs          Base's home, upgraded to ${revision}
  Pairing URL   ${input.pairingUrl ?? `none could be minted; run: ${pairCommandLine(paths.upgrade, input.ownerName ?? "<the name the owner gave>")}`}
  Web           http://localhost:${facts.webPort}
  Server port   ${facts.serverPort}
  Home          ${paths.upgrade.home}
  Log           ${paths.upgrade.log}

Head's own server and the base build stay stopped until \`rebuild\`.

Commands:
  ${selfCommand(paths, "upgrade")}   start over: put back the copy from before the upgrade, and upgrade it again
  ${selfCommand(paths, "status")}    say whether it is running
  ${selfCommand(paths, "restart")}   stop, then start the upgraded server on the same home
  ${selfCommand(paths, "stop")}      stop the server
  ${selfCommand(paths, 'guest "<name>"')}   add a second person, with their pairing URL
                                      (flags: --thread <id> or --project <id>, --level view|collaborate)
  ${selfCommand(paths, "rebuild")}   stop, delete ${paths.root} and the base checkout, build and start again
                                      (flags as for a first start)

How to test is in .agents/skills/j5-live-test/SKILL.md.
`;
}

/** The ports the first `upgrade` recorded, or undefined before one. */
function upgradeOf(paths: LiveTestPaths): UpgradePorts | undefined {
  if (!NodeFS.existsSync(paths.manifest)) return undefined;
  const manifest = readManifest(paths);
  return "upgrade" in manifest ? manifest.upgrade : undefined;
}

function headRevision(paths: LiveTestPaths): {
  readonly commit: string;
  readonly changed: boolean;
} {
  return {
    commit: gitIn(paths.worktree, "rev-parse", "HEAD") ?? "",
    changed: (gitIn(paths.worktree, "status", "--porcelain") ?? "") !== "",
  };
}

/** Starts this worktree's build on the base's home, at the base's address, or joins it. */
async function startUpgraded(
  paths: LiveTestPaths,
  ports: UpgradePorts,
  deadline: number,
  justUpgraded: "first" | "again" | undefined,
): Promise<void> {
  if (currentServerState(paths.upgrade).kind === "stopped") {
    for (const port of [ports.serverPort, ports.webPort]) {
      const listener = listenerOn(port);
      if (listener !== undefined) {
        throw new LiveTestRefusal(
          `Port ${port}, part of the base's address, is in use by process ${listener}. Nothing was started.`,
        );
      }
    }
  }
  console.log("Starting this worktree's build on the base's home...");
  const runner = upgradeRunner(ports);
  const facts = await startServer(paths.upgrade, "dev", runner.environment, deadline, runner.args);
  console.log(
    formatUpgrade({
      paths,
      facts,
      pairingUrl: upgradedPairingUrl(paths, facts),
      ownerName: upgradedOwner(paths),
      head: headRevision(paths),
      justUpgraded,
    }),
  );
}

/**
 * Turns provider update checks off in a home's settings, as the head's generator
 * builds its own home: a provider found behind its latest release raises a
 * toast over the top-right controls tests click. A base whose generator
 * predates that leaves them on.
 */
function withoutProviderUpdateChecks(home: string): void {
  const file = NodePath.join(home, "userdata", "settings.json");
  const settings = NodeFS.existsSync(file)
    ? (JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  NodeFS.writeFileSync(
    file,
    `${JSON.stringify({ ...settings, enableProviderUpdateChecks: false }, null, 2)}\n`,
  );
}

/**
 * Stops every server, then starts this worktree's build on the base's home at
 * the base's address. The first run keeps a copy of that home; every later
 * run puts the copy back first, so each one upgrades the same old state.
 */
async function upgrade(paths: LiveTestPaths): Promise<void> {
  const built = builtMode(paths);
  const baseRef = builtBaseRef(paths);
  const recorded = upgradeOf(paths);
  const ports = upgradeTarget({
    built,
    recorded,
    baseFacts: readServerLog(
      NodeFS.existsSync(paths.upgrade.baseLog)
        ? NodeFS.readFileSync(paths.upgrade.baseLog, "utf8")
        : "",
    ),
    baseHome: paths.upgrade.home,
    baseHomeExists: NodeFS.existsSync(paths.upgrade.home),
    inheritedPort: process.env.T3CODE_PORT,
    rebuildCommand: selfCommand(paths, `rebuild ${modeFlags("base", baseRef)}`),
    startCommand: selfCommand(paths, modeFlags("base", baseRef)),
  });
  await stop(paths);
  if (recorded === undefined) {
    // Every server is stopped, so a file copy of the home is a consistent one.
    NodeFS.rmSync(paths.upgrade.root, { recursive: true, force: true });
    NodeFS.mkdirSync(paths.upgrade.root);
    NodeFS.cpSync(paths.upgrade.home, paths.upgrade.before, { recursive: true });
    // Written once the copy is whole: a run cut off before this copies again.
    const manifest: Manifest = { ...(readManifest(paths) as DefaultManifest), upgrade: ports };
    NodeFS.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    if (!NodeFS.existsSync(paths.upgrade.before)) {
      throw new LiveTestRefusal(
        `The copy from before the upgrade is missing at ${paths.upgrade.before}. Start over with: ${selfCommand(paths, `rebuild ${modeFlags("base", baseRef)}`)}`,
      );
    }
    NodeFS.rmSync(paths.upgrade.home, { recursive: true, force: true });
    NodeFS.cpSync(paths.upgrade.before, paths.upgrade.home, { recursive: true });
  }
  withoutProviderUpdateChecks(paths.upgrade.home);
  await startUpgraded(
    paths,
    ports,
    Date.now() + START_BUDGET_MS,
    recorded === undefined ? "first" : "again",
  );
}

/** The servers a build has: one, Local and Remote in the peer modes, or Head and the upgraded base. */
const serversOf = (
  paths: LiveTestPaths,
): ReadonlyArray<{ readonly name: string; readonly paths: ServerPaths }> =>
  isPeerMode(builtMode(paths) ?? "default")
    ? [
        { name: " Local", paths },
        { name: " Remote", paths: paths.remote },
      ]
    : upgradeOf(paths) !== undefined
      ? [
          { name: " Head", paths },
          { name: " (upgraded Base)", paths: paths.upgrade },
        ]
      : [{ name: "", paths }];

async function stop(paths: LiveTestPaths, replacing = false): Promise<void> {
  // Classify every server before signalling any, so a refusal leaves both alone.
  const servers = serversOf(paths).map((server) => ({
    ...server,
    state: currentServerState(server.paths),
  }));
  const removeTailnetMapping = () => {
    if (builtMode(paths) !== "for-dev") return;
    removeOwnTailnetMapping(
      readServerLog(NodeFS.existsSync(paths.log) ? NodeFS.readFileSync(paths.log, "utf8") : ""),
    );
  };
  for (const { state } of servers) {
    if (state.kind === "unverified") {
      // A runner killed outright leaves a group this script will not signal.
      // Its tailnet mapping can still go: that signals nothing, and is limited
      // to a mapping this run made.
      removeTailnetMapping();
      throw new LiveTestRefusal(state.reason);
    }
  }
  for (const { name, paths: server, state } of servers) {
    if (state.kind === "stopped" || state.kind === "unverified") {
      NodeFS.rmSync(server.record, { force: true });
      console.log(`J5 Code live-test server${name}: STOPPED (it was not running)`);
      continue;
    }
    await stopGroup(state.group);
    NodeFS.rmSync(server.record, { force: true });
    console.log(`J5 Code live-test server${name}: STOPPED`);
  }
  if (NodeFS.existsSync(NodePath.join(paths.base, LIVE_TEST_SCRIPT))) {
    const stopped = baseScriptNow(paths, ["stop"], BASE_STATUS_TIMEOUT_MS + STOP_TIMEOUT_MS);
    console.log(`Base: ${stopped.stdout.trim()}`);
    if (stopped.status !== 0) {
      throw new LiveTestRefusal("The base server could not be stopped; see the line above.");
    }
    // Checked on every command. Here it comes after the stop, so a moved
    // checkout is reported without leaving its server running. A rebuild is
    // about to replace the build, which is the way out of a moved checkout.
    const commit = (readManifest(paths) as DefaultManifest).baseCommit;
    if (!replacing && builtMode(paths) === "base" && commit !== undefined) {
      assertBaseCheckout(paths, commit);
    }
  }
  removeTailnetMapping();
}

function status(paths: LiveTestPaths): void {
  if (upgradeOf(paths) !== undefined) return statusOfUpgrade(paths);
  statusOfHead(paths);
  if (builtMode(paths) !== "base") return;
  const { progress, serverStatus, failure } = readBaseProgress(paths);
  console.log(`\n${formatBaseProgress(paths, progress)}`);
  if (failure !== undefined) {
    throw new LiveTestRefusal(
      `The ${failure.step} step failed:\n${failure.said}\nWhen that is fixed, run: ${selfCommand(paths, modeFlags("base", builtBaseRef(paths)))}`,
    );
  }
  if (progress.checkout === "failed") {
    // Says which commit it is at and that it was not changed.
    assertBaseCheckout(paths, (readManifest(paths) as DefaultManifest).baseCommit ?? "");
  }
  if (progress.server !== "done") {
    const next = `Nothing is running in the background.\nContinue with: ${selfCommand(paths, modeFlags("base", builtBaseRef(paths)))}`;
    // With the head stopped too, this is simply a stopped build, not a fault.
    if (currentServerState(paths).kind === "stopped") return console.log(next);
    throw new LiveTestRefusal(`The base is not ready. ${next}`);
  }
  console.log(`\n${baseHeading(paths)}\n\n${serverStatus}\n${baseCheckoutNote(paths)}`);
}

function statusOfUpgrade(paths: LiveTestPaths): void {
  const state = currentServerState(paths.upgrade);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  if (state.kind === "running") {
    return console.log(
      formatUpgrade({
        paths,
        facts: state.facts,
        pairingUrl: upgradedPairingUrl(paths, state.facts),
        ownerName: upgradedOwner(paths),
        head: headRevision(paths),
        justUpgraded: undefined,
      }),
    );
  }
  if (state.kind === "notServing") {
    return console.log(notServingMessage(paths.upgrade, " (upgraded Base)", state.reason));
  }
  console.log(`J5 Code live-test server (upgraded Base): STOPPED

Base's home was upgraded to this worktree's build; Head's own server and the base build stay stopped.
Start the upgraded server again with: ${selfCommand(paths, "restart")}
Or start over from the copy made before the upgrade: ${selfCommand(paths, "upgrade")}`);
}

function statusOfHead(paths: LiveTestPaths): void {
  const servers = serversOf(paths).map((server) => ({
    ...server,
    state: currentServerState(server.paths),
  }));
  for (const { state } of servers) {
    if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  }
  const [first, second] = servers;
  if (first?.state.kind === "running" && builtMode(paths) === "for-dev") {
    return console.log(formatForDeveloper(paths, first.state.facts));
  }
  if (
    first?.state.kind === "running" &&
    (second === undefined || second.state.kind === "running")
  ) {
    return printRunning(
      paths,
      first.state.facts,
      second?.state.kind === "running" ? second.state.facts : undefined,
    );
  }
  const built = builtMode(paths);
  for (const { name, paths: server, state } of servers) {
    if (state.kind === "notServing") {
      console.log(notServingMessage(server, name, state.reason));
    } else if (servers.length > 1) {
      console.log(
        `J5 Code live-test server${name}: ${state.kind === "running" ? "RUNNING" : "STOPPED"}`,
      );
    }
  }
  if (servers.some(({ state }) => state.kind !== "stopped")) return;
  console.log(
    `${servers.length > 1 ? "" : "J5 Code live-test server: STOPPED\n"}\n${
      built === undefined
        ? "No test home is built yet."
        : `The test home is built at ${paths.root}, in ${built} mode.`
    }\nStart it with: ${selfCommand(paths, modeFlags(built ?? "default", builtBaseRef(paths)))}`,
  );
}

/** Where `guest` gives a new person their level. */
export type GuestScope =
  | { readonly kind: "server" }
  | { readonly kind: "project" | "thread"; readonly id: string };

/** What `guest` was asked for. The ids and the name go to the server as given; it checks them. */
export type GuestRequest =
  /** A device the server does not know, which names itself when it is first opened. */
  | { readonly kind: "unknown" }
  | {
      readonly kind: "person";
      readonly name: string;
      /**
       * Set only by a flag. Without either, someone already on the server gets a link for a
       * further device, and someone new is a Viewer on the test project.
       */
      readonly level?: "viewer" | "collaborator" | "owner";
      readonly scope?: GuestScope;
    };

const GUEST_USAGE = `Usage: node scripts/j5/setup-agent-live-test.ts guest "<name>" [--server | --project <id> | --thread <id>] [--level viewer|collaborator|owner]
       node scripts/j5/setup-agent-live-test.ts guest --unknown`;
const GUEST_NOT_ON_BASE =
  "`guest` adds a person to the head server only. The base server belongs to the base checkout's own script, which this command does not reach.";
/** The server's own refusal (`OwnerOutsideServerError`), given before it is asked. */
const GUEST_OWNER_AT_SERVER = "Owner is held at server scope only.";

/** The arguments after `guest`. */
export function parseGuest(args: ReadonlyArray<string>): GuestRequest {
  if (args.includes(MODE_FLAGS.base)) throw new LiveTestRefusal(GUEST_NOT_ON_BASE);
  const parsed = (() => {
    try {
      return NodeUtil.parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
          server: { type: "boolean" },
          thread: { type: "string" },
          project: { type: "string" },
          level: { type: "string" },
          unknown: { type: "boolean" },
        },
      });
    } catch {
      throw new LiveTestRefusal(GUEST_USAGE);
    }
  })();
  const { server, thread, project, level, unknown } = parsed.values;
  if (unknown === true) {
    if (
      parsed.positionals.length > 0 ||
      server !== undefined ||
      thread !== undefined ||
      project !== undefined ||
      level !== undefined
    ) {
      throw new LiveTestRefusal(GUEST_USAGE);
    }
    return { kind: "unknown" };
  }
  const [name] = parsed.positionals;
  const scopes = [server, thread, project].filter((given) => given !== undefined);
  if (
    parsed.positionals.length !== 1 ||
    name === undefined ||
    name.trim() === "" ||
    scopes.length > 1 ||
    (level !== undefined && level !== "viewer" && level !== "collaborator" && level !== "owner")
  ) {
    throw new LiveTestRefusal(GUEST_USAGE);
  }
  if (level === "owner" && server !== true) throw new LiveTestRefusal(GUEST_OWNER_AT_SERVER);
  return {
    kind: "person",
    name,
    ...(level === undefined ? {} : { level }),
    ...(server === true
      ? { scope: { kind: "server" as const } }
      : thread !== undefined
        ? { scope: { kind: "thread" as const, id: thread } }
        : project !== undefined
          ? { scope: { kind: "project" as const, id: project } }
          : {}),
  };
}

/**
 * Why `guest` will not act on this build, or undefined when it may. It needs a
 * server this script has proven to be its own, on a home that holds nothing of
 * the developer's. Whether the owner has a name yet is the server's to say.
 */
export function guestRefusal(input: {
  readonly built: LiveTestMode | undefined;
  /** Whether the server the guest goes to, Local in a peer build or the upgraded base, is running. */
  readonly serving: boolean;
  readonly startCommand: string;
}): string | undefined {
  const { built } = input;
  if (built === "for-dev") {
    return "`guest` does not run on a --for-dev server: it holds a copy of the developer's data.";
  }
  return input.serving
    ? undefined
    : `No live-test server is running here to add a guest to. Start it with: ${input.startCommand}`;
}

/** What `guest` did, for `formatGuest`. */
export type GuestOutcome =
  | {
      readonly kind: "new";
      readonly name: string;
      readonly level: string;
      readonly scope: GuestScope;
    }
  | { readonly kind: "device"; readonly name: string }
  | { readonly kind: "unknown" };

/** What `guest` prints: what it made, for whom, and the URL that pairs a browser. */
export function formatGuest(input: {
  /** Whether the build has a Remote server too. */
  readonly peer: boolean;
  readonly outcome: GuestOutcome;
  readonly pairingUrl: string;
}): string {
  const server = `the live-test server${input.peer ? " Local" : ""}`;
  const { outcome } = input;
  const body =
    outcome.kind === "new"
      ? `Added a new person to ${server}:

  Name          ${outcome.name}
  Level         ${outcome.level} on ${
    outcome.scope.kind === "server" ? "the server" : `${outcome.scope.kind} ${outcome.scope.id}`
  }
  Pairing URL   ${input.pairingUrl}`
      : outcome.kind === "device"
        ? `Made a link for a new device of someone already on ${server}:

  Name          ${outcome.name}
  Pairing URL   ${input.pairingUrl}`
        : `Made a link for a device ${server} does not know:

  Pairing URL   ${input.pairingUrl}

On first open, the device is asked who it belongs to before it can use anything.`;
  return `${body}
${input.peer ? "\nPeople are added to Local only; this command does not reach Remote.\n" : ""}
Open it in a new tab.
`;
}

/**
 * Whether `pair --person` refused because no one has the name (`PairingPersonUnknownError` in
 * `apps/server/src/j5/sharing/cliPairing.ts`), told by its tag in the CLI's log line.
 */
export const refusedAsUnknownPerson = (stdout: string) =>
  /ERROR \(#\d+\): PairingPersonUnknownError: /.test(stdout);

/** The reason the CLI gave for a refusal, which it logs on stdout with a stack. */
const cliRefusal = (run: NodeChildProcess.SpawnSyncReturns<string>) =>
  /ERROR \(#\d+\): \w+: ([\s\S]*?)\n\s+at /.exec(run.stdout ?? "")?.[1] ??
  ((run.stderr ?? "")
    .split("\n")
    .filter((line) => !/ExperimentalWarning|--trace-warnings/.test(line))
    .join("\n")
    .trim() ||
    String(run.error ?? "it gave no reason"));

/**
 * Adds a person or a device to the running server through the commands a
 * person would use (register D36): `j5 pair --person`, which makes a link for
 * someone already there or creates someone new at the level and scope given,
 * and a bare `j5 auth pairing create` for a device the server does not know. In
 * a peer build that server is Local: a browser not paired with Local is not
 * served the app, so a person on Remote could not open it.
 */
function guest(paths: LiveTestPaths, request: GuestRequest): void {
  const built = builtMode(paths);
  // After `upgrade` the server running here is this worktree's build on the base's home, whose
  // test project the base's own generator recorded.
  const upgraded = upgradeOf(paths) !== undefined;
  const server = upgraded ? paths.upgrade : paths;
  // Identity first, as for a stop: only a server proven to be this script's is acted on.
  const state = currentServerState(server);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  const refusal = guestRefusal({
    built,
    serving: state.kind === "running",
    startCommand: selfCommand(paths, modeFlags(built ?? "default", builtBaseRef(paths))),
  });
  if (refusal !== undefined) throw new LiveTestRefusal(refusal);
  // The refusal above covers this; it is here to tell the compiler so.
  if (state.kind !== "running") return;
  const run = (args: ReadonlyArray<string>) =>
    NodeChildProcess.spawnSync(process.execPath, [...args], {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      encoding: "utf8",
      timeout: GUEST_TIMEOUT_MS,
    });
  const refused = (made: NodeChildProcess.SpawnSyncReturns<string>) =>
    new LiveTestRefusal(`The server did not make the link:\n${cliRefusal(made)}`);
  const print = (outcome: GuestOutcome, pairingUrl: string) =>
    console.log(formatGuest({ peer: isPeerMode(built ?? "default"), outcome, pairingUrl }));

  if (request.kind === "unknown") {
    const made = run([
      NodePath.join(paths.worktree, "apps/server/src/bin.ts"),
      "auth",
      "pairing",
      "create",
      "--base-dir",
      server.home,
      "--json",
      "--base-url",
      pairingBaseUrl(server),
    ]);
    const pairingUrl = /"pairUrl": "([^"]+)"/.exec(made.stdout ?? "")?.[1];
    if (made.status !== 0 || pairingUrl === undefined) throw refused(made);
    return print({ kind: "unknown" }, pairingUrl);
  }

  const pairingUrlOf = (made: NodeChildProcess.SpawnSyncReturns<string>) =>
    made.status === 0 ? /Pairing URL: (\S+)/.exec(made.stdout ?? "")?.[1] : undefined;
  // With no level or scope asked for, someone already here gets a link for a further device.
  if (request.level === undefined && request.scope === undefined) {
    const forExisting = run(pairArguments(server, request.name));
    const pairingUrl = pairingUrlOf(forExisting);
    if (pairingUrl !== undefined) return print({ kind: "device", name: request.name }, pairingUrl);
    if (!refusedAsUnknownPerson(forExisting.stdout ?? "")) throw refused(forExisting);
  }
  const level = request.level ?? "viewer";
  const manifest = upgraded
    ? readDefaultManifest(NodePath.dirname(paths.upgrade.home))
    : readManifest(paths);
  const scope: GuestScope | undefined =
    request.scope ??
    ("project" in manifest ? { kind: "project", id: manifest.project.id } : undefined);
  if (scope === undefined) {
    throw new LiveTestRefusal(
      "This home has no test project to add someone to. Give --server, --project <id> or --thread <id>.",
    );
  }
  const added = run([
    ...pairArguments(server, request.name),
    "--level",
    level,
    ...(scope.kind === "server" ? [] : [`--${scope.kind}`, scope.id]),
  ]);
  const pairingUrl = pairingUrlOf(added);
  if (pairingUrl === undefined) throw refused(added);
  print({ kind: "new", name: request.name, level, scope }, pairingUrl);
}

const USAGE = `Usage: node scripts/j5/setup-agent-live-test.ts [--fresh | --peer [--poll] | --for-dev | --base <ref>]
       node scripts/j5/setup-agent-live-test.ts rebuild [--fresh | --peer [--poll] | --for-dev | --base <ref>]
       node scripts/j5/setup-agent-live-test.ts status | restart | stop | upgrade
       ${GUEST_USAGE.slice("Usage: ".length)}`;

/**
 * The command and, for a start or `rebuild`, the mode its flags ask for.
 * `status`, `restart`, `stop` and `upgrade` act on whatever is built and take no flags.
 */
export function parseCommand(args: ReadonlyArray<string>): {
  readonly command: LiveTestCommand;
  readonly mode: LiveTestMode;
  readonly baseRef?: string;
} {
  // --base is the one flag with a value; take the pair out before sorting the rest.
  const baseIndex = args.indexOf(MODE_FLAGS.base);
  const baseRef = baseIndex === -1 ? undefined : args[baseIndex + 1];
  const rest = baseIndex === -1 ? args : args.toSpliced(baseIndex, 2);
  const flags = rest
    .filter((argument) => argument.startsWith("--"))
    .toSorted()
    .join(" ");
  const words = rest.filter((argument) => !argument.startsWith("--"));
  const command = words[0] ?? "start";
  const plainMode = (Object.keys(MODE_FLAGS) as ReadonlyArray<LiveTestMode>).find(
    (candidate) =>
      candidate !== "base" && MODE_FLAGS[candidate].split(" ").toSorted().join(" ") === flags,
  );
  // A base is compared with the default build, so --base goes with no other mode flag.
  const mode = baseIndex === -1 ? plainMode : plainMode === "default" ? "base" : undefined;
  if (
    words.length > 1 ||
    !COMMANDS.some((known) => known === command) ||
    mode === undefined ||
    // The ref is printed inside commands, and git allows shell characters in ref names.
    (mode === "base" && (baseRef === undefined || !/^[\w@+=:,./][\w@+=:,./^~-]*$/.test(baseRef))) ||
    (mode !== "default" && command !== "start" && command !== "rebuild")
  ) {
    throw new LiveTestRefusal(USAGE);
  }
  return {
    command: command as LiveTestCommand,
    mode,
    ...(mode === "base" && baseRef !== undefined ? { baseRef } : {}),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = args[0] === "guest" ? parseGuest(args.slice(1)) : parseCommand(args);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
  if (NodeOS.platform() !== "linux" && !IS_MACOS) {
    throw new LiveTestRefusal("This script runs only on Linux and macOS.");
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
  if (!("command" in parsed)) return guest(paths, parsed);
  const { command, mode, baseRef } = parsed;
  if (command === "status") return status(paths);
  if (command === "stop") return stop(paths);
  if (command === "upgrade") return upgrade(paths);
  if (command === "restart" || command === "rebuild") await stop(paths, command === "rebuild");
  // resolveLiveTestPaths has confirmed this directory is inside the worktree's own .j5code.
  // Refuse an unusable base before a rebuild deletes the build that is there.
  if (command === "rebuild" && baseRef !== undefined) resolveBase(paths, baseRef);
  if (command === "rebuild") {
    // A base checkout is a registered git worktree: unregister it, not just delete it.
    removeBaseCheckout(paths);
    NodeFS.rmSync(paths.root, { recursive: true, force: true });
  }
  // A restart keeps the mode that is built; only a start or rebuild chooses one.
  if (command === "restart") {
    return start(paths, builtMode(paths) ?? "default", builtBaseRef(paths));
  }
  await start(paths, mode, baseRef);
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    if (!(cause instanceof LiveTestRefusal)) throw cause;
    console.error(cause.message);
    process.exitCode = 1;
  });
}
