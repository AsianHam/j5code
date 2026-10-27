// @effect-diagnostics nodeBuiltinImport:off - synchronous Git CLI fixtures use an isolated temporary repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import reviewedNightly3238 from "../../apps/server/src/j5/persistence/reviewed-v0.1.1-nightly.20261017.3238.v1.json" with { type: "json" };
import reviewedV013 from "../../apps/server/src/j5/persistence/reviewed-v0.1.3.v1.json" with { type: "json" };
import reviewed from "../../apps/server/src/j5/persistence/reviewed-v2-reconcile.v1.json" with { type: "json" };
import {
  inspectMigrationChanges,
  readMigrationDependencies,
  matchesReviewedBridge,
  type MigrationRecord,
} from "./check-upstream-migrations.ts";

const record = (id: number, name: string, sha256 = "same"): MigrationRecord => ({
  id,
  name,
  sha256,
  path: `${id}_${name}.ts`,
});

describe("upstream migration compatibility audit", () => {
  it("accepts append-only additions and implementation-preserving path moves", () => {
    const before = [record(1, "First"), record(2, "Second")];
    expect(
      inspectMigrationChanges(before, [
        { ...record(1, "First"), path: "moved/First.ts" },
        record(2, "Second"),
        record(3, "Third"),
      ]),
    ).toEqual([]);
  });

  it("detects renumbering and an inserted migration that the high-water runner would skip", () => {
    expect(
      inspectMigrationChanges(
        [record(1, "First"), record(2, "Second")],
        [record(1, "First"), record(2, "Inserted"), record(3, "Second")],
      ),
    ).toEqual([
      { kind: "renumbered", name: "Second", oldId: 2, newId: 3 },
      { kind: "inserted_below_high_water", name: "Inserted", newId: 2 },
    ]);
  });

  it("detects renamed, removed, and edited historical migrations", () => {
    expect(
      inspectMigrationChanges(
        [record(1, "First"), record(2, "Second"), record(3, "Third")],
        [record(1, "Renamed"), record(3, "Third", "changed")],
      ),
    ).toEqual([
      { kind: "removed", name: "First", oldId: 1 },
      { kind: "removed", name: "Second", oldId: 2 },
      { kind: "implementation_changed", name: "Third", oldId: 3, newId: 3 },
      { kind: "inserted_below_high_water", name: "Renamed", newId: 1 },
    ]);
  });

  it("rejects duplicate IDs and identities", () => {
    expect(inspectMigrationChanges([], [record(1, "One"), record(1, "Two")])).toContainEqual({
      kind: "invalid_manifest",
      name: "Two",
    });
    expect(inspectMigrationChanges([], [record(1, "One"), record(2, "One")])).toContainEqual({
      kind: "invalid_manifest",
      name: "One",
    });
  });
});

describe("reviewed pin → upstream nightly 3238", () => {
  it("chains from the previous review and appends only 061 and 062", () => {
    const { sourceMigrations, targetMigrations, targetRef } = reviewedNightly3238;
    expect(sourceMigrations).toEqual(reviewed.targetMigrations);
    expect(matchesReviewedBridge(sourceMigrations, targetMigrations, targetRef)).toBe(true);
    // Neither review vouches for the other's transition.
    expect(matchesReviewedBridge(sourceMigrations, targetMigrations, reviewed.targetRef)).toBe(
      false,
    );
    expect(
      inspectMigrationChanges(sourceMigrations, targetMigrations)
        .filter(({ kind }) => kind !== "implementation_changed")
        .map(({ kind }) => kind),
    ).toEqual([]);
    expect(targetMigrations.slice(-2).map(({ id, name }) => [id, name])).toEqual([
      [61, "PullRequestReviewGuides"],
      [62, "ThreadFailureLookupIndex"],
    ]);
  });
});

describe("reviewed pin → upstream v0.1.3", () => {
  it("chains from the 3238 review, appends 063 to 069, and audits 050's frozen helper", () => {
    const { sourceMigrations, targetMigrations, targetRef } = reviewedV013;
    expect(sourceMigrations).toEqual(reviewedNightly3238.targetMigrations);
    expect(matchesReviewedBridge(sourceMigrations, targetMigrations, targetRef)).toBe(true);
    expect(
      matchesReviewedBridge(sourceMigrations, targetMigrations, reviewedNightly3238.targetRef),
    ).toBe(false);
    expect(
      inspectMigrationChanges(sourceMigrations, targetMigrations)
        .filter(({ kind }) => kind !== "implementation_changed")
        .map(({ kind }) => kind),
    ).toEqual([]);
    expect(targetMigrations.slice(-7).map(({ id }) => id)).toEqual([63, 64, 65, 66, 67, 68, 69]);
    expect(
      targetMigrations
        .find(({ name }) => name === "ProjectionThreadPullRequests")
        ?.dependencies?.map(({ path }) => path),
    ).toEqual(["apps/server/src/persistence/Migrations/legacyThreadPullRequestKey.ts"]);
  });
});

describe("reviewed pin → upstream V2 renumbering", () => {
  it("accepts only the pin manifest and the exact reviewed upstream target", () => {
    const { sourceMigrations, targetMigrations, targetRef } = reviewed;
    expect(matchesReviewedBridge(sourceMigrations, targetMigrations, targetRef)).toBe(true);
    expect(matchesReviewedBridge(sourceMigrations, targetMigrations, "other")).toBe(false);
    expect(matchesReviewedBridge(sourceMigrations.slice(0, -1), targetMigrations, targetRef)).toBe(
      false,
    );
    expect(
      matchesReviewedBridge(
        sourceMigrations,
        [...targetMigrations, record(61, "Unreviewed")],
        targetRef,
      ),
    ).toBe(false);
    expect(
      matchesReviewedBridge(
        sourceMigrations,
        targetMigrations.map((row) => (row.id === 55 ? { ...row, sha256: "changed" } : row)),
        targetRef,
      ),
    ).toBe(false);
  });
  it("records the renumbering and the inserted migration", () => {
    expect(
      inspectMigrationChanges(reviewed.sourceMigrations, reviewed.targetMigrations).filter(
        ({ kind }) => kind !== "implementation_changed",
      ),
    ).toEqual([
      { kind: "renumbered", name: "OrchestrationV2", oldId: 54, newId: 55 },
      { kind: "renumbered", name: "RemoveRedundantProjectionIndexes", oldId: 55, newId: 56 },
      {
        kind: "inserted_below_high_water",
        name: "ProjectionThreadsAutoSettleDisabledAt",
        newId: 54,
      },
    ]);
  });
  it("detects a helper change even when the top-level migration did not change", () => {
    for (const name of ["ProjectionThreadPullRequests", "OrchestrationV2"]) {
      const changed = reviewed.targetMigrations.map((row) =>
        row.name === name
          ? {
              ...row,
              dependencies: (row.dependencies ?? []).map((dep, index) =>
                index === 0 ? { ...dep, sha256: "edited" } : dep,
              ),
            }
          : row,
      );
      expect(matchesReviewedBridge(reviewed.sourceMigrations, changed, reviewed.targetRef)).toBe(
        false,
      );
      const original = reviewed.targetMigrations.find((row) => row.name === name)!;
      expect(inspectMigrationChanges(reviewed.targetMigrations, changed)).toContainEqual({
        kind: "implementation_changed",
        name,
        oldId: original.id,
        newId: original.id,
      });
    }
  });
  it("refuses unfamiliar static or dynamic migration composition", () => {
    for (const name of ["OrchestrationV2", "ProjectionThreadPullRequests"]) {
      expect(() =>
        readMigrationDependencies("unused", "unused", name, 'import NewStep from "./new.ts";'),
      ).toThrow(/Unreviewed migration composition/);
      expect(() =>
        readMigrationDependencies("unused", "unused", name, 'await import("./new.ts")'),
      ).toThrow(/dynamic migration dependency/);
    }
  });
});

it("reads helper and backfill dependency changes from Git even with unchanged entry points", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-migration-audit-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    for (const migration of reviewed.targetMigrations.filter(({ dependencies }) => dependencies)) {
      const dependencies = migration.dependencies ?? [];
      for (const dependency of dependencies) {
        const file = NodePath.join(directory, dependency.path);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, "original");
      }
      git("add", ".");
      const before = git("write-tree");
      const implementation =
        migration.name === "OrchestrationV2"
          ? dependencies
              .map(
                ({ path }, index) =>
                  `import Step${index} from "./OrchestrationV2/${NodePath.basename(path)}";`,
              )
              .join("\n")
          : 'import { legacyThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";';
      const original = readMigrationDependencies(directory, before, migration.name, implementation);
      for (const dependency of dependencies) {
        NodeFS.writeFileSync(
          NodePath.join(directory, dependency.path),
          "changed SQL or backfill behavior",
        );
        git("add", ".");
        const after = readMigrationDependencies(
          directory,
          git("write-tree"),
          migration.name,
          implementation,
        );
        expect(after.find(({ path }) => path === dependency.path)?.sha256).not.toBe(
          original.find(({ path }) => path === dependency.path)?.sha256,
        );
        expect(
          inspectMigrationChanges(
            [{ ...migration, dependencies: original }],
            [{ ...migration, dependencies: after }],
          ),
        ).toContainEqual({
          kind: "implementation_changed",
          name: migration.name,
          oldId: migration.id,
          newId: migration.id,
        });
        NodeFS.writeFileSync(NodePath.join(directory, dependency.path), "original");
      }
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
