import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ServerSettings, ThreadId } from "@t3tools/contracts";
import type { CrewMemberModels, CrewMemberReasoning } from "@t3tools/contracts/j5";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { useServerConfigs, useThreadShell } from "../../state/entities";

const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * One of the lists custom members are held to in the Captain's project, as the server will check
 * it: the environment's list, or the project's own. `null` while either is unknown, which offers
 * everything, so the card never hides a choice the server would allow.
 */
function useCrewMemberList<Key extends "crewMemberModels" | "crewMemberReasoning">(
  key: Key,
  environmentId: EnvironmentId | null,
  captainThreadId: ThreadId,
): ServerSettings[Key] | null {
  const projectId =
    useThreadShell(environmentId === null ? null : scopeThreadRef(environmentId, captainThreadId))
      ?.projectId ?? null;
  const config = useServerConfigs().get(environmentId ?? NO_ENVIRONMENT);
  return config === undefined || projectId === null
    ? null
    : resolveProjectSettings(config.settings, projectId).settings[key];
}

/** The models custom members may run on in the Captain's project. */
export const useCrewMemberModels = (
  environmentId: EnvironmentId | null,
  captainThreadId: ThreadId,
): CrewMemberModels => useCrewMemberList("crewMemberModels", environmentId, captainThreadId);

/** The reasoning levels custom members may run at in the Captain's project. */
export const useCrewMemberReasoning = (
  environmentId: EnvironmentId | null,
  captainThreadId: ThreadId,
): CrewMemberReasoning => useCrewMemberList("crewMemberReasoning", environmentId, captainThreadId);
