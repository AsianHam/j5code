// @effect-diagnostics nodeBuiltinImport:off - builds throwaway claim directories.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  FINGERPRINT_ENV,
  FINGERPRINT_EVAL,
  androidAbi,
  chooseMobilePorts,
  claimSlot,
  devClientUrl,
  emulatorPortForSlot,
  emulatorSerials,
  finishSessionCleanup,
  readMobileRecord,
  serialRunningAvd,
  sessionsOnDevice,
  iosBusy,
  iosPool,
  metroBundles,
  pairingDeepLink,
  releaseSlot,
  shellQuote,
  simulatorsFromSimctl,
} from "./live-test-mobile.ts";
import { LiveTestRefusal, parseCommand } from "./setup-agent-live-test.ts";

const claimsFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-mobile-claims-"));
  const worktree = (name: string) => {
    const path = NodePath.join(root, name);
    NodeFS.mkdirSync(path, { recursive: true });
    return path;
  };
  return {
    directory: NodePath.join(root, "claims"),
    worktree,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

describe("parseCommand --mobile", () => {
  it("sets up a device on a start or rebuild of the default home", () => {
    assert.deepEqual(parseCommand(["--mobile", "ios"]), {
      command: "start",
      mode: "default",
      mobile: "ios",
    });
    assert.deepEqual(parseCommand(["rebuild", "--mobile", "android"]), {
      command: "rebuild",
      mode: "default",
      mobile: "android",
    });
    assert.deepEqual(parseCommand(["--mobile", "phone"]), {
      command: "start",
      mode: "default",
      mobile: "phone",
    });
    assert.deepEqual(parseCommand(["mobile-open"]), { command: "mobile-open", mode: "default" });
  });

  it("refuses another platform, another home, or a command that sets nothing up", () => {
    for (const args of [
      ["--mobile"],
      ["--mobile", "windows"],
      ["--mobile", "ios", "--fresh"],
      ["--mobile", "ios", "--peer"],
      ["--mobile", "ios", "--base", "j5/main"],
      ["stop", "--mobile", "ios"],
      ["mobile-open", "--mobile", "ios"],
    ]) {
      assert.throws(() => parseCommand(args), LiveTestRefusal, undefined, args.join(" "));
    }
  });
});

describe("chooseMobilePorts", () => {
  const range = { first: 7000, last: 7099 };
  it("keeps one worktree's pair across runs, inside the configured range", () => {
    const first = chooseMobilePorts({ worktree: "/w/a", range, avoid: [], isFree: () => true });
    assert.deepEqual(
      chooseMobilePorts({ worktree: "/w/a", range, avoid: [], isFree: () => true }),
      first,
    );
    assert.strictEqual(first.metroPort, first.serverPort + 1);
    assert.isAtLeast(first.serverPort, range.first);
    assert.isAtMost(first.metroPort, range.last);
  });

  it("moves past a pair with a busy or avoided port", () => {
    const first = chooseMobilePorts({ worktree: "/w/a", range, avoid: [], isFree: () => true });
    const busy = chooseMobilePorts({
      worktree: "/w/a",
      range,
      avoid: [],
      isFree: (port) => port !== first.metroPort,
    });
    assert.notStrictEqual(busy.serverPort, first.serverPort);
    const avoided = chooseMobilePorts({
      worktree: "/w/a",
      range,
      avoid: [first.serverPort],
      isFree: () => true,
    });
    assert.notStrictEqual(avoided.serverPort, first.serverPort);
  });

  it("refuses when the range is full", () => {
    assert.throws(
      () => chooseMobilePorts({ worktree: "/w/a", range, avoid: [], isFree: () => false }),
      LiveTestRefusal,
    );
  });
});

describe("claimSlot", () => {
  it("gives each worktree its own slot, the same one again, and refuses past the pool", () => {
    using fixture = claimsFixture();
    const slots = ["j5-tester-1", "j5-tester-2"];
    const [a, b, c] = ["a", "b", "c"].map(fixture.worktree);
    const claim = (worktree: string) =>
      claimSlot({ directory: fixture.directory, platform: "ios", slots, worktree: worktree! });
    assert.strictEqual(claim(a!), "j5-tester-1");
    assert.strictEqual(claim(b!), "j5-tester-2");
    assert.strictEqual(claim(a!), "j5-tester-1");
    assert.throws(() => claim(c!), /All 2 iOS test devices are in use:[\s\S]*j5-tester-1: .*\/a/);
  });

  it("frees a slot only for the worktree that holds it", () => {
    using fixture = claimsFixture();
    const slots = ["j5-tester-1"];
    const [a, b] = ["a", "b"].map(fixture.worktree);
    const input = { directory: fixture.directory, platform: "android", slots } as const;
    claimSlot({ ...input, worktree: a! });
    releaseSlot({ ...input, slot: "j5-tester-1", worktree: b! });
    assert.throws(() => claimSlot({ ...input, worktree: b! }), LiveTestRefusal);
    releaseSlot({ ...input, slot: "j5-tester-1", worktree: a! });
    assert.strictEqual(claimSlot({ ...input, worktree: b! }), "j5-tester-1");
  });

  it("keeps each claim one directory inside the claims folder, whatever the names hold", () => {
    using fixture = claimsFixture();
    const worktree = fixture.worktree("a");
    for (const slot of ["QA/iPhone", "../escape"]) {
      claimSlot({
        directory: fixture.directory,
        platform: "ios",
        host: "user@mac",
        slots: [slot],
        worktree,
      });
    }
    assert.deepEqual(NodeFS.readdirSync(fixture.directory).toSorted(), [
      "ios-user_mac-.._escape",
      "ios-user_mac-QA_iPhone",
    ]);
  });

  it("says how to clear a claim whose worktree is gone", () => {
    using fixture = claimsFixture();
    const input = { directory: fixture.directory, platform: "android", slots: ["s"] } as const;
    const gone = fixture.worktree("gone");
    claimSlot({ ...input, worktree: gone });
    NodeFS.rmSync(gone, { recursive: true });
    assert.throws(
      () => claimSlot({ ...input, worktree: fixture.worktree("next") }),
      /that worktree is gone: rm -r .*android-s/,
    );
  });
});

describe("iosPool", () => {
  it("takes the available Simulators with the pool's prefix in number order, with their state", () => {
    const simulators = simulatorsFromSimctl(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            { name: "j5-tester-10", udid: "U10", state: "Shutdown", isAvailable: true },
            { name: "j5-tester-2", udid: "U2", state: "Booted", isAvailable: true },
            { name: "iPhone 17 Pro", udid: "P", state: "Booted", isAvailable: true },
            { name: "j5-tester-3", udid: "U3", state: "Shutdown", isAvailable: false },
          ],
        },
      }),
    );
    assert.deepEqual(
      iosPool(simulators, { prefix: "j5-tester-" }).map((s) => [s.name, s.booted]),
      [
        ["j5-tester-2", true],
        ["j5-tester-10", false],
      ],
    );
    assert.deepEqual(
      iosPool(simulators, { names: ["iPhone 17 Pro", "j5-tester-3"] }).map((s) => s.name),
      ["iPhone 17 Pro"],
    );
  });
});

describe("iosBusy", () => {
  const simulators = [
    { name: "j5-tester-1", udid: "U1", booted: false },
    { name: "j5-tester-2", udid: "U2", booted: false },
    { name: "iPhone 17 Pro", udid: "P", booted: true },
    { name: "iPad", udid: "I", booted: false },
  ];
  const pool = simulators.slice(0, 2);

  it("counts another worktree's claimed Simulator before it boots, and booted ones outside the pool", () => {
    assert.deepEqual(
      iosBusy({ simulators, pool, mine: "U1", claimed: (name) => name === "j5-tester-2" }),
      ["j5-tester-2", "iPhone 17 Pro"],
    );
  });

  it("does not count this worktree's own Simulator or a free, shut down one", () => {
    assert.deepEqual(iosBusy({ simulators, pool, mine: "U1", claimed: () => false }), [
      "iPhone 17 Pro",
    ]);
  });
});

describe("androidAbi", () => {
  it("runs the emulator image this machine runs natively, and refuses others", () => {
    assert.strictEqual(androidAbi("x64"), "x86_64");
    assert.strictEqual(androidAbi("arm64"), "arm64-v8a");
    assert.throws(() => androidAbi("ia32"), LiveTestRefusal);
  });
});

describe("emulatorPortForSlot", () => {
  it("gives two setups claiming at once different slots, and so different ports", () => {
    using fixture = claimsFixture();
    const slots = ["j5-tester-1", "j5-tester-2"];
    const input = { directory: fixture.directory, platform: "android", slots } as const;
    const first = claimSlot({ ...input, worktree: fixture.worktree("a") });
    const second = claimSlot({ ...input, worktree: fixture.worktree("b") });
    assert.deepEqual([first, second].map(emulatorPortForSlot), [5556, 5558]);
  });

  it("refuses a name that is not one of the rig's slots", () => {
    assert.throws(() => emulatorPortForSlot("Pixel_8"), LiveTestRefusal);
    assert.throws(() => emulatorPortForSlot("j5-tester-0"), LiveTestRefusal);
  });
});

describe("sessionsOnDevice", () => {
  it("names only the sessions on this device, so stop and setup leave other devices' alone", () => {
    const list = JSON.stringify({
      sessions: [
        { name: "t3-a", id: "emulator-5558", device: "j5-tester-2" },
        { name: "t3-b", id: "emulator-5556", device: "j5-tester-1" },
        { name: "t3-c", id: "emulator-5558", device: "j5-tester-2" },
      ],
    });
    assert.deepEqual(sessionsOnDevice(list, "emulator-5558"), ["t3-a", "t3-c"]);
    assert.deepEqual(sessionsOnDevice(JSON.stringify({ sessions: [] }), "emulator-5558"), []);
  });
});

describe("finishSessionCleanup", () => {
  const withRecord = (record: object) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-mobile-record-"));
    NodeFS.writeFileSync(NodePath.join(root, "mobile.json"), JSON.stringify(record));
    return { root };
  };
  const base = { platform: "android", slot: "j5-tester-2", serverPort: 6000, metroPort: 6001 };

  it("closes a fresh claim's leftovers on the first boot that finishes, even after a timed-out one", () => {
    const paths = withRecord({ ...base, sessionCleanupPending: true });
    const closed: Array<string> = [];
    finishSessionCleanup(paths, (record) => closed.push(record.slot));
    assert.deepEqual(closed, ["j5-tester-2"]);
    finishSessionCleanup(paths, (record) => closed.push(record.slot));
    assert.deepEqual(closed, ["j5-tester-2"]);
    assert.strictEqual(readMobileRecord(paths)?.sessionCleanupPending, undefined);
  });

  it("leaves a record without the marker alone, so the tester's own session survives", () => {
    const closed: Array<string> = [];
    finishSessionCleanup(withRecord(base), (record) => closed.push(record.slot));
    assert.deepEqual(closed, []);
  });
});

describe("serialRunningAvd", () => {
  it("finds the slot's emulator by its AVD, so a foreign emulator on the slot's port is left alone", () => {
    const devices = "List of devices attached\nemulator-5556\tdevice\nemulator-5558\tdevice\n";
    const avds: Record<string, string> = {
      "emulator-5556": "j5-tester-2\r\nOK",
      "emulator-5558": "Pixel_8\r\nOK",
    };
    assert.strictEqual(
      serialRunningAvd("j5-tester-2", devices, (serial) => avds[serial]),
      "emulator-5556",
    );
    assert.strictEqual(
      serialRunningAvd("j5-tester-1", devices, (serial) => avds[serial]),
      undefined,
    );
  });
});

describe("emulatorSerials", () => {
  it("includes an emulator that is offline or still booting, so stop does not delete its AVD", () => {
    const devices =
      "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tdevice\n";
    assert.deepEqual(emulatorSerials(devices), ["emulator-5554", "emulator-5556"]);
  });
});

describe("links", () => {
  it("opens the dev client against Metro on the address the device reaches this machine by", () => {
    const link = new URL(devClientUrl("100.64.0.1", 7001));
    assert.strictEqual(link.protocol, "j5code-dev:");
    assert.strictEqual(link.searchParams.get("url"), "http://100.64.0.1:7001");
  });

  it("moves the pairing token onto the backend origin the device reaches", () => {
    const link = new URL(
      pairingDeepLink({
        host: "10.0.2.2",
        serverPort: 7000,
        pairingUrl: "http://localhost:6741/pair#token=ABC123",
      }),
    );
    assert.strictEqual(link.host, "connections");
    assert.strictEqual(
      link.searchParams.get("pairingUrl"),
      "http://10.0.2.2:7000/pair#token=ABC123",
    );
    assert.strictEqual(link.searchParams.get("autoConnect"), "1");
  });
});

describe("metroBundles", () => {
  it("counts served and failed bundles through the log's colours", () => {
    const log = [
      "\u001B[32mAndroid Bundled\u001B[39m 4038ms apps/mobile/index.ts (4587 modules)",
      "iOS Bundled 812ms apps/mobile/src/lib/uuid.ts (911 modules)",
      "iOS Bundling failed 30ms apps/mobile/index.ts",
    ].join("\n");
    assert.deepEqual(metroBundles(log), { served: 2, failed: 1 });
  });
});

describe("shellQuote", () => {
  it("keeps a URL with & and ' as one word", () => {
    assert.strictEqual(shellQuote("a&b'c"), `'a&b'\\''c'`);
  });
});

describe("fingerprint", () => {
  it("is computed as scripts/mobile-native-client.ts computes it, so the cached client is found", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "..", "mobile-native-client.ts"),
      "utf8",
    );
    assert.include(source, FINGERPRINT_EVAL);
    for (const [key, value] of Object.entries(FINGERPRINT_ENV)) {
      assert.include(source, `${key}: "${value}"`);
    }
  });
});
