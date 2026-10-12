// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - a standalone Node CLI that runs git and prints markdown.
/**
 * Publishes before and after screenshots for a pull request and prints the
 * markdown table for its description:
 *
 *   node scripts/j5/pr-evidence.ts <pr-number> --pair "<caption>" <before.png> <after.png>
 *                                               --new "<caption>" <after.png> ...
 *
 * `--pair` is a state the change altered; `--new` is a state the change adds,
 * which has no before. Both repeat, in the order the rows should appear.
 *
 * Each file is checked to really be a PNG, then copied to `pr-<number>/` on
 * the `j5/evidence` branch from a fresh shallow clone in a temporary directory
 * and pushed. Other agents push there too, so a rejected push is rebased and
 * retried. Each image link is then checked to return an image before the table
 * is printed. Screenshots never go on the pull request's own branch.
 *
 * `--remote <url>` and `--branch <name>` point it somewhere else, which is how
 * it is tested without touching the real branch. The only branches it will
 * push to are `j5/evidence` and a self-test branch named
 * `j5/evidence-selftest-*`, unless the remote is a local bare repository. The link
 * check runs only for a GitHub remote.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const DEFAULT_BRANCH = "j5/evidence";
/** A throwaway branch for trying the real push path; whoever makes one deletes it. */
const SELFTEST_BRANCH_PREFIX = "j5/evidence-selftest-";
const PUSH_ATTEMPTS = 4;
const LINK_ATTEMPTS = 6;

/** A reason this script will not act, printed as-is. */
export class EvidenceRefusal extends Error {}

export interface EvidencePair {
  readonly caption: string;
  /** Undefined for a state the change adds. */
  readonly before: string | undefined;
  readonly after: string;
}

export interface EvidenceRequest {
  readonly pullRequest: number;
  readonly pairs: ReadonlyArray<EvidencePair>;
  readonly remote: string | undefined;
  readonly branch: string;
}

const USAGE = `Usage: node scripts/j5/pr-evidence.ts <pr-number> (--pair "<caption>" <before.png> <after.png> | --new "<caption>" <after.png>)...
       [--remote <git url>] [--branch <name>]`;

export function parseEvidenceArgs(args: ReadonlyArray<string>): EvidenceRequest {
  const [number, ...rest] = args;
  const pullRequest = Number(number);
  if (number === undefined || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    throw new EvidenceRefusal(USAGE);
  }
  const pairs: Array<EvidencePair> = [];
  let remote: string | undefined;
  let branch = DEFAULT_BRANCH;
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (flag === "--pair") {
      const [caption, before, after] = rest.slice(index + 1, index + 4);
      if (caption === undefined || before === undefined || after === undefined) {
        throw new EvidenceRefusal(USAGE);
      }
      pairs.push({ caption, before, after });
      index += 4;
    } else if (flag === "--new") {
      const [caption, after] = rest.slice(index + 1, index + 3);
      if (caption === undefined || after === undefined) throw new EvidenceRefusal(USAGE);
      pairs.push({ caption, before: undefined, after });
      index += 3;
    } else if ((flag === "--remote" || flag === "--branch") && rest[index + 1] !== undefined) {
      if (flag === "--remote") remote = rest[index + 1];
      else branch = rest[index + 1] ?? branch;
      index += 2;
    } else {
      throw new EvidenceRefusal(USAGE);
    }
  }
  if (pairs.length === 0) throw new EvidenceRefusal(USAGE);
  return { pullRequest, pairs, remote, branch };
}

/** The owner and repository of a GitHub remote, or undefined for any other remote. */
export function githubRepository(remote: string): string | undefined {
  // Only decides whether image links can be checked; it guards nothing.
  return /github\.com(?::\d+)?[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)?.[1];
}

/**
 * Whether `remote` is, for certain, a bare repository in a directory on this
 * machine: what the tests push to. A URL of any kind is not, and neither is a
 * checkout, which could be a clone of the real repository.
 */
function isLocalBareRepository(remote: string): boolean {
  const directory = remote.startsWith("file://") ? remote.slice("file://".length) : remote;
  if (!NodePath.isAbsolute(directory) || !NodeFS.existsSync(directory)) return false;
  return run("git", ["rev-parse", "--is-bare-repository"], directory).output === "true";
}

/**
 * Why this script will not push to `branch` on `remote`, or undefined when it
 * may. Evidence goes only to the evidence branch, or to a self-test branch,
 * never to a pull request's own branch or to main. The one exception is a
 * remote proved to be a local bare repository. The rule is "refuse unless
 * proved harmless", because a remote can name the real repository in more
 * forms than any pattern would catch.
 */
export function branchRefusal(remote: string, branch: string): string | undefined {
  if (branch === DEFAULT_BRANCH || branch.startsWith(SELFTEST_BRANCH_PREFIX)) return undefined;
  if (isLocalBareRepository(remote)) return undefined;
  return `Refusing to push screenshots to ${branch} on ${remote}. They go only to ${DEFAULT_BRANCH} (or a ${SELFTEST_BRANCH_PREFIX}* branch for a self test), never to a pull request's own branch. Another branch is allowed only on a local bare repository.`;
}

/**
 * The link that renders an image inline. The `refs/heads/` form is used
 * because the plain form can return 404 for a few seconds after a push.
 */
export const rawUrl = (repository: string, branch: string, path: string) =>
  `https://raw.githubusercontent.com/${repository}/refs/heads/${branch}/${path}`;

/**
 * Where a file goes on the branch. The name carries the caption, the side and
 * the first bytes of the file's hash, so a later push with a changed image
 * gets a new name and an old link never shows a new picture.
 */
export function evidencePath(input: {
  readonly pullRequest: number;
  readonly index: number;
  readonly caption: string;
  readonly side: "before" | "after";
  readonly sha256: string;
}): string {
  const slug =
    input.caption
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .slice(0, 40) || "image";
  return `pr-${input.pullRequest}/${String(input.index + 1).padStart(2, "0")}-${slug}-${input.side}-${input.sha256.slice(0, 8)}.png`;
}

export interface PublishedPair {
  readonly caption: string;
  readonly before: string | undefined;
  readonly after: string;
}

/** The table for the pull request description; each cell is a path or a link. */
export function evidenceTable(
  pairs: ReadonlyArray<PublishedPair>,
  link: (path: string) => string,
): string {
  // A raw pipe ends a table cell even inside alt text, and a bracket or a
  // newline ends the alt text, so none may reach the row unescaped.
  const inCell = (caption: string) => caption.replaceAll(/\s*\n\s*/g, " ").replaceAll("|", "\\|");
  const inAlt = (caption: string) => inCell(caption).replaceAll(/[[\]]/g, "");
  const cell = (caption: string, side: string, path: string | undefined) =>
    path === undefined ? "new" : `![${inAlt(caption)}, ${side}](${link(path)})`;
  return [
    "| | Before | After |",
    "| --- | --- | --- |",
    ...pairs.map(
      (pair) =>
        `| ${inCell(pair.caption)} | ${cell(pair.caption, "before", pair.before)} | ${cell(pair.caption, "after", pair.after)} |`,
    ),
  ].join("\n");
}

function run(command: string, args: ReadonlyArray<string>, cwd?: string) {
  const result = NodeChildProcess.spawnSync(command, [...args], { cwd, encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** Refuses a file that is not really a PNG: tools write JPEG or WebP bytes under a `.png` name. */
export function assertPng(file: string): void {
  if (!NodeFS.existsSync(file)) throw new EvidenceRefusal(`${file} does not exist.`);
  const kind = run("file", ["--brief", "--mime-type", file]).output;
  if (kind !== "image/png") {
    throw new EvidenceRefusal(
      `${file} is ${kind}, not a PNG. GitHub will not render it; capture it again as PNG.`,
    );
  }
}

/**
 * Clones the branch shallowly into `cloneDir`, copies the images in and
 * commits them. A fresh clone has no hooks, which matters: the repository's
 * pre-commit hook fails on this branch because it has no source tree.
 */
export function stageEvidence(input: {
  readonly request: EvidenceRequest;
  readonly remote: string;
  readonly cloneDir: string;
}): ReadonlyArray<PublishedPair> {
  const { request, remote, cloneDir } = input;
  const cloned = run("git", [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    request.branch,
    remote,
    cloneDir,
  ]);
  if (!cloned.ok) {
    throw new EvidenceRefusal(
      `Could not clone ${request.branch} from ${remote}:\n${cloned.output}`,
    );
  }
  const place = (file: string, index: number, caption: string, side: "before" | "after") => {
    const sha256 = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
    const path = evidencePath({ pullRequest: request.pullRequest, index, caption, side, sha256 });
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cloneDir, path)), { recursive: true });
    NodeFS.copyFileSync(file, NodePath.join(cloneDir, path));
    return path;
  };
  const published = request.pairs.map((pair, index) => ({
    caption: pair.caption,
    before:
      pair.before === undefined ? undefined : place(pair.before, index, pair.caption, "before"),
    after: place(pair.after, index, pair.caption, "after"),
  }));
  run("git", ["add", "--all"], cloneDir);
  // Nothing staged means these exact images are already on the branch.
  if (!run("git", ["diff", "--cached", "--quiet"], cloneDir).ok) {
    const committed = run(
      "git",
      ["commit", "--message", `evidence: screenshots for #${request.pullRequest}`],
      cloneDir,
    );
    if (!committed.ok) throw new EvidenceRefusal(`Could not commit:\n${committed.output}`);
  }
  return published;
}

/** Pushes the clone's commit, rebasing onto whatever other agents pushed in the meantime. */
export function pushEvidence(cloneDir: string, branch: string): void {
  for (let attempt = 1; ; attempt++) {
    const pushed = run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], cloneDir);
    if (pushed.ok) return;
    if (attempt === PUSH_ATTEMPTS) {
      throw new EvidenceRefusal(
        `Could not push to ${branch} after ${PUSH_ATTEMPTS} attempts:\n${pushed.output}`,
      );
    }
    const rebased = run("git", ["pull", "--rebase", "origin", branch], cloneDir);
    if (!rebased.ok) {
      throw new EvidenceRefusal(`Could not rebase onto ${branch}:\n${rebased.output}`);
    }
  }
}

async function assertImageLink(url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { method: "HEAD" });
    const type = response.headers.get("content-type") ?? "";
    if (response.status === 200 && type.startsWith("image/")) return;
    if (attempt === LINK_ATTEMPTS) {
      throw new EvidenceRefusal(
        `${url} returned ${response.status} ${type}, not an image. The push succeeded; do not post this link until it works.`,
      );
    }
    await NodeTimersPromises.setTimeout(2_000);
  }
}

async function main(): Promise<void> {
  const request = parseEvidenceArgs(process.argv.slice(2));
  for (const pair of request.pairs) {
    if (pair.before !== undefined) assertPng(pair.before);
    assertPng(pair.after);
  }
  const checkout = NodePath.resolve(import.meta.dirname, "../..");
  const remote = request.remote ?? run("git", ["remote", "get-url", "origin"], checkout).output;
  const refusal = branchRefusal(remote, request.branch);
  if (refusal !== undefined) throw new EvidenceRefusal(refusal);
  const cloneDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-pr-evidence-"));
  try {
    const published = stageEvidence({ request, remote, cloneDir });
    pushEvidence(cloneDir, request.branch);
    const repository = githubRepository(remote);
    if (repository === undefined) {
      console.log(evidenceTable(published, (path) => path));
      console.error(
        `\nPushed to ${request.branch} at ${remote}. Not a GitHub remote, so no links were checked.`,
      );
      return;
    }
    const link = (path: string) => rawUrl(repository, request.branch, path);
    for (const pair of published) {
      if (pair.before !== undefined) await assertImageLink(link(pair.before));
      await assertImageLink(link(pair.after));
    }
    console.log(evidenceTable(published, link));
  } finally {
    NodeFS.rmSync(cloneDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    if (!(cause instanceof EvidenceRefusal)) throw cause;
    console.error(cause.message);
    process.exitCode = 1;
  });
}
