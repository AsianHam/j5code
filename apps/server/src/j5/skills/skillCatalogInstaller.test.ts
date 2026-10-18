// @effect-diagnostics nodeBuiltinImport:off - exercises the native async installer with isolated filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderInstanceId, type SkillCatalogReplacement } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { stringify } from "yaml";

import {
  applyPlan,
  IncompleteApplyError,
  loadCatalog,
  loadState,
  planInstall,
  resolveSelection,
  runApply,
  saveState,
  skillDescription,
  stateFilePath,
  verifyLinks,
  verifySkills,
  type Catalog,
} from "./skillCatalogInstaller.ts";
import { canonicalSkillRoot } from "./skillFileSystem.ts";
import { createManagedSkillLink, listManagedSkillLinks, previewSkillLink } from "./skillLinks.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));
const windows = HostProcess.Platform.defaultValue() === "win32";
const linkType = windows ? "junction" : "dir";
let root: string;
let homeDir: string;
let stateDir: string;
let targets: string[];
let catalogDir: string;
const core = { core: { description: "Core", skills: ["explain"] } };

async function writeCatalog(dir = catalogDir, groups: Catalog["groups"] = core) {
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dir, "catalog.yaml"), stringify({ groups }));
  for (const skill of Object.values(groups).flatMap((group) => group.skills)) {
    await NodeFSP.mkdir(NodePath.join(dir, "skills", skill), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(dir, "skills", skill, "SKILL.md"),
      `---\ndescription: Explain clearly\n---\n`,
    );
  }
  return loadCatalog(NodePath.join(dir, "catalog.yaml"));
}
const dirs = () => targets;
async function apply(
  selected: string[],
  dir = catalogDir,
  options?: Parameters<typeof runApply>[1],
) {
  return runApply(
    {
      catalog: await loadCatalog(NodePath.join(dir, "catalog.yaml")),
      catalogDir: dir,
      stateDir,
      targets,
      state: await loadState(stateDir),
      selected,
      windows,
    },
    options,
  );
}

beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-installer-"));
  homeDir = NodePath.join(root, "home");
  catalogDir = NodePath.join(root, "catalog");
  stateDir = NodePath.join(root, "state");
  targets = [
    NodePath.join(homeDir, ".agents", "skills"),
    NodePath.join(homeDir, ".claude", "skills"),
  ];
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  await writeCatalog();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("does not take over another environment's catalog links", async () => {
  await apply(["core"]);
  const other = NodePath.join(root, "other-catalog");
  const catalog = await writeCatalog(other);
  const foreignState = NodePath.join(root, "other-state");
  const result = await runApply({
    catalog,
    catalogDir: other,
    stateDir: foreignState,
    targets,
    state: await loadState(foreignState),
    selected: ["core"],
    windows,
  });
  expect(result.installed).toBe(0);
  expect(result.conflicts).toHaveLength(2);
  for (const dir of dirs())
    expect(await NodeFSP.realpath(NodePath.join(dir, "explain"))).toBe(
      await NodeFSP.realpath(NodePath.join(catalogDir, "skills", "explain")),
    );
});

it("rolls back a newly created link if its ownership identity cannot be read", async () => {
  const symlink = NodeFSP.symlink;
  const lstat = NodeFSP.lstat;
  let capture = false;
  vi.spyOn(NodeFSP, "symlink").mockImplementation(async (...args) => {
    await symlink(...args);
    capture = true;
  });
  vi.spyOn(NodeFSP, "lstat").mockImplementation(async (...args) => {
    if (capture) {
      capture = false;
      throw new Error("identity unavailable");
    }
    return lstat(...args);
  });
  await expect(apply(["core"])).rejects.toThrow("identity unavailable");
  for (const dir of dirs())
    await expect(NodeFSP.lstat(NodePath.join(dir, "explain"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  expect((await loadState(stateDir)).links).toEqual([]);
});

describe("confirmed catalog replacements", () => {
  async function preview(broken = false) {
    const old = NodePath.join(root, "old-catalog");
    await writeCatalog(old);
    for (const dir of dirs()) {
      await NodeFSP.mkdir(dir, { recursive: true });
      await NodeFSP.symlink(
        NodePath.join(old, "skills", "explain"),
        NodePath.join(dir, "explain"),
        linkType,
      );
    }
    if (broken) await NodeFSP.rm(old, { recursive: true });
    const result = await apply(["core"]);
    return result.conflicts.map((conflict) => {
      expect(conflict.replacement).toBeDefined();
      return conflict.replacement!;
    });
  }
  async function replace(
    replacements: ReadonlyArray<SkillCatalogReplacement>,
    selected = ["core"],
  ) {
    return runApply({
      catalog: await loadCatalog(NodePath.join(catalogDir, "catalog.yaml")),
      catalogDir,
      stateDir,
      targets,
      state: await loadState(stateDir),
      selected,
      windows,
      replacements,
    });
  }

  it.each([false, true])(
    "replaces only confirmed external links, including broken links (%s)",
    async (broken) => {
      const [chosen, other] = await preview(broken);
      const result = await replace([chosen!]);
      expect(result).toMatchObject({ installed: 1, removed: 0, failed: [] });
      expect(result.conflicts.map((conflict) => conflict.linkPath)).toEqual([other!.linkPath]);
      expect(await NodeFSP.realpath(chosen!.linkPath)).toBe(await NodeFSP.realpath(chosen!.target));
      expect(await NodeFSP.readlink(other!.linkPath)).toBe(other!.currentTarget);
      expect((await loadState(stateDir)).links).toEqual([
        { path: chosen!.linkPath, target: chosen!.target },
      ]);
      if (!broken)
        expect(
          (await NodeFSP.stat(NodePath.join(chosen!.currentTarget, "SKILL.md"))).isFile(),
        ).toBe(true);
      expect(await apply([])).toMatchObject({ removed: 1 });
      expect(await NodeFSP.readlink(other!.linkPath)).toBe(other!.currentTarget);
    },
  );

  it.each(["file", "directory", "target", "identity", "missing"])(
    "rejects a link changed to %s before any mutation",
    async (change) => {
      const requests = await preview();
      const chosen = requests[0]!;
      const saved = await NodeFSP.readFile(stateFilePath(stateDir), "utf8");
      await NodeFSP.rename(chosen.linkPath, chosen.linkPath + ".old");
      if (change === "file") await NodeFSP.writeFile(chosen.linkPath, "keep");
      if (change === "directory") await NodeFSP.mkdir(chosen.linkPath);
      if (change === "target" || change === "identity") {
        await NodeFSP.symlink(
          change === "identity" ? chosen.currentTarget : catalogDir,
          chosen.linkPath,
          linkType,
        );
      }
      await expect(replace(requests)).rejects.toThrow("changed since preview");
      expect(await NodeFSP.readFile(stateFilePath(stateDir), "utf8")).toBe(saved);
      expect(await NodeFSP.readlink(requests[1]!.linkPath)).toBe(requests[1]!.currentTarget);
      if (change === "file") expect(await NodeFSP.readFile(chosen.linkPath, "utf8")).toBe("keep");
      if (change === "directory")
        expect((await NodeFSP.lstat(chosen.linkPath)).isDirectory()).toBe(true);
    },
  );

  it("refuses non-link conflicts and forged or out-of-scope replacements", async () => {
    const [chosen] = await preview();
    const requests = [
      [{ ...chosen!, linkPath: NodePath.join(root, "elsewhere") }],
      [{ ...chosen!, target: NodePath.join(root, "other-source") }],
      [{ ...chosen!, identity: "stale" }],
      [chosen!, chosen!],
    ];
    for (const request of requests)
      await expect(replace(request)).rejects.toThrow("changed since preview");
    await expect(replace([chosen!], [])).rejects.toThrow("changed since preview");
    await NodeFSP.unlink(chosen!.linkPath);
    await NodeFSP.mkdir(chosen!.linkPath);
    const result = await apply(["core"]);
    expect(
      result.conflicts.find((conflict) => conflict.linkPath === chosen!.linkPath)?.replacement,
    ).toBeUndefined();
    await expect(replace([chosen!])).rejects.toThrow("changed since preview");
  });

  it("does not apply unrelated additions or removals during link replacement", async () => {
    const [chosen, other] = await preview();
    const owned = NodePath.join(await canonicalSkillRoot(dirs()[0]!), "retired");
    const oldTarget = NodePath.join(root, "retired-source");
    await NodeFSP.symlink(oldTarget, owned, linkType);
    const state = await loadState(stateDir);
    await saveState(stateDir, {
      ...state,
      links: [...state.links, { path: owned, target: oldTarget }],
    });
    await NodeFSP.unlink(other!.linkPath);
    expect(await replace([chosen!])).toMatchObject({ installed: 1, removed: 0 });
    expect(await NodeFSP.readlink(owned)).toBe(oldTarget);
    await expect(NodeFSP.lstat(other!.linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadState(stateDir)).links).toContainEqual({ path: owned, target: oldTarget });
  });

  it("rejects a confirmation after another client changes the saved selection", async () => {
    const requests = await preview();
    await saveState(stateDir, { ...(await loadState(stateDir)), groups: [] });
    await expect(replace(requests)).rejects.toThrow("selection changed since preview");
    for (const request of requests)
      expect(await NodeFSP.readlink(request.linkPath)).toBe(request.currentTarget);
    expect((await loadState(stateDir)).groups).toEqual([]);
  });

  it("checks identity again immediately before replacing a same-target link", async () => {
    const [chosen] = await preview();
    await NodeFSP.rename(chosen!.linkPath, chosen!.linkPath + ".old");
    await NodeFSP.symlink(chosen!.currentTarget, chosen!.linkPath, linkType);
    const result = await applyPlan(
      {
        removals: [],
        additions: [
          {
            skill: "explain",
            linkPath: chosen!.linkPath,
            target: chosen!.target,
            replace: true,
            previousTarget: chosen!.currentTarget,
            previousIdentity: chosen!.identity,
          },
        ],
      },
      { windows },
    );
    expect(result.applied).toEqual([]);
    expect(result.failed[0]?.error).toContain("changed since inspection");
    expect(await NodeFSP.readlink(chosen!.linkPath)).toBe(chosen!.currentTarget);
  });

  it("restores external links and leaves ownership unchanged when state saving fails", async () => {
    const requests = await preview(true);
    const saved = await loadState(stateDir);
    vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(new Error("save denied"));
    await expect(replace(requests)).rejects.toMatchObject({
      name: "IncompleteApplyError",
      result: { installed: 0, removed: 0 },
    });
    expect(await loadState(stateDir)).toEqual(saved);
    for (const request of requests)
      expect(await NodeFSP.readlink(request.linkPath)).toBe(request.currentTarget);
  });
});

describe("catalog validation and selection", () => {
  it("overlaps source validation reads with a limit of eight", async () => {
    const skills = Array.from({ length: 17 }, (_, index) => `skill-${index}`);
    const catalog = await writeCatalog(catalogDir, { core: { description: "Core", skills } });
    const stat = NodeFSP.stat;
    let active = 0;
    let peak = 0;
    const reads = vi.spyOn(NodeFSP, "stat").mockImplementation(async (file) => {
      peak = Math.max(peak, ++active);
      try {
        return await stat(file);
      } finally {
        active--;
      }
    });
    await verifySkills(catalog, skills);
    expect(reads).toHaveBeenCalledTimes(17);
    expect(peak).toBe(8);
  });
  it.each([
    [{}, undefined],
    [{ groups: [] }, undefined],
    [{ groups: { Core: core.core } }, undefined],
    [{ groups: { core: null } }, undefined],
    [{ groups: { core: { skills: ["explain"] } } }, undefined],
    [{ groups: { core: { description: "c", skills: [] } } }, undefined],
    [{ groups: { core: { description: "c", skills: ["../escape"] } } }, undefined],
    [{ groups: { core: { ...core.core, depends: "other" } } }, undefined],
    [{ groups: { core: { ...core.core, depends: ["other"] } } }, "unknown dependency: other"],
    [
      { groups: { core: { ...core.core, depends: ["constructor"] } } },
      "unknown dependency: constructor",
    ],
    [{ groups: { ...core, other: core.core } }, "Skill explain is in groups core and other"],
  ])("rejects invalid catalog %#", async (data, message) => {
    const file = NodePath.join(catalogDir, "catalog.yaml");
    await NodeFSP.writeFile(file, stringify(data));
    await expect(loadCatalog(file)).rejects.toThrow(message);
  });

  it("expands dependencies, keeps explicit selections, and rejects cycles and unknown groups", async () => {
    const catalog = await writeCatalog(catalogDir, {
      ...core,
      review: { description: "Review", skills: ["review"], depends: ["core"] },
      all: { description: "All", skills: ["all"], depends: ["review"] },
    });
    expect(resolveSelection(catalog, ["all", "all"])).toEqual({
      groups: ["core", "review", "all"],
      skills: ["explain", "review", "all"],
    });
    for (const group of ["unknown", "constructor"]) {
      expect(() => resolveSelection(catalog, [group])).toThrow(`Unknown group: ${group}`);
    }
    expect((await apply(["all", "all"])).selectedGroups).toEqual(["all"]);
    expect((await loadState(stateDir)).groups).toEqual(["all"]);
    const cyclic = await writeCatalog(catalogDir, {
      core: { ...core.core, depends: ["other"] },
      other: { description: "o", skills: ["other"], depends: ["core"] },
    });
    expect(() => resolveSelection(cyclic, ["core"])).toThrow(
      "Dependency cycle: core -> other -> core",
    );
  });

  it("rejects missing SKILL.md before changing links or state", async () => {
    await NodeFSP.unlink(NodePath.join(catalogDir, "skills", "explain", "SKILL.md"));
    await expect(apply(["core"])).rejects.toThrow("Missing SKILL.md for: explain");
    await expect(NodeFSP.lstat(homeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["dangling", "directory", "directory-link"])(
    "rejects a %s SKILL.md before changing links or state",
    async (kind) => {
      await apply(["core"]);
      const previous = await NodeFSP.readFile(stateFilePath(stateDir), "utf8");
      const file = NodePath.join(catalogDir, "skills", "explain", "SKILL.md");
      await NodeFSP.unlink(file);
      if (kind === "directory") await NodeFSP.mkdir(file);
      else
        await NodeFSP.symlink(
          kind === "dangling" ? NodePath.join(root, "missing.md") : catalogDir,
          file,
        );
      await expect(apply(["core"])).rejects.toThrow("Missing SKILL.md for: explain");
      expect(await NodeFSP.readFile(stateFilePath(stateDir), "utf8")).toBe(previous);
      for (const dir of dirs())
        expect((await NodeFSP.lstat(NodePath.join(dir, "explain"))).isSymbolicLink()).toBe(true);
    },
  );

  it("accepts a SKILL.md symlink to a regular file", async () => {
    const file = NodePath.join(catalogDir, "skills", "explain", "SKILL.md");
    const target = NodePath.join(root, "source.md");
    await NodeFSP.rename(file, target);
    await NodeFSP.symlink(target, file);
    expect(await apply(["core"])).toMatchObject({ installed: 2, failed: [] });
  });

  it("reports invalid sources in selection order", async () => {
    const catalog = await writeCatalog(catalogDir, {
      core: { description: "Core", skills: ["zulu", "alpha", "middle"] },
    });
    await NodeFSP.rm(NodePath.join(catalogDir, "skills", "zulu"), { recursive: true });
    await NodeFSP.rm(NodePath.join(catalogDir, "skills", "middle"), { recursive: true });
    await expect(verifySkills(catalog, ["zulu", "alpha", "middle"])).rejects.toThrow(
      "Missing SKILL.md for: zulu, middle",
    );
  });
});

describe("link ownership", () => {
  it("classifies absent, unchanged, replacement, and foreign entries without mutation", async () => {
    const skills = ["absent", "same", "owned", "foreign", "directory", "file"];
    await writeCatalog(catalogDir, { core: { description: "c", skills } });
    const dir = dirs()[0]!;
    await NodeFSP.mkdir(dir, { recursive: true });
    const target = (skill: string) => NodePath.join(catalogDir, "skills", skill);
    const path = (skill: string) => NodePath.join(dir, skill);
    await NodeFSP.symlink(target("same"), path("same"), linkType);
    await NodeFSP.symlink(target("same"), path("owned"), linkType);
    await NodeFSP.symlink(target("same"), path("foreign"), linkType);
    await NodeFSP.mkdir(path("directory"));
    await NodeFSP.writeFile(path("file"), "keep");
    const before = await NodeFSP.readdir(dir);
    const plan = await planInstall({
      catalogDir,
      skills,
      dirs: [dir],
      recordedLinks: [{ path: path("owned"), target: target("same") }],
    });
    expect(plan.additions.map((entry) => [entry.skill, entry.replace ?? false])).toEqual([
      ["absent", false],
      ["owned", true],
    ]);
    expect(plan.unchanged.map((entry) => entry.skill)).toEqual(["same"]);
    expect(plan.conflicts.map((entry) => entry.skill)).toEqual(["foreign", "directory", "file"]);
    expect(await NodeFSP.readdir(dir)).toEqual(before);
    expect(await NodeFSP.readFile(path("file"), "utf8")).toBe("keep");
    expect(
      await verifyLinks([{ skill: "owned", linkPath: path("owned"), target: target("same") }]),
    ).toEqual([]);
  });

  it("installs idempotently, replaces owned targets, and deselects only owned links", async () => {
    expect(await apply(["core"])).toMatchObject({ installed: 2, removed: 0 });
    expect(await apply(["core"])).toMatchObject({ installed: 0, unchanged: 2 });
    const otherCatalog = NodePath.join(root, "other-catalog");
    await writeCatalog(otherCatalog);
    expect(await apply(["core"], otherCatalog)).toMatchObject({ installed: 2, removed: 0 });
    const links = (await loadState(stateDir)).links;
    expect(
      links.every((link) => link.target === NodePath.join(otherCatalog, "skills", "explain")),
    ).toBe(true);
    for (const dir of dirs()) await NodeFSP.writeFile(NodePath.join(dir, "foreign"), "keep");
    expect(await apply([], otherCatalog)).toMatchObject({ removed: 2 });
    expect((await loadState(stateDir)).links).toEqual([]);
    for (const dir of dirs()) expect(await NodeFSP.readdir(dir)).toEqual(["foreign"]);
  });

  it("leaves matching external links untouched", async () => {
    const skill = NodePath.join(catalogDir, "skills", "explain");
    const agentRoot = dirs()[0]!;
    await NodeFSP.mkdir(agentRoot, { recursive: true });
    const foreign = NodePath.join(agentRoot, "explain");
    await NodeFSP.symlink(skill, foreign, linkType);
    expect(await apply(["core"])).toMatchObject({ installed: 1, unchanged: 1 });
    expect((await loadState(stateDir)).links.map((link) => link.path)).not.toContain(foreign);
    expect(await apply([])).toMatchObject({ removed: 1 });
    expect(await NodeFSP.realpath(foreign)).toBe(await NodeFSP.realpath(skill));
  });

  it("leaves managed links owned by the linker untouched", async () => {
    const skill = NodePath.join(catalogDir, "skills", "explain");
    const stateDir = NodePath.join(root, "link-state");
    const preview = {
      ...(await previewSkillLink(skill, dirs()[0]!, "claudeAgent")),
      sharedWith: [],
    };
    const request = {
      source: { instanceId: ProviderInstanceId.make("claude"), path: skill, name: "explain" },
      targetInstanceId: ProviderInstanceId.make("codex"),
      scope: "user" as const,
    };
    await createManagedSkillLink(stateDir, preview, request, windows);
    await apply(["core"]);
    await apply([]);
    expect((await listManagedSkillLinks(stateDir))[0]?.status).toBe("linked");
  });

  it("counts a shared physical skills root once and migrates equivalent saved paths", async () => {
    const agentRoot = NodePath.join(homeDir, ".agents", "skills");
    const claudeRoot = NodePath.join(homeDir, ".claude", "skills");
    await NodeFSP.mkdir(agentRoot, { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(claudeRoot), { recursive: true });
    await NodeFSP.symlink(agentRoot, claudeRoot, linkType);
    expect(await apply(["core"])).toMatchObject({ installed: 1, failed: [] });
    expect((await loadState(stateDir)).links).toHaveLength(1);

    const target = NodePath.join(catalogDir, "skills", "explain");
    await saveState(stateDir, {
      folder: catalogDir,
      groups: ["core"],
      links: [
        { path: NodePath.join(agentRoot, "explain"), target },
        { path: NodePath.join(claudeRoot, "explain"), target },
      ],
    });
    expect(await apply(["core"])).toMatchObject({ unchanged: 1 });
    expect((await loadState(stateDir)).links).toHaveLength(1);
    expect(await apply([])).toMatchObject({ removed: 1 });
    await expect(NodeFSP.lstat(NodePath.join(agentRoot, "explain"))).rejects.toThrow(/ENOENT/);
  });

  it("refuses conflicting ownership records for one physical destination", async () => {
    const agentRoot = NodePath.join(homeDir, ".agents", "skills");
    const claudeRoot = NodePath.join(homeDir, ".claude", "skills");
    await NodeFSP.mkdir(agentRoot, { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(claudeRoot), { recursive: true });
    await NodeFSP.symlink(agentRoot, claudeRoot, linkType);
    const target = NodePath.join(catalogDir, "skills", "explain");
    await NodeFSP.symlink(target, NodePath.join(agentRoot, "explain"), linkType);
    await saveState(stateDir, {
      folder: catalogDir,
      groups: ["core"],
      links: [
        { path: NodePath.join(agentRoot, "explain"), target },
        { path: NodePath.join(claudeRoot, "explain"), target: NodePath.join(root, "other") },
      ],
    });
    const saved = await NodeFSP.readFile(stateFilePath(stateDir), "utf8");
    await expect(apply([])).rejects.toThrow(/Conflicting saved ownership/);
    expect(await NodeFSP.readFile(stateFilePath(stateDir), "utf8")).toBe(saved);
    expect(await NodeFSP.readlink(NodePath.join(agentRoot, "explain"))).toBe(target);
  });

  it("removes broken owned links and their state after upstream deletion", async () => {
    await apply(["core"]);
    await NodeFSP.rm(NodePath.join(catalogDir, "skills", "explain"), { recursive: true });
    expect(await apply([])).toMatchObject({ removed: 2 });
    expect((await loadState(stateDir)).links).toEqual([]);
    for (const dir of dirs()) expect(await NodeFSP.readdir(dir)).toEqual([]);
  });

  it("rechecks additions and removals and stops at the first changed entry", async () => {
    const [dir] = dirs();
    const plan = await planInstall({
      catalogDir,
      skills: ["explain"],
      dirs: [dir!],
      recordedLinks: [],
    });
    await NodeFSP.mkdir(NodePath.join(dir!, "explain"), { recursive: true });
    const addition = await applyPlan(plan, { windows });
    expect(addition.failed[0]?.error).toContain("changed since inspection");
    expect(addition.applied).toEqual([]);
    await NodeFSP.rm(dir!, { recursive: true });
    await apply(["core"]);
    const removal = await planInstall({
      catalogDir,
      skills: [],
      dirs: await Promise.all(dirs().map(canonicalSkillRoot)),
      recordedLinks: (await loadState(stateDir)).links,
    });
    await NodeFSP.unlink(NodePath.join(dir!, "explain"));
    await NodeFSP.writeFile(NodePath.join(dir!, "explain"), "foreign");
    const result = await applyPlan(removal, { windows });
    expect(result.failed[0]?.error).toContain("changed since inspection");
    expect(result.applied).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(dir!, "explain"), "utf8")).toBe("foreign");
    expect((await NodeFSP.lstat(NodePath.join(dirs()[1]!, "explain"))).isSymbolicLink()).toBe(true);
  });
});

describe("partial apply recovery", () => {
  it.each(["remove", "create"])(
    "retains correct ownership after a replacement %s fails",
    async (failure) => {
      await apply(["core"]);
      const otherCatalog = NodePath.join(root, "other-catalog");
      await writeCatalog(otherCatalog);
      const blocked = NodePath.join(await canonicalSkillRoot(dirs()[1]!), "explain");
      const originalUnlink = NodeFSP.unlink;
      const originalSymlink = NodeFSP.symlink;
      if (failure === "remove") {
        vi.spyOn(NodeFSP, "unlink").mockImplementation(async (path) => {
          if (path === blocked) throw new Error("blocked removal");
          return originalUnlink(path);
        });
      } else {
        vi.spyOn(NodeFSP, "symlink").mockImplementation(async (target, path, type) => {
          if (path === blocked) throw new Error("blocked creation");
          return originalSymlink(target, path, type);
        });
      }
      const error = await apply(["core"], otherCatalog).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(IncompleteApplyError);
      if (!(error instanceof IncompleteApplyError)) throw new Error("Expected partial result");
      expect(error.result).toMatchObject({
        installed: 1,
        removed: failure === "create" ? 1 : 0,
        failed: [{ linkPath: blocked, error: expect.stringContaining("blocked") }],
      });
      const saved = await loadState(stateDir);
      expect(saved.links).toHaveLength(failure === "remove" ? 2 : 1);
      if (failure === "remove")
        expect(saved.links.find((link) => link.path === blocked)?.target).toBe(
          NodePath.join(catalogDir, "skills", "explain"),
        );
      vi.restoreAllMocks();
      await apply(["core"], otherCatalog);
      expect(
        (await loadState(stateDir)).links.every(
          (link) => link.target === NodePath.join(otherCatalog, "skills", "explain"),
        ),
      ).toBe(true);
    },
  );

  it.each(["throw", "mismatch"])(
    "preserves counts and ownership on verification %s",
    async (failure) => {
      await expect(
        apply(["core"], catalogDir, {
          verifyLinks: async () => {
            if (failure === "throw") throw new Error("verification denied");
            return [NodePath.join(dirs()[0]!, "explain")];
          },
        }),
      ).rejects.toMatchObject({
        name: "IncompleteApplyError",
        result: {
          installed: 2,
          failed: [
            {
              error: expect.stringContaining(
                failure === "throw" ? "verification denied" : "not verified",
              ),
            },
          ],
        },
      });
      expect((await loadState(stateDir)).links).toHaveLength(2);
      expect(await apply(["core"])).toMatchObject({ unchanged: 2 });
    },
  );

  it.each([false, true])(
    "rolls back completed additions when persistence fails (link failure %s)",
    async (failLink) => {
      await saveState(stateDir, { folder: catalogDir, groups: [], links: [] });
      const previous = await NodeFSP.readFile(stateFilePath(stateDir), "utf8");
      const originalSymlink = NodeFSP.symlink;
      if (failLink)
        vi.spyOn(NodeFSP, "symlink").mockImplementation(async (target, path, type) => {
          if (path === NodePath.join(await canonicalSkillRoot(dirs()[1]!), "explain"))
            throw new Error("link denied");
          return originalSymlink(target, path, type);
        });
      vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(new Error("save denied"));
      await expect(apply(["core"])).rejects.toMatchObject({
        name: "IncompleteApplyError",
        message: expect.stringContaining("state save failed"),
        result: { installed: 0 },
      });
      expect(await NodeFSP.readFile(stateFilePath(stateDir), "utf8")).toBe(previous);
      for (const dir of dirs()) {
        await expect(NodeFSP.lstat(NodePath.join(dir, "explain"))).rejects.toThrow(/ENOENT/);
      }
      vi.restoreAllMocks();
      await apply(["core"]);
      expect((await loadState(stateDir)).links).toHaveLength(2);
    },
  );

  it("restores owned targets after a failed state save during replacement", async () => {
    await apply(["core"]);
    const previous = await loadState(stateDir);
    const otherCatalog = NodePath.join(root, "other-catalog");
    await writeCatalog(otherCatalog);
    vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(new Error("save denied"));
    await expect(apply(["core"], otherCatalog)).rejects.toMatchObject({
      name: "IncompleteApplyError",
      result: { installed: 0, removed: 0 },
    });
    expect(await loadState(stateDir)).toEqual(previous);
    for (const link of previous.links) {
      expect(await NodeFSP.readlink(link.path)).toBe(link.target);
    }
  });

  it("reports an incomplete rollback and never adopts its unrecorded link", async () => {
    const path = NodePath.join(await canonicalSkillRoot(dirs()[0]!), "explain");
    vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(new Error("save denied"));
    const unlink = NodeFSP.unlink;
    vi.spyOn(NodeFSP, "unlink").mockImplementation(async (link) => {
      if (link === path) throw new Error("unlink denied");
      return unlink(link);
    });
    const failure = await apply(["core"]).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "IncompleteApplyError",
      message: expect.stringContaining("Rollback incomplete"),
      result: { installed: 1, failed: [expect.objectContaining({ linkPath: path })] },
    });
    vi.restoreAllMocks();
    await apply(["core"]);
    expect((await loadState(stateDir)).links.map((link) => link.path)).not.toContain(path);
  });
});

describe("state, targets and descriptions", () => {
  it("overlaps plan reads within eight and preserves directory and skill order", async () => {
    const skills = Array.from({ length: 9 }, (_, index) => `skill-${index}`);
    const targetRoots = dirs();
    const recordedLinks = targetRoots.map((dir) => ({
      path: NodePath.join(dir, "removed"),
      target: NodePath.join(catalogDir, "skills", "removed"),
    }));
    for (const link of recordedLinks) {
      await NodeFSP.mkdir(NodePath.dirname(link.path), { recursive: true });
      await NodeFSP.symlink(link.target, link.path, linkType);
      await NodeFSP.mkdir(NodePath.join(NodePath.dirname(link.path), "skill-3"));
    }
    const lstat = NodeFSP.lstat;
    let active = 0;
    let peak = 0;
    vi.spyOn(NodeFSP, "lstat").mockImplementation(async (file) => {
      peak = Math.max(peak, ++active);
      try {
        return await lstat(file);
      } finally {
        active--;
      }
    });
    const plan = await planInstall({ catalogDir, skills, dirs: targetRoots, recordedLinks });
    expect(peak).toBe(8);
    expect(plan.additions.map((entry) => entry.linkPath)).toEqual(
      targetRoots.flatMap((dir) =>
        skills.filter((skill) => skill !== "skill-3").map((skill) => NodePath.join(dir, skill)),
      ),
    );
    expect(plan.removals.map((entry) => entry.linkPath)).toEqual(
      recordedLinks.map((link) => link.path),
    );
    expect(plan.conflicts.map((entry) => entry.linkPath)).toEqual(
      targetRoots.map((dir) => NodePath.join(dir, "skill-3")),
    );
  });
  it("writes state atomically with private permissions", async () => {
    const initial = { folder: catalogDir, groups: [], links: [] };
    await saveState(stateDir, initial);
    const oldFile = await NodeFSP.open(stateFilePath(stateDir));
    try {
      await saveState(stateDir, { ...initial, groups: ["core"] });
      expect(JSON.parse(await oldFile.readFile("utf8"))).toEqual(initial);
      expect((await loadState(stateDir)).groups).toEqual(["core"]);
      if (!windows) expect((await NodeFSP.stat(stateFilePath(stateDir))).mode & 0o777).toBe(0o600);
      expect(await NodeFSP.readdir(NodePath.dirname(stateFilePath(stateDir)))).toEqual([
        "skill-catalog.json",
      ]);
    } finally {
      await oldFile.close();
    }
  });

  it("preserves malformed state and installed links", async () => {
    await apply(["core"]);
    await NodeFSP.writeFile(stateFilePath(stateDir), "{malformed");
    await expect(apply([])).rejects.toBeInstanceOf(SyntaxError);
    expect(await NodeFSP.readFile(stateFilePath(stateDir), "utf8")).toBe("{malformed");
    for (const dir of dirs())
      expect((await NodeFSP.lstat(NodePath.join(dir, "explain"))).isSymbolicLink()).toBe(true);
  });

  it("honors explicit targets and migrates relative ownership", async () => {
    targets = [targets[0]!, NodePath.join(root, "custom", "skills")];
    await apply(["core"]);
    expect(
      (await NodeFSP.lstat(NodePath.join(root, "custom", "skills", "explain"))).isSymbolicLink(),
    ).toBe(true);
    const relativePath = NodePath.join("claude-config", "skills", "explain");
    targets = [targets[0]!, NodePath.join(catalogDir, "claude-config", "skills")];
    const oldTarget = NodePath.join(root, "old-target");
    await NodeFSP.mkdir(oldTarget);
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(catalogDir, relativePath)), {
      recursive: true,
    });
    await NodeFSP.symlink(oldTarget, NodePath.join(catalogDir, relativePath), linkType);
    await saveState(stateDir, {
      folder: catalogDir,
      groups: ["core"],
      links: [{ path: relativePath, target: oldTarget }],
    });
    expect(await apply(["core"])).toMatchObject({ installed: 1, unchanged: 1 });
    expect((await loadState(stateDir)).links.every((link) => NodePath.isAbsolute(link.path))).toBe(
      true,
    );
    expect(await apply([])).toMatchObject({ removed: 1 });
    await expect(NodeFSP.lstat(NodePath.join(catalogDir, relativePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await NodeFSP.lstat(NodePath.join(root, "custom", "skills", "explain"))).isSymbolicLink(),
    ).toBe(true);
  });

  it("rejects relative ownership without an absolute saved folder", async () => {
    for (const folder of [null, "relative"]) {
      await saveState(stateDir, {
        folder,
        groups: [],
        links: [{ path: "skills/explain", target: catalogDir }],
      });
      await expect(loadState(stateDir)).rejects.toThrow("saved catalog folder is not absolute");
    }
  });

  it("reads untruncated multiline frontmatter and tolerates missing or malformed descriptions", async () => {
    const file = NodePath.join(catalogDir, "skills", "explain", "SKILL.md");
    const long = "description ".repeat(30).trim();
    await NodeFSP.writeFile(
      file,
      `---\r\ndescription: |\r\n  ${long}\r\n  More details\r\n---\r\n`,
    );
    expect(await skillDescription(catalogDir, "explain")).toBe(`${long} More details`);
    for (const text of ["No frontmatter", "---\ndescription: [broken\n---\n"]) {
      await NodeFSP.writeFile(file, text);
      expect(await skillDescription(catalogDir, "explain")).toBe("");
    }
    expect(await skillDescription(catalogDir, "missing")).toBe("");
  });
});
