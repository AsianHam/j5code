// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - this synchronous Git audit is a standalone Node CLI that emits machine-readable JSON.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import reviewedNightly3238 from "../../apps/server/src/j5/persistence/reviewed-v0.1.1-nightly.20261017.3238.v1.json" with { type: "json" };
import reviewedV013 from "../../apps/server/src/j5/persistence/reviewed-v0.1.3.v1.json" with { type: "json" };
import reviewedV2Reconcile from "../../apps/server/src/j5/persistence/reviewed-v2-reconcile.v1.json" with { type: "json" };

export interface MigrationRecord {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly dependencies?: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

export interface MigrationChange {
  readonly kind:
    | "invalid_manifest"
    | "removed"
    | "renumbered"
    | "implementation_changed"
    | "inserted_below_high_water";
  readonly name: string;
  readonly oldId?: number;
  readonly newId?: number;
}

/** Compares persisted migration identities and implementations, independently of filenames. */
export function inspectMigrationChanges(
  before: ReadonlyArray<MigrationRecord>,
  after: ReadonlyArray<MigrationRecord>,
): ReadonlyArray<MigrationChange> {
  const changes: Array<MigrationChange> = [];
  for (const records of [before, after]) {
    const ids = new Set<number>();
    const names = new Set<string>();
    for (const row of records) {
      if (!Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id) || names.has(row.name)) {
        changes.push({ kind: "invalid_manifest", name: row.name });
      }
      ids.add(row.id);
      names.add(row.name);
    }
  }
  const oldNames = new Set(before.map(({ name }) => name));
  const newNames = new Map(after.map((row) => [row.name, row]));
  const highWater = Math.max(0, ...before.map(({ id }) => id));
  for (const row of before) {
    const next = newNames.get(row.name);
    if (!next) {
      changes.push({ kind: "removed", name: row.name, oldId: row.id });
      continue;
    }
    if (row.id !== next.id) {
      changes.push({ kind: "renumbered", name: row.name, oldId: row.id, newId: next.id });
    }
    if (
      row.sha256 !== next.sha256 ||
      JSON.stringify(row.dependencies ?? []) !== JSON.stringify(next.dependencies ?? [])
    ) {
      changes.push({
        kind: "implementation_changed",
        name: row.name,
        oldId: row.id,
        newId: next.id,
      });
    }
  }
  for (const row of after) {
    if (!oldNames.has(row.name) && row.id <= highWater) {
      changes.push({ kind: "inserted_below_high_water", name: row.name, newId: row.id });
    }
  }
  return changes;
}

const sameManifest = (
  actual: ReadonlyArray<MigrationRecord>,
  expected: ReadonlyArray<MigrationRecord>,
) =>
  actual.length === expected.length &&
  actual.every((row, index) => {
    const other = expected[index];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.name === other.name &&
      row.sha256 === other.sha256 &&
      JSON.stringify(row.dependencies ?? []) === JSON.stringify(other.dependencies ?? [])
    );
  });

/** Reviewed transitions, oldest first. Each is a record of one advance, never regenerated. */
const reviewedBridges = [reviewedV2Reconcile, reviewedNightly3238, reviewedV013];

/** Reviewed upstream targets. A candidate must contain one of these exact commits. */
export const reviewedTargetRefs = reviewedBridges.map((bridge) => bridge.targetRef);

/** Allows only the recorded old manifest and exact reviewed upstream target. */
export function matchesReviewedBridge(
  before: ReadonlyArray<MigrationRecord>,
  after: ReadonlyArray<MigrationRecord>,
  targetSha: string,
): boolean {
  // Each bridge's note says why its changes are safe; 050's helper drift is safe only because a
  // recorded 050 never reruns.
  return reviewedBridges.some(
    (bridge) =>
      targetSha === bridge.targetRef &&
      sameManifest(before, bridge.sourceMigrations) &&
      sameManifest(after, bridge.targetMigrations),
  );
}

const gitText = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

// Identified by manifest name: upstream renumbers these files (054 → 055 for V2).
const composedName = "OrchestrationV2";
const backfillName = "ProjectionThreadPullRequests";
const auditedNames = new Set([composedName, backfillName]);

const migrationsDir = "apps/server/src/persistence/Migrations/";

/** The import specifiers a reviewed dependency list implies for one audited migration. */
function expectedDirectImports(
  name: string,
  dependencies: ReadonlyArray<{ readonly path: string }>,
): ReadonlyArray<string> {
  if (name === composedName)
    return dependencies.map(({ path }) => `./OrchestrationV2/${NodePath.posix.basename(path)}`);
  // Before v0.1.3, 050 imported the shared module; since then a frozen helper beside it.
  return dependencies.every(({ path }) => path.startsWith(migrationsDir))
    ? dependencies.map(({ path }) => `./${NodePath.posix.basename(path)}`)
    : ["@t3tools/shared/threadPullRequests"];
}

/**
 * Hash the reviewed V2 setup and the functions reached by the PR backfill.
 * This is a bounded dependency list, not a module resolver: implementation changes
 * require reviewing these dependencies again before allowing another bridge.
 */
export function readMigrationDependencies(
  cwd: string,
  sha: string,
  name: string,
  implementation: string,
): NonNullable<MigrationRecord["dependencies"]> {
  if (!auditedNames.has(name)) return [];
  const imports = [...implementation.matchAll(/from "([^"\n]+)"/g)].map((match) => match[1]!);
  if (/\bimport\s*\(/.test(implementation))
    throw new Error("Unreviewed dynamic migration dependency");
  const direct = imports
    .filter((specifier) => !specifier.startsWith("effect/"))
    .toSorted()
    .join("\n");
  // Each review records the helper files one version of the migration reaches. Base and candidate
  // can be different versions (050 moved to a frozen local helper in v0.1.3), so the audit is the
  // reviewed list whose imports match this implementation, newest first.
  const expected = reviewedBridges
    .toReversed()
    .flatMap((bridge) => [bridge.targetMigrations, bridge.sourceMigrations])
    .map((rows) => rows.find((row) => row.name === name)?.dependencies)
    .find(
      (dependencies) =>
        dependencies !== undefined &&
        expectedDirectImports(name, dependencies).toSorted().join("\n") === direct,
    );
  if (expected === undefined) {
    throw new Error("Unreviewed migration composition; update its dependency audit first");
  }
  return expected.map(({ path }) => ({
    path,
    sha256: NodeCrypto.createHash("sha256")
      .update(gitText(cwd, "show", `${sha}:${path}`))
      .digest("hex"),
  }));
}

/** Reads the repository's static manifest; unfamiliar syntax fails instead of producing an empty audit. */
export function readMigrationManifest(cwd: string, sha: string): ReadonlyArray<MigrationRecord> {
  const source = gitText(cwd, "show", `${sha}:apps/server/src/persistence/Migrations.ts`);
  const imports = new Map(
    [...source.matchAll(/import (Migration\d+) from "\.\/(Migrations\/[^"\n]+)";/g)].map(
      (match) => [match[1]!, match[2]!] as const,
    ),
  );
  const entries = [...source.matchAll(/\[(\d+), "([^"]+)", (Migration\d+)\]/g)];
  if (entries.length === 0 || entries.length !== imports.size) {
    throw new Error(
      "Unrecognized migration manifest syntax; update the audit before advancing the pin.",
    );
  }
  return entries.map((match) => {
    const relativePath = imports.get(match[3]!);
    if (!relativePath) throw new Error("Migration entry has no static implementation import.");
    const path = `apps/server/src/persistence/${relativePath}`;
    const implementation = gitText(cwd, "show", `${sha}:${path}`);
    return {
      id: Number(match[1]),
      name: match[2]!,
      path,
      sha256: NodeCrypto.createHash("sha256").update(implementation).digest("hex"),
      ...(auditedNames.has(match[2]!)
        ? { dependencies: readMigrationDependencies(cwd, sha, match[2]!, implementation) }
        : {}),
    };
  });
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      base: { type: "string" },
      candidate: { type: "string" },
      "allow-reviewed-bridge": { type: "boolean", default: false },
    },
  });
  if (!values.base || !values.candidate) {
    throw new Error(
      "Usage: node scripts/j5/check-upstream-migrations.ts --base <ref> --candidate <ref> [--allow-reviewed-bridge]",
    );
  }
  const cwd = process.cwd();
  const base = gitText(
    cwd,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.base}^{commit}`,
  ).trim();
  const candidate = gitText(
    cwd,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.candidate}^{commit}`,
  ).trim();
  const before = readMigrationManifest(cwd, base);
  const after = readMigrationManifest(cwd, candidate);
  const changes = inspectMigrationChanges(before, after);
  // The candidate may be the reviewed upstream commit itself or a J5 commit built on it.
  const containsTarget = (target: string) => {
    if (target === candidate) return true;
    try {
      gitText(cwd, "merge-base", "--is-ancestor", target, candidate);
      return true;
    } catch {
      return false;
    }
  };
  const bridge =
    values["allow-reviewed-bridge"] &&
    reviewedTargetRefs.some(
      (target) => containsTarget(target) && matchesReviewedBridge(before, after, target),
    );
  const status =
    changes.length === 0 ? "append_only" : bridge ? "reviewed_bridge_required" : "blocked";
  console.log(
    JSON.stringify(
      { base, candidate, status, changes, databaseUpgradeProofRequired: changes.length !== 0 },
      null,
      2,
    ),
  );
  process.exitCode = status === "blocked" ? 1 : 0;
}
