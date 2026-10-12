import { type ChatAttachment, OrchestratorMcpFailure, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  type McpClientCaller,
  McpInvocationContext,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { assertTargetWithinLimits, loadCaller } from "../../../mcp/threadAccess.ts";
import { exceededDispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { type CommCommandId, outsideAgentParticipantId } from "../contracts.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2ASendService } from "../SendService.ts";
import { sendClaimingAttachments } from "./attachments.ts";
import type { J5SendMessageInput } from "./tools.ts";

/**
 * An outside agent is an MCP client signed in through upstream's OAuth flow: a session, a label
 * and an approved level, with no thread. This module holds what J5's tools do for one.
 */
class J5OutsideAgentToolError extends Data.TaggedError("J5OutsideAgentToolError")<{
  readonly state: string;
  readonly nextCommand: string;
}> {
  override get message(): string {
    return `${this.state} ${this.nextCommand}`;
  }
}

/** The legal move for a tool that needs a thread for something to come back to. */
export const spawnAndBrief = (task: string) =>
  `Start an agent with j5_spawn_agent and brief it to ${task}.`;

/**
 * Declares a tool that acts as the calling thread and so is refused to an outside agent. Upstream's
 * own refusal says only that a thread is needed; this one also names what the outside agent can do
 * instead. Every J5 tool that needs a calling thread is declared with this, so none can admit an
 * outside agent by forgetting the check. It is `writes` underneath: a read-only client is refused,
 * and the caller needs the orchestration capability, which every provider session J5 starts has.
 */
export const actsAsThreadCaller = <P, A, E, R>(
  tool: string,
  legalMove: string,
  handle: (params: P, scope: McpThreadInvocationScope) => Effect.Effect<A, E, R>,
) =>
  McpToolAccess.writes((params: P) =>
    threadCaller(tool, legalMove).pipe(Effect.flatMap((scope) => handle(params, scope))),
  );

/** The same for a tool that only reads what belongs to the calling thread; any sign-in level is told its legal move. */
export const readsAsThreadCaller = <P, A, E, R>(
  tool: string,
  legalMove: string,
  handle: (params: P, scope: McpThreadInvocationScope) => Effect.Effect<A, E, R>,
) =>
  McpToolAccess.reads((params: P) =>
    threadCaller(tool, legalMove).pipe(Effect.flatMap((scope) => handle(params, scope))),
  );

const threadCaller = (tool: string, legalMove: string) =>
  McpInvocationContext.pipe(
    Effect.flatMap((scope) =>
      scope.thread === undefined && scope.client !== undefined
        ? Effect.fail(
            new OrchestratorMcpFailure({
              code: "thread_credential_required",
              message: `${tool} needs an agent running inside J5 Code, and this MCP client signed in from outside a thread. ${legalMove}`,
            }),
          )
        : requireThreadScope(scope, tool),
    ),
  );

interface OutsideAgentCaller {
  readonly scope: McpInvocationScope;
  readonly client: McpClientCaller;
}

/** The outside agent calling, or undefined for a thread caller. */
export const outsideAgentCaller = McpInvocationContext.pipe(
  Effect.map((scope): OutsideAgentCaller | undefined =>
    scope.thread === undefined && scope.client !== undefined
      ? { scope, client: scope.client }
      : undefined,
  ),
);

/** An outside agent has no project of its own, so a spawn names the one the new agent joins. */
export const outsideSpawnNeedsProject = new J5OutsideAgentToolError({
  state:
    "An outside agent has no project of its own, so j5_spawn_agent needs to be told where the agent goes.",
  nextCommand:
    'Call t3_project_list and retry j5_spawn_agent with one of its project ids as project_id, or with scratch for the "No project" project.',
});

/** `shared` is the caller's own checkout, and an outside agent has none. */
export const outsideSpawnHasNoCheckout = new J5OutsideAgentToolError({
  state:
    'workspace {"type":"shared"} is the caller\'s own checkout, and an outside agent has none.',
  nextCommand:
    'Retry j5_spawn_agent with workspace {"type":"root"} for the project\'s main checkout, a new worktree, or one of the project\'s worktrees.',
});

/**
 * A persona's policy sets the agent's permission mode, and for an outside agent that mode must
 * be within the level its sign-in was approved at. A thread caller's persona spawn has no such
 * ceiling: the approved level is a promise the approval page makes about an agent the person
 * does not watch.
 */
export const assertPersonaWithinApprovedLevel = Effect.fn(
  "j5.a2a.mcp.assertPersonaWithinApprovedLevel",
)(function* (caller: OutsideAgentCaller, persona: string, runtimeMode: RuntimeMode) {
  const { limits } = yield* loadCaller();
  if (
    exceededDispatchModeLimit(limits, {
      runtimeMode,
      interactionMode: limits.interactionMode,
    }) === undefined
  ) {
    return;
  }
  return yield* new J5OutsideAgentToolError({
    state: `Persona ${persona} runs in permission mode ${runtimeMode}, which is broader than the level this MCP client was approved for (${caller.client.access}).`,
    nextCommand:
      "Retry j5_spawn_agent with a persona within that level (j5_list_personas shows each one's runtime policy) or without a persona, or sign in again and have the person approve a higher level.",
  });
});

/**
 * `j5_send_message` for an outside agent: a plain message to an agent on this server, recorded in
 * the receiver's project. The approved sign-in level caps every send, one that asks for no steer or restart included,
 * because it is a promise the approval page makes about an agent the person does not watch.
 */
export const sendAsOutsideAgent = Effect.fn("j5.a2a.mcp.sendAsOutsideAgent")(function* (
  caller: OutsideAgentCaller,
  input: J5SendMessageInput,
  /** Namespaced by the client session, so a new sign-in is a new set of retry keys. */
  commandIdFor: (requestKey: string) => CommCommandId,
) {
  if (
    input.expect_reply === true ||
    input.exchange_id != null ||
    input.intent != null ||
    input.urgency != null
  ) {
    return yield* new J5OutsideAgentToolError({
      state:
        "An outside agent sends plain messages only. It cannot receive a reply, so expect_reply, exchange_id, intent and urgency are refused.",
      nextCommand: "Retry j5_send_message without them.",
    });
  }
  const service = yield* A2ASendService;
  const receiver = yield* service.outsideAgentReceiver(input.to);
  const target = yield* (yield* ThreadManagementService)
    .getThreadShell(receiver.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (target === null) {
    return yield* new J5OutsideAgentToolError({
      state: `The thread of ${input.to} cannot be read to check it against your approved level.`,
      nextCommand: "Retry j5_send_message.",
    });
  }
  const { limits } = yield* loadCaller();
  yield* assertTargetWithinLimits(limits, target).pipe(
    Effect.mapError(
      (error) =>
        new J5OutsideAgentToolError({
          state: `${input.to} runs with broader permissions than this MCP client was approved for (${caller.client.access}): ${error.message}`,
          nextCommand:
            "The approved level caps every message an outside agent sends. Message an agent within it, or ask the person to message this one.",
        }),
    ),
  );
  const mode = input.mode ?? "queue";
  const attachments = input.attachments ?? [];
  const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const requestKey = input.client_request_id ?? (yield* (yield* Crypto.Crypto).randomUUIDv4);
  const send = (claimed?: ReadonlyArray<ChatAttachment>) =>
    service.sendAsOutsideAgent({
      commandId: commandIdFor(requestKey),
      senderParticipantId: outsideAgentParticipantId(caller.client.sessionId),
      senderName: caller.client.label,
      to: input.to,
      receiverProjectId: receiver.projectId,
      message: input.message,
      // A steer or a restart carries the limit to delivery, as a thread sender's does.
      ...(mode === "queue" ? {} : { mode, modeLimit: limits }),
      ...(claimed === undefined ? {} : { attachments: claimed }),
      acceptedAt,
    });
  const result =
    attachments.length === 0
      ? yield* send()
      : yield* sendClaimingAttachments(receiver.threadId, attachments, send);
  yield* (yield* A2ADeliveryWorker).notify;
  // No backlog notice: it counts the caller's own waiting messages by its thread, and an outside
  // agent has none.
  return result;
});
