import { ThreadId } from "@t3tools/contracts";
import { CrewSeatWorkspace } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";

class CrewSeatWorkspaceNotReadyError extends Orchestrator.OrchestratorDispatchError.extend<CrewSeatWorkspaceNotReadyError>(
  "CrewSeatWorkspaceNotReadyError",
)({ threadId: ThreadId }) {
  override get message(): string {
    return "This Crew seat's worktree is not ready. Retry workspace preparation in its thread before sending more work.";
  }
}

class CrewSeatInactiveError extends Orchestrator.OrchestratorDispatchError.extend<CrewSeatInactiveError>(
  "CrewSeatInactiveError",
)({ threadId: ThreadId }) {
  override get message(): string {
    return "Restore this waiting member's Crew before sending its first assignment.";
  }
}

const decodeWorkspace = Schema.decodeUnknownEffect(Schema.fromJsonString(CrewSeatWorkspace));
const isDispatchError = Schema.is(
  Schema.Union([
    Orchestrator.OrchestratorV2Error,
    CrewSeatWorkspaceNotReadyError,
    CrewSeatInactiveError,
  ]),
);

/** Workspace preparation belongs to acceptance; Crew context belongs to provider delivery. */
export const layer = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const inner = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const receipts = yield* CommandReceiptStoreV2;
    const crews = yield* Crews.AgentCrewInstanceService;
    const locks = yield* KeyedLock.make<string>();
    type Dispatch = Orchestrator.OrchestratorV2["Service"]["dispatch"];
    const dispatchToSeat = (
      command: Extract<Parameters<Dispatch>[0], { type: "message.dispatch" }>,
    ) =>
      locks.withLock(
        command.threadId,
        Effect.gen(function* () {
          if (Option.isSome(yield* receipts.getByCommandId(command.commandId)))
            return yield* inner.dispatch(command);
          const [context] = yield* sql<{
            readonly workspace: string;
            readonly delivered_roster: string | null;
          }>`
          SELECT workspace, delivered_roster FROM j5_crew_seat_context WHERE thread_id = ${command.threadId}
        `;
          if (context === undefined) return yield* inner.dispatch(command);
          if (
            context.delivered_roster === null &&
            (yield* crews.findMembership(participantIdForThread(command.threadId))) === null
          ) {
            return yield* new CrewSeatInactiveError({
              threadId: command.threadId,
              commandId: command.commandId,
              commandType: command.type,
            });
          }
          const workspace = yield* decodeWorkspace(context.workspace);
          if (workspace.type !== "worktree") return yield* inner.dispatch(command);
          const shell = yield* inner.getThreadShell(command.threadId);
          if (shell === null || shell.worktreePath !== null) return yield* inner.dispatch(command);
          const projection = yield* inner.getThreadRecords(command.threadId, ["runs"]);
          if (projection.runs.some((run) => run.status === "preparing"))
            return yield* inner.dispatch(command);
          if (projection.runs.length > 0 || context.delivered_roster !== null) {
            return yield* new CrewSeatWorkspaceNotReadyError({
              threadId: command.threadId,
              commandId: command.commandId,
              commandType: command.type,
            });
          }
          return yield* inner.dispatch({
            ...command,
            dispatchMode: {
              type: "defer_start",
              // The saved commit is the base, and it is never fetched forward: a seat saved
              // before commits were pinned still starts from its ref.
              workspaceStrategy:
                workspace.baseCommit === undefined
                  ? workspace
                  : {
                      type: "worktree",
                      baseRef: workspace.baseCommit,
                      ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
                      startFromOrigin: false,
                    },
            },
          });
        }).pipe(
          Effect.mapError((cause) =>
            isDispatchError(cause)
              ? cause
              : new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
          ),
        ),
      );
    const dispatch: Dispatch = (command) => {
      if (command.type !== "message.dispatch") return inner.dispatch(command);
      // Seat contexts are written when a Crew launches, before any message reaches the seat, so
      // an ordinary thread skips the lock and the receipt read.
      return sql`SELECT 1 AS present FROM j5_crew_seat_context WHERE thread_id = ${command.threadId}`.pipe(
        Effect.mapError(
          (cause) =>
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
        Effect.flatMap((seat) =>
          seat.length === 0 ? inner.dispatch(command) : dispatchToSeat(command),
        ),
      );
    };
    return Orchestrator.OrchestratorV2.of({ ...inner, dispatch });
  }),
).pipe(Layer.provide(Crews.layer));
