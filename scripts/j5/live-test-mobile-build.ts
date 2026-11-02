// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - part of the standalone live-test CLI.
/**
 * `setup-agent-live-test.ts mobile-build ios|android`: builds the dev client for this checkout's
 * native fingerprint into `mobile:install`'s cache, where `mobile-open` installs it from. Android,
 * and iOS on a local Mac, build in this worktree. An iOS host reached over SSH builds in a checkout
 * of this commit there, which the rig makes and keeps.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import {
  androidAbi,
  androidSdk,
  cachedClientPath,
  describeIosHost,
  iosHostSucceeds,
  nativeFingerprint,
  reachableIosHost,
  runOnIosHost,
  type MobilePlatform,
} from "./live-test-mobile.ts";
import { mobileRigConfig, type IosHost } from "./live-test-mobile-config.ts";
import {
  LiveTestRefusal,
  liveTestEnvironment,
  type LiveTestPaths,
} from "./setup-agent-live-test.ts";

/** The exit codes the remote scripts use for refusals they have already explained. */
const LOCKED_EXIT = 75;
const NOT_RIG_CHECKOUT_EXIT = 76;
/** Marks a checkout the rig made, so it never forces a checkout over someone's own clone. */
const RIG_MARKER = ".j5-mobile-rig";

export function parseMobileBuild(args: ReadonlyArray<string>): MobilePlatform {
  const [platform, ...rest] = args;
  if (rest.length > 0 || (platform !== "ios" && platform !== "android")) {
    throw new LiveTestRefusal(
      "Usage: node scripts/j5/setup-agent-live-test.ts mobile-build ios|android",
    );
  }
  return platform;
}

const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A path from the settings as one shell word on the remote host, `~/` meaning its home. */
export const remotePath = (path: string) =>
  path === "~"
    ? '"$HOME"'
    : path.startsWith("~/")
      ? `"$HOME"/${shellWord(path.slice(2))}`
      : shellWord(path);

/** The same path as `git push` addresses it over SSH: relative paths are from the remote home. */
const pushPath = (path: string) => (path.startsWith("~/") ? path.slice(2) : path);

/**
 * Makes the checkout exist as the rig's own: a new empty repository, marked, the first time. A
 * directory that is there without the mark is someone else's, and is refused.
 */
export function ensureCheckoutScript(input: { readonly checkout: string }): string {
  const checkout = remotePath(input.checkout);
  return `if [ ! -e ${checkout} ]; then
  mkdir -p ${checkout} && git init -q ${checkout} && touch ${checkout}/${RIG_MARKER} && echo ${RIG_MARKER} >> ${checkout}/.git/info/exclude
elif [ ! -e ${checkout}/${RIG_MARKER} ]; then
  echo ${shellWord(`${input.checkout} on the iOS host was not made by the mobile rig, so the rig will not check out over it. Point ios.host.checkout at a new path, or add ${RIG_MARKER} there if it is the rig's.`)} >&2
  exit ${NOT_RIG_CHECKOUT_EXIT}
fi
`;
}

/**
 * The script the iOS host runs, from stdin: take the build lock (refusing if another build holds
 * it), check out `commit`, install, and build into the cache. The lock goes when the script ends.
 */
export function iosBuildScript(input: {
  readonly commit: string;
  readonly owner: string;
  readonly checkout: string;
  readonly envFile: string | undefined;
  readonly configPath: string;
}): string {
  const checkout = remotePath(input.checkout);
  const lock = remotePath(`${input.checkout}.build-lock`);
  return `set -e
lock=${lock}
if ! mkdir "$lock" 2>/dev/null; then
  printf '%s %s\\n' 'Another iOS build is running on this host:' "$(cat "$lock/owner" 2>/dev/null)" >&2
  echo ${shellWord(`Wait for it. If none is running, remove ${input.checkout}.build-lock on the iOS host.`)} >&2
  exit ${LOCKED_EXIT}
fi
trap 'rm -rf "$lock"' EXIT
# A trap that only cleaned up would let the shell go on to the next step without the lock.
trap 'exit 1' HUP INT TERM
printf '%s since %s\\n' ${shellWord(input.owner)} "$(date)" > "$lock/owner"
cd ${checkout}
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo ${shellWord(`${input.checkout} on the iOS host has changes to tracked files; the rig will not overwrite them. Discard them there with \`git checkout -- .\` in that directory, or point ios.host.checkout at a new path.`)} >&2
  exit 1
fi
git checkout -q -f --detach ${input.commit}
${input.envFile === undefined ? "" : `. ${remotePath(input.envFile)}\n`}if ! command -v vp >/dev/null 2>&1; then
  echo ${shellWord(`vp is not on the iOS host's PATH in a login shell. Set ios.host.envFile in ${input.configPath} to the file that puts it there.`)} >&2
  exit 1
fi
vp i
node scripts/mobile-native-client.ts ensure ios --prepare
`;
}

/** Makes the iOS host's checkout hold `commit` by pushing it, so an unpushed commit works too. */
function syncIosCheckout(
  paths: LiveTestPaths,
  host: IosHost & { readonly kind: "ssh" },
  commit: string,
): void {
  const ensured = runOnIosHost(host, ensureCheckoutScript({ checkout: host.checkout }));
  if (ensured.status !== 0) {
    throw new LiveTestRefusal(
      ensured.stderr.trim() || `Preparing ${host.checkout} on ${describeIosHost(host)} failed.`,
    );
  }
  const push = NodeChildProcess.spawnSync(
    "git",
    [
      "-C",
      paths.worktree,
      "push",
      "-q",
      "--force",
      `${host.ssh}:${pushPath(host.checkout)}`,
      `${commit}:refs/j5-rig/${NodePath.basename(paths.worktree)}`,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } },
  );
  if (push.status !== 0) {
    throw new LiveTestRefusal(
      `Pushing ${commit} to ${describeIosHost(host)} failed:\n${push.stderr}`,
    );
  }
}

/** `mobile:install`'s own build into its cache, in this worktree. */
function buildHere(paths: LiveTestPaths, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(paths.worktree, "scripts/mobile-native-client.ts"),
      "ensure",
      ...args,
      "--prepare",
    ],
    {
      cwd: paths.worktree,
      env: { ...liveTestEnvironment(process.env, paths.worktree), ...env },
      stdio: "inherit",
    },
  );
}

export function mobileBuild(paths: LiveTestPaths, platform: MobilePlatform): void {
  const fingerprint = nativeFingerprint(paths, platform);
  const commandLine = `mobile-build ${platform}`;
  if (platform === "android") {
    const sdk = androidSdk();
    console.log(`Building the Android dev client for fingerprint ${fingerprint} here...`);
    const build = buildHere(paths, ["android", "--abi", androidAbi()], {
      ANDROID_HOME: sdk.root,
      ANDROID_SDK_ROOT: sdk.root,
    });
    if (build.status !== 0) throw new LiveTestRefusal(`The Android build failed; see above.`);
    return console.log(`The Android dev client is ready. Next: mobile-open.`);
  }
  const host = reachableIosHost();
  if (host.kind === "local") {
    console.log(
      `Building the iOS dev client for fingerprint ${fingerprint} here (6-15 minutes when it is not cached)...`,
    );
    if (buildHere(paths, ["ios"], {}).status !== 0) {
      throw new LiveTestRefusal("The iOS build failed; see above.");
    }
    return console.log("The iOS dev client is ready. Next: mobile-open.");
  }
  const commit = NodeChildProcess.spawnSync("git", ["-C", paths.worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  syncIosCheckout(paths, host, commit);
  console.log(
    `Building the iOS dev client on ${describeIosHost(host)} at ${commit.slice(0, 10)} (6-15 minutes when it is not cached)...`,
  );
  // A login shell, which puts tools such as CocoaPods (`pod install` in a cold build) on PATH.
  const build = NodeChildProcess.spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", host.ssh, "/bin/zsh -l -s"],
    {
      input: iosBuildScript({
        commit,
        owner: paths.worktree,
        checkout: host.checkout,
        envFile: host.envFile,
        configPath: mobileRigConfig().path,
      }),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (build.status === LOCKED_EXIT) throw new LiveTestRefusal("Run mobile-build again later.");
  if (build.status !== 0) throw new LiveTestRefusal("The iOS build failed; see above.");
  // The host built for the commit; this worktree may differ from it by uncommitted native changes.
  if (
    !iosHostSucceeds(host, `test -d "$HOME"/${shellWord(cachedClientPath("ios", fingerprint))}`)
  ) {
    throw new LiveTestRefusal(
      `${describeIosHost(host)} built ${commit.slice(0, 10)}, but this worktree's native fingerprint ${fingerprint} differs from it: commit the native changes, then run ${commandLine} again.`,
    );
  }
  console.log("The iOS dev client is ready. Next: mobile-open.");
}
