import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DispatchModeLimit, type DispatchModes } from "../../orchestration-v2/DispatchModeLimit.ts";
import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * Upstream's Stop for one thread, as its own senders issue it: `thread.stop` interrupts the
 * running turn, holds the queue and ends pull request watches, then the thread's delegated tasks
 * are stopped. Nothing to stop is an accepted no-op, and a retry with the same `commandId`
 * repeats nothing. `j5_stop_agent`, Crew stop and Crew retirement all stop a thread this way.
 */
export const stopThread = (
  threads: Pick<ThreadManagementService["Service"], "dispatch" | "stopDelegatedTasks">,
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly reason?: string | undefined;
  },
  /**
   * The broadest modes the stopper may touch, for upstream to check under the thread's lock when
   * it applies the Stop. Absent for a person, and for a Captain stopping its own Crew's seat.
   * It gates the thread named here and not its delegated tasks, which follow their parent.
   */
  limit?: DispatchModes,
) =>
  threads
    .dispatch({ type: "thread.stop", ...input })
    .pipe(
      Effect.provideService(DispatchModeLimit, limit),
      Effect.andThen(threads.stopDelegatedTasks(input)),
    );
