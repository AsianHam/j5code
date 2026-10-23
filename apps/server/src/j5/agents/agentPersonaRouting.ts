import {
  agentPersonaReasoningDescriptor,
  defaultInstanceIdForDriver,
  isProviderAvailable,
  type AgentPersonaAuthorityPolicy,
  type AgentPersonaRouteFailureCode as ContractRouteFailureCode,
  type ModelSelection,
  type OrchestrationV2AgentPersonaCatalog,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  getBuiltInAgentPersona,
  type AgentModelTarget,
  type AgentPersonaDefinition,
  type AgentPersonaId,
} from "./agentPersonas.ts";
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";

export type AgentPersonaRouteFailureCode = ContractRouteFailureCode;

export interface AgentPersonaRouteFailure {
  readonly code: AgentPersonaRouteFailureCode;
  readonly instanceId?: ProviderInstanceId;
}

export interface AgentPersonaRouteAttempt {
  readonly route: "primary" | "fallback";
  readonly target: AgentModelTarget;
  readonly failures: ReadonlyArray<AgentPersonaRouteFailure>;
}

export type AgentPersonaRouteResolution =
  | {
      readonly status: "available";
      readonly personaId: AgentPersonaId;
      readonly definitionVersion: number;
      readonly route: "primary" | "fallback";
      readonly driver: AgentModelTarget["driver"];
      readonly modelSelection: ModelSelection;
      readonly rejectedTargets: ReadonlyArray<AgentPersonaRouteAttempt>;
    }
  | {
      readonly status: "unavailable";
      readonly personaId: AgentPersonaId;
      readonly definitionVersion: number;
      readonly attempts: ReadonlyArray<AgentPersonaRouteAttempt>;
    };

export function unavailableAgentPersonaReason(
  resolution: Extract<AgentPersonaRouteResolution, { status: "unavailable" }>,
): "routes-unavailable" | "authority-not-enforceable" {
  return resolution.attempts.every(({ failures }) =>
    failures.some(({ code }) => code === "authority-not-enforceable"),
  )
    ? "authority-not-enforceable"
    : "routes-unavailable";
}

/** The launch selection for a target on a provider that already passed the availability check. */
export function agentPersonaModelSelection(
  provider: ServerProvider,
  target: AgentModelTarget,
): ModelSelection {
  const descriptor = agentPersonaReasoningDescriptor(
    provider.models.find((model) => model.slug === target.model),
  );
  if (descriptor === undefined) {
    throw new Error(
      `Model ${target.model} on ${provider.instanceId} advertises no reasoning option; check availability first.`,
    );
  }
  return {
    instanceId: provider.instanceId,
    model: target.model,
    options: [{ id: descriptor.id, value: target.reasoningEffort }],
  };
}

/** Why one provider instance cannot serve one declared route target right now. */
export function agentPersonaTargetUnavailableReason(
  provider: ServerProvider,
  target: AgentModelTarget,
): AgentPersonaRouteFailureCode | undefined {
  if (!isProviderAvailable(provider)) return "provider-unavailable";
  if (!provider.enabled) return "provider-disabled";
  if (!provider.installed) return "provider-not-installed";
  if (provider.status === "error" || provider.status === "disabled") return "provider-error";
  if (provider.auth.status === "unauthenticated") return "provider-unauthenticated";
  const model = provider.models.find((candidate) => candidate.slug === target.model);
  if (model === undefined) return "model-not-advertised";

  const descriptor = agentPersonaReasoningDescriptor(model);
  if (!descriptor?.options.some((option) => option.id === target.reasoningEffort)) {
    return "reasoning-effort-not-advertised";
  }
  return undefined;
}

function candidatesForTarget(
  providers: ReadonlyArray<ServerProvider>,
  target: AgentModelTarget,
): ReadonlyArray<ServerProvider> {
  return providers
    .filter((provider) => provider.driver === target.driver)
    .map((provider, index) => ({
      provider,
      index,
      isDefault: provider.instanceId === defaultInstanceIdForDriver(provider.driver),
    }))
    .sort(
      (left, right) => Number(right.isDefault) - Number(left.isDefault) || left.index - right.index,
    )
    .map(({ provider }) => provider);
}

export function resolveAgentPersonaRoute(input: {
  readonly personaId: AgentPersonaId;
  readonly definition?: AgentPersonaDefinition;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly authorityPolicy?: AgentPersonaAuthorityPolicy;
}): AgentPersonaRouteResolution {
  const definition = input.definition ?? getBuiltInAgentPersona(input.personaId);
  const authorityPolicy = input.authorityPolicy ?? definition.authority.defaultPolicy;
  const rejectedTargets: Array<AgentPersonaRouteAttempt> = [];

  for (const [index, target] of definition.modelRoute.entries()) {
    const route = index === 0 ? "primary" : "fallback";
    const candidates = candidatesForTarget(input.providers, target);
    const failures: Array<AgentPersonaRouteFailure> = [];

    if (!providerCanEnforceAgentPersonaAuthority(target.driver, authorityPolicy)) {
      // Also name a missing provider, so a mistyped driver doesn't read as a policy gap alone.
      rejectedTargets.push({
        route,
        target,
        failures: [
          { code: "authority-not-enforceable" },
          ...(candidates.length === 0 ? [{ code: "provider-not-configured" as const }] : []),
        ],
      });
      continue;
    }

    if (candidates.length === 0) {
      failures.push({ code: "provider-not-configured" });
    }

    for (const provider of candidates) {
      const reason = agentPersonaTargetUnavailableReason(provider, target);
      if (reason !== undefined) {
        failures.push({ code: reason, instanceId: provider.instanceId });
        continue;
      }

      return {
        status: "available",
        personaId: definition.id,
        definitionVersion: definition.version,
        route,
        driver: target.driver,
        modelSelection: agentPersonaModelSelection(provider, target),
        rejectedTargets,
      };
    }

    rejectedTargets.push({ route, target, failures });
  }

  return {
    status: "unavailable",
    personaId: definition.id,
    definitionVersion: definition.version,
    attempts: rejectedTargets,
  };
}

export function buildAgentPersonaCatalog(
  providers: ReadonlyArray<ServerProvider>,
  definitions: ReadonlyArray<AgentPersonaDefinition>,
): OrchestrationV2AgentPersonaCatalog {
  return {
    personas: definitions.map((definition) => {
      const resolution = resolveAgentPersonaRoute({
        personaId: definition.id,
        definition,
        providers,
      });
      return {
        personaId: definition.id,
        definitionVersion: definition.version,
        displayName: definition.displayName,
        description: definition.description,
        ...(definition.acceptedInput === undefined
          ? {}
          : { acceptedInput: definition.acceptedInput }),
        ...(definition.outputArtifact === undefined
          ? {}
          : { outputArtifact: definition.outputArtifact }),
        defaultAuthorityPolicy: definition.authority.defaultPolicy,
        allowedAuthorityPolicies: [...definition.authority.allowedPolicies],
        availability:
          resolution.status === "available"
            ? {
                status: "available" as const,
                resolvedRoute: resolution.route,
                resolvedDriver: resolution.driver,
                resolvedModelSelection: resolution.modelSelection,
              }
            : {
                status: "unavailable" as const,
                reason: unavailableAgentPersonaReason(resolution),
                // Settings shows these so a blocked badge names the missing model or provider.
                attempts: resolution.attempts.map((attempt) => ({
                  route: attempt.route,
                  driver: attempt.target.driver,
                  model: attempt.target.model,
                  reasoningEffort: attempt.target.reasoningEffort,
                  failures: [...new Set(attempt.failures.map(({ code }) => code))],
                })),
              },
      };
    }),
  };
}
