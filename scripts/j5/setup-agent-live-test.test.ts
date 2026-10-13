// @effect-diagnostics nodeBuiltinImport:off globalDate:off - builds throwaway directory layouts to exercise the path guards.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PAIRING_SCOPES,
  classifyServer,
  formatGuest,
  formatInstructions,
  guestRefusal,
  parseGuest,
  LiveTestRefusal,
  addRemoteUrl,
  baseEnvironment,
  baseProgress,
  listsPeer,
  peerRepairCommand,
  peerSteps,
  isOwnMapping,
  mappingCleanup,
  mappingsFromStatus,
  shareRefusal,
  tailnetMappings,
  liveTestEnvironment,
  type LiveTestMode,
  modeRefusal,
  parseCommand,
  readServerLog,
  resolveLiveTestPaths,
  runInOwnGroup,
  startRefusal,
  type ServerLogFacts,
} from "./setup-agent-live-test.ts";

/** A fake machine: a home with a live `.j5code`, a main checkout, and a linked worktree below the live home. */
function makeLayout() {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-live-test-script-")),
  );
  const homeDirectory = NodePath.join(base, "home");
  const liveHome = NodePath.join(homeDirectory, ".j5code");
  const mainCheckout = NodePath.join(base, "main");
  const worktree = NodePath.join(liveHome, "worktrees", "project", "feature");
  NodeFS.mkdirSync(NodePath.join(liveHome, "userdata"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(mainCheckout, ".git"), { recursive: true });
  NodeFS.mkdirSync(worktree, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(worktree, ".git"),
    `gitdir: ${mainCheckout}/.git/worktrees/feature\n`,
  );
  return { base, homeDirectory, liveHome, mainCheckout, worktree };
}

const refusal = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (cause) {
    assert.instanceOf(cause, LiveTestRefusal);
    return (cause as LiveTestRefusal).message;
  }
  return assert.fail("expected a refusal");
};

describe("resolveLiveTestPaths", () => {
  it("puts the test state in a linked worktree's own .j5code, even below the live home", async () => {
    const layout = makeLayout();
    const paths = await resolveLiveTestPaths({
      checkout: layout.worktree,
      homeDirectory: layout.homeDirectory,
      environment: { J5CODE_HOME: layout.liveHome },
    });
    assert.equal(paths.root, NodePath.join(layout.worktree, ".j5code", "live-test"));
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses the main checkout and a directory that is no checkout", async () => {
    const layout = makeLayout();
    for (const checkout of [layout.mainCheckout, layout.base]) {
      assert.include(
        await refusal(
          resolveLiveTestPaths({ checkout, homeDirectory: layout.homeDirectory, environment: {} }),
        ),
        "not a linked git worktree",
      );
    }
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses a .j5code that links out of the worktree", async () => {
    const layout = makeLayout();
    NodeFS.symlinkSync(layout.liveHome, NodePath.join(layout.worktree, ".j5code"));
    assert.include(
      await refusal(
        resolveLiveTestPaths({
          checkout: layout.worktree,
          homeDirectory: layout.homeDirectory,
          environment: {},
        }),
      ),
      "outside this worktree's .j5code",
    );
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses when the worktree's .j5code is the live home", async () => {
    const layout = makeLayout();
    const environment = { J5CODE_HOME: NodePath.join(layout.worktree, ".j5code") };
    assert.include(
      await refusal(
        resolveLiveTestPaths({
          checkout: layout.worktree,
          homeDirectory: layout.homeDirectory,
          environment,
        }),
      ),
      "is the live home",
    );
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });
});

describe("resolveLiveTestPaths after a build", () => {
  const resolve = (layout: ReturnType<typeof makeLayout>) =>
    resolveLiveTestPaths({
      checkout: layout.worktree,
      homeDirectory: layout.homeDirectory,
      environment: { J5CODE_HOME: layout.liveHome },
    });

  it("refuses a home or repository that has become a link out of the build", async () => {
    for (const [name, target] of [
      ["home", (layout: ReturnType<typeof makeLayout>) => layout.liveHome],
      ["test-repo", (layout: ReturnType<typeof makeLayout>) => layout.mainCheckout],
      // The second server's home in the peer modes is held to the same rule.
      ["remote/home", (layout: ReturnType<typeof makeLayout>) => layout.liveHome],
      // The base checkout is deleted by rebuild, so it must be a directory of this build.
      ["base", (layout: ReturnType<typeof makeLayout>) => layout.mainCheckout],
      // The state directory inside a real home, linked to the live database's directory.
      [
        "home/userdata",
        (layout: ReturnType<typeof makeLayout>) => NodePath.join(layout.liveHome, "userdata"),
      ],
    ] as const) {
      const layout = makeLayout();
      const root = NodePath.join(layout.worktree, ".j5code", "live-test");
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
      NodeFS.symlinkSync(target(layout), NodePath.join(root, name));
      assert.include(await refusal(resolve(layout)), `outside ${root}`);
      NodeFS.rmSync(layout.base, { recursive: true, force: true });
    }
  });

  it("refuses a Remote home that is Local's home under another name", async () => {
    for (const link of ["remote/home", "remote/home/userdata", "remote/test-repo"]) {
      const layout = makeLayout();
      const root = NodePath.join(layout.worktree, ".j5code", "live-test");
      NodeFS.mkdirSync(NodePath.join(root, "home", "userdata"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(root, "test-repo"), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, link)), { recursive: true });
      // Inside the root, so the containment check alone would let it through.
      NodeFS.symlinkSync(
        NodePath.join(root, link.replace("remote/", "")),
        NodePath.join(root, link),
      );
      assert.include(await refusal(resolve(layout)), "must have separate homes and repositories");
      NodeFS.rmSync(layout.base, { recursive: true, force: true });
    }
  });

  it("derives the home from the worktree, whatever a manifest might say", async () => {
    const layout = makeLayout();
    const root = NodePath.join(layout.worktree, ".j5code", "live-test");
    NodeFS.mkdirSync(NodePath.join(root, "home"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, "manifest.json"),
      JSON.stringify({ home: layout.liveHome, testRepo: layout.mainCheckout }),
    );
    const paths = await resolve(layout);
    assert.equal(paths.home, NodePath.join(root, "home"));
    assert.equal(paths.testRepo, NodePath.join(root, "test-repo"));
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses a worktree whose path would break the commands it prints", async () => {
    for (const name of ["with space", "semi;colon", "dollar$(x)"]) {
      const layout = makeLayout();
      const worktree = NodePath.join(NodePath.dirname(layout.worktree), name);
      NodeFS.renameSync(layout.worktree, worktree);
      assert.include(
        await refusal(resolve({ ...layout, worktree })),
        "contains a space or a shell character",
      );
      NodeFS.rmSync(layout.base, { recursive: true, force: true });
    }
  });
});

describe("startRefusal", () => {
  const facts: ServerLogFacts = {
    serverPort: 15634,
    webPort: 7594,
    baseDir: "/w/.j5code/live-test/home",
    pairingUrl: undefined,
    recovered: false,
    sharedUrl: undefined,
    shareFailure: undefined,
  };
  const input = { facts, home: "/w/.j5code/live-test/home", inheritedPort: "5773" };

  it("lets a server on the test home and its own port continue, before and after it reports", () => {
    assert.isUndefined(startRefusal(input));
    assert.isUndefined(
      startRefusal({ ...input, facts: { ...facts, serverPort: undefined, baseDir: undefined } }),
    );
  });

  it("abandons a server on another home", () => {
    assert.include(
      startRefusal({ ...input, facts: { ...facts, baseDir: "/w/.j5code" } }) ?? "",
      "not the test home",
    );
  });

  it("abandons a server on the live port or the port the shell inherited", () => {
    assert.include(
      startRefusal({ ...input, inheritedPort: undefined, facts: { ...facts, serverPort: 5773 } }) ??
        "",
      "live server's port",
    );
    assert.include(startRefusal({ ...input, inheritedPort: "15634" }) ?? "", "live server's port");
  });

  it("abandons a server that had to be shared and was not", () => {
    const unshared = { ...facts, shareFailure: "permission denied" };
    assert.include(
      startRefusal({ ...input, facts: unshared, requireShare: true }) ?? "",
      "could not share on the tailnet: permission denied",
    );
    // A test server that nobody asked to share carries on.
    assert.isUndefined(startRefusal({ ...input, facts: unshared }));
  });
});

describe("tailnet mappings", () => {
  const status = [
    "https://openclaw.tail477304.ts.net:8444 (tailnet only)",
    "|-- / proxy http://127.0.0.1:5773",
    "",
    "https://openclaw.tail477304.ts.net:7594 (tailnet only)",
    "|-- / proxy http://localhost:7594",
  ].join("\n");
  const mappings = tailnetMappings(status);

  it("reads each mapped port with where it proxies to", () => {
    assert.deepEqual(mappings, [
      { port: 8444, targets: ["http://127.0.0.1:5773"] },
      { port: 7594, targets: ["http://localhost:7594"] },
    ]);
    assert.deepEqual(tailnetMappings("No serve config\n"), []);
  });

  it("calls a mapping ours only when it proxies to our own web port on loopback", () => {
    for (const target of ["http://localhost:7594", "http://127.0.0.1:7594", "http://[::1]:7594"]) {
      assert.isTrue(isOwnMapping({ port: 7594, targets: [target] }, 7594));
    }
    // The live install's mapping, seen from a worktree whose web port is 8444.
    assert.isFalse(isOwnMapping({ port: 8444, targets: ["http://127.0.0.1:5773"] }, 8444));
    assert.isFalse(isOwnMapping({ port: 7594, targets: ["http://10.0.0.5:7594"] }, 7594));
    assert.isFalse(isOwnMapping({ port: 7594, targets: ["http://localhost:75940"] }, 7594));
    assert.isFalse(isOwnMapping({ port: 7594, targets: [] }, 7594));
    // An extra route to somewhere else makes the whole mapping not ours.
    assert.isFalse(
      isOwnMapping({ port: 7594, targets: ["http://localhost:7594", "http://localhost:9"] }, 7594),
    );
  });

  const allowed = () => true;

  it("never shares on a port browsers refuse, using the dev runner's own list", async () => {
    // Pinning the port skips the runner's check, so the script applies it.
    const runner = (await import(NodePath.join(import.meta.dirname, "../dev-runner.ts"))) as {
      readonly isBrowserAllowedPort: (port: number) => boolean;
    };
    for (const port of [6000, 6566, 6667, 6697]) {
      assert.include(
        shareRefusal(port, [], runner.isBrowserAllowedPort) ?? "",
        "browsers refuse to open",
      );
    }
    assert.isUndefined(shareRefusal(7594, [], runner.isBrowserAllowedPort));
  });

  it("never shares on the live install's tailnet port", () => {
    assert.include(shareRefusal(8444, [], allowed) ?? "", "live install's tailnet port");
    assert.include(shareRefusal(8444, mappings, allowed) ?? "", "live install's tailnet port");
  });

  it("never shares over a mapping this server did not make", () => {
    const foreign = [{ port: 7000, targets: ["http://127.0.0.1:3000"] }];
    assert.include(shareRefusal(7000, foreign, allowed) ?? "", "this server did not set up");
  });

  it("treats a failed status read as an error, not as nothing mapped", () => {
    assert.throws(
      () => mappingsFromStatus({ status: 1, stdout: "", stderr: "tailscaled is not running" }),
      /cannot be read:\ntailscaled is not running/,
    );
    assert.throws(
      () => mappingsFromStatus({ status: null, stdout: "", stderr: "" }),
      LiveTestRefusal,
    );
    assert.deepEqual(mappingsFromStatus({ status: 0, stdout: status, stderr: "" }), mappings);
  });

  it("on stop removes only a mapping this run made", () => {
    const shared = {
      serverPort: 15634,
      webPort: 7594,
      baseDir: "/w/.j5code/live-test/home",
      pairingUrl: "https://host.ts.net:7594/pair#token=T",
      recovered: true,
      sharedUrl: "https://host.ts.net:7594/",
      shareFailure: undefined,
    };
    assert.deepEqual(mappingCleanup(shared, mappings), { kind: "remove", port: 7594 });
    // Already removed by the dev runner on its way out.
    assert.deepEqual(mappingCleanup(shared, [mappings[0]!]), { kind: "nothing" });
    // This run's log never recorded a share: whatever is on the port is not ours to touch.
    assert.deepEqual(mappingCleanup({ ...shared, sharedUrl: undefined }, mappings), {
      kind: "nothing",
    });
    // The port now carries someone else's mapping, such as the live install's.
    assert.deepEqual(mappingCleanup({ ...shared, webPort: 8444 }, mappings), {
      kind: "foreign",
      port: 8444,
      targets: ["http://127.0.0.1:5773"],
    });
  });

  it("shares on a free port, and over its own leftover mapping", () => {
    assert.isUndefined(shareRefusal(7000, mappings, allowed));
    assert.isUndefined(shareRefusal(7594, mappings, allowed));
  });
});

describe("liveTestEnvironment", () => {
  it("drops what the live server exports and stops the dev server adopting its cwd", () => {
    const environment = liveTestEnvironment(
      {
        T3CODE_PORT: "5773",
        T3CODE_HOST: "127.0.0.1",
        J5CODE_HOME: "/home/dev/.j5code",
        J5CODE_SERVER_NAME: "live",
        PATH: "/usr/bin",
        KEEP: "1",
      },
      "/work/tree",
    );
    assert.deepEqual(environment, {
      KEEP: "1",
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      PATH: `/work/tree/node_modules/.bin${NodePath.delimiter}/usr/bin`,
    });
  });
});

describe("readServerLog", () => {
  it("reads the ports, the home and the newest pairing URL through the logger's colours", () => {
    const log = [
      "\u001B[32m[dev-runner] mode=dev source=worktree /w serverPort=15634 webPort=7594 baseDir=/w/.j5code/live-test/home\u001B[0m",
      "  pairingUrl: http://localhost:7594/pair#token=OLD",
      "[22:02:53.552] INFO (#4139): V2 orchestration recovery completed",
      "  \u001B[1mpairingUrl\u001B[0m: http://localhost:7594/pair#token=NEW",
    ].join("\n");
    assert.deepEqual(readServerLog(log), {
      serverPort: 15634,
      webPort: 7594,
      baseDir: "/w/.j5code/live-test/home",
      pairingUrl: "http://localhost:7594/pair#token=NEW",
      recovered: true,
      sharedUrl: undefined,
      shareFailure: undefined,
    });
    assert.deepEqual(readServerLog("starting"), {
      serverPort: undefined,
      webPort: undefined,
      baseDir: undefined,
      pairingUrl: undefined,
      recovered: false,
      sharedUrl: undefined,
      shareFailure: undefined,
    });
  });

  it("reads where the dev runner shared the server, or why it could not", () => {
    assert.equal(
      readServerLog(
        "[23:01:02.003] INFO (#1): [dev-runner] shared on tailnet: https://host.ts.net:7594",
      ).sharedUrl,
      "https://host.ts.net:7594",
    );
    assert.equal(
      readServerLog(
        "[23:01:02.003] WARN (#1): [dev-runner] could not share on the tailnet: permission denied. Continuing unshared.",
      ).shareFailure,
      "permission denied. Continuing unshared.",
    );
  });
});

describe("classifyServer", () => {
  const facts: ServerLogFacts = {
    serverPort: 15634,
    webPort: 7594,
    baseDir: "/w/.j5code/live-test/home",
    pairingUrl: "http://localhost:7594/pair#token=T",
    recovered: true,
    sharedUrl: undefined,
    shareFailure: undefined,
  };
  const ours = {
    worktree: "/w",
    record: { processGroup: 100, leaderStartTime: "4242" },
    facts,
    groupMembers: () => [100, 101],
    listenerOn: (): number | undefined => 101,
    processGroupOf: (): number | undefined => 100,
    startTimeOf: (): string | undefined => "4242",
    cwdOf: (pid: number): string | undefined => (pid === 100 ? "/w" : "/w/apps/server"),
  };

  it("is running when the port's listener is in the recorded group and inside the worktree", () => {
    assert.equal(classifyServer(ours).kind, "running");
  });

  it("is stopped with no record, or once the recorded group is empty", () => {
    assert.equal(classifyServer({ ...ours, record: undefined }).kind, "stopped");
    assert.equal(classifyServer({ ...ours, groupMembers: () => [] }).kind, "stopped");
  });

  it("is ours but not serving while it boots, after its server crashes, or if the port went elsewhere", () => {
    for (const other of [
      { facts: { ...facts, serverPort: undefined } },
      { listenerOn: () => undefined },
      // The port now belongs to another server, such as the live one.
      { processGroupOf: () => 999 },
      { cwdOf: (pid: number) => (pid === 100 ? "/w" : "/somewhere/else") },
    ]) {
      assert.equal(classifyServer({ ...ours, ...other }).kind, "notServing");
    }
  });

  it("never treats a live group as ours when its leader is not the process that was spawned", () => {
    const badLeaders = [
      // The pid was recycled: same number, later start.
      { startTimeOf: () => "9999" },
      // The leader exited and only stragglers remain.
      { startTimeOf: () => undefined },
      { cwdOf: (pid: number) => (pid === 100 ? "/somewhere/else" : "/w/apps/server") },
      // A sibling directory that shares the worktree's name as a prefix.
      { cwdOf: (pid: number) => (pid === 100 ? "/w-other" : "/w/apps/server") },
      { cwdOf: (pid: number) => (pid === 100 ? undefined : "/w/apps/server") },
    ];
    for (const other of badLeaders) {
      // A healthy listener in the group proves nothing about who leads it.
      assert.equal(classifyServer({ ...ours, ...other }).kind, "unverified");
      assert.equal(
        classifyServer({ ...ours, ...other, listenerOn: () => undefined }).kind,
        "unverified",
      );
    }
  });
});

describe("parseCommand", () => {
  it("defaults to a start in default mode", () => {
    assert.deepEqual(parseCommand([]), { command: "start", mode: "default" });
    assert.deepEqual(parseCommand(["restart"]), { command: "restart", mode: "default" });
  });

  it("takes a mode flag on a start and on rebuild, in either position", () => {
    assert.deepEqual(parseCommand(["--fresh"]), { command: "start", mode: "fresh" });
    assert.deepEqual(parseCommand(["rebuild", "--fresh"]), { command: "rebuild", mode: "fresh" });
    assert.deepEqual(parseCommand(["--fresh", "rebuild"]), { command: "rebuild", mode: "fresh" });
    assert.deepEqual(parseCommand(["--peer"]), { command: "start", mode: "peer" });
    assert.deepEqual(parseCommand(["rebuild", "--peer", "--poll"]), {
      command: "rebuild",
      mode: "peer-poll",
    });
    assert.deepEqual(parseCommand(["--poll", "--peer"]), { command: "start", mode: "peer-poll" });
    assert.deepEqual(parseCommand(["rebuild", "--for-dev"]), {
      command: "rebuild",
      mode: "for-dev",
    });
    assert.deepEqual(parseCommand(["--base", "origin/j5/main"]), {
      command: "start",
      mode: "base",
      baseRef: "origin/j5/main",
    });
    assert.deepEqual(parseCommand(["rebuild", "--base", "v1"]), {
      command: "rebuild",
      mode: "base",
      baseRef: "v1",
    });
  });

  it("refuses unknown words and flags, and a mode flag where none applies", () => {
    for (const args of [
      ["bogus"],
      ["stop", "now"],
      // --base needs a ref, compares against the default build only, and is not a ref named "rebuild".
      ["--base"],
      ["--base", "--fresh"],
      ["--base", "main", "--fresh"],
      ["--base", "main", "--peer"],
      ["status", "--base", "main"],
      // The ref is printed inside commands; git allows these characters in ref names.
      ["--base", "main;rm"],
      ["--base", "$(x)"],
      ["--base", "a b"],
      ["--base", "-x"],
      // A shell expands a leading tilde when the printed command is pasted.
      ["--base", "~user"],
      ["--fresh", "--fresh"],
      // --poll says how two servers peer; it means nothing alone or with an empty home.
      ["--poll"],
      ["--fresh", "--peer"],
      ["--for-dev", "--peer"],
      ["status", "--peer"],
      // These act on whatever is built; a flag would suggest they could change it.
      ["status", "--fresh"],
      ["restart", "--fresh"],
      ["stop", "--fresh"],
    ]) {
      assert.throws(() => parseCommand(args), LiveTestRefusal);
    }
  });
});

describe("modeRefusal", () => {
  const commands = {
    startCommand: (mode: LiveTestMode) => `start:${mode}`,
    rebuildCommand: (mode: LiveTestMode) => `rebuild:${mode}`,
  };

  it("lets a start use a home built in the mode it asks for", () => {
    assert.isUndefined(modeRefusal({ requested: "fresh", built: "fresh", ...commands }));
    assert.isUndefined(modeRefusal({ requested: "default", built: "default", ...commands }));
  });

  it("refuses the other mode and names both ways forward", () => {
    // A bare start asks for the test project; an empty home must not answer it.
    const bare = modeRefusal({ requested: "default", built: "fresh", ...commands }) ?? "";
    assert.include(bare, "built in fresh mode, not default mode");
    assert.include(bare, "start:fresh");
    assert.include(bare, "rebuild:default");
    const fresh = modeRefusal({ requested: "fresh", built: "default", ...commands }) ?? "";
    assert.include(fresh, "start:default");
    assert.include(fresh, "rebuild:fresh");
  });
});

describe("peerSteps", () => {
  const local = {
    home: "/w/home",
    origin: "http://127.0.0.1:1",
    environmentId: "L",
    name: "Local",
  };
  const remote = {
    home: "/w/remote/home",
    origin: "http://127.0.0.1:2",
    environmentId: "R",
    name: "Remote",
  };

  it("has the issuer mint for the holder's environment, and the holder record the issuer's origin", () => {
    const steps = peerSteps({ issuer: remote, holder: local, poll: false });
    assert.deepEqual(steps.credential, [
      "credential",
      "--base-dir",
      "/w/remote/home",
      "--origin",
      "http://127.0.0.1:2",
      "--for",
      "L",
      "--label",
      "Local",
      "--credential-only",
    ]);
    assert.deepEqual(steps.add("SECRET"), [
      "add",
      "--base-dir",
      "/w/home",
      "--origin",
      "http://127.0.0.1:1",
      "--peer-origin",
      "http://127.0.0.1:2",
      "--credential",
      "SECRET",
    ]);
  });

  it("in poll mode has the issuer store messages and the holder poll for them", () => {
    const steps = peerSteps({ issuer: local, holder: remote, poll: true });
    assert.equal(steps.credential.at(-1), "--store");
    assert.equal(steps.add("SECRET").at(-1), "--poll");
  });
});

describe("peerRepairCommand", () => {
  it("is the same start when both servers are up, and restart when either is not", () => {
    assert.equal(peerRepairCommand("peer", "RUNNING", "RUNNING"), "--peer");
    assert.equal(peerRepairCommand("peer-poll", "RUNNING", "RUNNING"), "--peer --poll");
    // A start would only wait on a server that is there but not serving.
    assert.equal(peerRepairCommand("peer", "RUNNING", "NOT SERVING"), "restart");
    assert.equal(peerRepairCommand("peer", "NOT SERVING", "RUNNING"), "restart");
    assert.equal(peerRepairCommand("peer", "RUNNING", "STOPPED"), "restart");
    assert.equal(peerRepairCommand("peer", "RUNNING", "UNVERIFIED"), "restart");
  });
});

describe("listsPeer", () => {
  const list = (peers: ReadonlyArray<object>) => JSON.stringify({ ok: true, peers });

  it("is true only when the server's own list names the other with no error", () => {
    assert.isTrue(listsPeer(list([{ label: "Remote", lastError: null }]), "Remote"));
    // Two ports listening is not peering: an empty list is the usual unpeered state.
    assert.isFalse(listsPeer(list([]), "Remote"));
    assert.isFalse(listsPeer(list([{ label: "Local", lastError: null }]), "Remote"));
    assert.isFalse(listsPeer(list([{ label: "Remote", lastError: "hello failed" }]), "Remote"));
  });

  it("is false when the list could not be read", () => {
    assert.isFalse(listsPeer(undefined, "Remote"));
    assert.isFalse(listsPeer("", "Remote"));
    assert.isFalse(listsPeer("not json", "Remote"));
  });
});

describe("addRemoteUrl", () => {
  it("points Local's web app at Remote's server with Remote's token", () => {
    assert.equal(
      addRemoteUrl({
        localWebPort: 7594,
        remoteServerPort: 15961,
        remotePairingUrl: "http://localhost:7921/pair#token=ABC123",
      }),
      "http://localhost:7594/pair?host=http%3A%2F%2Flocalhost%3A15961&label=Remote#token=ABC123",
    );
  });

  it("is absent when no token could be minted for Remote", () => {
    assert.isUndefined(
      addRemoteUrl({ localWebPort: 7594, remoteServerPort: 15961, remotePairingUrl: undefined }),
    );
  });
});

describe("runInOwnGroup", () => {
  const options = (deadline: number) => ({ cwd: NodeOS.tmpdir(), env: process.env, deadline });

  it("returns a finished command's status and what it printed", async () => {
    const done = await runInOwnGroup(
      process.execPath,
      ["-e", "console.log('built'); console.error('warned'); process.exit(3)"],
      options(Date.now() + 20_000),
    );
    assert.deepEqual(
      { status: done.status, timedOut: done.timedOut },
      { status: 3, timedOut: false },
    );
    assert.include(done.output, "built");
    assert.include(done.output, "warned");
  });

  it("at the deadline ends the command and everything it started", async () => {
    const pidFile = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-live-test-group-")),
      "grandchild.pid",
    );
    // A step whose child starts a grandchild that would outlive it, as an
    // install or a build does. Killing the child alone would leave it running.
    const step = `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const cut = await runInOwnGroup(process.execPath, ["-e", step], options(Date.now() + 1_500));
    assert.isTrue(cut.timedOut);
    assert.isBelow(Date.now() - started, 10_000);
    const grandchild = Number(NodeFS.readFileSync(pidFile, "utf8"));
    assert.isAbove(grandchild, 0);
    assert.isFalse(NodeFS.existsSync(`/proc/${grandchild}`), "the grandchild is still running");
    NodeFS.rmSync(NodePath.dirname(pidFile), { recursive: true, force: true });
  });
});

describe("runInOwnGroup against a command that will not stop", () => {
  it("kills a command that ignores the request to end, and returns", async () => {
    const started = Date.now();
    const cut = await runInOwnGroup(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { cwd: NodeOS.tmpdir(), env: process.env, deadline: Date.now() + 500 },
    );
    assert.isTrue(cut.timedOut);
    // Half a second to the deadline, five more of grace, then the kill.
    assert.isBelow(Date.now() - started, 15_000);
  }, 30_000);
});

describe("baseProgress", () => {
  const ready = {
    checkoutHead: "abc",
    sameRepository: true,
    commit: "abc",
    installed: true,
    serverRunning: true,
    failedStep: undefined,
  };

  it("reports each step from what is on disk", () => {
    assert.deepEqual(baseProgress(ready), { checkout: "done", install: "done", server: "done" });
    assert.deepEqual(baseProgress({ ...ready, serverRunning: false }), {
      checkout: "done",
      install: "done",
      server: "not done",
    });
    assert.deepEqual(
      baseProgress({ ...ready, checkoutHead: undefined, installed: false, serverRunning: false }),
      { checkout: "not done", install: "not done", server: "not done" },
    );
  });

  it("never counts a later step as done on top of an earlier one that is not", () => {
    // An install marker left beside a checkout that has since gone or moved proves nothing.
    assert.deepEqual(baseProgress({ ...ready, checkoutHead: undefined }), {
      checkout: "not done",
      install: "not done",
      server: "not done",
    });
    assert.deepEqual(baseProgress({ ...ready, installed: false }), {
      checkout: "done",
      install: "not done",
      server: "not done",
    });
  });

  it("calls a checkout at another commit, or of another repository, failed", () => {
    assert.equal(baseProgress({ ...ready, checkoutHead: "def" }).checkout, "failed");
    assert.equal(baseProgress({ ...ready, sameRepository: false }).checkout, "failed");
  });

  it("shows the step that last failed as failed until it succeeds", () => {
    assert.deepEqual(
      baseProgress({ ...ready, installed: false, serverRunning: false, failedStep: "install" }),
      { checkout: "done", install: "failed", server: "not done" },
    );
    assert.equal(
      baseProgress({ ...ready, serverRunning: false, failedStep: "server" }).server,
      "failed",
    );
    assert.equal(
      baseProgress({ ...ready, checkoutHead: undefined, failedStep: "checkout" }).checkout,
      "failed",
    );
  });
});

describe("baseEnvironment", () => {
  const inherited = { T3CODE_PORT: "5773", J5CODE_HOME: "/home/dev/.j5code", PATH: "/usr/bin" };

  it("gives the base the clock the head was built with, on every start", () => {
    const manifest = { baseClock: 1_760_000_000_000 };
    const first = baseEnvironment(inherited, "/w", manifest);
    // A retry in a later invocation has no J5_LIVE_TEST_NOW of its own; the manifest supplies it.
    const retry = baseEnvironment({ PATH: "/usr/bin" }, "/w", manifest);
    assert.equal(first.J5_LIVE_TEST_NOW, "1760000000000");
    assert.equal(retry.J5_LIVE_TEST_NOW, "1760000000000");
    assert.isUndefined(first.T3CODE_PORT);
    assert.isUndefined(first.J5CODE_HOME);
  });

  it("sets no clock for a build that recorded none", () => {
    assert.isUndefined(baseEnvironment(inherited, "/w", {}).J5_LIVE_TEST_NOW);
  });
});

describe("PAIRING_SCOPES", () => {
  it("is the scope set of the server's startup pairing URL", async () => {
    // The contracts package is not a dependency of the scripts package, so load it by path.
    const contracts = (await import(
      NodePath.join(import.meta.dirname, "../../packages/contracts/src/auth.ts")
    )) as { readonly AuthAdministrativeScopes: ReadonlyArray<string> };
    assert.sameMembers([...PAIRING_SCOPES], [...contracts.AuthAdministrativeScopes]);
  });
});

describe("formatInstructions", () => {
  const worktree = "/w";
  const server = (root: string) => ({
    worktree,
    home: `${root}/home`,
    testRepo: `${root}/test-repo`,
    log: `${root}/server.log`,
    record: `${root}/server.json`,
  });
  const paths = {
    ...server("/w/.j5code/live-test"),
    root: "/w/.j5code/live-test",
    manifest: "/w/.j5code/live-test/manifest.json",
    base: "/w/.j5code/live-test/base",
    remote: { ...server("/w/.j5code/live-test/remote"), root: "/w/.j5code/live-test/remote" },
  };
  const facts: ServerLogFacts = {
    serverPort: 13000,
    webPort: 5000,
    baseDir: paths.home,
    pairingUrl: undefined,
    recovered: true,
    sharedUrl: undefined,
    shareFailure: undefined,
  };
  const built = {
    project: { id: "project-1", title: "Live test repo" },
    defaultModel: "claude-haiku-5-5",
    personas: [],
    playbooks: [],
    holdScript: "scripts/hold.sh",
  };
  const ownerLines = (output: string) =>
    output.split("\n").filter((line) => line.trimStart().startsWith("Owner "));

  it("names the owner the home was built with", () => {
    const output = formatInstructions({
      paths,
      manifest: { ...built, ownerName: "Test owner" },
      facts,
      pairingUrl: "http://localhost:5000/pair#token=T",
    });
    assert.deepEqual(ownerLines(output), ["  Owner         Test owner"]);
    assert.include(output, 'guest "<name>"');
  });

  it("names each server's owner in a peer build", () => {
    const output = formatInstructions({
      paths,
      manifest: { ...built, mode: "peer", ownerName: "Local owner" },
      facts,
      pairingUrl: undefined,
      remote: { facts, ownerName: "Remote owner", addToBrowserUrl: undefined, peered: true },
    });
    assert.deepEqual(ownerLines(output), [
      "  Owner         Local owner",
      "  Owner         Remote owner",
    ]);
  });

  it("has no owner line for a home built without one, and no guest command for a fresh home", () => {
    // A home an older generator built, as a base checkout's can be.
    assert.deepEqual(
      ownerLines(formatInstructions({ paths, manifest: built, facts, pairingUrl: undefined })),
      [],
    );
    const fresh = formatInstructions({
      paths,
      manifest: { mode: "fresh" },
      facts,
      pairingUrl: undefined,
    });
    assert.deepEqual(ownerLines(fresh), []);
    assert.notInclude(fresh, "guest");
  });
});

describe("parseGuest", () => {
  it("defaults to a view grant on the test project", () => {
    assert.deepEqual(parseGuest(["Priya"]), { name: "Priya", level: "view" });
  });

  it("takes a thread or a project, and a level", () => {
    assert.deepEqual(parseGuest(["Sam (QA)", "--thread", "t-1", "--level", "collaborate"]), {
      name: "Sam (QA)",
      level: "collaborate",
      target: { kind: "thread", id: "t-1" },
    });
    assert.deepEqual(parseGuest(["--project", "p-1", "Priya"]), {
      name: "Priya",
      level: "view",
      target: { kind: "project", id: "p-1" },
    });
  });

  it("refuses no name, two names, both targets, an unknown level and an unknown flag", () => {
    for (const args of [
      [],
      ["  "],
      ["Priya", "Sam"],
      ["Priya", "--thread", "t-1", "--project", "p-1"],
      ["Priya", "--level", "admin"],
      ["Priya", "--fresh"],
      // Guests go to Local in every mode.
      ["Priya", "--remote"],
    ]) {
      assert.throws(() => parseGuest(args), LiveTestRefusal, /Usage: .* guest "<name>"/);
    }
  });

  it("refuses the base server", () => {
    assert.throws(() => parseGuest(["Priya", "--base"]), LiveTestRefusal, /head server only/);
  });
});

describe("guestRefusal", () => {
  const startCommand = "node script";
  const ask = (built: LiveTestMode | undefined, serving = true) =>
    guestRefusal({ built, serving, startCommand });

  it("lets a guest be added to a running default, base or peer server", () => {
    for (const built of ["default", "base", "peer", "peer-poll"] as const) {
      assert.isUndefined(ask(built));
    }
  });

  it("refuses a fresh home and a server for the developer, running or not", () => {
    assert.include(ask("fresh"), "--fresh");
    assert.include(ask("for-dev", false), "--for-dev");
  });

  it("refuses when no server is running, and says how to start one", () => {
    assert.include(ask("default", false), "Start it with: node script");
    assert.include(ask(undefined, false), "Start it with: node script");
    assert.include(ask("peer", false), "Start it with: node script");
  });
});

describe("formatGuest", () => {
  const added = {
    personId: "human:1",
    displayName: "Priya",
    level: "view",
    target: { kind: "project", id: "p-1" },
    pairingUrl: "http://localhost:5000/pair#token=T&j5share=1",
  } as const;

  it("states who was added, the level, the URL and how to open it, and nothing else", () => {
    assert.equal(
      formatGuest({ ...added, peer: false }),
      `Added a guest to the live-test server:

  Name          Priya
  Person id     human:1
  Granted       view on project p-1
  Pairing URL   http://localhost:5000/pair#token=T&j5share=1

Open the pairing URL in a new incognito tab, one tab per person.
`,
    );
  });

  it("in a peer build says the guest went to Local, and that Remote is not reached", () => {
    const output = formatGuest({ ...added, peer: true });
    assert.include(output, "Added a guest to the live-test server Local:");
    assert.include(output, "Guests are added to Local only; this command does not reach Remote.");
  });
});
