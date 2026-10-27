import type { EnvironmentId } from "@t3tools/contracts";

import { useOptionalSettingsScope } from "../components/settings/SettingsScopeContext";

/**
 * A named environment in the settings scope pins the page and replaces its own picker; otherwise
 * the picker offers the selection's environments and starts at its representative, like upstream's
 * Providers page. Outside settings nothing is narrowed.
 */
export function useSettingsScopeEnvironments<T extends { readonly environmentId: EnvironmentId }>(
  environments: readonly T[],
  fallbackEnvironmentId: EnvironmentId | null,
) {
  const settings = useOptionalSettingsScope();
  if (settings === null || settings.scope.kind === "unavailable") {
    return {
      candidates: environments,
      pinnedEnvironmentId: null,
      initialEnvironmentId: fallbackEnvironmentId,
    };
  }
  const { scope, environment } = settings;
  const pinnedEnvironmentId = scope.kind === "all" ? null : scope.environmentId;
  const selected = new Set(scope.environmentIds);
  return {
    candidates: environments.filter((entry) => selected.has(entry.environmentId)),
    pinnedEnvironmentId,
    initialEnvironmentId:
      pinnedEnvironmentId ?? environment?.environmentId ?? fallbackEnvironmentId,
  };
}
