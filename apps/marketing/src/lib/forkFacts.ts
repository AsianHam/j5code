import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ForkFacts {
  /** Short SHA of the upstream commit the latest stable release is built on. */
  pin: string;
  /** ISO date that pin was frozen. */
  pinFrozenOn: string;
  /** The stable J5 Code release that carries the pin, such as "0.0.48". */
  releaseVersion: string;
  /** The upstream branch the pin was taken from, such as "main". */
  upstreamBranch: string;
}

/**
 * Locates FORK.md by walking up from the build's working directory. Astro
 * bundles this module before running it, so import.meta.url no longer points
 * into the source tree; the working directory (apps/marketing locally and on
 * Vercel) is the stable anchor.
 */
function findForkFile(): string | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const candidate = NodePath.join(dir, "FORK.md");
    if (NodeFS.existsSync(candidate)) return candidate;
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * FORK.md's `Released pin:` line describes the latest stable release, not
 * `j5/main`. Returns undefined unless the whole line parses, so a half-edited
 * line shows nothing rather than a mix of old and new facts.
 */
export function parseReleasedPin(text: string): ForkFacts | undefined {
  const line =
    /^Released pin: `([0-9a-f]{7,40})`, from (?:upstream )?`?([^\s`,]+)`? \(in J5 Code (\d+\.\d+\.\d+), frozen (\d{4}-\d{2}-\d{2})\)/m.exec(
      text,
    );
  const [, pin, upstreamBranch, releaseVersion, pinFrozenOn] = line ?? [];
  if (!pin || !upstreamBranch || !releaseVersion || !pinFrozenOn) return undefined;
  return { pin: pin.slice(0, 7), pinFrozenOn, releaseVersion, upstreamBranch };
}

/**
 * Reads the released pin from FORK.md at build time so the Foundation section
 * never carries a hand-typed commit.
 * Returns undefined when the file or the line it depends on is missing, and
 * the page then omits the row rather than showing a stale value.
 */
export function readForkFacts(): ForkFacts | undefined {
  const file = findForkFile();
  if (!file) return undefined;
  return parseReleasedPin(NodeFS.readFileSync(file, "utf8"));
}
