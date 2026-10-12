import { delegateTask } from "../../agents/agentDelegation.ts";
import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { actsAsThreadCaller, spawnAndBrief } from "./outsideAgent.ts";
import { J5OrchestratorSurface, mapJ5OrchestratorCapabilities } from "./orchestratorSurface.ts";

const handlers = {
  // A delegated task reports back to the thread that asked for it, and an outside agent has none.
  delegate_task: actsAsThreadCaller(
    "delegate_task",
    spawnAndBrief("delegate the task"),
    delegateTask,
  ),
  // Declared as upstream declares the tool this stands in for.
  orchestrator_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.capabilities(scope).pipe(Effect.map(mapJ5OrchestratorCapabilities));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof J5OrchestratorSurface.tools>;

export const layer = McpToolAccess.toLayer(J5OrchestratorSurface, handlers);
