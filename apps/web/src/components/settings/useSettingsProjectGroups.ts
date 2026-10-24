import { useClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useOwnedEnvironments } from "../../j5/sharing/settingsAccess";

export function useSettingsProjectGroups() {
  // J5 (case 72): Settings manages only the projects of servers the person owns.
  const projects = useOwnedEnvironments(useProjects());
  // Read the grouping fields one by one: a selector that builds an object hands back a new
  // identity on every client settings write, which rebuilds every group and, through the
  // settings scope, re-renders every settings row.
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
