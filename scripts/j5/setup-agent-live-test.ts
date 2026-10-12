// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - a standalone Node CLI that manages one child process group and prints instructions.
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
 * wizard shows. `--peer` runs two servers, Local and Remote, each with its own
 * home and test project, peered so their agents can message each other;
 * `--peer --poll` has Remote poll Local instead of being reached by it.
 * `--for-dev` is different in kind: a server for the developer to use, on a
 * copy of their data, shared on the tailnet. Agents take no turns on it. A
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
} as const;
export type LiveTestMode = keyof typeof MODE_FLAGS;
const isPeerMode = (mode: LiveTestMode) => mode === "peer" || mode === "peer-poll";

/** What the generator records about a default build. Paths are never read from it: see LiveTestPaths. */
interface DefaultManifest {
  /** Absent in the generator's file; the script adds it for the peer modes. */
  readonly mode?: "default" | "peer" | "peer-poll";
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
  readonly remote: ServerPaths & { readonly root: string };
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
  /** The tailnet URL the dev runner shared the web server at, with `--share`. */
  readonly sharedUrl: string | undefined;
  /** Why sharing failed. The dev runner only warns and carries on unshared. */
  readonly shareFailure: string | undefined;
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
    sharedUrl: /\[dev-runner\] shared on tailnet: (\S+)/.exec(text)?.[1],
    shareFailure: /\[dev-runner\] could not share on the tailnet: (.*)/.exec(text)?.[1],
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
    cwdOf: (pid) => {
      try {
        return NodeFS.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return undefined;
      }
    },
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
    /** Opened in a browser paired with Local, it adds Remote there. Works once. */
    readonly addToBrowserUrl: string | undefined;
    /** Whether each server's own peer list names the other. */
    readonly peered: boolean;
  };
}): string {
  const { paths, manifest, facts, remote } = input;
  const pairCommand = `node ${pairArguments(paths).join(" ")}`;
  return `J5 Code live-test server${remote === undefined ? "" : "s"}: RUNNING
${remote === undefined ? "" : "\nLocal, where the browser pairs:"}
  Pairing URL   ${input.pairingUrl ?? `none could be minted; run: ${pairCommand}`}
  Web           http://localhost:${facts.webPort}
  Server port   ${facts.serverPort}
  Home          ${paths.home}
  Log           ${paths.log}
${
  remote === undefined
    ? ""
    : `
Remote, which has no web server of its own:
  Server port   ${remote.facts.serverPort}
  Home          ${paths.remote.home}
  Log           ${paths.remote.log}
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
The pairing URL works once. \`status\` prints a fresh one, and so does:
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
Playbooks: ${manifest.playbooks.join(", ")}

Hold a turn open by asking the agent to run: ${manifest.holdScript}
Release it with: touch ${NodePath.join(paths.testRepo, HOLD_RELEASE_FILE)}`
}

Commands:
  ${selfCommand(paths, "status")}    say whether it is running
  ${selfCommand(paths, "restart")}   stop, then start on the same home
  ${selfCommand(paths, "stop")}      stop the server
  ${selfCommand(paths, "rebuild")}   stop, delete ${paths.root}, build and start again
                                      (flags: none for the test project, --fresh for an empty home,
                                      --peer or --peer --poll for two peered servers,
                                      --for-dev for a server the developer uses)

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
const pairArguments = (paths: ServerPaths): ReadonlyArray<string> => [
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
function mintPairingUrl(paths: ServerPaths): string | undefined {
  const pair = NodeChildProcess.spawnSync(process.execPath, [...pairArguments(paths)], {
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
  console.log(
    formatInstructions({
      paths,
      manifest: readManifest(paths),
      facts,
      pairingUrl: mintPairingUrl(paths),
      ...(remoteFacts === undefined
        ? {}
        : {
            remote: {
              facts: remoteFacts,
              peered: justPeered || arePeered(paths, facts.serverPort, remoteFacts.serverPort),
              addToBrowserUrl: addRemoteUrl({
                localWebPort: facts.webPort,
                remoteServerPort: remoteFacts.serverPort,
                remotePairingUrl: mintPairingUrl(paths.remote),
              }),
            },
          }),
    }),
  );
}

function readManifest(paths: LiveTestPaths): Manifest {
  return JSON.parse(NodeFS.readFileSync(paths.manifest, "utf8")) as Manifest;
}

function logTail(paths: ServerPaths): string {
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
  const generate = (root: string) => {
    const build = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(paths.worktree, "apps/server/src/j5/test-support/liveTestHome.ts"),
        "--root",
        root,
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
    return generate(paths.root);
  }
  console.log("Building two test repositories and homes (about a minute, no model calls)...");
  // Remote first: Local's manifest is the mark of a finished build, so it comes last.
  generate(paths.remote.root);
  generate(paths.root);
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

async function start(paths: LiveTestPaths, mode: LiveTestMode): Promise<void> {
  const deadline = Date.now() + START_BUDGET_MS;
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
  if (built === undefined && currentServerState(paths).kind === "stopped") buildHome(paths, mode);

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

/** The servers a build has: one, or Local and Remote in the peer modes. */
const serversOf = (
  paths: LiveTestPaths,
): ReadonlyArray<{ readonly name: string; readonly paths: ServerPaths }> =>
  isPeerMode(builtMode(paths) ?? "default")
    ? [
        { name: " Local", paths },
        { name: " Remote", paths: paths.remote },
      ]
    : [{ name: "", paths }];

async function stop(paths: LiveTestPaths): Promise<void> {
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
  removeTailnetMapping();
}

function status(paths: LiveTestPaths): void {
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
    }\nStart it with: ${selfCommand(paths, MODE_FLAGS[built ?? "default"])}`,
  );
}

const USAGE = `Usage: node scripts/j5/setup-agent-live-test.ts [--fresh | --peer [--poll] | --for-dev]
       node scripts/j5/setup-agent-live-test.ts rebuild [--fresh | --peer [--poll] | --for-dev]
       node scripts/j5/setup-agent-live-test.ts status | restart | stop`;

/**
 * The command and, for a start or `rebuild`, the mode its flags ask for.
 * `status`, `restart` and `stop` act on whatever is built and take no flags.
 */
export function parseCommand(args: ReadonlyArray<string>): {
  readonly command: LiveTestCommand;
  readonly mode: LiveTestMode;
} {
  const flags = args
    .filter((argument) => argument.startsWith("--"))
    .toSorted()
    .join(" ");
  const words = args.filter((argument) => !argument.startsWith("--"));
  const command = words[0] ?? "start";
  const mode = (Object.keys(MODE_FLAGS) as ReadonlyArray<LiveTestMode>).find(
    (candidate) => MODE_FLAGS[candidate].split(" ").toSorted().join(" ") === flags,
  );
  if (
    words.length > 1 ||
    !COMMANDS.some((known) => known === command) ||
    mode === undefined ||
    (mode !== "default" && command !== "start" && command !== "rebuild")
  ) {
    throw new LiveTestRefusal(USAGE);
  }
  return { command: command as LiveTestCommand, mode };
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
