import {
  AgentPersonaId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { invokeAgent } from "./agentInvocation.ts";
import { CrewMemberModels } from "./crewMemberModels.ts";

/**
 * Upstream's delegate_task input plus an optional persona. With `persona`, the server applies
 * the saved definition's instructions, model route, reasoning, and runtime policy; without it,
 * this is upstream's plain child delegation.
 */
export const J5DelegateTaskInput = Schema.Struct({
  ...OrchestratorMcpDelegateTaskInput.fields,
  persona: Schema.optional(
    AgentPersonaId.annotate({
      description:
        "Persona ID to run the child as, taken from an @persona:ID mention or the Settings → Agent Setup library. The server applies its instructions, model route, reasoning, and runtime policy; omit target and runtimeMode when passing persona.",
    }),
  ),
});
export type J5DelegateTaskInput = typeof J5DelegateTaskInput.Type;

/**
 * Written for J5 rather than prefixed onto upstream's text: upstream's description tells the model to
 * use this tool for any subagent request, which contradicts the orchestration instructions that keep
 * ordinary subagent work provider-native. Here the persona use leads and the plain child is the
 * fallback.
 */
export const J5_DELEGATE_TASK_DESCRIPTION =
  "Start one child agent with only `task`. No parent history. Pass persona=ID when the user writes @persona:ID or asks for a persona by name: the server pins that persona's instructions, provider, model, reasoning, and runtime policy, so omit target and runtimeMode. Give the persona a self-contained task, and if that call fails, report the error instead of substituting a plain child. Without persona, this is a plain J5-tracked child for cross-provider work, for same-provider work the native subagent tool cannot run, or for work the user wants tracked as a J5 task; for an ordinary subagent request, use your provider's native subagent mechanism instead. Without persona the child's model and reasoning level, inherited ones included, must be ones the project's Models for custom members lists allow; a refusal lists the eligible ones to retry with in `target`. Separate checkout or PR per child: `isolation:'worktree'`. Keep `taskId` for `task_status` and `task_cancel`.";

/** J5's delegate_task: the upstream tool with the persona extension, registered in place of it. */
export const J5DelegateTaskTool = Tool.make("delegate_task", {
  description: J5_DELEGATE_TASK_DESCRIPTION,
  parameters: J5DelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext,
    OrchestratorMcpService,
    ThreadManagementService,
    ProviderRegistry.ProviderRegistry,
    // A plain child's model and reasoning level are held to the project's lists for custom members.
    CrewMemberModels,
  ],
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const delegateTask = Effect.fn("j5.delegateTask")(function* (input: J5DelegateTaskInput) {
  const { persona: personaId, ...delegate } = input;
  if (personaId === undefined) {
    const scope = yield* McpInvocationContext;
    const service = yield* OrchestratorMcpService;
    const memberModels = yield* CrewMemberModels;
    // A persona runs on its own model; a plain child, even one that inherits its parent's model,
    // runs on a model and level the project's lists allow. Upstream calls this with the model it
    // resolved.
    return yield* service.delegateTask(scope, {
      ...delegate,
      authorizeTarget: ({ projectId, modelSelection }) =>
        memberModels.assertEligible({ projectId, selection: modelSelection }).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "model_unavailable",
                message:
                  error._tag === "CrewMemberModelNotEligibleError"
                    ? `${error.message} Retry with target set to one of them as providerInstanceId and model.`
                    : `${error.message} Retry with target options setting the model's reasoning option to one of them.`,
              }),
          ),
        ),
    });
  }
  if (delegate.target !== undefined || delegate.runtimeMode !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "A persona pins its provider, model, reasoning, and runtime mode. Omit target and runtimeMode when passing persona.",
    });
  }
  // Both are undefined here (checked above); the destructure only narrows the type for invokeAgent.
  const { target: _target, runtimeMode: _runtimeMode, ...personaDelegate } = delegate;
  return yield* invokeAgent({ personaId, ...personaDelegate });
});
