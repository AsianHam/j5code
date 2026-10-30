import { J5DelegateTaskTool } from "../../agents/agentDelegation.ts";
import {
  NonNegativeInt,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpFailure,
  OrchestratorMcpModelOption,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ThreadId,
  type OrchestratorMcpCapabilitiesResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorMcpService];

export const J5OrchestratorProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.optional(Schema.String),
      options: Schema.optional(Schema.Array(OrchestratorMcpModelOption)),
    }),
  ),
  omittedModels: Schema.optional(NonNegativeInt),
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  constraints: Schema.Array(Schema.String),
});

export const J5OrchestratorCapabilitiesResult = Schema.Struct({
  /** The calling thread, or null when the caller is not a J5 thread. */
  parentThreadId: Schema.NullOr(ThreadId),
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  inheritedOptions: Schema.optional(Schema.Array(ProviderOptionSelection)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(J5OrchestratorProviderCapability),
  features: Schema.Struct({
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
  }),
});

export const mapJ5OrchestratorCapabilities = (
  capabilities: OrchestratorMcpCapabilitiesResult,
): typeof J5OrchestratorCapabilitiesResult.Type => ({
  parentThreadId: capabilities.parentThreadId,
  inheritedProviderInstanceId: capabilities.inheritedProviderInstanceId,
  inheritedModel: capabilities.inheritedModel,
  ...(capabilities.inheritedOptions === undefined
    ? {}
    : { inheritedOptions: capabilities.inheritedOptions }),
  runtimeMode: capabilities.runtimeMode,
  interactionMode: capabilities.interactionMode,
  providers: capabilities.providers.map((provider) => ({
    providerInstanceId: provider.providerInstanceId,
    driverKind: provider.driverKind,
    displayName: provider.displayName,
    models: provider.models,
    ...(provider.omittedModels === undefined ? {} : { omittedModels: provider.omittedModels }),
    ...(provider.runtimeModes === undefined ? {} : { runtimeModes: provider.runtimeModes }),
    constraints: provider.constraints,
  })),
  features: {
    incrementalThreadRead: capabilities.features.incrementalThreadRead,
    scheduledTasks: capabilities.features.scheduledTasks,
  },
});

export const J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION =
  "List providers, models, options, and runtime modes for `delegate_task` and `j5_spawn_agent`, and the provider, model and options this thread runs with. Short list. `search` finds others. Any catalog model works.";

export const J5OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description: J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION,
  parameters: OrchestratorMcpCapabilitiesInput,
  success: J5OrchestratorCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/**
 * The two orchestrator tools J5 declares itself: `delegate_task` takes a persona, and
 * `orchestrator_capabilities` leaves out upstream's claims about tools J5 does not expose. The
 * upstream tools J5 registers unchanged are in upstreamCatalog.ts.
 */
export const J5OrchestratorSurface = Toolkit.make(
  J5DelegateTaskTool,
  J5OrchestratorCapabilitiesTool,
);
