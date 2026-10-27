import { useClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useOwnedEnvironments } from "../../j5/sharing/settingsAccess";

export function useSettingsProjectGroups() {
  // J5 (case 72): Settings manages only the projects of servers the person owns.
  const projects = useOwnedEnvironments(useProjects());
  // Avoid object selector identities that rebuild groups and every settings row on each write.
  const sidebarProjectGroupingMode = useClientSettings(
    (settings) => settings.sidebarProjectGroupingMode,
  );
  const sidebarProjectGroupingOverrides = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  return buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides },
    primaryEnvironmentId,
    resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
