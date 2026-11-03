import { CommandId, RunId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";

const PREPARE_COMMAND_PREFIX = "command:j5:crew-seat-prepare:";

const prepareCommandId = (runId: RunId) => CommandId.make(`${PREPARE_COMMAND_PREFIX}${runId}`);

/**
 * Whether a stored event is the metadata update ThreadLaunch commits (as `<launch command>:workspace`)
 * when this module's preparation creates a seat's worktree. A worktree bound any other way, by a
 * handoff or a metadata update, never carries this command.
 */
export const isSeatWorktreeCreation = (commandId: CommandId | null) =>
  commandId !== null &&
  commandId.startsWith(PREPARE_COMMAND_PREFIX) &&
  commandId.endsWith(":workspace");

/** A waiting seat's first assignment uses upstream's durable worktree preparation path. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const launcher = yield* ThreadLaunchService;
    const sql = yield* SqlClient.SqlClient;
    const prepare = (run: OrchestrationV2Run) =>
      run.status !== "preparing"
        ? Effect.void
        : Effect.gen(function* () {
            const rows =
              yield* sql`SELECT thread_id FROM j5_crew_seat_context WHERE thread_id = ${run.threadId}`;
            if (rows.length === 0) return;
            yield* launcher.prepareRun({
              threadId: run.threadId,
              runId: run.id,
              commandId: prepareCommandId(run.id),
            });
          });
    const afterSequence = yield* readEventStoreHighWater("J5 crew seat preparation");
    const rows = yield* sql<{ readonly thread_id: string; readonly run_id: string }>`
    SELECT run.thread_id, run.run_id FROM orchestration_v2_projection_runs AS run
    JOIN j5_crew_seat_context AS context ON context.thread_id = run.thread_id
    WHERE run.status = 'preparing'
  `;
    for (const row of rows) {
      const projection = yield* threads.getThreadRecords(ThreadId.make(row.thread_id), ["runs"], {
        runIds: [RunId.make(row.run_id)],
      });
      for (const run of projection.runs) yield* prepare(run);
    }
    yield* threads.streamStoredEventsFrom({ afterSequence }).pipe(
      Stream.runForEach((stored) =>
        stored.event.type === "run.created" ? prepare(stored.event.payload) : Effect.void,
      ),
      Effect.tapError((cause) => Effect.logError("J5 crew seat preparation failed", { cause })),
      Effect.forkScoped,
    );
  }),
);
