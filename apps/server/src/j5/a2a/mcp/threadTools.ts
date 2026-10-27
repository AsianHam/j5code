import {
  type CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
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
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
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
 * Upstream's transfer, organize and queue tools with the same parameters and reach (any thread in
 * the environment), re-declared for what J5 adds: a fork reports a lineage failure in its own
 * words, organize refuses to archive a Crew seat on its own, and a queue edit lets an agent edit
 * only a message it sent, keeping a J5 message's envelope around the new text.
 */
export const J5AdaptedThreadToolkit = Toolkit.make(
  Tool.make("t3_thread_transfer", {
    ...common,
    parameters: ThreadToolkit.tools.t3_thread_transfer.parametersSchema,
    success: ThreadToolkit.tools.t3_thread_transfer.successSchema,
    description:
      "Move context between threads. Omit `threadId` for this thread. fork: copy it from `sourcePoint` (default latest stable run) into a new thread with the same setup; no turn runs yet. If recording a fork's placement fails, the error names the durable fork and its command for repair; calling again does not retry it. merge_back: merge it from `sourcePoint` into a related `targetThreadId` in the same project. status: its context transfers.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_thread_organize", {
    ...common,
    dependencies: [...common.dependencies, AgentCrewInstanceService],
    parameters: ThreadToolkit.tools.t3_thread_organize.parametersSchema,
    success: ThreadToolkit.tools.t3_thread_organize.successSchema,
    description:
      "Pin, snooze, settle, archive, or mark a thread unread. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. Settling this thread applies at turn end. A failed turn or queued message leaves it active. Archive hides the agent and closes its Exchanges; unarchive restores it without reopening them. A Crew seat cannot be archived alone: use j5_archive_crew or the Fleet page. Archiving a Captain archives its Crew. Archive does not interrupt a running turn.",
  })
    .annotate(Tool.Title, "Organize a thread")
    .annotate(Tool.Destructive, true),
  Tool.make("t3_queue", {
    ...common,
    dependencies: [...common.dependencies, SqlClient.SqlClient],
    parameters: ThreadToolkit.tools.t3_queue.parametersSchema,
    success: ThreadToolkit.tools.t3_queue.successSchema,
    description:
      "Manage a thread's queued messages. Omit `threadId` for this thread. list: send order, paged by `cursor` and `limit`. read: up to 16,000 chars of one. edit: replace the `text` of one you sent; attachments stay. For a message you sent with j5_send_message, pass only the new message: its envelope stays. cancel. reorder: before `beforeRunId`, or to the end with null. promote_to_steer: send it now as steering to active `targetRunId`. cancel, reorder and promote_to_steer work on any queued message. Writes fail once the run is no longer queued.",
  }).annotate(Tool.Destructive, true),
);

const refuseEdit = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const OTHERS_MESSAGE =
  "You can edit only a queued message you sent. t3_queue's cancel, reorder and promote_to_steer still work on it.";

const isLineageError = Schema.is(Schema.instanceOf(J5ThreadLineageError));
/** A lineage refusal in its own words; anything else as upstream reports a dispatch failure. */
const lineageFailure = (cause: Parameters<typeof dispatchFailure>[0]) =>
  isLineageError(cause)
    ? new OrchestratorMcpFailure({
        code: cause.phase === "admission" ? "invalid_request" : "orchestration_error",
        message: cause.message,
      })
    : dispatchFailure(cause);

/** A field the chosen action needs. `null` counts as given, as in `beforeRunId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}

const dispatch = Effect.fn("j5.mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

/** J5's edit: only the sender's own message, and a J5 message keeps its envelope. */
const editQueuedMessage = Effect.fn("j5.mcp.editQueuedMessage")(function* (input: {
  readonly threadId?: ThreadId | undefined;
  readonly queuedRunId: RunId;
  readonly text: string;
}) {
  const { threads, projection, caller } = yield* readThread(input.threadId, ["runs", "messages"]);
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
      message: "text is empty. To withdraw the message, use t3_queue with action cancel.",
    });
  }
  if (caller === undefined) {
    return yield* refuseEdit(
      "t3_queue edit changes a queued message an agent sent from its thread, and this call has no calling thread. Its cancel, reorder and promote_to_steer still work.",
    );
  }
  const deliveredId = ledgerMessageIdOfDelivery(message.id);
  const delivery =
    deliveredId === undefined
      ? undefined
      : yield* readDelivery(deliveredId, projection.thread.id).pipe(Effect.mapError(unavailable));
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
          "This message no longer has the J5 envelope it was delivered with: someone rewrote its header or closing instruction in the queue. Cancel it with t3_queue and send it again with j5_send_message.",
      });
    }
    // An agent that read the message with t3_queue's read may hand back the whole envelope.
    const body = bodyInEnvelope(input.text, envelope) ?? input.text;
    if (body.trim().length === 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "text is empty. To withdraw the message, use t3_queue with action cancel.",
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
});

/** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

/** What `/mcp` registers. The handlers follow upstream's in `toolkits/thread/handlers.ts`. */
export const layer = McpToolAccess.toLayer(J5AdaptedThreadToolkit, {
  t3_thread_transfer: McpToolAccess.either(
    (input) => input.action === "status",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
        return {
          transfers: projection.contextTransfers.map(
            ({ id, sourceThreadId, targetThreadId, status }) => ({
              id,
              sourceThreadId,
              targetThreadId,
              status,
            }),
          ),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      (input) =>
        Effect.gen(function* () {
          const sourcePoint = input.sourcePoint ?? { type: "latest_stable" as const };
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          if (input.action === "merge_back") {
            const targetThreadId = yield* required(input.targetThreadId, "targetThreadId");
            yield* readThread(targetThreadId);
            const result = yield* threads
              .dispatch({
                type: "thread.merge_back",
                commandId,
                sourceThreadId: projection.thread.id,
                targetThreadId,
                sourcePoint,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence, targetThreadId };
          }
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(lineageFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
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
  t3_queue: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
        if (input.action === "list") {
          const runs = queuedRunsInDeliveryOrder(projection);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 20);
          return {
            items: runs.slice(cursor, end).flatMap((run) => {
              const entry = queueEntry(projection, run.id, 1000);
              return entry === undefined ? [] : [entry];
            }),
            nextCursor: end < runs.length ? end : null,
          };
        }
        const queuedRunId = yield* required(input.queuedRunId, "queuedRunId");
        return (
          queueEntry(projection, queuedRunId, 16000) ??
          (yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The queued message was not found.",
          }))
        );
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const runId = yield* required(input.queuedRunId, "queuedRunId");
        switch (input.action) {
          case "edit": {
            const text = yield* required(input.text, "text");
            return yield* editQueuedMessage({ threadId: input.threadId, queuedRunId: runId, text });
          }
          case "reorder": {
            const beforeRunId = yield* required(input.beforeRunId, "beforeRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.reorder",
              runId,
              beforeRunId,
            }));
          }
          case "promote_to_steer": {
            const targetRunId = yield* required(input.targetRunId, "targetRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-message.promote-to-steer",
              queuedRunId: runId,
              targetRunId,
            }));
          }
          default:
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.cancel",
              runId,
            }));
        }
      }),
    ),
  ),
});

/** The same handlers as a plain layer, for tests that call a tool without registering it. */
export const J5AdaptedThreadHandlersLive = McpToolAccess.HandlersLayer.layer(layer);
