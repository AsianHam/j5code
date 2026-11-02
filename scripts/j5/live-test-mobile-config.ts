// @effect-diagnostics nodeBuiltinImport:off - part of the standalone live-test CLI.
/**
 * The mobile rig's machine-local settings: where iOS runs, which devices it may use, and which
 * ports a device reaches. They describe one person's machines, so they live outside the repository,
 * in `$XDG_CONFIG_HOME/j5code/mobile-rig.json` (or the file `J5_MOBILE_RIG_CONFIG` names). Without
 * the file, the defaults below serve a single machine: iOS on this Mac, Android on this host.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LiveTestRefusal } from "./setup-agent-live-test.ts";

export type IosHost =
  | { readonly kind: "local" }
  | {
      readonly kind: "ssh";
      /** An SSH destination, such as a `~/.ssh/config` alias. */
      readonly ssh: string;
      /** The build checkout on that host; `~/` means its home. */
      readonly checkout: string;
      /** A file the host's login shell must source to find node and vp. */
      readonly envFile: string | undefined;
    };

export interface MobileRigConfig {
  /** Where this file is, for messages that send a person to it. */
  readonly path: string;
  readonly ios: {
    /** Undefined when no iOS host is configured and this machine is not a Mac. */
    readonly host: IosHost | undefined;
    /** The Simulators the rig may claim and erase: these names, or every name with this prefix. */
    readonly simulators: { readonly names: ReadonlyArray<string> } | { readonly prefix: string };
    /** Booted Simulators the host takes at once, its own counted too. One unless raised. */
    readonly maxBooted: number;
  };
  readonly android: {
    /** The SDK root; by default ANDROID_HOME, ANDROID_SDK_ROOT, then the platform's usual place. */
    readonly sdk: string | undefined;
    readonly slots: number;
  };
  /** The range the backend and Metro ports are chosen from. */
  readonly ports: { readonly first: number; readonly last: number };
  /** How a phone reaches this machine: `tailscale` resolves this machine's tailnet address. */
  readonly phone: { readonly host: string };
}

export const DEFAULT_SIMULATOR_PREFIX = "j5-test-";
const DEFAULT_ANDROID_SLOTS = 2;
/** Clear of the dev runner's ranges and of both operating systems' ephemeral ports. */
const DEFAULT_PORTS = { first: 20000, last: 29999 } as const;
const DEFAULT_REMOTE_CHECKOUT = "~/.cache/j5-mobile-rig/checkout";

export function mobileRigConfigPath(environment: NodeJS.ProcessEnv, home: string): string {
  const explicit = environment.J5_MOBILE_RIG_CONFIG?.trim();
  if (explicit) return NodePath.resolve(expandHome(explicit, home));
  const configHome = environment.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  return NodePath.join(configHome, "j5code", "mobile-rig.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The settings from the file's text (undefined when there is no file), with defaults for what it
 * leaves out. A key it does not know, or a value of the wrong type, is refused by name.
 */
export function parseMobileRigConfig(input: {
  readonly path: string;
  readonly text: string | undefined;
  readonly platform: NodeJS.Platform;
}): MobileRigConfig {
  const refuse = (key: string, problem: string): never => {
    throw new LiveTestRefusal(`${input.path}: ${key} ${problem}.`);
  };
  let raw: unknown = {};
  if (input.text !== undefined) {
    try {
      raw = JSON.parse(input.text);
    } catch (cause) {
      throw new LiveTestRefusal(`${input.path} is not valid JSON: ${(cause as Error).message}`);
    }
  }
  const object = (value: unknown, key: string, known: ReadonlyArray<string>) => {
    if (value === undefined) return {};
    if (!isRecord(value)) return refuse(key, "must be an object");
    for (const name of Object.keys(value)) {
      if (!known.includes(name)) refuse(key === "" ? name : `${key}.${name}`, "is not a setting");
    }
    return value;
  };
  const string = (value: unknown, key: string) =>
    value === undefined
      ? undefined
      : typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : refuse(key, "must be a non-empty string");
  const positive = (value: unknown, key: string) =>
    value === undefined
      ? undefined
      : Number.isInteger(value) && (value as number) > 0
        ? (value as number)
        : refuse(key, "must be a positive whole number");

  const top = object(raw, "", ["ios", "android", "ports", "phone"]);
  const ios = object(top.ios, "ios", ["host", "simulators", "maxBooted"]);
  const android = object(top.android, "android", ["sdk", "slots"]);
  const ports = object(top.ports, "ports", ["first", "last"]);
  const phone = object(top.phone, "phone", ["host"]);

  let host: IosHost | undefined;
  if (ios.host === undefined) {
    host = input.platform === "darwin" ? { kind: "local" } : undefined;
  } else if (ios.host === "local") {
    host = { kind: "local" };
  } else {
    const remote = object(ios.host, "ios.host", ["ssh", "checkout", "envFile"]);
    host = {
      kind: "ssh",
      ssh: string(remote.ssh, "ios.host.ssh") ?? refuse("ios.host.ssh", "is required"),
      checkout: string(remote.checkout, "ios.host.checkout") ?? DEFAULT_REMOTE_CHECKOUT,
      envFile: string(remote.envFile, "ios.host.envFile"),
    };
  }

  let simulators: MobileRigConfig["ios"]["simulators"] = { prefix: DEFAULT_SIMULATOR_PREFIX };
  if (ios.simulators !== undefined) {
    if (
      !Array.isArray(ios.simulators) ||
      ios.simulators.length === 0 ||
      !ios.simulators.every((name) => typeof name === "string" && name.trim() !== "")
    ) {
      refuse("ios.simulators", "must be a non-empty list of Simulator names");
    }
    const names = (ios.simulators as ReadonlyArray<string>).map((name) => name.trim());
    if (new Set(names).size !== names.length) refuse("ios.simulators", "names a Simulator twice");
    simulators = { names };
  }

  const first = positive(ports.first, "ports.first") ?? DEFAULT_PORTS.first;
  const last = positive(ports.last, "ports.last") ?? DEFAULT_PORTS.last;
  if (first < 1024 || last > 65535 || last - first < 1) {
    refuse("ports", "must be a range of at least two ports within 1024-65535");
  }

  return {
    path: input.path,
    ios: { host, simulators, maxBooted: positive(ios.maxBooted, "ios.maxBooted") ?? 1 },
    android: {
      sdk: string(android.sdk, "android.sdk"),
      slots: positive(android.slots, "android.slots") ?? DEFAULT_ANDROID_SLOTS,
    },
    ports: { first, last },
    phone: { host: string(phone.host, "phone.host") ?? "tailscale" },
  };
}

let loaded: MobileRigConfig | undefined;

/** This machine's settings, read once per command. */
export function mobileRigConfig(): MobileRigConfig {
  if (loaded !== undefined) return loaded;
  const path = mobileRigConfigPath(process.env, NodeOS.homedir());
  // A file someone named must be there; only the default location may be absent.
  if (process.env.J5_MOBILE_RIG_CONFIG?.trim() && !NodeFS.existsSync(path)) {
    throw new LiveTestRefusal(`J5_MOBILE_RIG_CONFIG names ${path}, which does not exist.`);
  }
  const text = NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : undefined;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
  loaded = parseMobileRigConfig({ path, text, platform: process.platform });
  return loaded;
}

/** A local path from the file, with `~/` meaning this machine's home. */
export const expandHome = (path: string, home: string) =>
  path === "~" ? home : path.startsWith("~/") ? NodePath.join(home, path.slice(2)) : path;
