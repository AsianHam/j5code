import {
  type ChatAttachment,
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import {
  J5_PEER_API_PATHS,
  peerCredentialRejectedReason,
  type PeerDeliveryRequest,
} from "@t3tools/contracts/j5";
import { codexModelFamily, normalizeModelSlug } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit, type DispatchModes } from "../../orchestration-v2/DispatchModeLimit.ts";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import {
  formatClosedHumanEnvelope,
  formatClosedPeerEnvelope,
  formatMachineEnvelope,
  formatOutsideAgentEnvelope,
  formatPeerEnvelope,
} from "./EnvelopeFormatter.ts";
import { outsideAgentNameRows } from "./outsideAgentNames.ts";
import { PeerDeliveryRefusalCode } from "./PeerInboundService.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { peerProtocolHeaders, responseProtocolMismatch } from "./peerProtocol.ts";
import {
  type DeliveryEnvelopeChannel,
  type SendMode,
  LedgerProjectId,
  ExchangeId,
  isHumanParticipantId,
  isMachineParticipantId,
  isOutsideAgentParticipantId,
  Participant,
  ParticipantId,
  type LedgerMessageId,
} from "./contracts.ts";

export class A2ADeliveryTargetError extends Schema.TaggedError<A2ADeliveryTargetError>()(
  "A2ADeliveryTargetError",
  {
    participantId: Schema.String,
    state: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot deliver to ${this.participantId}: ${this.state}. Call j5_list_participants before sending again.`;
  }
}

export class A2ADeliveryTransportError extends Schema.TaggedError<A2ADeliveryTransportError>()(
  "A2ADeliveryTransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The receiver durably accepted the message, but its run waits behind a held queue
 * (upstream holds queued runs after a restart until someone resumes the thread).
 * The message is not delivered yet; the worker retries without alarming.
 */
export class A2ADeliveryHeldError extends Schema.TaggedError<A2ADeliveryHeldError>()(
  "A2ADeliveryHeldError",
  {
    participantId: Schema.String,
    runId: Schema.String,
  },
) {
  override get message(): string {
    return `${this.participantId} holds queued messages until someone resumes its thread; run ${this.runId} is queued, not delivered.`;
  }
}

export const isHeldError = Schema.is(A2ADeliveryHeldError);

/** The peer server refused the message for good: its receiver is gone or will not take it. */
export class A2ADeliveryRefusedError extends Schema.TaggedError<A2ADeliveryRefusedError>()(
  "A2ADeliveryRefusedError",
  {
    participantId: Schema.String,
    /** The peer's refusal code, such as `policy_refused`. */
    code: Schema.String,
    /** The peer's own sentence for why, which the sender is told. */
    refusal: Schema.String,
  },
) {
  override get message(): string {
    return `The peer server refused the message to ${this.participantId}: ${this.code}: ${this.refusal}`;
  }
}

export const isRefusedError = Schema.is(A2ADeliveryRefusedError);

export interface AgentDeliveryInput {
  readonly originProjectId: LedgerProjectId;
  readonly receiverProjectId: LedgerProjectId;
  readonly messageId: LedgerMessageId;
  readonly senderId: ParticipantId;
  readonly receiverId: ParticipantId;
  readonly exchangeId: ExchangeId | null;
  readonly exchangeRole: "none" | "ask" | "followup" | "reply" | "terminal_notice";
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  /** How the sender asked for the message to land; absent means `queue`. */
  readonly mode?: SendMode;
  /** The broadest modes the sender could touch when it asked for a steer or a restart. */
  readonly modeLimit?: DispatchModes;
  readonly envelopeChannel: DeliveryEnvelopeChannel;
  /** The peer server a received message came from, named in its envelope; absent for a local sender. */
  readonly senderServerName?: string;
}

export interface HumanDeliveryInput extends AgentDeliveryInput {
  readonly createdAt: string;
}

/** A receiver homed on a peer server: the peer writes its own received row and delivers from there. */
export interface PeerDeliveryInput {
  readonly receiverEnvironmentId: string;
  /** The one body a message crosses in, built by `buildPeerDeliveryBody` for direct sends and polls alike. */
  readonly body: PeerDeliveryRequest;
}

const PEER_DELIVERY_TIMEOUT = Duration.seconds(15);

export interface A2ADeliveryTransportShape {
  /** Withdraw an accepted queue entry, or prove that delivery already reached its run/provider. */
  readonly cancelAgent: (input: {
    readonly receiverId: ParticipantId;
    readonly messageId: LedgerMessageId;
  }) => Effect.Effect<"cancelled" | "delivered", A2ADeliveryTransportError>;
  readonly deliverAgent: (
    input: AgentDeliveryInput,
  ) => Effect.Effect<void, A2ADeliveryTransportError | A2ADeliveryHeldError>;
  readonly deliverHuman: (
    input: HumanDeliveryInput,
  ) => Effect.Effect<void, A2ADeliveryTransportError>;
  readonly deliverPeer: (
    input: PeerDeliveryInput,
  ) => Effect.Effect<void, A2ADeliveryTransportError | A2ADeliveryRefusedError>;
}

export class A2ADeliveryTransport extends Context.Service<
  A2ADeliveryTransport,
  A2ADeliveryTransportShape
>()("t3/j5/a2a/DeliveryTransport/A2ADeliveryTransport") {}

const stablePart = (value: string) => encodeURIComponent(value);

/**
 * Every retry reuses this upstream command/message pair. A rejected upstream
 * receipt therefore exhausts into the visible alarm instead of rotating an id
 * that could double-inject after an ambiguous post-commit failure.
 */
export const deliveryCommandId = (messageId: LedgerMessageId) =>
  CommandId.make(`command:j5:a2a:delivery:${stablePart(messageId)}`);

/**
 * The command an asked-for steer or restart is dispatched under. It is not the delivery's own:
 * upstream records a rejected command for good, and a restart is rejected when the turn it was
 * aimed at has just ended, so the plain delivery that follows must keep a command id that nothing
 * has refused.
 */
export const askedDeliveryCommandId = (
  messageId: LedgerMessageId,
  mode: Exclude<SendMode, "queue">,
) => CommandId.make(`${deliveryCommandId(messageId)}:${mode}`);

/** Every command one message's delivery may have been dispatched under. */
const deliveryCommandIds = (messageId: LedgerMessageId) => [
  deliveryCommandId(messageId),
  askedDeliveryCommandId(messageId, "steer"),
  askedDeliveryCommandId(messageId, "restart"),
];

const DELIVERY_MESSAGE_ID_PREFIX = "message:j5:a2a:delivery:";

export const deliveryMessageId = (messageId: LedgerMessageId) =>
  MessageId.make(`${DELIVERY_MESSAGE_ID_PREFIX}${stablePart(messageId)}`);

/** Whether a thread message is an A2A delivery (a peer message or a platform notice). */
export const isDeliveryMessageId = (messageId: string) =>
  messageId.startsWith(DELIVERY_MESSAGE_ID_PREFIX);

interface MembershipRow {
  readonly payload: string;
}

interface HumanExchangeRow {
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
  readonly intent: string;
  readonly urgency: "blocking" | "soon" | "fyi" | null;
  readonly opened_seq: number;
  readonly created_at: string;
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));
const decodeRefusalOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: PeerDeliveryRefusalCode, message: Schema.String })),
);
const decodeRefusal = (text: string) => decodeRefusalOption(text).pipe(Option.getOrNull);
const assertNever = (channel: never): never => {
  throw new Error(`Unsupported A2A delivery envelope channel: ${String(channel)}`);
};

// A person never opens an ask through the platform; their only ledger message
// is the inbox answer, delivered as a reply. Nothing produces another shape,
// so a person-origin non-reply is a corrupt delivery, not a channel.
const assertPersonReply = (input: AgentDeliveryInput): never => {
  throw new Error(
    `Unsupported A2A delivery: person ${input.senderId} sent a ${input.exchangeRole} message ${input.messageId}`,
  );
};

// Every GPT 6 model (Astra, Luna, Sol and their point releases) takes messages during work.
const isGpt6Model = (model: string | null) =>
  model !== null && /^gpt-6[-.]/.test(codexModelFamily(model));

/** Use the active run's selection, not the picker selection for future runs. */
export const gpt6PeerSteeringRun = (
  target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerTurns" | "providerThreads" | "providerSessions"
  >,
  channel: DeliveryEnvelopeChannel,
) => {
  if (channel !== "peer" || target.thread.archivedAt !== null) return undefined;
  const run = ThreadManagement.latestSteerableRun(target);
  if (run === undefined) return undefined;
  const providerThread = target.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  const session = target.providerSessions.find(
    (candidate) => candidate.id === providerThread?.providerSessionId,
  );
  return providerThread?.driver === "codex" &&
    session?.driver === "codex" &&
    session.capabilities.turns.supportsActiveSteering === true &&
    isGpt6Model(normalizeModelSlug(run.modelSelection.model, providerThread.driver))
    ? run
    : undefined;
};

/**
 * The running turn a `steer` or `restart` lands on, by upstream's own steering policy: a steer
 * needs a provider that steers a turn directly or by interrupting and restarting it, and a restart
 * needs the second. Undefined when the receiver has no such turn, and the message is then
 * delivered as any other: it starts a turn on an idle agent, or waits behind a busy one.
 */
export const requestedSteeringRun = (
  target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerTurns" | "providerThreads" | "providerSessions"
  >,
  channel: DeliveryEnvelopeChannel,
  mode: Exclude<SendMode, "queue">,
) => {
  if (channel !== "peer" || target.thread.archivedAt !== null) return undefined;
  const run = ThreadManagement.latestSteerableRun(target);
  if (run === undefined) return undefined;
  const providerThread = target.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  const turns = target.providerSessions.find(
    (candidate) => candidate.id === providerThread?.providerSessionId,
  )?.capabilities.turns;
  if (turns === undefined) return undefined;
  const restarts = turns.supportsInterrupt && turns.supportsSteeringByInterruptRestart;
  return (mode === "steer" ? turns.supportsActiveSteering || restarts : restarts) ? run : undefined;
};

export const formatAgentDeliveryEnvelope = (
  input: AgentDeliveryInput & {
    readonly originProjectTitle?: string | undefined;
    /** The label an outside agent signed in with. */
    readonly outsideAgentName?: string | undefined;
  },
): string => {
  switch (input.envelopeChannel) {
    case "peer":
      return input.exchangeRole === "reply"
        ? isHumanParticipantId(input.senderId)
          ? formatClosedHumanEnvelope({
              senderId: input.senderId,
              message: input.message,
            })
          : formatClosedPeerEnvelope({
              senderId: input.senderId,
              originProjectId: input.originProjectId,
              originProjectTitle: input.originProjectTitle,
              message: input.message,
              ...(input.senderServerName === undefined
                ? {}
                : { senderServerName: input.senderServerName }),
            })
        : isHumanParticipantId(input.senderId)
          ? assertPersonReply(input)
          : isMachineParticipantId(input.senderId)
            ? formatMachineEnvelope({
                senderId: input.senderId,
                originProjectId: input.originProjectId,
                originProjectTitle: input.originProjectTitle,
                message: input.message,
              })
            : isOutsideAgentParticipantId(input.senderId)
              ? formatOutsideAgentEnvelope({
                  senderId: input.senderId,
                  senderName: input.outsideAgentName,
                  message: input.message,
                })
              : formatPeerEnvelope({
                  senderId: input.senderId,
                  originProjectId: input.originProjectId,
                  originProjectTitle: input.originProjectTitle,
                  exchangeId: input.exchangeId,
                  message: input.message,
                  ...(input.senderServerName === undefined
                    ? {}
                    : { senderServerName: input.senderServerName }),
                });
    case "silence_notice":
    case "lifecycle_notice":
      return input.message;
    default:
      return assertNever(input.envelopeChannel);
  }
};

export const live: Layer.Layer<
  A2ADeliveryTransport,
  never,
  | ThreadManagement.ThreadManagementService
  | OrchestratorV2
  | EffectOutboxV2
  | SqlClient.SqlClient
  | PeerRegistryService
  | HttpClient.HttpClient
> = Layer.effect(
  A2ADeliveryTransport,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const orchestrator = yield* OrchestratorV2;
    const outbox = yield* EffectOutboxV2;
    const peers = yield* PeerRegistryService;
    const httpClient = yield* HttpClient.HttpClient;
    const awaitSteeringOutcome = Effect.fn(function* (effectId: string) {
      // Only bound the observer. The provider effect may still acknowledge later;
      // retries must inspect that same durable effect, never inject a new one.
      const outcome = yield* outbox.awaitSettled(effectId).pipe(Effect.timeout("30 seconds"));
      if (outcome.status !== "succeeded") {
        return yield* new A2ADeliveryTransportError({
          operation: "await peer steering",
          cause: outcome.lastError ?? `Steering effect ${outcome.status}.`,
        });
      }
    });
    const sql = yield* SqlClient.SqlClient;
    // An agent sender is homed in the delivery's origin project, so its thread
    // is one primary-key read on the (agent-only) membership projection.
    const agentThreadId = Effect.fn("j5.a2a.delivery.agentThreadId")(function* (
      projectId: LedgerProjectId,
      participantId: ParticipantId,
    ) {
      const rows = yield* sql<{ readonly thread_id: string }>`SELECT thread_id
        FROM j5_a2a_membership
        WHERE project_id = ${projectId} AND participant_id = ${participantId}`;
      return rows[0] === undefined ? undefined : ThreadId.make(rows[0].thread_id);
    });

    return A2ADeliveryTransport.of({
      cancelAgent: (input) =>
        Effect.gen(function* () {
          const rows =
            yield* sql<MembershipRow>`SELECT json_extract(payload, '$.participant') AS payload
          FROM j5_a2a_comm_event WHERE kind = 'participant.joined'
            AND json_extract(payload, '$.participant.id') = ${input.receiverId}`;
          if (rows.length !== 1)
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "missing immutable delivery identity",
            });
          const participant = yield* decodeParticipant(rows[0]!.payload);
          if (participant.kind !== "agent")
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "not an agent",
            });
          // A steer may sit under the delivery's own command (Astra) or the one its sender asked
          // for; its outcome, not the message in the thread, says whether the provider took it.
          const priorEffects = (yield* Effect.forEach(deliveryCommandIds(input.messageId), (id) =>
            outbox.listByCommandId(id),
          )).flat();
          const steer = priorEffects.find(
            (effect) => effect.request.type === "provider-turn.steer",
          );
          if (steer !== undefined) {
            const outcome = yield* outbox.awaitSettled(steer.id).pipe(Effect.timeout("30 seconds"));
            return outcome.status === "succeeded" ? ("delivered" as const) : ("cancelled" as const);
          }
          const projection = yield* threads.getThreadProjection(participant.threadId);
          const message = projection.messages.find(
            (entry) => entry.id === deliveryMessageId(input.messageId),
          );
          if (message === undefined) return "cancelled" as const;
          const run = projection.runs.find((entry) => entry.id === message.runId);
          if (run === undefined)
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "accepted message has no run",
            });
          if (run.status === "queued") {
            // The orchestrator serializes this cancellation with queue promotion.
            // If promotion won, retry observes the accepted run rather than claiming cancellation.
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(
                `command:j5:a2a:cancel-delivery:${stablePart(input.messageId)}`,
              ),
              threadId: participant.threadId,
              runId: run.id,
            });
            return "cancelled" as const;
          }
          return run.status === "cancelled" ? ("cancelled" as const) : ("delivered" as const);
        }).pipe(
          Effect.mapError(
            (cause) => new A2ADeliveryTransportError({ operation: "cancel agent delivery", cause }),
          ),
        ),
      deliverAgent: (input) =>
        Effect.gen(function* () {
          const rows = yield* sql<MembershipRow>`
            SELECT payload
            FROM j5_a2a_membership
            WHERE project_id = ${input.receiverProjectId}
              AND participant_id = ${input.receiverId}
              AND archived_at IS NULL
            LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) {
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "membership disappeared before delivery",
            });
          }
          const participant = yield* decodeParticipant(row.payload);
          if (participant.kind !== "agent") {
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "participant is not an addressable agent thread",
            });
          }
          const target = yield* threads.getThreadProjection(participant.threadId);
          if (target.thread.archivedAt !== null) {
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "thread is archived",
            });
          }
          // A retry must observe the original steer even if its run has ended.
          // Re-dispatching the stable command as a queue request cannot prove delivery.
          // Upstream prunes succeeded and cancelled effects after seven days; past that the
          // steer row is gone and the accepted message in the projection decides below.
          const priorEffects = yield* outbox.listByCommandId(deliveryCommandId(input.messageId));
          const priorSteer = priorEffects.find(
            (effect) => effect.request.type === "provider-turn.steer",
          );
          if (priorSteer !== undefined) return yield* awaitSteeringOutcome(priorSteer.id);
          // GPT 6 models can receive peer updates during their long turns. Other models
          // and platform notices retain QS1's queue policy (Claude issue #73).
          const alreadyAccepted = target.messages.some(
            (message) => message.id === deliveryMessageId(input.messageId),
          );
          const steeringRun = alreadyAccepted
            ? undefined
            : gpt6PeerSteeringRun(target, input.envelopeChannel);
          // The header names the sender's project by id, with its title when the sender is on this
          // server. A peer server's project is not one of ours, so it is named by id alone.
          const originProject =
            input.senderServerName !== undefined
              ? []
              : yield* sql<{ readonly title: string }>`
                  SELECT title FROM projection_projects WHERE project_id = ${input.originProjectId}
                `.pipe(
                  Effect.mapError(
                    (cause) =>
                      new A2ADeliveryTransportError({ operation: "read origin project", cause }),
                  ),
                );
          const outsideAgent = !isOutsideAgentParticipantId(input.senderId)
            ? []
            : yield* outsideAgentNameRows(sql, [input.senderId]).pipe(
                Effect.mapError(
                  (cause) =>
                    new A2ADeliveryTransportError({ operation: "read outside agent", cause }),
                ),
              );
          const envelope = formatAgentDeliveryEnvelope({
            ...input,
            originProjectTitle: originProject[0]?.title,
            outsideAgentName: outsideAgent[0]?.display_name,
          });
          // Upstream links an agent-authored message to its sending thread. A machine and an
          // outside agent have none.
          const senderThreadId =
            input.envelopeChannel === "peer" &&
            !isHumanParticipantId(input.senderId) &&
            !isMachineParticipantId(input.senderId) &&
            !isOutsideAgentParticipantId(input.senderId)
              ? yield* agentThreadId(input.originProjectId, input.senderId)
              : undefined;
          const sendInput = {
            projectId: target.thread.projectId,
            commandId: deliveryCommandId(input.messageId),
            threadId: participant.threadId,
            messageId: deliveryMessageId(input.messageId),
            ...(senderThreadId === undefined ? {} : { senderThreadId }),
            text: envelope,
            attachments: input.attachments ?? [],
            mode: "queue",
            createdBy:
              input.envelopeChannel === "silence_notice" ||
              input.envelopeChannel === "lifecycle_notice"
                ? "system"
                : isHumanParticipantId(input.senderId)
                  ? "user"
                  : "agent",
            creationSource: "mcp",
          } satisfies ThreadManagement.ThreadManagementSendInput;
          const heldRun = (run: OrchestrationV2Run | undefined) =>
            run?.status === "queued" && run.queueHeld === true
              ? Effect.fail(
                  new A2ADeliveryHeldError({ participantId: input.receiverId, runId: run.id }),
                )
              : Effect.void;
          const mode = input.mode ?? "queue";
          if (mode !== "queue") {
            // The sender asked for a steer or a restart (see `askedDeliveryCommandId`).
            const askedCommandId = askedDeliveryCommandId(input.messageId, mode);
            const landed = Effect.fn("j5.a2a.delivery.landedAsAsked")(function* () {
              const steer = (yield* outbox.listByCommandId(askedCommandId)).find(
                (effect) => effect.request.type === "provider-turn.steer",
              );
              if (steer !== undefined) {
                yield* awaitSteeringOutcome(steer.id);
                return true;
              }
              // A restart, and a steer the provider takes by interrupting and restarting, leave
              // no steer effect: the message in the thread is the proof.
              const accepted = yield* orchestrator.getThreadProjection(participant.threadId);
              if (!accepted.messages.some((message) => message.id === sendInput.messageId)) {
                return false;
              }
              yield* heldRun(
                accepted.runs.find((run) => run.userMessageId === sendInput.messageId),
              );
              return true;
            });
            if (yield* landed()) return;
            const askedRun = requestedSteeringRun(target, input.envelopeChannel, mode);
            if (askedRun !== undefined) {
              yield* orchestrator
                .dispatch({
                  type: "message.dispatch",
                  commandId: askedCommandId,
                  threadId: sendInput.threadId,
                  messageId: sendInput.messageId,
                  text: sendInput.text,
                  attachments: sendInput.attachments,
                  ...(sendInput.senderThreadId === undefined
                    ? {}
                    : { senderThreadId: sendInput.senderThreadId }),
                  createdBy: sendInput.createdBy,
                  creationSource: sendInput.creationSource,
                  modelSelection: askedRun.modelSelection,
                  dispatchMode: {
                    type: mode === "restart" ? "restart_active" : "steer_active",
                    targetRunId: askedRun.id,
                  },
                })
                .pipe(
                  // The sender's limit when it sent. The receiver's user can raise its modes
                  // before delivery, and upstream checks again under the thread's lock.
                  Effect.provideService(DispatchModeLimit, input.modeLimit),
                  // Refused or too late: the message is delivered as any other, below.
                  Effect.catch((cause) =>
                    Effect.logInfo("J5 A2A delivery could not land as its sender asked", {
                      messageId: input.messageId,
                      mode,
                      cause,
                    }),
                  ),
                );
              if (yield* landed()) return;
            }
            return yield* heldRun((yield* threads.sendToThread(sendInput)).run);
          }
          if (steeringRun === undefined) {
            yield* heldRun((yield* threads.sendToThread(sendInput)).run);
          } else {
            // Pin the checked run and model. If it completed before admission,
            // upstream can accept this same message as a queued follow-up.
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: sendInput.commandId,
              threadId: sendInput.threadId,
              messageId: sendInput.messageId,
              text: sendInput.text,
              attachments: sendInput.attachments,
              ...(sendInput.senderThreadId === undefined
                ? {}
                : { senderThreadId: sendInput.senderThreadId }),
              createdBy: sendInput.createdBy,
              creationSource: sendInput.creationSource,
              modelSelection: steeringRun.modelSelection,
              dispatchMode: { type: "steer_active", targetRunId: steeringRun.id },
            });
          }
          // Re-read even after queue dispatch: a concurrent attempt may have
          // committed this same command as a steer before our projection read.
          const effects = yield* outbox.listByCommandId(sendInput.commandId);
          const steer = effects.find((effect) => effect.request.type === "provider-turn.steer");
          if (steer !== undefined) {
            yield* awaitSteeringOutcome(steer.id);
          } else if (steeringRun !== undefined) {
            const accepted = yield* orchestrator.getThreadProjection(participant.threadId);
            const followUp = accepted.runs.find((run) => run.userMessageId === sendInput.messageId);
            if (followUp !== undefined) return yield* heldRun(followUp);
            return yield* new A2ADeliveryTransportError({
              operation: "await peer steering",
              cause: "The committed command has no steering effect.",
            });
          }
        }).pipe(
          Effect.mapError((cause) =>
            isHeldError(cause)
              ? cause
              : new A2ADeliveryTransportError({ operation: "deliver agent", cause }),
          ),
        ),
      deliverPeer: (input) =>
        Effect.gen(function* () {
          const receiverId = ParticipantId.make(input.body.receiverId);
          const peer = yield* peers.connection(input.receiverEnvironmentId);
          if (peer === null) {
            return yield* new A2ADeliveryTargetError({
              participantId: receiverId,
              state: `peer ${input.receiverEnvironmentId} is no longer recorded on this server`,
            });
          }
          // A peer that polls is never called; its messages wait here until it asks.
          if (peer.origin === null || peer.credential === null) {
            return yield* new A2ADeliveryTargetError({
              participantId: receiverId,
              state: `peer ${peer.label} polls this server for its messages, so none is sent to it`,
            });
          }
          const body = input.body;
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${peer.origin}${J5_PEER_API_PATHS.deliver}`).pipe(
              HttpClientRequest.bearerToken(peer.credential),
              HttpClientRequest.acceptJson,
              HttpClientRequest.setHeaders(peerProtocolHeaders),
            ),
            body,
          );
          const response = yield* httpClient
            .execute(request)
            .pipe(Effect.timeout(PEER_DELIVERY_TIMEOUT));
          // An older server answers 201 to a body it cannot read, so its version is checked first.
          // The peer's row shows a mismatch until a later delivery succeeds.
          const mismatch = responseProtocolMismatch({
            response,
            peer: peer.label,
          });
          if (mismatch !== null) {
            yield* peers.recordLastError(peer.environmentId, mismatch);
            return yield* new A2ADeliveryTargetError({
              participantId: receiverId,
              state: mismatch,
            });
          }
          if (response.status === 200 || response.status === 201) {
            yield* peers.recordLastError(peer.environmentId, null);
            return;
          }
          // A peer rejects the credential it issued only once it removed this
          // server: the row says it ended the peering. The send retries and alarms.
          if (response.status === 401) {
            yield* peers.recordLastError(
              peer.environmentId,
              peerCredentialRejectedReason(peer.label),
            );
          }
          const text = yield* response.text;
          // Only an error answer that is the peer's own refusal, with its code
          // and reason, is final: it decided, so retrying cannot change it. A
          // bare status, such as an older server's missing route or a proxy's
          // page, or any other 2xx, is retried and alarms like any failure.
          const refused =
            response.status >= 200 && response.status < 300 ? null : decodeRefusal(text);
          if (refused !== null) {
            return yield* new A2ADeliveryRefusedError({
              participantId: receiverId,
              code: refused.error,
              refusal: refused.message.slice(0, 4_000),
            });
          }
          return yield* new A2ADeliveryTransportError({
            operation: "deliver to peer",
            cause: `Peer ${peer.label} answered HTTP ${String(response.status)}: ${text.slice(0, 500)}`,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isRefusedError(cause)
              ? cause
              : new A2ADeliveryTransportError({ operation: "deliver to peer", cause }),
          ),
        ),
      deliverHuman: (input) =>
        input.envelopeChannel === "lifecycle_notice"
          ? Effect.gen(function* () {
              const terminal = yield* sql`SELECT 1 FROM j5_a2a_human_inbox
                WHERE person_id = ${input.receiverId} AND project_id = ${input.originProjectId}
                  AND exchange_id = ${input.exchangeId} AND status = 'dropped'
                  AND terminal_notice_message_id = ${input.messageId}`;
              if (terminal.length !== 1)
                return yield* new A2ADeliveryTransportError({
                  operation: "deliver human lifecycle notice",
                  cause: "Terminal human inbox notice is not projected.",
                });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new A2ADeliveryTransportError({
                    operation: "deliver human lifecycle notice",
                    cause,
                  }),
              ),
            )
          : Effect.gen(function* () {
              yield* sql`
            INSERT INTO j5_a2a_human_inbox_data (
              origin_project_id,
              message_id,
              exchange_id,
              sender_id,
              receiver_id,
              payload,
              created_at
            ) VALUES (
              ${input.originProjectId},
              ${input.messageId},
              ${input.exchangeId},
              ${input.senderId},
              ${input.receiverId},
              ${input.message},
              ${input.createdAt}
            )
            ON CONFLICT(origin_project_id, message_id) DO NOTHING
          `;
              if (input.exchangeId === null) return;
              const exchanges = yield* sql<HumanExchangeRow>`
            SELECT sender_id, receiver_id, status, intent, urgency, opened_seq, created_at
            FROM j5_a2a_exchange
            WHERE project_id = ${input.originProjectId}
              AND exchange_id = ${input.exchangeId}
              AND receiver_id = ${input.receiverId}
            LIMIT 1
          `;
              const exchange = exchanges[0];
              if (exchange === undefined || exchange.urgency === null) {
                return yield* new A2ADeliveryTargetError({
                  participantId: input.receiverId,
                  state: "person-addressed exchange disappeared before inbox projection",
                });
              }
              // A follow-up may still be pending when the person answers or
              // lifecycle closure drops the exchange. The raw peer message is
              // durable above, but a discharged obligation has no active inbox
              // row to update and is a successful projection no-op.
              if (exchange.status !== "open") return;
              yield* sql`
            INSERT INTO j5_a2a_human_inbox (
              person_id,
              project_id,
              exchange_id,
              sender_id,
              intent,
              urgency,
              latest_message_id,
              latest_message,
              opened_seq,
              opened_at,
              status,
              terminal_seq,
              terminal_at,
              terminal_disposition,
              terminal_cause,
              terminal_facts,
              terminal_notice_message_id
            ) VALUES (
              ${input.receiverId},
              ${input.originProjectId},
              ${input.exchangeId},
              ${exchange.sender_id},
              ${exchange.intent},
              ${exchange.urgency},
              ${input.messageId},
              ${input.message},
              ${exchange.opened_seq},
              ${exchange.created_at},
              'open',
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL
            )
            ON CONFLICT(person_id, project_id, exchange_id) DO UPDATE SET
              latest_message_id = excluded.latest_message_id,
              latest_message = excluded.latest_message
            WHERE j5_a2a_human_inbox.status = 'open'
          `;
            }).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) => new A2ADeliveryTransportError({ operation: "deliver human", cause }),
              ),
            ),
    });
  }),
);
