import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { CrewMemberModels } from "@t3tools/contracts/j5";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { useServerConfigs, useThreadShell } from "../../state/entities";

const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * The models custom members may run on in the Captain's project, as the server will check them:
 * the environment's list, or the project's own. `null` while either is unknown, which offers every
 * model, so the card never hides a choice the server would allow.
 */
export function useCrewMemberModels(
  environmentId: EnvironmentId | null,
  captainThreadId: ThreadId,
): CrewMemberModels {
  const projectId =
    useThreadShell(environmentId === null ? null : scopeThreadRef(environmentId, captainThreadId))
      ?.projectId ?? null;
  const config = useServerConfigs().get(environmentId ?? NO_ENVIRONMENT);
  return config === undefined || projectId === null
    ? null
    : resolveProjectSettings(config.settings, projectId).settings.crewMemberModels;
}
