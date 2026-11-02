// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - part of the standalone live-test CLI.
/**
 * `setup-agent-live-test.ts --mobile ios|android|phone`: the test server, Metro on this worktree's
 * own port, one device claimed from a pool (and a tunnel to an iOS host over SSH), as this
 * machine's settings say (live-test-mobile-config.ts). `mobile-open` installs and pairs the app.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { J5_BRANDING, mobileNativeProjectName } from "../lib/j5-branding.ts";
import { expandHome, mobileRigConfig, type IosHost } from "./live-test-mobile-config.ts";
import {
  LiveTestRefusal,
  cwdOf,
  currentServerState,
  listenerOn,
  liveTestEnvironment,
  mintPairingUrl,
  processGroupOf,
  readManifest,
  readServerLog,
  selfCommand,
  type ServerLogFacts,
  startServer,
  startTimeOf,
  stopGroup,
  type LiveTestPaths,
} from "./setup-agent-live-test.ts";

export const MOBILE_PLATFORMS = ["ios", "android"] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];
/** A device the rig provides, or the developer's own phone, which reaches this machine over the network. */
export type MobileTarget = MobilePlatform | "phone";

/** One AVD per slot, made and deleted by the rig: two emulators cannot share an AVD while the Device panel opens it read-write. */
export const androidSlots = (count: number) =>
  Array.from({ length: count }, (_, index) => `j5-tester-${index + 1}`);
const ANDROID_DEVICE_PROFILE = "pixel_8";
/** How each device reaches this machine's loopback: through the tunnel on iOS, the emulator's alias on Android. */
const DEVICE_LOOPBACK: Record<MobilePlatform, string> = { ios: "127.0.0.1", android: "10.0.2.2" };
const BUNDLE_TIMEOUT_MS = 120_000;
const TUNNEL_TIMEOUT_MS = 20_000;
const EMULATOR_EXIT_TIMEOUT_MS = 30_000;
const PAIR_TIMEOUT_MS = 60_000;
/** Long enough for the app to finish adding the environment, so a link it is using is not sent twice. */
const PAIR_REOPEN_MS = 10_000;

/** A process this script spawned detached, so its pid is also its group. */
interface ProcessRecord {
  readonly pid: number;
  readonly startTime: string;
}

/** What `mobile.json` in the live-test root says. Written as soon as a slot is claimed, so `stop` can release it. */
export interface MobileRecord {
  readonly platform: MobileTarget;
  /** Phone only: the address the phone reaches the backend and Metro by. */
  readonly host?: string;
  /** The Simulator's or the AVD's name. */
  readonly slot: string;
  /** iOS only: the claimed Simulator, and the host it is on, kept so `stop` acts on that host whatever the settings say later. */
  readonly udid?: string;
  readonly iosHost?: IosHost;
  readonly serverPort: number;
  readonly metroPort: number;
  readonly metro?: ProcessRecord;
  readonly tunnel?: ProcessRecord;
  /** Android only: the emulator this script booted, and its console port (serial `emulator-<port>`). */
  readonly emulator?: ProcessRecord & { readonly port: number };
  /** Set by a fresh claim until the first boot closes the sessions a gone holder left on the device. */
  readonly sessionCleanupPending?: true;
}

const mobileFiles = (paths: Pick<LiveTestPaths, "root">) => ({
  record: NodePath.join(paths.root, "mobile.json"),
  metroLog: NodePath.join(paths.root, "metro.log"),
  tunnelLog: NodePath.join(paths.root, "tunnel.log"),
  emulatorLog: NodePath.join(paths.root, "emulator.log"),
});

export function readMobileRecord(paths: Pick<LiveTestPaths, "root">): MobileRecord | undefined {
  const file = mobileFiles(paths).record;
  return NodeFS.existsSync(file)
    ? (JSON.parse(NodeFS.readFileSync(file, "utf8")) as MobileRecord)
    : undefined;
}

function writeMobileRecord(paths: Pick<LiveTestPaths, "root">, record: MobileRecord): void {
  NodeFS.mkdirSync(paths.root, { recursive: true });
  NodeFS.writeFileSync(mobileFiles(paths).record, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The backend and Metro ports for `worktree`: a pair inside `range`, starting from a point
 * the worktree path picks so that each worktree keeps its own pair across restarts.
 */
export function chooseMobilePorts(input: {
  readonly worktree: string;
  readonly range: { readonly first: number; readonly last: number };
  /** Ports already taken by this server, such as the dev runner's web port. */
  readonly avoid: ReadonlyArray<number>;
  readonly isFree: (port: number) => boolean;
}): { readonly serverPort: number; readonly metroPort: number } {
  const pairs = Math.floor((input.range.last - input.range.first + 1) / 2);
  const start =
    NodeCrypto.createHash("sha256").update(input.worktree).digest().readUInt32BE(0) % pairs;
  for (let step = 0; step < pairs; step += 1) {
    const serverPort = input.range.first + 2 * ((start + step) % pairs);
    const metroPort = serverPort + 1;
    const usable = (port: number) => !input.avoid.includes(port) && input.isFree(port);
    if (usable(serverPort) && usable(metroPort)) return { serverPort, metroPort };
  }
  throw new LiveTestRefusal(
    `No free pair of ports is left in ${input.range.first}-${input.range.last}.`,
  );
}

/** The address a device reaches this machine by. */
const deviceHost = (record: MobileRecord) =>
  record.platform === "phone" ? record.host! : DEVICE_LOOPBACK[record.platform];

/** Where claims live: shared by every worktree on this machine, so it is outside all of them. */
export const claimsDirectory = (home: string) =>
  NodePath.join(home, ".cache", "j5-mobile-rig", "claims");

const ownerOf = (claim: string): string | undefined => {
  try {
    return NodeFS.readFileSync(NodePath.join(claim, "owner"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Claims the first free slot for `worktree`, or the one it already holds. A claim is a directory
 * made with one atomic `mkdir`, holding the owner's worktree path. A full pool is refused, never queued.
 */
export function claimSlot(input: {
  readonly directory: string;
  readonly platform: MobilePlatform;
  /** The machine the devices are on, for iOS: names repeat across hosts. */
  readonly host?: string;
  readonly slots: ReadonlyArray<string>;
  readonly worktree: string;
}): string {
  NodeFS.mkdirSync(input.directory, { recursive: true });
  const claimOf = (slot: string) => NodePath.join(input.directory, claimName(input, slot));
  const held = input.slots.find((slot) => ownerOf(claimOf(slot)) === input.worktree);
  if (held !== undefined) return held;
  for (const slot of input.slots) {
    try {
      NodeFS.mkdirSync(claimOf(slot));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw cause;
    }
    NodeFS.writeFileSync(NodePath.join(claimOf(slot), "owner"), `${input.worktree}\n`);
    return slot;
  }
  const holders = input.slots.map((slot) => {
    const owner = ownerOf(claimOf(slot));
    const gone = owner !== undefined && !NodeFS.existsSync(owner);
    return `  ${slot}: ${owner ?? "being claimed"}${gone ? ` (that worktree is gone: rm -r ${claimOf(slot)})` : ""}`;
  });
  throw new LiveTestRefusal(
    `All ${input.slots.length} ${input.platform === "ios" ? "iOS" : "Android"} test devices are in use:\n${holders.join("\n")}\nTry again when one is free; each holder releases its device with \`stop\`.`,
  );
}

/** A claim's directory name: platform, host for iOS, and device. */
const claimName = (
  input: { readonly platform: MobilePlatform; readonly host?: string },
  slot: string,
) =>
  [input.platform, ...(input.host === undefined ? [] : [input.host]), slot]
    // Hosts and Simulator names come from the settings: one path segment, whatever they hold.
    .map((part) => part.replaceAll(/[^\w.-]/g, "_"))
    .join("-");

/** Releases a claim this worktree holds. Someone else's claim is left alone. */
export function releaseSlot(input: {
  readonly directory: string;
  readonly platform: MobilePlatform;
  readonly host?: string;
  readonly slot: string;
  readonly worktree: string;
}): void {
  const claim = NodePath.join(input.directory, claimName(input, input.slot));
  if (ownerOf(claim) === input.worktree) NodeFS.rmSync(claim, { recursive: true, force: true });
}

export interface Simulator {
  readonly name: string;
  readonly udid: string;
  readonly booted: boolean;
}

/** Every available Simulator in `xcrun simctl list devices --json` output. */
export function simulatorsFromSimctl(json: string): ReadonlyArray<Simulator> {
  const { devices } = JSON.parse(json) as {
    readonly devices: Record<
      string,
      ReadonlyArray<{ name: string; udid: string; state: string; isAvailable?: boolean }>
    >;
  };
  return Object.values(devices)
    .flat()
    .filter((device) => device.isAvailable !== false)
    .map((device) => ({ name: device.name, udid: device.udid, booted: device.state === "Booted" }));
}

/** The test pool, in name order: the Simulators the settings name, or those with their prefix. */
export const iosPool = (
  simulators: ReadonlyArray<Simulator>,
  spec: { readonly names: ReadonlyArray<string> } | { readonly prefix: string },
) =>
  simulators
    .filter((simulator) =>
      "names" in spec
        ? spec.names.includes(simulator.name)
        : simulator.name.startsWith(spec.prefix),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

/**
 * The Simulators besides `mine` that count against the iOS host's limit: every other pool
 * Simulator another worktree has claimed, booted or not yet, and any booted one outside the pool.
 */
export function iosBusy(input: {
  readonly simulators: ReadonlyArray<Simulator>;
  readonly pool: ReadonlyArray<Simulator>;
  readonly mine: string;
  readonly claimed: (name: string) => boolean;
}): ReadonlyArray<string> {
  const pool = new Set(input.pool.map((simulator) => simulator.udid));
  return input.simulators
    .filter(
      (simulator) =>
        simulator.udid !== input.mine &&
        (pool.has(simulator.udid)
          ? simulator.booted || input.claimed(simulator.name)
          : simulator.booted),
    )
    .map((simulator) => simulator.name);
}

/** A string as one word for a POSIX shell: the remote login shell over SSH, or `adb shell`. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The URL that opens the dev client against Metro without the launcher's onboarding and overlays. */
export function devClientUrl(host: string, metroPort: number): string {
  const query = new URLSearchParams({
    url: `http://${host}:${metroPort}`,
    disableOnboarding: "1",
    disableAutoLaunch: "1",
    disableFab: "1",
  });
  return `${J5_BRANDING.mobile.development.scheme}://expo-development-client/?${query}`;
}

/**
 * The app's Add Environment route for a pairing link from `pair`. The token is moved onto the
 * backend origin the device reaches, as `buildPairingUrl` in apps/server/src/startupAccess.ts does.
 */
export function pairingDeepLink(input: {
  readonly host: string;
  readonly serverPort: number;
  readonly pairingUrl: string;
}): string {
  const token = new URLSearchParams(new URL(input.pairingUrl).hash.slice(1)).get("token");
  if (token === null) throw new LiveTestRefusal(`No token in the pairing URL ${input.pairingUrl}.`);
  const pairing = new URL(`http://${input.host}:${input.serverPort}/pair`);
  pairing.hash = new URLSearchParams([["token", token]]).toString();
  const query = new URLSearchParams({ pairingUrl: pairing.toString(), autoConnect: "1" });
  return `${J5_BRANDING.mobile.development.scheme}://connections/new?${query}`;
}

/** How many bundles Metro's log says it has served or failed, as `iOS Bundled 812ms ...`. */
export function metroBundles(log: string): { readonly served: number; readonly failed: number } {
  const plain = log.replaceAll(/\u001B\[[0-9;]*m/g, "");
  return {
    served: [...plain.matchAll(/\b(iOS|Android) Bundled\b/g)].length,
    failed: [...plain.matchAll(/\b(iOS|Android) Bundling failed\b/g)].length,
  };
}

/**
 * `expo/fingerprint` exactly as scripts/mobile-native-client.ts runs it, so the rig finds the
 * client that `mobile:install` caches. A test keeps the two in step.
 */
export const FINGERPRINT_EVAL = `const f = require('expo/fingerprint'); f.createFingerprintAsync(process.cwd(), { platforms: [process.argv[1]], silent: true, ignorePaths: ['android/**', 'ios/**'], sourceSkips: f.DEFAULT_SOURCE_SKIPS | f.SourceSkips.ExpoConfigExtraSection }).then(fp => console.log('T3_NATIVE_FINGERPRINT=' + fp.hash)).catch(e => { console.error(e); process.exitCode = 1; });`;
export const FINGERPRINT_ENV = {
  APP_VARIANT: "development",
  MOBILE_VERSION_POLICY: "appVersion",
  T3CODE_IOS_PERSONAL_TEAM: "0",
  CI: "1",
  EXPO_NO_GIT_STATUS: "1",
  COPYFILE_DISABLE: "1",
} as const;

/** Where `mobile:install` caches the client for a fingerprint, relative to the home directory. */
export const cachedClientPath = (platform: MobilePlatform, fingerprint: string) =>
  platform === "ios"
    ? `.cache/t3code/native-clients/artifacts/ios/development/${fingerprint}/${mobileNativeProjectName(J5_BRANDING.mobile.development.appName)}.app`
    : `.cache/t3code/native-clients/artifacts/android/development-${androidAbi()}/${fingerprint}/app-debug.apk`;

/** The emulator ABI this machine runs natively, as Android and `mobile:install --abi` name it. */
// oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
export function androidAbi(arch: string = process.arch): "x86_64" | "arm64-v8a" {
  if (arch === "x64") return "x86_64";
  if (arch === "arm64") return "arm64-v8a";
  throw new LiveTestRefusal(
    `The Android emulator needs an x86_64 or arm64 machine; this one is ${arch}.`,
  );
}

export function nativeFingerprint(paths: LiveTestPaths, platform: MobilePlatform): string {
  const run = NodeChildProcess.spawnSync(process.execPath, ["--eval", FINGERPRINT_EVAL, platform], {
    cwd: NodePath.join(paths.worktree, "apps/mobile"),
    env: { ...process.env, ...FINGERPRINT_ENV },
    encoding: "utf8",
    timeout: 120_000,
  });
  const hash = /T3_NATIVE_FINGERPRINT=([a-f0-9]{40,64})/.exec(run.stdout ?? "")?.[1];
  if (hash === undefined) {
    throw new LiveTestRefusal(`Expo did not return a native fingerprint:\n${run.stderr}`);
  }
  return hash;
}

/** Labels of the pairing links the test server has issued and nobody has used yet. */
function activePairingLabels(paths: LiveTestPaths): ReadonlyArray<string> {
  const list = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(paths.worktree, "apps/server/src/bin.ts"),
      "auth",
      "pairing",
      "list",
      "--base-dir",
      paths.home,
      "--json",
    ],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (list.status !== 0) throw new LiveTestRefusal(`Listing pairing links failed:\n${list.stderr}`);
  return (JSON.parse(list.stdout) as ReadonlyArray<{ readonly label?: string }>).flatMap((link) =>
    link.label === undefined ? [] : [link.label],
  );
}

export const describeIosHost = (host: IosHost) =>
  host.kind === "local" ? "this Mac" : `the iOS host (ssh ${host.ssh})`;

/** A shell command on the iOS host: here, or over SSH. */
export function runOnIosHost(host: IosHost, command: string, timeoutMs = 60_000) {
  return host.kind === "local"
    ? NodeChildProcess.spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: timeoutMs })
    : NodeChildProcess.spawnSync(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.ssh, command],
        { encoding: "utf8", timeout: timeoutMs },
      );
}

/** Whether a command on the iOS host succeeds. */
export const iosHostSucceeds = (host: IosHost, command: string) =>
  runOnIosHost(host, command, 30_000).status === 0;

/** A command on the iOS host. Its stdout, or a refusal naming what failed. */
function onIosHost(host: IosHost, command: string, timeoutMs = 60_000): string {
  const run = runOnIosHost(host, command, timeoutMs);
  if (run.status !== 0) {
    throw new LiveTestRefusal(
      `On ${describeIosHost(host)}, \`${command}\` failed: ${(run.stderr || String(run.error ?? "")).trim() || `exit ${run.status}`}`,
    );
  }
  return run.stdout;
}

/** The configured iOS host, checked to answer, or a refusal saying what to set. */
export function reachableIosHost(): IosHost {
  const config = mobileRigConfig();
  const host = config.ios.host;
  if (host === undefined) {
    throw new LiveTestRefusal(
      `No iOS host is set up: iOS Simulators need macOS. Set ios.host.ssh in ${config.path} to use a Mac over SSH.`,
    );
  }
  const probe = runOnIosHost(host, "xcrun simctl help", 15_000);
  if (probe.status !== 0) {
    const said = (probe.stderr || String(probe.error ?? "")).trim() || `exit ${probe.status}`;
    throw new LiveTestRefusal(
      host.kind === "local"
        ? `iOS Simulators need Xcode on this Mac: \`xcrun simctl\` said: ${said}`
        : `iOS host offline; Android is available (--mobile android).\n\`ssh ${host.ssh}\` said: ${said}`,
    );
  }
  return host;
}

const iosSimulators = (host: IosHost) =>
  simulatorsFromSimctl(onIosHost(host, "xcrun simctl list devices --json"));

/** The Android SDK's tools, or a refusal naming what is missing. */
export function androidSdk() {
  const home = NodeOS.homedir();
  const config = mobileRigConfig();
  const configured =
    config.android.sdk === undefined ? undefined : expandHome(config.android.sdk, home);
  const root = [
    configured,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    NodePath.join(home, "Android", "Sdk"),
    NodePath.join(home, "Android", "sdk"),
    NodePath.join(home, "Library", "Android", "sdk"),
  ].find((candidate) => candidate && NodeFS.existsSync(NodePath.join(candidate, "platform-tools")));
  if (root === undefined) {
    throw new LiveTestRefusal(
      configured === undefined
        ? `No Android SDK found: set ANDROID_HOME, or android.sdk in ${config.path}.`
        : `${config.path} names the Android SDK ${configured}, which has no platform-tools.`,
    );
  }
  const tools = {
    root,
    adb: NodePath.join(root, "platform-tools", "adb"),
    avdmanager: NodePath.join(root, "cmdline-tools", "latest", "bin", "avdmanager"),
    emulator: NodePath.join(root, "emulator", "emulator"),
  };
  for (const tool of [tools.adb, tools.avdmanager, tools.emulator]) {
    if (!NodeFS.existsSync(tool)) throw new LiveTestRefusal(`The Android SDK has no ${tool}.`);
  }
  return tools;
}

/** The newest system image installed for this machine's ABI, as avdmanager names a package. */
function androidSystemImage(root: string): string {
  const abi = androidAbi();
  const images = NodePath.join(root, "system-images");
  for (const api of NodeFS.existsSync(images)
    ? NodeFS.readdirSync(images).toSorted().toReversed()
    : []) {
    for (const tag of NodeFS.readdirSync(NodePath.join(images, api))) {
      if (NodeFS.existsSync(NodePath.join(images, api, tag, abi))) {
        return `system-images;${api};${tag};${abi}`;
      }
    }
  }
  throw new LiveTestRefusal(`No ${abi} system image is installed under ${images}.`);
}

/** On Linux the emulator needs KVM; macOS uses its own hypervisor. */
function assertKvm(): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
  if (process.platform !== "linux") return;
  try {
    NodeFS.accessSync("/dev/kvm", NodeFS.constants.R_OK | NodeFS.constants.W_OK);
  } catch {
    throw new LiveTestRefusal(
      "This user cannot use /dev/kvm, so the Android emulator cannot run. Ask the developer to add it to the kvm group.",
    );
  }
}

const runAsync = (command: string, args: ReadonlyArray<string>, input?: string) =>
  new Promise<{ readonly status: number | null; readonly output: string }>((resolve) => {
    const child = NodeChildProcess.spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (cause) => resolve({ status: null, output: String(cause) }));
    child.on("exit", (status) => resolve({ status, output }));
    child.stdin.end(input ?? "");
  });

async function createAvd(slot: string): Promise<void> {
  const sdk = androidSdk();
  const created = await runAsync(
    sdk.avdmanager,
    [
      "create",
      "avd",
      "--force",
      "-n",
      slot,
      "-k",
      androidSystemImage(sdk.root),
      "-d",
      ANDROID_DEVICE_PROFILE,
    ],
    "no\n",
  );
  if (created.status !== 0) {
    throw new LiveTestRefusal(`Creating the AVD ${slot} failed:\n${created.output.trim()}`);
  }
}

function avdExists(slot: string): boolean {
  const avdHome =
    process.env.ANDROID_AVD_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".android", "avd");
  return NodeFS.existsSync(NodePath.join(avdHome, `${slot}.ini`));
}

/** Emulator serials in `adb devices` output, including ones still booting or gone offline. */
export const emulatorSerials = (devices: string) =>
  devices.match(/^emulator-\d+(?=\s+(device|offline)\b)/gm) ?? [];

/**
 * The pid of whatever runs `avd`, from the lock file the emulator holds while it runs, even
 * one adb cannot see: a lock left by a killed emulator names a pid that is gone.
 */
function avdRunner(avd: string): number | undefined {
  const avdHome =
    process.env.ANDROID_AVD_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".android", "avd");
  try {
    // The emulator writes its pid with a trailing byte that is not whitespace.
    const pid = Number(
      /\d+/.exec(
        NodeFS.readFileSync(NodePath.join(avdHome, `${avd}.avd`, "hardware-qemu.ini.lock"), "utf8"),
      )?.[0],
    );
    return Number.isInteger(pid) && startTimeOf(pid) !== undefined ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The serial of the running emulator whose AVD is `avd`, if any. */
function emulatorSerial(avd: string): string | undefined {
  const { adb } = androidSdk();
  const devices = NodeChildProcess.spawnSync(adb, ["devices"], { encoding: "utf8" }).stdout ?? "";
  return serialRunningAvd(
    avd,
    devices,
    (serial) =>
      NodeChildProcess.spawnSync(adb, ["-s", serial, "emu", "avd", "name"], {
        encoding: "utf8",
        timeout: 10_000,
      }).stdout,
  );
}

/** The emulator serial whose AVD is `avd`; a serial names a port, not an emulator. */
export function serialRunningAvd(
  avd: string,
  devices: string,
  avdNameOf: (serial: string) => string | undefined,
): string | undefined {
  return emulatorSerials(devices).find(
    (serial) => avdNameOf(serial)?.split(/\r?\n/)[0]?.trim() === avd,
  );
}

/** Whether anything listens on `port`, even a process of another user's whose pid is hidden. */
function portInUse(port: number): boolean {
  const listing =
    // oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
    process.platform === "darwin"
      ? NodeChildProcess.spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
          encoding: "utf8",
        })
      : NodeChildProcess.spawnSync("ss", ["-H", "-ltn", `sport = :${port}`], { encoding: "utf8" });
  return (listing.stdout ?? "").trim() !== "";
}

/**
 * The console port of slot `j5-tester-<n>`'s emulator: 5554 + 2n, so it comes with the slot's
 * atomic claim and two setups can never pick the same one. Its adb port is the one above. 5554
 * stays free: the Device panel boots every AVD there.
 */
export function emulatorPortForSlot(slot: string): number {
  const number = Number(/^j5-tester-(\d+)$/.exec(slot)?.[1]);
  if (!Number.isInteger(number) || number < 1) {
    throw new LiveTestRefusal(`${slot} is not an Android slot the rig made.`);
  }
  return 5554 + 2 * number;
}

/**
 * Boots the slot's AVD here, on the slot's own console port, headless. The Device panel attaches to a
 * running emulator by its serial; asked to boot an AVD while another emulator runs, it opens
 * the running one instead.
 */
async function startEmulator(
  paths: LiveTestPaths,
  record: MobileRecord,
  deadline: number,
): Promise<void> {
  const sdk = androidSdk();
  const again = selfCommand(paths, "--mobile android");
  if (isOurs(paths, record.emulator)) {
    return bootedAsSlot(sdk.adb, record.emulator!, record.slot, deadline, again);
  }
  const port = emulatorPortForSlot(record.slot);
  for (const taken of [port, port + 1]) {
    if (!portInUse(taken)) continue;
    const holder = listenerOn(taken);
    throw new LiveTestRefusal(
      `Port ${taken}, which ${record.slot}'s emulator uses, is already taken${holder === undefined ? "" : ` by process ${holder}`}, not by this script.`,
    );
  }
  const log = mobileFiles(paths).emulatorLog;
  const emulator = {
    ...spawnRecorded(
      sdk.emulator,
      [
        "-avd",
        record.slot,
        "-port",
        String(port),
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot",
        "-gpu",
        "auto",
      ],
      {
        cwd: paths.worktree,
        env: { ...process.env, ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root },
        log,
      },
    ),
    port,
  };
  writeMobileRecord(paths, { ...readMobileRecord(paths)!, emulator });
  await bootedAsSlot(sdk.adb, emulator, record.slot, deadline, again, log);
}

/**
 * Waits for the emulator to boot, then makes sure the one behind its serial runs `slot`'s AVD:
 * the serial names a port, not an emulator.
 */
async function bootedAsSlot(
  adb: string,
  emulator: ProcessRecord & { readonly port: number },
  slot: string,
  deadline: number,
  again: string,
  log?: string,
): Promise<void> {
  await waitForBoot(adb, emulator, deadline, again, log);
  const avd = NodeChildProcess.spawnSync(
    adb,
    ["-s", `emulator-${emulator.port}`, "emu", "avd", "name"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  )
    .stdout?.split(/\r?\n/)[0]
    ?.trim();
  if (avd !== slot) {
    throw new LiveTestRefusal(
      `emulator-${emulator.port} runs the AVD ${avd ?? "(unknown)"}, not ${slot}. Do not open it; run stop, then set up again.`,
    );
  }
}

const emulatorBooted = (adb: string, port: number) =>
  NodeChildProcess.spawnSync(
    adb,
    ["-s", `emulator-${port}`, "shell", "getprop", "sys.boot_completed"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  ).stdout?.trim() === "1";

/** Waits until Android has booted: the Device panel lists an emulator only after that. */
async function waitForBoot(
  adb: string,
  emulator: ProcessRecord & { readonly port: number },
  deadline: number,
  /** The setup command that resumes the wait without touching the emulator. */
  again: string,
  log?: string,
): Promise<void> {
  const serial = `emulator-${emulator.port}`;
  for (;;) {
    if (emulatorBooted(adb, emulator.port)) return;
    if (startTimeOf(emulator.pid) !== emulator.startTime) {
      throw new LiveTestRefusal(
        `The emulator exited while booting.${log === undefined ? "" : `\n${tail(log)}`}`,
      );
    }
    if (Date.now() > deadline) {
      throw new LiveTestRefusal(
        `The emulator ${serial} is still booting; it has been left running. Do not call device_open yet: run ${again}, which waits for it and then prints the device to open. Not rebuild: that deletes the emulator.`,
      );
    }
    await NodeTimersPromises.setTimeout(1_000);
  }
}

function spawnRecorded(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly log: string },
): ProcessRecord {
  const log = NodeFS.openSync(options.log, "w");
  const child = NodeChildProcess.spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  NodeFS.closeSync(log);
  const startTime = child.pid === undefined ? undefined : startTimeOf(child.pid);
  if (child.pid === undefined || startTime === undefined) {
    throw new LiveTestRefusal(`${command} could not be spawned.`);
  }
  child.unref();
  return { pid: child.pid, startTime };
}

/** Whether a recorded process is still the one this script spawned from this worktree. */
const isOurs = (paths: LiveTestPaths, record: ProcessRecord | undefined) => {
  if (record === undefined || startTimeOf(record.pid) !== record.startTime) return false;
  const cwd = cwdOf(record.pid);
  if (cwd === undefined) return false;
  const relative = NodePath.relative(NodeFS.realpathSync(paths.worktree), cwd);
  return !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const tail = (file: string) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8").split("\n").slice(-30).join("\n")
    : "";

async function startMetro(
  paths: LiveTestPaths,
  record: MobileRecord,
  deadline: number,
): Promise<ProcessRecord> {
  const { metroLog } = mobileFiles(paths);
  const metro = isOurs(paths, record.metro)
    ? record.metro!
    : spawnRecorded(
        NodePath.join(paths.worktree, "apps/mobile/node_modules/.bin/expo"),
        [
          "start",
          "--dev-client",
          "--scheme",
          J5_BRANDING.mobile.development.scheme,
          "--port",
          String(record.metroPort),
        ],
        {
          cwd: NodePath.join(paths.worktree, "apps/mobile"),
          env: {
            ...liveTestEnvironment(process.env, paths.worktree),
            APP_VARIANT: "development",
            // The host the manifest's bundle URL names, as the device reaches Metro.
            REACT_NATIVE_PACKAGER_HOSTNAME: deviceHost(record),
            // One bundle, as a release build has. A lazy chunk that fails to load at launch can fail
            // every `import("expo-file-system")`, which then reads as a storage error.
            EXPO_NO_METRO_LAZY: "1",
            BROWSER: "none",
          },
          log: metroLog,
        },
      );
  writeMobileRecord(paths, { ...readMobileRecord(paths)!, metro });
  for (;;) {
    const listener = listenerOn(record.metroPort);
    if (listener !== undefined && processGroupOf(listener) === metro.pid) return metro;
    if (startTimeOf(metro.pid) !== metro.startTime) {
      throw new LiveTestRefusal(
        `Metro exited while starting. Last lines of ${metroLog}:\n${tail(metroLog)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new LiveTestRefusal(
        `Metro was not listening on ${record.metroPort} in time; it has been left running. See ${metroLog}, then run ${selfCommand(paths, `--mobile ${record.platform}`)}.`,
      );
    }
    await NodeTimersPromises.setTimeout(250);
  }
}

/** Opens the reverse tunnel that puts the backend and Metro on the iOS host's loopback, which the Simulator shares. */
async function startTunnel(
  paths: LiveTestPaths,
  record: MobileRecord,
  host: IosHost & { readonly kind: "ssh" },
): Promise<ProcessRecord> {
  const { tunnelLog } = mobileFiles(paths);
  const forward = (port: number) => ["-R", `127.0.0.1:${port}:127.0.0.1:${port}`];
  const tunnel = isOurs(paths, record.tunnel)
    ? record.tunnel!
    : spawnRecorded(
        "ssh",
        [
          "-N",
          "-o",
          "BatchMode=yes",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=15",
          ...forward(record.serverPort),
          ...forward(record.metroPort),
          host.ssh,
        ],
        { cwd: paths.worktree, env: process.env, log: tunnelLog },
      );
  writeMobileRecord(paths, { ...readMobileRecord(paths)!, tunnel });
  const check = `curl -fsS -o /dev/null http://127.0.0.1:${record.serverPort}/.well-known/t3/environment && curl -fsS http://127.0.0.1:${record.metroPort}/status`;
  const until = Date.now() + TUNNEL_TIMEOUT_MS;
  for (;;) {
    if (startTimeOf(tunnel.pid) !== tunnel.startTime) {
      throw new LiveTestRefusal(`The SSH tunnel to ${host.ssh} exited:\n${tail(tunnelLog)}`);
    }
    const probe = runOnIosHost(host, check, 15_000);
    if (probe.status === 0) return tunnel;
    if (Date.now() > until) {
      throw new LiveTestRefusal(
        `The iOS host cannot reach the backend and Metro through the tunnel: ${probe.stderr.trim()}`,
      );
    }
    await NodeTimersPromises.setTimeout(500);
  }
}

/**
 * The web port the dev runner derives for this worktree, which the mobile pair must not take.
 * With both ports explicit, its dry run prints that port and searches nothing.
 */
function devRunnerWebPort(paths: LiveTestPaths): number {
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
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const webPort = readServerLog(`${dryRun.stdout}${dryRun.stderr}`).webPort;
  if (webPort === undefined) {
    throw new LiveTestRefusal(`The dev runner did not report its web port:\n${dryRun.stderr}`);
  }
  return webPort;
}

/** Claims a device slot, recording it before anything else so `stop` can release it. */
function claim(
  paths: LiveTestPaths,
  platform: MobilePlatform,
  iosHost: IosHost | undefined,
): MobileRecord {
  const existing = readMobileRecord(paths);
  if (existing !== undefined) {
    if (existing.platform !== platform) {
      throw new LiveTestRefusal(
        `This worktree's live test is set up for ${existing.platform}. Stop it first: ${selfCommand(paths, "stop")}`,
      );
    }
    return existing;
  }
  const config = mobileRigConfig();
  const { serverPort, metroPort } = chooseMobilePorts({
    worktree: paths.worktree,
    range: config.ports,
    avoid: [devRunnerWebPort(paths)],
    isFree: (port) => listenerOn(port) === undefined,
  });
  // Nothing that can fail sits between a claim and its record, so `stop` always finds it.
  const directory = claimsDirectory(NodeOS.homedir());
  let slot: string;
  let udid: string | undefined;
  if (platform === "ios") {
    const host = iosHost!;
    const hostKey = host.kind === "local" ? "local" : host.ssh;
    const simulators = iosSimulators(host);
    const pool = iosPool(simulators, config.ios.simulators);
    if (pool.length === 0) {
      const wanted =
        "names" in config.ios.simulators
          ? `named ${config.ios.simulators.names.join(", ")}`
          : `whose names start with "${config.ios.simulators.prefix}"`;
      throw new LiveTestRefusal(
        `${describeIosHost(host)} has no Simulators ${wanted}, the test pool the rig may claim and erase. Create them in Xcode, or list yours as ios.simulators in ${config.path}.`,
      );
    }
    slot = claimSlot({
      directory,
      platform,
      host: hostKey,
      slots: pool.map((s) => s.name),
      worktree: paths.worktree,
    });
    const mine = pool.find((simulator) => simulator.name === slot)!;
    const busy = iosBusy({
      simulators,
      pool,
      mine: mine.udid,
      claimed: (name) =>
        ownerOf(NodePath.join(directory, claimName({ platform, host: hostKey }, name))) !==
        undefined,
    });
    if (busy.length >= config.ios.maxBooted) {
      releaseSlot({ directory, platform, host: hostKey, slot, worktree: paths.worktree });
      throw new LiveTestRefusal(
        `${describeIosHost(host)} already runs or has promised ${busy.length} Simulators (${busy.join(", ")}), its limit of ${config.ios.maxBooted} (ios.maxBooted). Try again when one is free.`,
      );
    }
    udid = mine.udid;
  } else {
    slot = claimSlot({
      directory,
      platform,
      slots: androidSlots(config.android.slots),
      worktree: paths.worktree,
    });
  }
  const record: MobileRecord = {
    platform,
    slot,
    ...(udid === undefined ? {} : { udid, iosHost: iosHost! }),
    serverPort,
    metroPort,
    sessionCleanupPending: true,
  };
  writeMobileRecord(paths, record);
  return record;
}

/**
 * Refuses a mobile start that cannot run (settings, iOS host, Android SDK or KVM, phone address)
 * before anything is built or started. A setup already recorded keeps the host it was made with.
 */
export function checkMobileCanStart(paths: LiveTestPaths, platform: MobileTarget): void {
  mobileRigConfig();
  const recorded = readMobileRecord(paths);
  if (platform === "ios") {
    if (recorded?.iosHost === undefined) reachableIosHost();
  } else if (platform === "android") {
    androidSdk();
    androidAbi();
    assertKvm();
  } else if (recorded === undefined) {
    phoneAddress();
  }
}

/**
 * What a mobile test needs to know about the test server. The browser's pairing link and the
 * web port are left out: the device reaches the backend by the address in the Mobile block.
 */
function formatMobileServer(paths: LiveTestPaths, facts: ServerLogFacts): string {
  const manifest = readManifest(paths);
  const owner = "ownerName" in manifest ? manifest.ownerName : undefined;
  return `J5 Code live-test server: RUNNING
  Home          ${paths.home}
  Log           ${paths.log}${owner === undefined ? "" : `\n  Owner         ${owner}`}${
    "project" in manifest
      ? `\n  Project       "${manifest.project.title}", ${paths.testRepo}\n  New threads   ${manifest.defaultModel}`
      : ""
  }
  Browser       optional: http://localhost:${facts.webPort}, paired with ${selfCommand(paths, "status")}'s link
`;
}

/**
 * Starts the backend on its mobile port, Metro, and the device side, joining any part that is
 * already running. A failure leaves what was started recorded; `stop` removes it.
 */
export async function startMobile(
  paths: LiveTestPaths,
  platform: MobileTarget,
  deadline: number,
): Promise<void> {
  if (readMobileRecord(paths) === undefined && currentServerState(paths).kind !== "stopped") {
    throw new LiveTestRefusal(
      `A live-test server is already running here without --mobile. Stop it first: ${selfCommand(paths, "stop")}`,
    );
  }
  if (platform === "phone") return startPhone(paths, deadline);
  const recorded = readMobileRecord(paths);
  if (recorded?.platform === "ios" && recorded.iosHost === undefined) {
    throw new LiveTestRefusal(
      `This mobile setup was made before the rig recorded its iOS host. Stop it with the build that made it, or reset ${recorded.slot} by hand and delete ${mobileFiles(paths).record}, then set up again.`,
    );
  }
  let iosHost: IosHost | undefined;
  if (platform === "ios") iosHost = recorded?.iosHost ?? reachableIosHost();
  else {
    androidSdk();
    assertKvm();
  }
  const record = claim(paths, platform, iosHost);
  const stopHint = `\nTo undo what was set up: ${selfCommand(paths, "stop")}`;
  try {
    console.log(`Starting the dev server, Metro and the ${platform} device slot ${record.slot}...`);
    const backend = startServer(paths, "dev", {}, deadline, ["--port", String(record.serverPort)]);
    backend.catch(() => undefined);
    const avd =
      platform === "android"
        ? (avdExists(record.slot) ? Promise.resolve() : createAvd(record.slot)).then(() =>
            startEmulator(paths, record, deadline),
          )
        : Promise.resolve();
    avd.catch(() => undefined);
    await startMetro(paths, record, deadline);
    const facts = await backend;
    await avd;
    finishSessionCleanup(paths, closeAgentDeviceSessions);
    if (iosHost?.kind === "ssh") await startTunnel(paths, readMobileRecord(paths)!, iosHost);
    console.log(formatMobileServer(paths, facts));
    console.log(formatMobile(paths, readMobileRecord(paths)!));
  } catch (cause) {
    if (cause instanceof LiveTestRefusal) throw new LiveTestRefusal(`${cause.message}${stopHint}`);
    throw cause;
  }
}

export function formatMobile(paths: LiveTestPaths, record: MobileRecord): string {
  if (record.platform === "phone") return formatPhone(paths, record);
  const host = DEVICE_LOOPBACK[record.platform];
  const setupAgain = selfCommand(paths, "--mobile android");
  // The Device panel lists an emulator only once it has booted, so until then nothing says to open it.
  const emulator =
    record.platform === "ios"
      ? "ready"
      : !isOurs(paths, record.emulator)
        ? "stopped"
        : emulatorBooted(androidSdk().adb, record.emulator!.port)
          ? "ready"
          : "booting";
  const device =
    record.platform === "ios"
      ? `${record.iosHost?.kind === "ssh" ? `hostId: the device host for "${record.iosHost.ssh}" in device_list` : `hostId "local"`}; deviceId "${record.udid}" (${record.slot})`
      : emulator === "stopped"
        ? `${record.slot}: its emulator is not running`
        : emulator === "booting"
          ? `${record.slot}: emulator-${record.emulator!.port} is still booting; do not call device_open yet`
          : `hostId "local"; deviceId "emulator-${record.emulator!.port}" (${record.slot})`;
  const next =
    emulator === "ready"
      ? `  1. device_open with the ids above.${record.platform === "ios" ? " It boots the Simulator." : ""}
  2. ${selfCommand(paths, "mobile-open")}
     installs the dev client, opens it against Metro and pairs it as the home's owner.`
      : `  1. ${setupAgain}
     ${emulator === "booting" ? "waits for the emulator to boot" : "starts the emulator"}, then prints the device to open.`;
  return `Mobile (${record.platform}), device slot ${record.slot}:
  Device panel  ${device}
  Backend       http://${host}:${record.serverPort} from the device
  Metro         http://${host}:${record.metroPort} from the device, log ${mobileFiles(paths).metroLog}${
    record.platform === "ios"
      ? record.iosHost?.kind === "ssh"
        ? `\n  Tunnel        ssh ${record.iosHost.ssh}, log ${mobileFiles(paths).tunnelLog}`
        : ""
      : ""
  }

Next:
${next}
When you finish: agent-device close (with device_open's flags, no --shutdown), device_close, then
${selfCommand(paths, "stop")} (it ${record.platform === "ios" ? "shuts down and erases the Simulator" : "shuts down and deletes the AVD"} and releases the slot).
`;
}

/** Installs the dev client on the booted device, opens it against Metro and pairs it as the owner. */
export async function mobileOpen(paths: LiveTestPaths): Promise<void> {
  const record = readMobileRecord(paths);
  if (record === undefined) {
    throw new LiveTestRefusal(
      `No mobile live test is set up here. Start one: ${selfCommand(paths, "--mobile ios|android|phone")}`,
    );
  }
  const server = currentServerState(paths);
  if (server.kind !== "running" || !isOurs(paths, record.metro)) {
    throw new LiveTestRefusal(
      `The backend or Metro is not running. Check with ${selfCommand(paths, "status")}, or start again with ${selfCommand(paths, `--mobile ${record.platform}`)}`,
    );
  }
  if (record.platform === "ios" && record.iosHost === undefined) {
    throw new LiveTestRefusal(
      `This mobile setup was made before the rig recorded its iOS host. Stop it with the build that made it, or delete ${mobileFiles(paths).record}, then set up again.`,
    );
  }
  if (record.iosHost?.kind === "ssh" && !isOurs(paths, record.tunnel)) {
    throw new LiveTestRefusal(
      `The SSH tunnel is down. Start it again with ${selfCommand(paths, "--mobile ios")}`,
    );
  }
  if (record.platform === "phone") return printPhoneLinks(paths, record);
  const openHint = `Open it first: device_open with the ids \`${selfCommand(paths, "status")}\` prints.`;

  const fingerprint = nativeFingerprint(paths, record.platform);
  const client = cachedClientPath(record.platform, fingerprint);
  let openUrl: (url: string) => void;
  if (record.platform === "ios") {
    const udid = record.udid!;
    const host = record.iosHost!;
    const simulator = iosSimulators(host).find((s) => s.udid === udid);
    if (simulator?.booted !== true)
      throw new LiveTestRefusal(`${record.slot} is not booted. ${openHint}`);
    const remoteClient = `"$HOME"/${shellQuote(client)}`;
    if (!iosHostSucceeds(host, `test -d ${remoteClient}`)) {
      throw new LiveTestRefusal(
        `The iOS host has no dev client for this checkout's native fingerprint ${fingerprint}. Build it (6-15 minutes; run it in the background): ${selfCommand(paths, "mobile-build ios")}`,
      );
    }
    console.log(`Installing the dev client on ${record.slot}...`);
    onIosHost(host, `xcrun simctl install ${udid} ${remoteClient}`, 120_000);
    // Without this, iOS asks "Open in J5 Code Dev?" for every link simctl opens. The device
    // hub's serve-sim writes the same approval before it opens a URL.
    const { scheme, appId } = J5_BRANDING.mobile.development;
    onIosHost(
      host,
      `xcrun simctl spawn ${udid} defaults write com.apple.launchservices.schemeapproval ${shellQuote(`com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`)} -string ${appId}`,
    );
    // openurl gives a launch 10 seconds. An app's first launch on a freshly erased Simulator,
    // with another booted beside it, can take longer; simctl launch waits for it.
    onIosHost(host, `xcrun simctl launch ${udid} ${appId}`, 120_000);
    openUrl = (url) => void onIosHost(host, `xcrun simctl openurl ${udid} ${shellQuote(url)}`);
  } else {
    if (!isOurs(paths, record.emulator)) {
      throw new LiveTestRefusal(
        `The emulator for ${record.slot} is not running. Start it again with ${selfCommand(paths, "--mobile android")}`,
      );
    }
    const serial = `emulator-${record.emulator!.port}`;
    const { adb } = androidSdk();
    const apk = NodePath.join(NodeOS.homedir(), client);
    if (!NodeFS.existsSync(apk)) {
      throw new LiveTestRefusal(
        `There is no Android dev client for this checkout's native fingerprint ${fingerprint}. Build it (about 15 minutes the first time; run it in the background): ${selfCommand(paths, "mobile-build android")}`,
      );
    }
    const adbRun = (args: ReadonlyArray<string>, what: string) => {
      const run = NodeChildProcess.spawnSync(adb, ["-s", serial, ...args], {
        encoding: "utf8",
        timeout: 180_000,
      });
      if (run.status !== 0)
        throw new LiveTestRefusal(`${what} failed: ${run.stderr || run.stdout}`);
    };
    adbRun(
      [
        "wait-for-device",
        "shell",
        'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done',
      ],
      "Waiting for the emulator to boot",
    );
    console.log(`Installing the dev client on ${record.slot} (${serial})...`);
    adbRun(["install", "-r", "-d", apk], "Installing the dev client");
    openUrl = (url) =>
      adbRun(
        ["shell", `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`],
        "Opening a link",
      );
  }

  const { metroLog } = mobileFiles(paths);
  const before = metroBundles(NodeFS.readFileSync(metroLog, "utf8"));
  console.log("Opening the dev client against Metro (the first bundle takes about 30 seconds)...");
  openUrl(devClientUrl(deviceHost(record), record.metroPort));
  const until = Date.now() + BUNDLE_TIMEOUT_MS;
  for (;;) {
    const now = metroBundles(NodeFS.readFileSync(metroLog, "utf8"));
    if (now.failed > before.failed) {
      throw new LiveTestRefusal(`Metro failed to bundle the app:\n${tail(metroLog)}`);
    }
    if (now.served > before.served) break;
    if (Date.now() > until) {
      throw new LiveTestRefusal(
        `Metro served no bundle within ${BUNDLE_TIMEOUT_MS / 1000} seconds of opening the dev client. Take a screenshot, read ${metroLog}, then run mobile-open again.`,
      );
    }
    await NodeTimersPromises.setTimeout(500);
  }

  const manifest = readManifest(paths);
  const owner = "ownerName" in manifest ? manifest.ownerName : undefined;
  if (owner === undefined)
    throw new LiveTestRefusal("The test home's owner has no name to pair as.");
  const label = `mobile-open ${record.slot} ${Date.now()}`;
  const pairingUrl = mintPairingUrl(paths, owner, label);
  if (pairingUrl === undefined) throw new LiveTestRefusal("Minting a pairing link failed.");
  const link = pairingDeepLink({
    host: deviceHost(record),
    serverPort: record.serverPort,
    pairingUrl,
  });
  // A link that arrives before the app has mounted is dropped, and nothing on the device says
  // when it has. The server does: a used link leaves its active list. So open until it is used.
  console.log(`Pairing as ${owner}...`);
  const pairUntil = Date.now() + PAIR_TIMEOUT_MS;
  let lastOpen = 0;
  while (activePairingLabels(paths).includes(label)) {
    if (Date.now() > pairUntil) {
      throw new LiveTestRefusal(
        `The app did not use the pairing link within ${PAIR_TIMEOUT_MS / 1000} seconds. Take a screenshot, then run mobile-open again.`,
      );
    }
    if (Date.now() - lastOpen >= PAIR_REOPEN_MS) {
      openUrl(link);
      lastOpen = Date.now();
    }
    await NodeTimersPromises.setTimeout(1_000);
  }
  console.log(`Opened the dev client and paired it as ${owner}.
Take a screenshot: the app should list the project "${"project" in manifest ? manifest.project.title : "the test project"}".
If it does not, run mobile-open again.${
    record.platform === "android"
      ? '\nOn a first launch Android may show "Could not import shared content"; press Retry.'
      : ""
  }`);
}

/** The names of the agent-device sessions on `deviceId`, from `agent-device session list` output. */
export function sessionsOnDevice(listJson: string, deviceId: string): ReadonlyArray<string> {
  const { sessions } = JSON.parse(listJson) as {
    readonly sessions?: ReadonlyArray<{ readonly name: string; readonly id?: string }>;
  };
  return (sessions ?? [])
    .filter((session) => session.id === deviceId)
    .map((session) => session.name);
}

/**
 * Ends the agent-device sessions that J5 Code's device host holds on this slot's device. `device_close`
 * leaves them open, and a session left open refuses the next holder with DEVICE_IN_USE. The sessions
 * live with the J5 Code the agent runs in; without its device tools there is nothing to close.
 */
/**
 * A fresh claim is exclusive, so a session already on the device belongs to a holder who is gone.
 * Runs once the device is up (so the emulator is proven the slot's), and only once: a later setup
 * rejoining the claim keeps the tester's own session.
 */
export function finishSessionCleanup(
  paths: Pick<LiveTestPaths, "root">,
  close: (record: MobileRecord) => void,
): void {
  const record = readMobileRecord(paths);
  if (record?.sessionCleanupPending !== true) return;
  close(record);
  const { sessionCleanupPending: _done, ...rest } = record;
  writeMobileRecord(paths, rest);
}

function closeAgentDeviceSessions(record: MobileRecord): void {
  const deviceId =
    record.platform === "ios"
      ? record.udid
      : record.platform === "android"
        ? emulatorSerial(record.slot)
        : undefined;
  if (deviceId === undefined) return;
  const deviceHome = NodePath.join(
    process.env.J5CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".j5code"),
    "userdata",
    "device",
  );
  const agentDevice = NodePath.join(deviceHome, "bin", "agent-device");
  // Only the local device host's config can be named without the database (`agentDeviceConfigPath`
  // in apps/server/src/device/AgentDeviceTarget.ts). An SSH host's id is in the database, so its
  // sessions are left to device_close.
  if (record.platform === "ios" && record.iosHost?.kind === "ssh") {
    return console.log(
      `agent-device sessions on ${record.slot} (host "${record.iosHost.ssh}"): not closed here; close yours with agent-device close (device_open's flags), then device_close`,
    );
  }
  const config = NodePath.join(
    deviceHome,
    "hosts",
    `${NodeCrypto.createHash("sha256").update("local").digest("hex").slice(0, 24)}.json`,
  );
  if (!NodeFS.existsSync(agentDevice) || !NodeFS.existsSync(config)) return;
  // The CLI wants a session flag on every call; listing ignores which one.
  const list = NodeChildProcess.spawnSync(
    agentDevice,
    ["session", "list", "--config", config, "--session", "j5-live-test"],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (list.status !== 0) return;
  for (const session of sessionsOnDevice(list.stdout, deviceId)) {
    const closed = NodeChildProcess.spawnSync(
      agentDevice,
      ["close", "--config", config, "--session", session],
      { encoding: "utf8", timeout: 30_000 },
    );
    console.log(
      closed.status === 0
        ? `agent-device session ${session} on ${record.slot}: CLOSED`
        : `agent-device session ${session} on ${record.slot} could not be closed: ${(closed.stderr || closed.stdout).trim()}`,
    );
  }
}

/**
 * Takes down everything `startMobile` recorded: Metro, the tunnel, the device (reset for the next
 * tester) and the claim. A step that fails keeps the record, so running `stop` again finishes it.
 */
export async function stopMobile(paths: LiveTestPaths): Promise<void> {
  const record = readMobileRecord(paths);
  if (record === undefined) return;
  for (const [name, process_] of [
    ["Metro", record.metro],
    ["SSH tunnel", record.tunnel],
  ] as const) {
    if (!isOurs(paths, process_)) continue;
    await stopGroup(process_!.pid);
    console.log(`${name}: STOPPED`);
  }
  if (record.platform === "phone") return NodeFS.rmSync(mobileFiles(paths).record, { force: true });
  closeAgentDeviceSessions(record);
  if (record.platform === "ios") {
    const udid = record.udid!;
    const host = record.iosHost;
    if (host === undefined) {
      throw new LiveTestRefusal(
        `This mobile setup was made before the rig recorded its iOS host, so it cannot tell which machine ${record.slot} is on. Stop it with the build that made it, or reset that Simulator by hand and delete ${mobileFiles(paths).record}.`,
      );
    }
    // Shutting down a Simulator that is already shut down is an error simctl reports; erase is not.
    runOnIosHost(host, `xcrun simctl shutdown ${udid}`);
    try {
      onIosHost(host, `xcrun simctl erase ${udid}`);
    } catch (cause) {
      const { metro: _metro, tunnel: _tunnel, ...rest } = record;
      writeMobileRecord(paths, rest);
      throw new LiveTestRefusal(
        `${record.slot} was not reset, so it is still claimed. ${(cause as Error).message}\nRun stop again when the iOS host is back.`,
      );
    }
    console.log(`Simulator ${record.slot}: SHUT DOWN AND ERASED`);
  } else {
    const { adb, avdmanager } = androidSdk();
    if (isOurs(paths, record.emulator)) await stopGroup(record.emulator!.pid);
    // One the Device panel booted from this AVD is not ours to signal, but it can be asked to quit.
    const serial = emulatorSerial(record.slot);
    if (serial !== undefined) {
      NodeChildProcess.spawnSync(adb, ["-s", serial, "emu", "kill"], { timeout: 15_000 });
      const until = Date.now() + EMULATOR_EXIT_TIMEOUT_MS;
      while (emulatorSerial(record.slot) !== undefined) {
        if (Date.now() > until) {
          throw new LiveTestRefusal(
            `The emulator ${serial} (${record.slot}) is still running. Close it with device_close, then run stop again.`,
          );
        }
        await NodeTimersPromises.setTimeout(500);
      }
    }
    const runner = avdRunner(record.slot);
    if (runner !== undefined) {
      // Kept claimed: deleting an AVD under a running emulator would hand the next tester a broken slot.
      throw new LiveTestRefusal(
        `Process ${runner}, which this script did not start, still runs the AVD ${record.slot}, so the slot stays claimed. Close it with device_close, then run stop again.`,
      );
    }
    const deleted = NodeChildProcess.spawnSync(avdmanager, ["delete", "avd", "-n", record.slot], {
      encoding: "utf8",
    });
    if (deleted.status !== 0 && !/no avd/i.test(`${deleted.stdout}${deleted.stderr}`)) {
      throw new LiveTestRefusal(`Deleting the AVD ${record.slot} failed:\n${deleted.stderr}`);
    }
    console.log(`Emulator ${record.slot}: SHUT DOWN AND DELETED`);
  }
  releaseSlot({
    directory: claimsDirectory(NodeOS.homedir()),
    platform: record.platform,
    ...(record.iosHost === undefined
      ? {}
      : { host: record.iosHost.kind === "local" ? "local" : record.iosHost.ssh }),
    slot: record.slot,
    worktree: paths.worktree,
  });
  NodeFS.rmSync(mobileFiles(paths).record, { force: true });
}

export function mobileStatus(paths: LiveTestPaths): string | undefined {
  const record = readMobileRecord(paths);
  if (record === undefined) return undefined;
  const state = (running: boolean) => (running ? "RUNNING" : "STOPPED");
  return `${formatMobile(paths, record)}
  Metro: ${state(isOurs(paths, record.metro))}${
    record.iosHost?.kind === "ssh"
      ? `   Tunnel: ${state(isOurs(paths, record.tunnel))}`
      : record.platform === "android"
        ? `   Emulator: ${state(isOurs(paths, record.emulator))}`
        : ""
  }`;
}

/** The address the developer's phone reaches this machine by: as set, or its tailnet address. */
function phoneAddress(): string {
  const config = mobileRigConfig();
  if (config.phone.host !== "tailscale") return config.phone.host;
  const ip = NodeChildProcess.spawnSync("tailscale", ["ip", "-4"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const address = ip.stdout?.split("\n")[0]?.trim();
  if (ip.status !== 0 || !address) {
    throw new LiveTestRefusal(
      `This machine has no tailnet address, so a phone cannot reach it (${ip.stderr || String(ip.error ?? "")}). Set phone.host in ${config.path} to an address the phone reaches.`,
    );
  }
  return address;
}

/**
 * The developer's own phone: the backend listens on every interface (the dev runner binds loopback
 * or all of them) on a port in the configured range, and Metro names the address the phone reaches.
 */
async function startPhone(paths: LiveTestPaths, deadline: number): Promise<void> {
  const existing = readMobileRecord(paths);
  if (existing !== undefined && existing.platform !== "phone") {
    throw new LiveTestRefusal(
      `This worktree's live test is set up for ${existing.platform}. Stop it first: ${selfCommand(paths, "stop")}`,
    );
  }
  const record: MobileRecord =
    existing ??
    (() => {
      const host = phoneAddress();
      const ports = chooseMobilePorts({
        worktree: paths.worktree,
        range: mobileRigConfig().ports,
        avoid: [devRunnerWebPort(paths)],
        isFree: (port) => listenerOn(port) === undefined,
      });
      const created: MobileRecord = { platform: "phone", slot: "phone", host, ...ports };
      writeMobileRecord(paths, created);
      return created;
    })();
  console.log("Starting the dev server and Metro for the developer's phone...");
  const backend = startServer(paths, "dev", {}, deadline, [
    "--port",
    String(record.serverPort),
    "--host",
    "0.0.0.0",
  ]);
  backend.catch(() => undefined);
  await startMetro(paths, record, deadline);
  console.log(formatMobileServer(paths, await backend));
  console.log(formatPhone(paths, record));
}

function formatPhone(paths: LiveTestPaths, record: MobileRecord): string {
  return `Mobile (phone), for the developer's own phone:
  Backend       http://${record.host}:${record.serverPort}
  Metro         http://${record.host}:${record.metroPort}, log ${mobileFiles(paths).metroLog}
  Both listen on every interface of this machine, its LAN and Docker networks included, not
  only the address above. The test server is isolated and admits only a device with a pairing link.

Next:
  ${selfCommand(paths, "mobile-open")}
     prints the two links to send the developer: one opens J5 Code Dev against this Metro,
     the other pairs it with this server as the home's owner.
When you finish: ${selfCommand(paths, "stop")}
`;
}

/** The phone is the developer's, so nothing here can open the links on it: they are printed to send. */
function printPhoneLinks(paths: LiveTestPaths, record: MobileRecord): void {
  const manifest = readManifest(paths);
  const owner = "ownerName" in manifest ? manifest.ownerName : undefined;
  if (owner === undefined)
    throw new LiveTestRefusal("The test home's owner has no name to pair as.");
  // The developer may open it a while after it is sent; `pair` defaults to five minutes.
  const pairingUrl = mintPairingUrl(paths, owner, `mobile-open phone ${Date.now()}`, "60m");
  if (pairingUrl === undefined) throw new LiveTestRefusal("Minting a pairing link failed.");
  const host = record.host!;
  const fingerprint = nativeFingerprint(paths, "ios");
  console.log(`Send the developer these two links, to open on the phone in this order:

1. Open J5 Code Dev against this branch's Metro:
   ${devClientUrl(host, record.metroPort)}

2. Then pair it with this test server, as ${owner} (works once, within an hour):
   ${pairingDeepLink({ host, serverPort: record.serverPort, pairingUrl })}

The phone must reach ${host}, and needs J5 Code Dev built for this checkout's iOS native fingerprint:
   ${fingerprint}
If the app on the phone was built for another fingerprint, rebuild it first: a mismatched client
can fail in ways that look like a bug in the branch.
If iOS asks to allow "Local Network" for J5 Code Dev, the developer allows it.`);
}
