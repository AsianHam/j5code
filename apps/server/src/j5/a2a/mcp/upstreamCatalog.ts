import { type Tool, Toolkit } from "effect/ai";

import type { HandlersLayer } from "../../../mcp/McpToolAccess.ts";
import { EnvironmentToolkit } from "../../../mcp/toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "../../../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../../../mcp/toolkits/project/tools.ts";
import { ThreadToolkit } from "../../../mcp/toolkits/thread/tools.ts";

// Original tool objects reuse upstream's handlers, and with them upstream's access
// declarations, without registering their excluded siblings. Keep this catalog explicit when
// upstream adds tools.

/**
 * Upstream's handlers for a whole toolkit, as the handlers of the part of it J5 registers.
 * Handlers are looked up by tool, so a layer for every tool also serves a selection of them.
 * TypeScript compares the two tool records property by property and cannot see that, hence the
 * cast; `Tools extends Part` keeps the selection inside the toolkit the handlers were built for.
 */
export const handlersFor = <Part extends Record<string, Tool.Any>, Tools extends Part, EX, RX>(
  _part: Toolkit.Toolkit<Part>,
  handlers: HandlersLayer<Tools, EX, RX>,
) => handlers as unknown as HandlersLayer<Part, EX, RX>;

export const J5EnvironmentToolkit = Toolkit.make(
  EnvironmentToolkit.tools.t3_environment_read,
  EnvironmentToolkit.tools.t3_environment_preferences_update,
);

/**
 * `t3_project_delete` stays out until J5 settles what deleting a project does to the state it
 * keeps for each project. `t3_thread_launch` is in this toolkit too; `j5_spawn_agent` is the door
 * for it.
 */
export const J5ProjectToolkit = Toolkit.make(
  ProjectToolkit.tools.t3_project_list,
  ProjectToolkit.tools.t3_project_read,
  ProjectToolkit.tools.t3_project_create,
  ProjectToolkit.tools.t3_project_update,
  ProjectToolkit.tools.t3_project_clone,
);

// Raw send, interrupt and bulk-create stay out: `j5_send_message`, `j5_stop_agent` and
// `j5_spawn_agent` are their doors. `t3_thread_wait` stays out because platform notices queue
// behind a running turn, so an agent blocked waiting on another thread never gets that thread's
// finish notice. `orchestrator_capabilities` and `delegate_task` are J5's (orchestratorSurface.ts).
export const J5OrchestratorToolkit = Toolkit.make(
  OrchestratorToolkit.tools.task_status,
  OrchestratorToolkit.tools.task_cancel,
  OrchestratorToolkit.tools.schedule_task,
  OrchestratorToolkit.tools.list_scheduled_tasks,
  OrchestratorToolkit.tools.delete_scheduled_task,
  OrchestratorToolkit.tools.request_secret,
  OrchestratorToolkit.tools.t3_thread_list,
  OrchestratorToolkit.tools.t3_thread_read,
  OrchestratorToolkit.tools.t3_thread_update,
  OrchestratorToolkit.tools.t3_workflow_stop,
  OrchestratorToolkit.tools.t3_background_wait,
);

// `t3_thread_transfer`, `t3_thread_organize` and `t3_queue` are J5's own (see threadTools.ts).
export const J5ThreadToolkit = Toolkit.make(
  ThreadToolkit.tools.t3_pending_request,
  ThreadToolkit.tools.t3_thread_configure,
  ThreadToolkit.tools.t3_thread_search,
  ThreadToolkit.tools.run_scheduled_task_now,
);
