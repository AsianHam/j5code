import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildSkillInventory,
  filterSkillInventory,
  inventoryColumnProviders,
  missingSkillLabel,
  skillDiscoveryState,
  skillOrigin,
} from "./skillInventory";

const skill: ServerProviderSkill = {
  name: "review",
  path: "/skills/review/SKILL.md",
  linkTarget: "/shared/review/SKILL.md",
  enabled: true,
};
function provider(
  id: string,
  skills: ReadonlyArray<ServerProviderSkill> = [skill],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-18T00:00:00Z",
    skills,
    slashCommands: [],
    models: [],
  };
}

describe("skill inventory", () => {
  it("keeps bundled skills from one executable in separate Built-in rows", () => {
    const claude = provider(
      "claudeAgent",
      ["simplify", "loop"].map((name) => ({
        name,
        path: "/usr/bin/claude",
        scope: "builtin",
        enabled: true,
      })),
    );
    const codex = provider("codex");
    const rows = buildSkillInventory([claude, codex]).filter((row) => row.origin === "Built-in");
    expect(rows.map((row) => row.records.get(claude.instanceId)?.[0]?.name)).toEqual([
      "loop",
      "simplify",
    ]);
    expect(rows.every((row) => !row.records.has(codex.instanceId))).toBe(true);
  });
  it("sorts by the first record name and breaks ties by the existing row key", () => {
    const a = provider("first", [
      { ...skill, name: "same", linkTarget: "/z/SKILL.md" },
      { ...skill, name: "same", linkTarget: "/a/SKILL.md" },
      { ...skill, name: "zulu", linkTarget: "/middle/SKILL.md" },
    ]);
    const b = provider("second", [{ ...skill, name: "alpha", linkTarget: "/middle/SKILL.md" }]);
    expect(
      buildSkillInventory([a, b]).map((row) => row.records.get(a.instanceId)![0]!.linkTarget),
    ).toEqual(["/a/SKILL.md", "/z/SKILL.md", "/middle/SKILL.md"]);
  });
  it("merges only canonical locations and retains every provider instance's complete records", () => {
    const a = provider("codex-personal");
    const disabled = {
      ...skill,
      name: "tools:review",
      path: "/claude/skills/review/SKILL.md",
      pluginId: "tools@market",
      enabled: false,
      userInvocationOnly: true,
      userInvocable: false,
    };
    const b = provider("claude-work", [disabled]);
    const c = provider("codex-work", [
      { ...skill, linkTarget: "/separate/plugin/review/SKILL.md", pluginId: "tools@other" },
    ]);
    const rows = buildSkillInventory([a, b, c]);
    expect(rows).toHaveLength(2);
    const merged = rows.find((row) => row.records.has(b.instanceId))!;
    expect(merged.origin).toBe("Plugin");
    expect(merged.records.get(a.instanceId)).toEqual([skill]);
    expect(merged.records.get(b.instanceId)).toEqual([disabled]);
    const unresolved = { name: "review", path: "/same/path", enabled: true };
    expect(
      buildSkillInventory([provider("one", [unresolved]), provider("two", [unresolved])]),
    ).toHaveLength(2);
  });

  it("classifies explicit plugin identity, catalog boundaries and provider scopes before cwd containment", () => {
    expect(skillOrigin({ ...skill, pluginId: "a", scope: "project" }, "/skills", "/shared")).toBe(
      "Plugin",
    );
    expect(
      skillOrigin(
        { ...skill, linkTarget: "C:\\catalog\\skills\\review\\SKILL.md", scope: "user" },
        undefined,
        "C:/catalog/",
      ),
    ).toBe("Catalog");
    expect(
      skillOrigin(
        { ...skill, linkTarget: "/catalog-other/skills/review/SKILL.md", scope: "user" },
        undefined,
        "/catalog",
      ),
    ).toBe("Personal");
    expect(
      skillOrigin(
        { ...skill, linkTarget: "/catalog/../other/SKILL.md", scope: "user" },
        undefined,
        "/catalog",
      ),
    ).toBe("Personal");
    expect(
      skillOrigin({
        ...skill,
        linkTarget: "/home/.t3/userdata/skill-catalogs/123/catalog/skills/review/SKILL.md",
      }),
    ).toBe("Catalog");
    expect(skillOrigin({ ...skill, scope: "user" }, "/skills")).toBe("Personal");
    expect(skillOrigin({ ...skill, scope: "system" }, "/skills")).toBe("Built-in");
    expect(skillOrigin(skill, "/unrelated")).toBe("Other");
    expect(skillOrigin(skill, "/skill")).toBe("Other");
    expect(skillOrigin(skill, "/skills")).toBe("Project");
  });

  it("filters names, descriptions, plugin IDs, source and target paths by provider instance", () => {
    const a = provider("one", [
      {
        ...skill,
        description: "Inspect changes",
        displayName: "Friendly title",
        shortDescription: "Brief summary",
        pluginId: "audit@team",
      },
    ]);
    const b = provider("two", [{ ...skill, linkTarget: "/other/SKILL.md", name: "deploy" }]);
    const rows = buildSkillInventory([a, b]);
    for (const query of [
      "inspect",
      "audit@team",
      "/shared/review",
      "review changes",
      "  FRIENDLY title ",
      "brief summary",
      "plugin",
    ])
      expect(filterSkillInventory(rows, query)).toHaveLength(1);
    expect(filterSkillInventory(rows, "", b.instanceId)).toHaveLength(1);
    expect(filterSkillInventory(rows, "review changes", b.instanceId)).toHaveLength(0);
  });

  it("keeps missing and failed discovery distinct from a successful empty inventory", () => {
    const global = provider("one");
    expect(skillDiscoveryState(global, "/project")).toBe("not-checked");
    expect(buildSkillInventory([global], "/project")).toHaveLength(1);
    const checked = {
      ...global,
      workspaceSnapshots: [
        { cwd: "/project", checkedAt: global.checkedAt, skills: [], slashCommands: [] },
      ],
    };
    expect(skillDiscoveryState(checked, "/project")).toBe("checked");
    expect(buildSkillInventory([checked], "/project")).toEqual([]);
    const stale = {
      ...global,
      workspaceSnapshots: [
        { ...checked.workspaceSnapshots[0]!, skills: [skill], refreshError: "Failed" },
      ],
    };
    expect(skillDiscoveryState(stale, "/project")).toBe("failed");
    expect(buildSkillInventory([stale], "/project")).toHaveLength(1);
    expect(missingSkillLabel(skillDiscoveryState(stale, "/project"))).toBe("Refresh failed");
    expect(skillDiscoveryState({ ...global, status: "error" })).toBe("failed");
    expect(
      skillDiscoveryState({ ...global, status: "ready", skillDiscoveryError: "Probe failed" }),
    ).toBe("failed");
    expect(skillDiscoveryState({ ...global, enabled: false })).toBe("not-checked");
  });

  it("keeps empty Codex and Claude columns only while the instance is on and installed", () => {
    const withSkills = provider("with-skills");
    const emptyOn = provider("empty-on", []);
    const emptyOff = { ...provider("empty-off", []), enabled: false };
    const emptyMissing = { ...provider("empty-missing", []), installed: false };
    const offWithCache = { ...provider("off-cached"), enabled: false };
    const emptyOther = {
      ...provider("empty-other", []),
      driver: ProviderDriverKind.make("cursor"),
    };
    const providers = [withSkills, emptyOn, emptyOff, emptyMissing, offWithCache, emptyOther];

    expect(
      inventoryColumnProviders(providers, buildSkillInventory(providers)).map((p) => p.instanceId),
    ).toEqual(["with-skills", "empty-on", "off-cached"]);
  });

  it("keeps only on and installed Codex and Claude columns when nothing reports skills", () => {
    const emptyOn = provider("empty-on", []);
    const emptyOff = { ...provider("empty-off", []), enabled: false };
    const emptyMissing = { ...provider("empty-missing", []), installed: false };
    const emptyOther = {
      ...provider("empty-other", []),
      driver: ProviderDriverKind.make("cursor"),
    };
    const providers = [emptyOn, emptyOff, emptyMissing, emptyOther];

    expect(inventoryColumnProviders(providers, []).map((p) => p.instanceId)).toEqual(["empty-on"]);
  });
});
