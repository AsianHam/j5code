import type { ProviderInstanceId, ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

import { SKILL_ORIGINS, skillOrigin, type SkillOrigin } from "@t3tools/shared/j5/skillInventory";
export {
  SKILL_ORIGINS,
  skillOrigin,
  skillDiscoveryState,
  type SkillOrigin,
  type SkillDiscoveryState,
} from "@t3tools/shared/j5/skillInventory";

import type { SkillDiscoveryState } from "@t3tools/shared/j5/skillInventory";

export interface SkillInventoryRow {
  readonly key: string;
  readonly origin: SkillOrigin;
  readonly sortName: string;
  readonly searchText: string;
  readonly records: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ServerProviderSkill>>;
}

export function buildSkillInventory(
  providers: ReadonlyArray<ServerProvider>,
  cwd?: string,
  catalogSource?: string,
): SkillInventoryRow[] {
  const rows = new Map<
    string,
    {
      key: string;
      origin: SkillOrigin;
      sortName: string;
      records: Map<ProviderInstanceId, ServerProviderSkill[]>;
    }
  >();
  for (const provider of providers) {
    const workspace = cwd
      ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)
      : undefined;
    for (const skill of workspace?.skills ?? provider.skills) {
      // Unresolved paths are not evidence that two providers see the same file.
      const key = skill.linkTarget
        ? JSON.stringify(["resolved", skill.linkTarget])
        : JSON.stringify([provider.instanceId, skill.path, skill.name, skill.pluginId]);
      const origin = skillOrigin(skill, cwd, catalogSource);
      const row = rows.get(key) ?? { key, origin, sortName: skill.name, records: new Map() };
      if (SKILL_ORIGINS.indexOf(origin) < SKILL_ORIGINS.indexOf(row.origin)) row.origin = origin;
      row.records.set(provider.instanceId, [
        ...(row.records.get(provider.instanceId) ?? []),
        skill,
      ]);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      searchText: [
        row.origin,
        ...[...row.records.values()]
          .flat()
          .flatMap((skill) => [
            skill.name,
            skill.displayName,
            skill.description,
            skill.shortDescription,
            skill.path,
            skill.linkTarget,
            skill.pluginId,
          ]),
      ]
        .join(" ")
        .toLowerCase(),
    }))
    .sort((a, b) => a.sortName.localeCompare(b.sortName) || a.key.localeCompare(b.key));
}

export function filterSkillInventory(
  rows: ReadonlyArray<SkillInventoryRow>,
  query: string,
  instanceId?: ProviderInstanceId,
): SkillInventoryRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (instanceId && !row.records.has(instanceId)) return false;
    return terms.every((term) => row.searchText.includes(term));
  });
}

/**
 * The provider columns the unfiltered inventory shows. A Codex or Claude
 * instance that is on stays visible with no skills, so a missing record reads
 * differently from unknown discovery; an instance that is off or not installed
 * shows only while it has cached rows.
 */
export function inventoryColumnProviders(
  providers: ReadonlyArray<ServerProvider>,
  rows: ReadonlyArray<SkillInventoryRow>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      ((provider.driver === "codex" || provider.driver === "claudeAgent") &&
        provider.enabled &&
        provider.installed) ||
      rows.some((row) => row.records.has(provider.instanceId)),
  );
}

export function missingSkillLabel(state: SkillDiscoveryState): string {
  return state === "checked"
    ? "Not detected"
    : state === "failed"
      ? "Refresh failed"
      : "Not checked";
}
