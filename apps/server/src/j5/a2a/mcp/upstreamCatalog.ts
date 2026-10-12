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
 * keeps for each project (#552). `t3_thread_launch` is in this toolkit too; `j5_spawn_agent` is
 * the door for it.
 */
export const J5ProjectToolkit = Toolkit.make(
  ProjectToolkit.tools.t3_project_list,
  ProjectToolkit.tools.t3_project_read,
  ProjectToolkit.tools.t3_project_create,
  ProjectToolkit.tools.t3_project_update,
  ProjectToolkit.tools.t3_project_clone,
);

/**
 * Upstream's raw send, interrupt and bulk-create tools stay out: J5's `j5_send_message`,
 * `j5_stop_agent` and `j5_spawn_agent` are the doors for those. `t3_thread_wait` is deliberately
 * absent. Platform notices queue behind a running turn, so a participant that blocks inside its
 * turn waiting for another thread can never receive the notice that thread's finish produces; a
 * Captain that waited on a seat starved itself of its own Crew's news (2026-09-14). A seat's
 * finish arrives as a message once the turn ends. `orchestrator_capabilities` and
 * `delegate_task` are J5's own (see orchestratorSurface.ts).
 */
export const J5OrchestratorToolkit = Toolkit.make(
  OrchestratorToolkit.tools.task_status,
  OrchestratorToolkit.tools.task_cancel,
  OrchestratorToolkit.tools.schedule_task,
  OrchestratorToolkit.tools.list_scheduled_tasks,
  OrchestratorToolkit.tools.update_scheduled_task,
  OrchestratorToolkit.tools.delete_scheduled_task,
  OrchestratorToolkit.tools.request_secret,
  OrchestratorToolkit.tools.t3_thread_list,
  OrchestratorToolkit.tools.t3_thread_read,
  OrchestratorToolkit.tools.t3_thread_update,
);

// `t3_thread_fork` and `t3_thread_organize` are J5's own (see threadTools.ts).
export const J5ThreadToolkit = Toolkit.make(
  ThreadToolkit.tools.t3_queue_list,
  ThreadToolkit.tools.t3_queue_read,
  ThreadToolkit.tools.t3_pending_request_list,
  ThreadToolkit.tools.t3_pending_request_read,
  ThreadToolkit.tools.t3_pending_request_respond,
  ThreadToolkit.tools.t3_thread_configuration,
  ThreadToolkit.tools.t3_thread_configure,
  ThreadToolkit.tools.t3_thread_transfers,
  ThreadToolkit.tools.t3_thread_merge_back,
  ThreadToolkit.tools.t3_thread_search,
  ThreadToolkit.tools.run_scheduled_task_now,
);
