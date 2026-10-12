import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { latestActiveRun } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  gpt6PeerSteeringRun,
  deliveryMessageId,
  isDeliveryMessageId,
  requestedSteeringRun,
} from "./DeliveryTransport.ts";
import { formatReceiverBacklogNotice } from "./EnvelopeFormatter.ts";
import { LedgerMessageId, Participant, type ParticipantId, type SendMode } from "./contracts.ts";

export interface ReceiverBacklog {
  /** Messages that will each start their own turn once the receiver's current turn ends. */
  readonly waiting: number;
  /** How many of those the caller sent. */
  readonly fromCaller: number;
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

/**
 * What a just-sent message is waiting behind: the receiver's running turn and the
 * A2A messages after it, both those already queued as runs and those the delivery
 * worker has not handed over yet. Undefined when the message will not wait: the
 * receiver is idle, takes it mid-turn (a GPT 6 model, or a steer or restart), holds its queue, is not an agent on
 * this server, or the message has already run or will never run. Measured when
 * called and never stored, so it is advice to the sender, not a delivery fact. A
 * failed read is logged and reads as undefined: the message is already committed,
 * and the send must not fail over advice.
 */
export const readReceiverBacklog = Effect.fn("j5.a2a.readReceiverBacklog")(
  function* (input: {
    readonly receiverId: ParticipantId;
    readonly callerThreadId: ThreadId;
    readonly sentMessageId: LedgerMessageId;
    /** How the sender asked for the message to land; absent means `queue`. */
    readonly mode?: SendMode | undefined;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* OrchestratorV2;
    const rows = yield* sql<{ readonly payload: string }>`
      SELECT payload FROM j5_a2a_membership
      WHERE participant_id = ${input.receiverId} AND archived_at IS NULL
      LIMIT 1
    `;
    if (rows[0] === undefined) return undefined;
    const participant = yield* decodeParticipant(rows[0].payload);
    if (participant.kind !== "agent") return undefined;

    // Committed deliveries the worker has not handed to this thread yet. Read before
    // the runs: the worker commits a run before it marks the delivery delivered, so
    // every message lands in at least one of the two reads. The drain index keeps this
    // to the small set of pending rows.
    const pendingRows = yield* sql<{ readonly message_id: string; readonly sender_id: string }>`
      SELECT message_id, sender_id FROM j5_a2a_delivery
      WHERE status IN ('pending', 'retry_scheduled')
        AND receiver_id = ${input.receiverId}
        AND receiver_environment_id IS NULL
    `;

    const target = yield* orchestrator.getThreadRecords(participant.threadId, [
      "runs",
      "providerTurns",
      "providerThreads",
      "providerSessions",
    ]);
    if (target.thread.archivedAt !== null || latestActiveRun(target) === undefined)
      return undefined;
    // A held queue drains only when someone resumes the thread, so "after its current
    // turn ends" would be false. Telling the sender about held receivers is #272.
    if (target.runs.some((run) => run.status === "queued" && run.queueHeld === true))
      return undefined;

    const runByMessage = new Map(target.runs.map((run) => [run.userMessageId, run]));
    const sentRun = runByMessage.get(deliveryMessageId(input.sentMessageId));
    // Already started or finished (a replay reports the current state, not the first one).
    if (sentRun !== undefined && sentRun.status !== "queued") return undefined;
    // Not yet handed over, so a running GPT 6 turn, or the turn a steer or restart lands on,
    // will take it mid-turn. Once queued, it stays queued even if the receiver's turn later
    // becomes steerable.
    const mode = input.mode ?? "queue";
    if (
      sentRun === undefined &&
      (mode === "queue"
        ? gpt6PeerSteeringRun(target, "peer")
        : requestedSteeringRun(target, "peer", mode)) !== undefined
    )
      return undefined;

    const pending = pendingRows.filter(
      (row) => !runByMessage.has(deliveryMessageId(LedgerMessageId.make(row.message_id))),
    );
    // Neither queued nor pending: cancelled or alarmed, so it is not waiting.
    if (sentRun === undefined && !pending.some((row) => row.message_id === input.sentMessageId))
      return undefined;
    const callerId = (yield* sql<{ readonly sender_id: string }>`
      SELECT sender_id FROM j5_a2a_delivery WHERE message_id = ${input.sentMessageId} LIMIT 1
    `)[0]?.sender_id;

    const queued = target.runs.filter(
      (run) => run.status === "queued" && isDeliveryMessageId(run.userMessageId),
    );
    const queuedMessages =
      queued.length === 0
        ? []
        : (yield* orchestrator.getThreadRecords(participant.threadId, ["messages"], {
            messageIds: queued.map((run) => run.userMessageId),
          })).messages;
    return {
      waiting: queued.length + pending.length,
      fromCaller:
        queuedMessages.filter((message) => message.senderThreadId === input.callerThreadId).length +
        pending.filter((row) => row.sender_id === callerId).length,
    } satisfies ReceiverBacklog;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("J5 A2A receiver backlog read failed", {
          receiverId: input.receiverId,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    ),
);

/** Adds the backlog notice to a send result when the message will wait behind the receiver's turn. */
export const withDeliveryNotice = Effect.fn("j5.a2a.withDeliveryNotice")(function* <
  R extends { readonly messageId: LedgerMessageId },
>(
  result: R,
  input: {
    readonly receiverId: ParticipantId;
    readonly callerThreadId: ThreadId;
    readonly mode?: SendMode | undefined;
  },
) {
  const backlog = yield* readReceiverBacklog({ ...input, sentMessageId: result.messageId });
  return backlog === undefined
    ? result
    : {
        ...result,
        deliveryNotice: formatReceiverBacklogNotice({
          receiverId: input.receiverId,
          waiting: backlog.waiting,
          fromYou: backlog.fromCaller,
        }),
      };
});
