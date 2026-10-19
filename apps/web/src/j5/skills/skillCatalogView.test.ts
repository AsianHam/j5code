import { describe, expect, it } from "vite-plus/test";

import {
  catalogScopeFor,
  extractPartialApplyResult,
  isCatalogActionable,
  isSourceChangedError,
  isSourceSaveable,
  pruneSelectedGroups,
  summarizeApplyResult,
} from "./skillCatalogView";

describe("skill catalog view helpers", () => {
  it("allows clearing a source and rejects unchanged drafts", () => {
    expect(isSourceSaveable("", "/opt/skills")).toBe(true);
    expect(isSourceSaveable("   ", "/opt/skills")).toBe(true);
    expect(isSourceSaveable("/opt/skills", "/opt/skills")).toBe(false);
    expect(isSourceSaveable("  /opt/skills  ", "/opt/skills")).toBe(false);
    expect(isSourceSaveable("https://example.com/skills.git", "/opt/skills")).toBe(true);
  });

  it("summarizes apply counts", () => {
    expect(summarizeApplyResult({ installed: 3, removed: 1, unchanged: 5, conflicts: [] })).toBe(
      "Installed 3 links, removed 1, 5 unchanged. For running agents, use “Restart agent session” in the command palette to pick up these changes.",
    );
  });

  it.each([0, 2])("highlights blocked links with %i successful installations", (installed) => {
    expect(
      summarizeApplyResult({
        installed,
        removed: 0,
        unchanged: 1,
        conflicts: [{ skill: "explain", linkPath: "/skills/explain", detail: "Existing link" }],
      }),
    ).toBe(
      `1 skill link was blocked by existing files or links. Installed ${installed} links, removed 0, 1 unchanged.${installed > 0 ? " For running agents, use “Restart agent session” in the command palette to pick up these changes." : ""}`,
    );
  });

  it("gives restart guidance for removals but not an unchanged selection", () => {
    expect(
      summarizeApplyResult({ installed: 0, removed: 2, unchanged: 0, conflicts: [] }),
    ).toContain("Restart agent session");
    expect(
      summarizeApplyResult({ installed: 0, removed: 0, unchanged: 3, conflicts: [] }),
    ).not.toContain("Restart agent session");
  });

  it("extracts partial results only from skill catalog errors", () => {
    const result = {
      selectedGroups: ["core"],
      installed: 1,
      removed: 0,
      unchanged: 0,
      conflicts: [],
      failed: [{ linkPath: "/tmp/x", error: "boom" }],
    };
    expect(extractPartialApplyResult({ _tag: "SkillCatalogError", message: "x", result })).toEqual(
      result,
    );
    expect(extractPartialApplyResult({ _tag: "SkillCatalogError", message: "x" })).toBeUndefined();
    expect(extractPartialApplyResult({ _tag: "OtherError", result })).toBeUndefined();
    expect(extractPartialApplyResult(new Error("boom"))).toBeUndefined();
    expect(extractPartialApplyResult(null)).toBeUndefined();
    expect(
      extractPartialApplyResult({ _tag: "SkillCatalogError", result: { installed: 1 } }),
    ).toBeUndefined();
  });

  it("preselects only saved groups the catalog still knows", () => {
    expect(pruneSelectedGroups([], [])).toEqual([]);
    expect(
      pruneSelectedGroups(["core", "retired"], [{ name: "core" }, { name: "extras" }]),
    ).toEqual(["core"]);
  });

  it("prunes selections against the latest known groups", () => {
    // An Update removed "extra" while ["core", "extra"] was checked.
    expect(pruneSelectedGroups(["core", "extra"], [{ name: "core" }])).toEqual(["core"]);
    expect(pruneSelectedGroups([], [{ name: "core" }])).toEqual([]);
    expect(pruneSelectedGroups(["core"], [])).toEqual([]);
  });

  it("detects stale-page source errors", () => {
    expect(
      isSourceChangedError({
        _tag: "SkillCatalogError",
        reason: "source-changed",
        message: "Wording can change",
      }),
    ).toBe(true);
    expect(isSourceChangedError("boom")).toBe(false);
    expect(isSourceChangedError(null)).toBe(false);
  });

  it("derives catalog identity from acknowledged settings", () => {
    // Identity follows live settings: another client's A → B change moves the
    // scope, so requests submit B instead of a cached A.
    expect(catalogScopeFor("env-1", "/catalog/A")).toBe("env-1::/catalog/A");
    expect(catalogScopeFor("env-1", "/catalog/B")).toBe("env-1::/catalog/B");
  });

  it("enables actions only for the displayed source with matching loaded status", () => {
    const ready = {
      busy: false,
      isPending: false,
      hasData: true,
      displayedSource: "/catalog/B",
      configuredSource: "/catalog/B",
    };
    expect(isCatalogActionable(ready)).toBe(true);
    // Saving B failed: the input still shows B against configured A.
    expect(isCatalogActionable({ ...ready, configuredSource: "/catalog/A" })).toBe(false);
    // Another client changed A → B: B's status has not loaded yet.
    expect(isCatalogActionable({ ...ready, isPending: true, hasData: false })).toBe(false);
    // Unsaved draft edits and in-flight states stay disabled.
    expect(isCatalogActionable({ ...ready, displayedSource: "  /catalog/B (edited)" })).toBe(false);
    expect(isCatalogActionable({ ...ready, busy: true })).toBe(false);
    expect(isCatalogActionable({ ...ready, isPending: true })).toBe(false);
    expect(isCatalogActionable({ ...ready, hasData: false })).toBe(false);
  });
});
