// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a standalone Node CLI the release workflows run before dependencies are installed.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

/**
 * J5 versions are dates: `<yyyymm>.<d>.<n>`, the UTC day a build was made and a counter for the
 * stable releases of that day. `202610.15.0` is the first stable release of 15 October 2026.
 * A nightly is `<yyyymm>.<d>.<n>-nightly.<yyyymmdd>.<run>`, where `n` is the next number no
 * stable release of that day has taken, so it sorts above every stable release that already
 * exists and below the stable release promoted from it.
 */
const STABLE = /^(\d{6})\.([1-9]|[12]\d|3[01])\.(0|[1-9]\d*)$/;
const NIGHTLY = /^(\d{6}\.(?:[1-9]|[12]\d|3[01])\.(?:0|[1-9]\d*))-nightly\.\d{8}\.\d+$/;

/** The nightly version for a build made on `date` (UTC, `yyyymmdd`), given the repository's tags. */
export function nightlyVersion(input: {
  readonly date: string;
  readonly runNumber: number;
  readonly tags: ReadonlyArray<string>;
}): string {
  if (!/^\d{8}$/.test(input.date))
    throw new Error(`Expected a yyyymmdd date; found ${input.date}.`);
  if (!Number.isSafeInteger(input.runNumber) || input.runNumber < 1) {
    throw new Error(`Expected a positive run number; found ${input.runNumber}.`);
  }
  const day = `${input.date.slice(0, 6)}.${Number(input.date.slice(6))}`;
  const taken = input.tags.flatMap((tag) => {
    const match = STABLE.exec(tag.replace(/^v/, ""));
    return match !== null && `${match[1]}.${match[2]}` === day ? [Number(match[3])] : [];
  });
  const next = taken.length === 0 ? 0 : Math.max(...taken) + 1;
  return `${day}.${next}-nightly.${input.date}.${input.runNumber}`;
}

/**
 * The stable version a nightly is promoted to: the nightly's own date and number. `latest` is the
 * tag of the current stable release; promoting a nightly from before it would offer every stable
 * install an older build, so that is refused.
 */
export function stableVersionOf(nightly: string, latest?: string): string {
  const match = NIGHTLY.exec(nightly.replace(/^v/, ""));
  if (match === null) {
    throw new Error(
      `Expected a nightly version (<yyyymm>.<d>.<n>-nightly.<yyyymmdd>.<run>); found ${nightly}.`,
    );
  }
  const version = match[1]!;
  if (latest !== undefined) {
    const parts = (value: string) => value.replace(/^v/, "").split(".").map(Number);
    const [candidate, current] = [parts(version), parts(latest)];
    const order = candidate.map((part, index) => part - current[index]!).find((diff) => diff !== 0);
    if (order !== undefined && order < 0) {
      throw new Error(
        `${nightly} is older than the current stable release ${latest}. Promote a newer nightly.`,
      );
    }
  }
  return version;
}

if (import.meta.main) {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      date: { type: "string" },
      "run-number": { type: "string" },
      "tags-file": { type: "string" },
      latest: { type: "string" },
    },
  });
  const [command, argument] = positionals;
  let version: string;
  if (command === "nightly") {
    version = nightlyVersion({
      date: values.date ?? "",
      runNumber: Number(values["run-number"]),
      tags: NodeFS.readFileSync(values["tags-file"] ?? "", "utf8").split("\n"),
    });
  } else if (command === "stable" && argument !== undefined) {
    version = stableVersionOf(argument, values.latest || undefined);
  } else {
    throw new Error(
      "Usage: release-version.ts nightly --date <yyyymmdd> --run-number <n> --tags-file <path> | stable <nightly> [--latest <tag>]",
    );
  }
  console.log(version);
}
