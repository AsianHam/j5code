import type { OrchestrationV2AgentPersonaAssignment, ProviderInstanceId } from "@t3tools/contracts";

/**
 * The provider instances the composer tries, in order. A saved agent's route comes first, so a
 * draft's slash commands, skills and runtime modes follow the agent, not the draft's earlier pick.
 */
export const composerProviderCandidates = (
  assignment: OrchestrationV2AgentPersonaAssignment | undefined,
  candidates: ReadonlyArray<ProviderInstanceId | null | undefined>,
): ReadonlyArray<ProviderInstanceId | null | undefined> => [
  assignment?.resolvedModelSelection.instanceId,
  ...candidates,
];
