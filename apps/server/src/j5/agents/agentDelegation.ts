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
        "Persona ID to run the child as, taken from an @persona:ID mention or the Settings → Personas library. The server applies its instructions, model route, reasoning, and runtime policy; omit target and runtimeMode when passing persona.",
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
  "Run one task as a J5-owned child of THIS thread with only the supplied task prompt; parent conversation history is not copied. Pass persona=ID when the user writes @persona:ID or asks for a persona by name: the server pins that persona's instructions, provider, model, reasoning, and runtime policy, so omit target and runtimeMode. Give the persona a self-contained task, and if that call fails, report the error instead of substituting a plain child. Without persona, this is a plain J5-tracked child for cross-provider work or for work the user wants tracked as a J5 task; for an ordinary subagent request, use your provider's native subagent mechanism instead. The childThreadId is backing storage, not an ordinary top-level thread. Set isolation to worktree for a separate checkout based on the parent local commit, with project setup completed before the child starts. Uncommitted edits are not copied; omitted isolation shares the parent checkout. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. A requested runtimeMode must be one the target provider lists in orchestrator_capabilities runtimeModes; an inherited one steps down to the broadest mode it offers. Leave runtimeMode unset unless the user asks for a supervised child: approval-required and auto-accept-edits usually make the child wait for a person at each action that needs approval. Prefer mode='async' for long work; mode='wait' blocks until completion, a blocking question, or timeout. If hasPendingQuestion, pass threadId=childThreadId to t3_pending_request_list, t3_pending_request_read (with requestId) and t3_pending_request_respond, or ask the user; the task's completion still wakes this thread. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. An async child's completion wakes this thread with a continuation message naming the task (queued behind any turn in progress), so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.";

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
    return yield* service.delegateTask(scope, delegate);
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
