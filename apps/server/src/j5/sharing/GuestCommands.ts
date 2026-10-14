import type { OrchestrationV2Command } from "@t3tools/contracts";

/**
 * The commands a guest holding Collaborate on a thread may send through
 * `orchestration.dispatchCommand` (Shared server AC13, AC14; Shared conversations AC14 to AC16).
 * Refuse by default: a command type that is not named here is refused, so nothing upstream adds
 * later is open to a guest until it is listed. Each allowed command is rebuilt from the fields
 * named for it, so a field that is not named never reaches upstream from a guest.
 */

type CommandType = OrchestrationV2Command["type"];
type CommandOf<T extends CommandType> = Extract<OrchestrationV2Command, { readonly type: T }>;

/** Keyed by command type so that a type upstream renames or removes fails to compile here. */
export const GUEST_COMMAND_TYPES = {
  // Sends a message: it starts the agent when it is idle and queues when it is not.
  "message.dispatch": true,
  // Changes or withdraws a queued message of the guest's own.
  "queued-run.edit": true,
  "queued-run.cancel": true,
  // Answers the agent's approval and question prompts.
  "runtime-request.respond": true,
  "thread.user-input.dismiss": true,
} as const satisfies Partial<Record<CommandType, true>>;

export type GuestCommandType = keyof typeof GUEST_COMMAND_TYPES;
export type GuestCommand = CommandOf<GuestCommandType>;

const isGuestCommandType = (type: unknown): type is GuestCommandType =>
  typeof type === "string" && Object.hasOwn(GUEST_COMMAND_TYPES, type);

/**
 * The thread a guest's command is for, read from the command's own `threadId`; `undefined` for a
 * command a guest may not send at all. Every command on the list names exactly one thread there.
 */
export const guestCommandThreadId = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { type, threadId } = payload as { readonly type?: unknown; readonly threadId?: unknown };
  return isGuestCommandType(type) && typeof threadId === "string" && threadId.length > 0
    ? threadId
    : undefined;
};

/**
 * What a guest may answer an approval prompt with: this one request, yes or no. Accepting for
 * the session or for good changes what the agent may do after the prompt, which stays with
 * members as the thread's access mode does.
 */
const GUEST_DECISIONS: ReadonlySet<string> = new Set(["accept", "decline", "cancel"]);

/**
 * What a guest's message may not carry, because each would make the message someone else's:
 * another sender, a scheduled task, a notification, or a continuation of someone's run. These
 * are not limits on what a guest may say.
 */
const MESSAGE_FIELDS_REFUSED = [
  "notification",
  "scheduledTaskId",
  "senderThreadId",
  "delegatedCompletion",
  "restartContinuationOfRunId",
  "usageLimitContinuationOfRunId",
  "manualContinuationOfRunId",
  "usageLimitRecoveryRequestId",
] as const satisfies ReadonlyArray<keyof CommandOf<"message.dispatch">>;

type MessageContext = NonNullable<CommandOf<"message.dispatch">["context"]>;

/** A kind of composer context the platform keeps for records of its own. */
const isPlatformKind = (kind: string) => kind.trim().toLowerCase().startsWith("j5");

/**
 * Why a guest's composer context is refused, or `null` when it may go on. A guest's message
 * carries what a member's does (mentions, terminal output, picked elements, review comments,
 * skills, other threads) and names a plan to build from, with two exceptions. A record that names a stored attachment is
 * refused with attachments themselves: upstream passes a stored attachment's id through
 * unchecked, so a guest could name one from a thread it cannot read. And a kind the platform
 * keeps for itself is not a guest's to send.
 */
const contextRefusal = (context: MessageContext | undefined): string | null => {
  for (const record of context?.records ?? []) {
    if (isPlatformKind(record.kind)) return "A guest's message cannot carry that.";
    if (record.kind === "image" || record.kind === "file" || "attachmentId" in record) {
      return "A guest cannot send attachments yet.";
    }
  }
  return null;
};

/** The other threads a guest's command attaches for the agent to read: named, not opened. */
export const threadsNamedBy = (command: GuestCommand): ReadonlyArray<string> =>
  command.type !== "message.dispatch" && command.type !== "queued-run.edit"
    ? []
    : (command.context?.records ?? []).flatMap((record) =>
        record.kind === "thread" && "threadId" in record ? [record.threadId] : [],
      );

/**
 * The thread whose plan a guest's message asks the agent to build from. Upstream does not only
 * read that plan: it marks it completed, on the plan's own thread. So this is a thread the
 * guest writes to, not one it merely reads.
 */
export const planThreadOf = (command: GuestCommand): string | undefined =>
  command.type === "message.dispatch" ? command.sourcePlanRef?.threadId : undefined;

const carriesAttachments = (command: {
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}) => (command.attachments?.length ?? 0) > 0;

export type GuestCommandDecision =
  | { readonly allowed: true; readonly command: GuestCommand }
  | { readonly allowed: false; readonly reason: string };

const refuse = (reason: string): GuestCommandDecision => ({ allowed: false, reason });

/**
 * A guest's command as it goes on to upstream, or why it does not. What a guest's client sends
 * as a matter of course and may not decide is left out without complaint: the model, the title,
 * and how the message is delivered, which for a guest is always "start if idle, else queue"
 * (upstream's `queue_after_active`), never a steer or a restart. What only a tampered client
 * would send is refused.
 */
export const guestCommand = (command: OrchestrationV2Command): GuestCommandDecision => {
  switch (command.type) {
    case "message.dispatch": {
      const carried = MESSAGE_FIELDS_REFUSED.find((name) => command[name] !== undefined);
      if (carried !== undefined) return refuse("A guest's message cannot carry that.");
      // An attachment id already stored passes through upstream unchecked, so a guest could name
      // one from a thread it cannot read.
      if (carriesAttachments(command)) return refuse("A guest cannot send attachments yet.");
      const contextRefused = contextRefusal(command.context);
      if (contextRefused !== null) return refuse(contextRefused);
      return {
        allowed: true,
        command: {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: command.threadId,
          messageId: command.messageId,
          text: command.text,
          attachments: [],
          ...(command.context === undefined ? {} : { context: command.context }),
          ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
          createdBy: "user",
          creationSource: command.creationSource === "mobile" ? "mobile" : "web",
          dispatchMode: { type: "queue_after_active" },
        },
      };
    }
    case "queued-run.edit": {
      if (carriesAttachments(command)) return refuse("A guest cannot send attachments yet.");
      const contextRefused = contextRefusal(command.context);
      if (contextRefused !== null) return refuse(contextRefused);
      return {
        allowed: true,
        command: {
          type: "queued-run.edit",
          commandId: command.commandId,
          threadId: command.threadId,
          runId: command.runId,
          text: command.text,
          ...(command.context === undefined ? {} : { context: command.context }),
        },
      };
    }
    case "queued-run.cancel":
      return {
        allowed: true,
        command: {
          type: "queued-run.cancel",
          commandId: command.commandId,
          threadId: command.threadId,
          runId: command.runId,
        },
      };
    case "runtime-request.respond":
      if (command.attachmentsByQuestionId !== undefined) {
        return refuse("A guest can answer in text only: no attachments.");
      }
      // An answer is words, or a choice of options: what the server can put its author on.
      if (
        command.answers !== undefined &&
        !Object.values(command.answers).every(
          (answer) =>
            typeof answer === "string" ||
            (Array.isArray(answer) && answer.every((value) => typeof value === "string")),
        )
      ) {
        return refuse("A guest answers a question in text.");
      }
      // One or the other: upstream takes a response that carries neither, or both.
      if ((command.decision === undefined) === (command.answers === undefined)) {
        return refuse("A guest answers a prompt with a decision or with words, not both.");
      }
      if (command.decision !== undefined && !GUEST_DECISIONS.has(command.decision)) {
        return refuse("A guest can approve or decline this one request; a member decides more.");
      }
      return {
        allowed: true,
        command: {
          type: "runtime-request.respond",
          commandId: command.commandId,
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.decision === undefined ? {} : { decision: command.decision }),
          ...(command.answers === undefined ? {} : { answers: command.answers }),
        },
      };
    case "thread.user-input.dismiss":
      return {
        allowed: true,
        command: {
          type: "thread.user-input.dismiss",
          commandId: command.commandId,
          threadId: command.threadId,
          requestId: command.requestId,
        },
      };
    default:
      return refuse("A guest cannot do that on a shared thread.");
  }
};
