import type {
  OrchestrationV2AgentPersonaCommandAssignment,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { AgentPersonaLibraryError, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import {
  agentPersonaModelSelection,
  agentPersonaTargetUnavailableReason,
} from "./agentPersonaRouting.ts";
import type { AgentModelTarget, AgentPersonaId } from "./agentPersonas.ts";

type Library = ReturnType<typeof createAgentPersonaLibrary>;

const describeTarget = (target: AgentModelTarget) =>
  `${target.driver} ${target.model} (${target.reasoningEffort})`;

export interface AgentPersonaPeerSpawnRequest {
  readonly personaId: AgentPersonaId;
  /** The spawner's explicit provider instance; `undefined` when the registry does not know it. */
  readonly provider: ServerProvider | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  /** Left out for a model with no reasoning option. A route always names a level, so none matches. */
  readonly reasoning?: string | undefined;
}

/**
 * Role-ful Peer Agent spawn (SP3): provider, model, and reasoning stay the spawner's explicit
 * choice, and the saved agent's declared routes constrain it. An out-of-route pick is an error
 * naming the agent, never a silent substitution. The matching route becomes the immutable
 * assignment, snapshotted exactly like a composer launch.
 */
export const prepareAgentPersonaPeerSpawn = Effect.fn("j5.prepareAgentPersonaPeerSpawn")(function* (
  request: AgentPersonaPeerSpawnRequest,
  library: Library,
) {
  const catalog = yield* library.catalog();
  if (catalog.disabledIds.includes(request.personaId)) {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} is disabled in this environment.`,
    });
  }
  const definition = catalog.definitions.find(({ id }) => id === request.personaId);
  if (definition === undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Unknown agent ${request.personaId} in this environment.`,
    });
  }
  const provider = request.provider;
  if (provider === undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Provider ${request.instanceId} is not configured in this environment.`,
    });
  }
  const index = definition.modelRoute.findIndex(
    (target) =>
      target.driver === provider.driver &&
      target.model === request.model &&
      target.reasoningEffort === request.reasoning,
  );
  const target = definition.modelRoute[index];
  if (target === undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} allows only ${definition.modelRoute
        .map(describeTarget)
        .join(
          " or ",
        )}; ${provider.driver} ${request.model} (${request.reasoning ?? "no reasoning"}) is outside its declared routes.`,
    });
  }
  const unavailable = agentPersonaTargetUnavailableReason(provider, target);
  if (unavailable !== undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} route ${describeTarget(target)} is unavailable on provider ${request.instanceId}: ${unavailable}.`,
    });
  }
  const modelSelection = agentPersonaModelSelection(provider, target);
  const result = buildAgentPersonaAssignment({
    definition,
    resolution: {
      status: "available",
      personaId: definition.id,
      definitionVersion: definition.version,
      route: index === 0 ? "primary" : "fallback",
      driver: target.driver,
      modelSelection,
      rejectedTargets: [],
    },
  });
  if (result.status !== "assigned") {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} cannot enforce its ${definition.authority.defaultPolicy} permissions on ${target.driver}.`,
    });
  }
  const definitionDigest = yield* library.snapshot(definition);
  const assignment: OrchestrationV2AgentPersonaCommandAssignment = {
    ...result.assignment,
    ...(definitionDigest === undefined
      ? {}
      : { definitionDigest, displayName: definition.displayName }),
  };
  return assignment;
});
