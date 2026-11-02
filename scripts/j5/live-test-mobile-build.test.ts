// @effect-diagnostics nodeBuiltinImport:off - runs the iOS build scripts' guards in a throwaway home.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ensureCheckoutScript,
  iosBuildScript,
  parseMobileBuild,
  remotePath,
} from "./live-test-mobile-build.ts";
import { LiveTestRefusal } from "./setup-agent-live-test.ts";

/** A checkout path with the characters a person's path can have. */
const checkout = "~/rig dir/it's checkout";

const homeFixture = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-mobile-build-"));
  return {
    home,
    at: (...parts: ReadonlyArray<string>) => NodePath.join(home, ...parts),
    run: (script: string) =>
      NodeChildProcess.spawnSync("sh", ["-c", script], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }),
    [Symbol.dispose]: () => NodeFS.rmSync(home, { recursive: true, force: true }),
  };
};

describe("parseMobileBuild", () => {
  it("takes one platform and nothing else", () => {
    assert.strictEqual(parseMobileBuild(["ios"]), "ios");
    assert.strictEqual(parseMobileBuild(["android"]), "android");
    for (const args of [[], ["windows"], ["ios", "android"]]) {
      assert.throws(() => parseMobileBuild(args), LiveTestRefusal);
    }
  });
});

describe("ensureCheckoutScript", () => {
  it("makes a marked repository the first time, and refuses a directory the rig did not make", () => {
    using fixture = homeFixture();
    const made = fixture.run(ensureCheckoutScript({ checkout }));
    assert.strictEqual(made.status, 0, made.stderr);
    assert.isTrue(NodeFS.existsSync(fixture.at("rig dir", "it's checkout", ".git")));
    assert.isTrue(NodeFS.existsSync(fixture.at("rig dir", "it's checkout", ".j5-mobile-rig")));
    assert.strictEqual(fixture.run(ensureCheckoutScript({ checkout })).status, 0);

    NodeFS.mkdirSync(fixture.at('odd "$name" `x`'));
    const odd = fixture.run(ensureCheckoutScript({ checkout: '~/odd "$name" `x`' }));
    assert.strictEqual(odd.status, 76);
    assert.include(odd.stderr, '~/odd "$name" `x` on the iOS host was not made by the mobile rig');

    NodeFS.mkdirSync(fixture.at("someone's clone"));
    const foreign = fixture.run(ensureCheckoutScript({ checkout: "~/someone's clone" }));
    assert.strictEqual(foreign.status, 76);
    assert.include(foreign.stderr, "not made by the mobile rig");
  });
});

describe("iosBuildScript", () => {
  // Only the lock is exercised: everything after it needs the iOS host's checkout and toolchain.
  const prelude = (owner: string) =>
    iosBuildScript({
      commit: "abc123",
      owner,
      checkout,
      envFile: undefined,
      configPath: "/cfg/mobile-rig.json",
    }).split(`cd ${remotePath(checkout)}`)[0]!;
  const lock = ["rig dir", "it's checkout.build-lock"] as const;

  it("stops at a signal instead of going on without the lock", () => {
    using fixture = homeFixture();
    NodeFS.mkdirSync(fixture.at("rig dir"));
    // sh, like the iOS host's zsh, resumes after a trap that does not exit.
    const run = fixture.run(`${prelude("/w/a")}kill -TERM $$\necho CONTINUED\n`);
    assert.notStrictEqual(run.status, 0);
    assert.notInclude(run.stdout, "CONTINUED");
    assert.isFalse(NodeFS.existsSync(fixture.at(...lock)));
  });

  it("refuses while another build holds the lock, naming its owner, and releases its own", () => {
    using fixture = homeFixture();
    NodeFS.mkdirSync(fixture.at(...lock), { recursive: true });
    NodeFS.writeFileSync(fixture.at(...lock, "owner"), "/w/other\n");
    const held = fixture.run(prelude("/w/it's-mine"));
    assert.strictEqual(held.status, 75);
    assert.include(held.stderr, "/w/other");

    NodeFS.rmSync(fixture.at(...lock), { recursive: true });
    const free = fixture.run(prelude("/w/it's-mine"));
    assert.strictEqual(free.status, 0, free.stderr);
    assert.isFalse(NodeFS.existsSync(fixture.at(...lock)));
  });

  it("sources the env file only when one is set, and names the setting when vp is missing", () => {
    const script = (envFile: string | undefined) =>
      iosBuildScript({
        commit: "abc123",
        owner: "/w/a",
        checkout,
        envFile,
        configPath: "/cfg/mobile-rig.json",
      });
    assert.include(script("~/.config/tool env"), `. "$HOME"/'.config/tool env'`);
    assert.notInclude(script(undefined), "\n. ");
    assert.include(script(undefined), "Set ios.host.envFile in /cfg/mobile-rig.json");
  });
});
