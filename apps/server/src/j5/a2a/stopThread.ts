import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DispatchModeLimit, type DispatchModes } from "../../orchestration-v2/DispatchModeLimit.ts";
import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * The reason an agent's Stop records, worded as upstream's MCP stops word theirs
 * (`agentStopReason` in `mcp/OrchestratorMcpService.ts`). Without one, the timeline reads
 * "Stopped by user".
 */
export const AGENT_STOP_REASON = "Stopped by an agent";

/**
 * Upstream's Stop for one thread, as its own senders issue it: `thread.stop` interrupts the
 * running turn, holds the queue, ends pull request watches, and stops the thread's delegated
 * tasks. Nothing to stop is an accepted no-op, and a retry with the same `commandId` repeats
 * nothing. `j5_stop_agent`, Crew stop and Crew retirement all stop a thread this way.
 */
export const stopThread = (
  threads: Pick<ThreadManagementService["Service"], "dispatch">,
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly reason?: string | undefined;
  },
  /**
   * The broadest modes the stopper may touch, for upstream to check under the thread's lock when
   * it applies the Stop. Absent for a person, and for a Captain stopping its own Crew's seat.
   * It gates the thread named here and not its delegated tasks, which upstream stops after it.
   */
  limit?: DispatchModes,
) =>
  threads
    .dispatch({ type: "thread.stop", ...input })
    .pipe(Effect.provideService(DispatchModeLimit, limit));
