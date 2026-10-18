import { OrchestratorMcpFailure, ThreadId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { dispatchFailure, newCommandId, readThread } from "../../../mcp/threadAccess.ts";
import { ThreadToolkit } from "../../../mcp/toolkits/thread/tools.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import { makeCrewSeatArchiveGuard } from "../crewSeatArchiveGuard.ts";
import { J5ThreadLineageError } from "../ThreadLineage.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, Crypto.Crypto],
};

/**
 * Upstream's fork and organize tools with the same parameters and reach (any thread in the
 * environment), re-declared for what J5 adds: fork reports a lineage failure in its own words,
 * and organize refuses to archive a Crew seat on its own.
 */
export const J5AdaptedThreadToolkit = Toolkit.make(
  Tool.make("t3_thread_fork", {
    ...common,
    parameters: ThreadToolkit.tools.t3_thread_fork.parametersSchema,
    success: ThreadToolkit.tools.t3_thread_fork.successSchema,
    description:
      "Fork a thread from a stable run or checkpoint using the existing fork command. Omit threadId to fork this thread. The fork inherits the source configuration. Acceptance does not mean a provider turn has completed. Each call creates a new fork. If recording its placement fails, the error identifies the durable fork and original command for operator repair; a new tool call does not retry that command.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_thread_organize", {
    ...common,
    dependencies: [...common.dependencies, AgentCrewInstanceService],
    parameters: ThreadToolkit.tools.t3_thread_organize.parametersSchema,
    success: ThreadToolkit.tools.t3_thread_organize.successSchema,
    description:
      "Pin, snooze, settle, archive, or mark a thread unread. Omit threadId for this thread. snooze requires snoozedUntil. Existing thread lifecycle rules apply. Settling this thread takes effect when your turn completes, returning settlesWhenTurnEnds=true; a turn that fails or is interrupted, or a queued message, leaves it active. Archive hides the agent and closes its Exchanges; unarchive restores visibility without reopening Exchanges. Crew seats cannot be archived individually; use j5_archive_crew or the Fleet page. Captain archive retains the crew cascade. Ordinary archive does not interrupt a running turn.",
  })
    .annotate(Tool.Title, "Organize a thread")
    .annotate(Tool.Destructive, true),
);

const isLineageError = Schema.is(Schema.instanceOf(J5ThreadLineageError));
/** A lineage refusal in its own words; anything else as upstream reports a dispatch failure. */
const lineageFailure = (cause: Parameters<typeof dispatchFailure>[0]) =>
  isLineageError(cause)
    ? new OrchestratorMcpFailure({
        code: cause.phase === "admission" ? "invalid_request" : "orchestration_error",
        message: cause.message,
      })
    : dispatchFailure(cause);

/** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

/** What `/mcp` registers. The handlers follow upstream's in `toolkits/thread/handlers.ts`. */
export const layer = McpToolAccess.toLayer(J5AdaptedThreadToolkit, {
  t3_thread_fork: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(lineageFailure));
      return { sequence: result.sequence, targetThreadId };
    }),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      if (command.type === "thread.archive") {
        const guard = yield* makeCrewSeatArchiveGuard;
        yield* guard(command).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code: "capability_denied",
                message: cause.message,
              }),
          ),
        );
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});

/** The same handlers as a plain layer, for tests that call a tool without registering it. */
export const J5AdaptedThreadHandlersLive = McpToolAccess.HandlersLayer.layer(layer);
