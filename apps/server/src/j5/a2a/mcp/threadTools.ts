import { OrchestratorMcpFailure, ThreadId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Tool, Toolkit } from "effect/ai";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import {
  dispatchFailure,
  newCommandId,
  readThread,
  unavailable,
} from "../../../mcp/threadAccess.ts";
import { ThreadToolkit } from "../../../mcp/toolkits/thread/tools.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import { makeCrewSeatArchiveGuard } from "../crewSeatArchiveGuard.ts";
import { ParticipantId } from "../contracts.ts";
import { ledgerMessageIdOfDelivery } from "../DeliveryTransport.ts";
import {
  bodyInEnvelope,
  claimQueuedEdit,
  readDelivery,
  releaseQueuedEditClaim,
} from "../queuedEdits.ts";
import { J5ThreadLineageError } from "../ThreadLineage.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, Crypto.Crypto],
};

/**
 * Upstream's fork, organize and queue-edit tools with the same parameters and reach (any thread in
 * the environment), re-declared for what J5 adds: fork reports a lineage failure in its own words,
 * organize refuses to archive a Crew seat on its own, and queue edit lets an agent edit only a
 * message it sent, keeping a J5 message's envelope around the new text.
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
  Tool.make("t3_queue_edit", {
    ...common,
    dependencies: [...common.dependencies, SqlClient.SqlClient],
    parameters: ThreadToolkit.tools.t3_queue_edit.parametersSchema,
    success: ThreadToolkit.tools.t3_queue_edit.successSchema,
    description:
      "Replace the text of a queued message you sent, preserving its attachments. For a message you sent with j5_send_message, pass only the new message: the platform keeps its envelope, so its sender and header stay as they were. A message another agent or a person sent can't be edited; t3_queue_cancel, t3_queue_reorder and t3_queue_promote_to_steer work on any queued message. The service rejects runs that are no longer queued.",
  }).annotate(Tool.Destructive, true),
);

const refuseEdit = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const OTHERS_MESSAGE =
  "You can edit only a queued message you sent. t3_queue_cancel, t3_queue_reorder and t3_queue_promote_to_steer still work on it.";

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
  t3_queue_edit: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId, [
        "runs",
        "messages",
      ]);
      const run = projection.runs.find(
        (candidate) => candidate.id === input.queuedRunId && candidate.status === "queued",
      );
      const message = projection.messages.find((candidate) => candidate.id === run?.userMessageId);
      if (run === undefined || message === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        });
      }
      if (input.text.trim().length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "text is empty. To withdraw the message, use t3_queue_cancel.",
        });
      }
      if (caller === undefined) {
        return yield* refuseEdit(
          "t3_queue_edit edits a queued message an agent sent from its thread, and this call has no calling thread. t3_queue_cancel, t3_queue_reorder and t3_queue_promote_to_steer still work.",
        );
      }
      const deliveredId = ledgerMessageIdOfDelivery(message.id);
      const delivery =
        deliveredId === undefined
          ? undefined
          : yield* readDelivery(deliveredId, projection.thread.id).pipe(
              Effect.mapError(unavailable),
            );
      if (message.senderThreadId !== caller.id) {
        return yield* refuseEdit(
          deliveredId !== undefined
            ? `This queued message is ${delivery === undefined ? "another participant's" : `${delivery.row.sender_id}'s`} J5 message, not yours. ${OTHERS_MESSAGE}`
            : message.createdBy === "user"
              ? `A person wrote this queued message. ${OTHERS_MESSAGE}`
              : `This queued message was not sent by you. ${OTHERS_MESSAGE}`,
        );
      }
      let text = input.text;
      let editorId: string | undefined;
      if (deliveredId !== undefined) {
        const envelope = delivery?.envelope;
        if (envelope === undefined || bodyInEnvelope(message.text, envelope) === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "This message no longer has the J5 envelope it was delivered with: someone rewrote its header or closing instruction in the queue. Cancel it with t3_queue_cancel and send it again with j5_send_message.",
          });
        }
        // An agent that read the message with t3_queue_read may hand back the whole envelope.
        const body = bodyInEnvelope(input.text, envelope) ?? input.text;
        if (body.trim().length === 0) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "text is empty. To withdraw the message, use t3_queue_cancel.",
          });
        }
        text = `${envelope.prefix}${body}${envelope.suffix}`;
        editorId = delivery?.row.sender_id;
      }
      const commandId = yield* newCommandId();
      if (editorId !== undefined) {
        yield* claimQueuedEdit({ commandId, editorId: ParticipantId.make(editorId) }).pipe(
          Effect.mapError(unavailable),
        );
      }
      const result = yield* threads
        .dispatch({
          type: "queued-run.edit",
          commandId,
          threadId: projection.thread.id,
          runId: run.id,
          text,
        })
        .pipe(
          Effect.tapError(() =>
            editorId === undefined ? Effect.void : Effect.ignore(releaseQueuedEditClaim(commandId)),
          ),
          Effect.mapError(dispatchFailure),
        );
      return { sequence: result.sequence };
    }),
  ),
});

/** The same handlers as a plain layer, for tests that call a tool without registering it. */
export const J5AdaptedThreadHandlersLive = McpToolAccess.HandlersLayer.layer(layer);
