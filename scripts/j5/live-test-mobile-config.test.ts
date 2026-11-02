import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_SIMULATOR_PREFIX,
  expandHome,
  mobileRigConfigPath,
  parseMobileRigConfig,
} from "./live-test-mobile-config.ts";
import { LiveTestRefusal } from "./setup-agent-live-test.ts";

const parse = (text: string | undefined, platform: NodeJS.Platform = "linux") =>
  parseMobileRigConfig({ path: "/cfg/mobile-rig.json", text, platform });

describe("mobileRigConfigPath", () => {
  it("is under the config home unless a path is named", () => {
    assert.strictEqual(mobileRigConfigPath({}, "/h"), "/h/.config/j5code/mobile-rig.json");
    assert.strictEqual(
      mobileRigConfigPath({ XDG_CONFIG_HOME: "/x" }, "/h"),
      "/x/j5code/mobile-rig.json",
    );
    assert.strictEqual(mobileRigConfigPath({ J5_MOBILE_RIG_CONFIG: "/a.json" }, "/h"), "/a.json");
    assert.strictEqual(
      mobileRigConfigPath({ J5_MOBILE_RIG_CONFIG: "~/rigs/m.json" }, "/h"),
      "/h/rigs/m.json",
    );
  });
});

describe("parseMobileRigConfig", () => {
  it("serves one machine without a file: iOS on this Mac, none elsewhere", () => {
    const linux = parse(undefined);
    assert.strictEqual(linux.ios.host, undefined);
    assert.deepEqual(linux.ios.simulators, { prefix: DEFAULT_SIMULATOR_PREFIX });
    assert.strictEqual(linux.ios.maxBooted, 1);
    assert.strictEqual(linux.android.slots, 2);
    assert.deepEqual(linux.ports, { first: 20000, last: 29999 });
    assert.strictEqual(linux.phone.host, "tailscale");
    assert.deepEqual(parse(undefined, "darwin").ios.host, { kind: "local" });
  });

  it("takes an iOS host over SSH, with its checkout defaulted and its env file optional", () => {
    const config = parse(
      JSON.stringify({
        ios: { host: { ssh: "mac" }, simulators: ["a", "b"], maxBooted: 2 },
        android: { sdk: "~/sdk", slots: 3 },
        ports: { first: 5000, last: 5999 },
        phone: { host: "10.1.2.3" },
      }),
    );
    assert.deepEqual(config.ios.host, {
      kind: "ssh",
      ssh: "mac",
      checkout: "~/.cache/j5-mobile-rig/checkout",
      envFile: undefined,
    });
    assert.deepEqual(config.ios.simulators, { names: ["a", "b"] });
    assert.strictEqual(config.ios.maxBooted, 2);
    assert.deepEqual(config.android, { sdk: "~/sdk", slots: 3 });
    assert.deepEqual(config.ports, { first: 5000, last: 5999 });
    assert.strictEqual(config.phone.host, "10.1.2.3");
    assert.deepEqual(parse(JSON.stringify({ ios: { host: "local" } })).ios.host, { kind: "local" });
  });

  it("refuses an unknown key, a wrong type, or an unusable range, by name", () => {
    for (const [text, named] of [
      ["{ not json", "not valid JSON"],
      [`{"ios":{"hosts":"mac"}}`, "ios.hosts is not a setting"],
      [`{"ios":{"host":{"checkout":"~/c"}}}`, "ios.host.ssh is required"],
      [`{"ios":{"simulators":["a","a"]}}`, "names a Simulator twice"],
      [`{"ios":{"maxBooted":0}}`, "ios.maxBooted must be a positive whole number"],
      [`{"android":{"slots":"3"}}`, "android.slots must be a positive whole number"],
      [`{"ports":{"first":80,"last":90}}`, "ports must be a range"],
      [`{"ports":{"first":7000,"last":7000}}`, "ports must be a range"],
    ] as const) {
      assert.throws(() => parse(text), LiveTestRefusal, named);
    }
  });
});

describe("expandHome", () => {
  it("reads ~/ as the home directory and leaves other paths alone", () => {
    assert.strictEqual(expandHome("~/Android/sdk", "/h"), "/h/Android/sdk");
    assert.strictEqual(expandHome("/opt/sdk", "/h"), "/opt/sdk");
  });
});
