import { ChatAttachment, ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { PeerSenderLabel } from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isNonEmpty());
const ProjectTitle = Schema.String.check(
  Schema.makeFilter((name) => name.trim().length > 0 || "A project title must not be blank."),
);
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const LedgerProjectId = Identifier.pipe(Schema.brand("J5A2ALedgerProjectId"));
export type LedgerProjectId = typeof LedgerProjectId.Type;

export const ExchangeId = Identifier.pipe(Schema.brand("J5A2AExchangeId"));
export type ExchangeId = typeof ExchangeId.Type;

export const CorrelationId = Identifier.pipe(Schema.brand("J5A2ACorrelationId"));
export type CorrelationId = typeof CorrelationId.Type;

export const ParticipantId = Identifier.pipe(Schema.brand("J5A2AParticipantId"));
export type ParticipantId = typeof ParticipantId.Type;

export const CommCommandId = Identifier.pipe(Schema.brand("J5A2ACommCommandId"));
export type CommCommandId = typeof CommCommandId.Type;

export const LedgerMessageId = Identifier.pipe(Schema.brand("J5A2ALedgerMessageId"));
export type LedgerMessageId = typeof LedgerMessageId.Type;

export const Urgency = Schema.Literals(["blocking", "soon", "fyi"]);
export type Urgency = typeof Urgency.Type;

/**
 * How a sender asks for its message to land on an agent, in upstream's words: `queue` is J5's
 * ordinary delivery (after the receiver's turn ends, or into it for the models D4 excepts),
 * `steer` joins the running turn, and `restart` interrupts the turn and restarts it with the
 * message. Upstream's `auto` is left out: it steers whenever it can.
 */
export const SendMode = Schema.Literals(["queue", "steer", "restart"]);
export type SendMode = typeof SendMode.Type;

/**
 * The broadest modes a sender could touch when it asked for a steer or a restart. Delivery is
 * later than the send, and the receiver's modes can be raised in between, so the limit is kept
 * with the message and upstream checks it again when the message is dispatched.
 */
export const SendModeLimit = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});

export const DeliveryEnvelopeChannel = Schema.Literals([
  "peer",
  "silence_notice",
  "lifecycle_notice",
]);
export type DeliveryEnvelopeChannel = typeof DeliveryEnvelopeChannel.Type;

export const SILENCE_DETECTOR_PARTICIPANT_ID = ParticipantId.make("platform:silence-detector");
export const LIFECYCLE_PARTICIPANT_ID = ParticipantId.make("platform:lifecycle");

export const isHumanParticipantId = (id: ParticipantId): boolean =>
  id.startsWith("human:") && id.length > "human:".length;

export const isDurableHumanParticipantId = (id: ParticipantId): boolean =>
  isHumanParticipantId(id) && id !== "human:global";

export const MACHINE_PARTICIPANT_ID_PREFIX = "machine:";
export const isMachineParticipantId = (id: ParticipantId): boolean =>
  id.startsWith(MACHINE_PARTICIPANT_ID_PREFIX) && id.length > MACHINE_PARTICIPANT_ID_PREFIX.length;
export const isPlatformParticipantId = (id: string): boolean => id.startsWith("platform:");
export const machineParticipantIdForName = (name: string) =>
  ParticipantId.make(`${MACHINE_PARTICIPANT_ID_PREFIX}${name}`);

/**
 * An outside agent: an MCP client signed in through OAuth, one participant per sign-in. It has no
 * thread and no project, sends plain messages only, and can never receive. It joins no ledger, so
 * it is not in the `Participant` union; its name is kept in `j5_a2a_outside_agent`.
 */
const OUTSIDE_AGENT_PARTICIPANT_ID_PREFIX = "outside:";
export const isOutsideAgentParticipantId = (id: ParticipantId): boolean =>
  id.startsWith(OUTSIDE_AGENT_PARTICIPANT_ID_PREFIX) &&
  id.length > OUTSIDE_AGENT_PARTICIPANT_ID_PREFIX.length;
export const outsideAgentParticipantId = (sessionId: string) =>
  ParticipantId.make(`${OUTSIDE_AGENT_PARTICIPANT_ID_PREFIX}${sessionId}`);

export const AgentParticipant = Schema.Struct({
  kind: Schema.Literal("agent"),
  id: ParticipantId,
  threadId: ThreadId,
});
export type AgentParticipant = typeof AgentParticipant.Type;

export const HumanParticipant = Schema.Struct({
  kind: Schema.Literal("human"),
  id: ParticipantId.pipe(
    Schema.check(
      Schema.makeFilter(isDurableHumanParticipantId, {
        message: "A human participant id must use the durable human:<person-id> namespace.",
      }),
    ),
  ),
});
export type HumanParticipant = typeof HumanParticipant.Type;

/**
 * A registered non-agent sender (cron job, watchdog, script). It has no thread,
 * sends plain messages only, and can never receive.
 */
export const MachineParticipant = Schema.Struct({
  kind: Schema.Literal("machine"),
  id: ParticipantId.pipe(
    Schema.check(
      Schema.makeFilter(isMachineParticipantId, {
        message: "A machine participant id must use the machine:<name> namespace.",
      }),
    ),
  ),
  name: Schema.String.check(Schema.isNonEmpty()),
});
export type MachineParticipant = typeof MachineParticipant.Type;

export const Participant = Schema.Union([AgentParticipant, HumanParticipant, MachineParticipant]);
export type Participant = typeof Participant.Type;

export const participantId = (participant: Participant): ParticipantId => participant.id;

export const ProjectLedger = Schema.Struct({
  id: LedgerProjectId,
  name: ProjectTitle,
  createdAt: Schema.String,
});
export type ProjectLedger = typeof ProjectLedger.Type;

export const CommEventKind = Schema.Literals([
  "exchange.opened",
  "message.sent",
  "message.received",
  "message.delivered",
  "message.delivery_failed",
  "message.cancelled",
  "exchange.closed",
  "exchange.dropped",
  "silence.notice",
  "participant.joined",
  "participant.left",
  "participant.archived",
  "participant.unarchived",
  "participant.deleted",
]);
export type CommEventKind = typeof CommEventKind.Type;

const NonMembershipEventKind = Schema.Literals([
  "exchange.opened",
  "message.sent",
  "message.delivered",
  "message.delivery_failed",
  "message.cancelled",
  "exchange.closed",
  "exchange.dropped",
  "silence.notice",
]);

const eventAddressFields = {
  sender: Schema.NullOr(ParticipantId),
  receiver: Schema.NullOr(ParticipantId),
  exchangeId: Schema.NullOr(ExchangeId),
  correlationId: Schema.NullOr(CorrelationId),
  createdAt: Schema.String,
} as const;

const NonMembershipCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: NonMembershipEventKind,
  payload: Schema.Json,
});

/**
 * The receiver project's own row for a message another project sent. When the
 * origin is a peer server, `originEnvironmentId` names it and the row is also
 * the fact this server delivers from, since no `message.sent` exists here.
 */
export const MessageReceivedPayload = Schema.Struct({
  originProjectId: LedgerProjectId,
  originEnvironmentId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /** The id and clock the origin used; this ledger keys and stamps the message itself. */
  originMessageId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  originCreatedAt: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /** "none": the row records a fact (a withdrawal) and injects nothing into the receiver's thread. */
  injection: Schema.optional(Schema.Literal("none")),
  /** From a peer delivery: the sender's display name its server sent, read by the client identity lookup and nothing else. */
  senderLabel: Schema.optional(PeerSenderLabel),
  /** From a peer delivery whose sender asked for a steer or a restart, with the sender's limit. */
  mode: Schema.optional(SendMode),
  modeLimit: Schema.optional(SendModeLimit),
  message: Schema.Json,
});
export type MessageReceivedPayload = typeof MessageReceivedPayload.Type;

const MessageReceivedCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: Schema.Literal("message.received"),
  correlationId: CorrelationId,
  payload: MessageReceivedPayload,
});

const ParticipantJoinedCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: Schema.Literal("participant.joined"),
  payload: Schema.Struct({ participant: Participant }),
});

const ParticipantMembershipCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: Schema.Literals([
    "participant.left",
    "participant.archived",
    "participant.unarchived",
    "participant.deleted",
  ]),
  payload: Schema.Struct({ participant: Participant }),
});

export const CommEvent = Schema.Union([
  NonMembershipCommEvent,
  MessageReceivedCommEvent,
  ParticipantJoinedCommEvent,
  ParticipantMembershipCommEvent,
]);
export type CommEvent = typeof CommEvent.Type;

const storedFields = {
  seq: PositiveInt,
  projectId: LedgerProjectId,
} as const;

export const StoredCommEvent = Schema.Union([
  Schema.Struct({ ...storedFields, ...NonMembershipCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...MessageReceivedCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...ParticipantJoinedCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...ParticipantMembershipCommEvent.fields }),
]);
export type StoredCommEvent = typeof StoredCommEvent.Type;

export const EnsureProjectCommand = Schema.Struct({
  projectId: LedgerProjectId,
  createdAt: Schema.String,
});
export type EnsureProjectCommand = typeof EnsureProjectCommand.Type;

export const AppendCommEventCommand = Schema.Struct({
  commandId: CommCommandId,
  projectId: LedgerProjectId,
  acceptedAt: Schema.String,
  event: CommEvent,
});
export type AppendCommEventCommand = typeof AppendCommEventCommand.Type;

export const CommCommandReceipt = Schema.Struct({
  commandId: CommCommandId,
  projectId: LedgerProjectId,
  commandType: Schema.Literal("comm.append"),
  acceptedAt: Schema.String,
  resultSeq: PositiveInt,
});
export type CommCommandReceipt = typeof CommCommandReceipt.Type;

export const AppendCommEventsCommand = Schema.Struct({
  commandId: CommCommandId,
  projectId: LedgerProjectId,
  acceptedAt: Schema.String,
  events: Schema.Array(CommEvent).pipe(Schema.check(Schema.isMinLength(1))),
});
export type AppendCommEventsCommand = typeof AppendCommEventsCommand.Type;

export const ExchangeOpenedPayload = Schema.Struct({
  intent: Schema.String.check(Schema.isNonEmpty()),
  urgency: Schema.NullOr(Urgency),
});
export type ExchangeOpenedPayload = typeof ExchangeOpenedPayload.Type;

/**
 * Why an Exchange ended, as a terminal notice carries it to the other party. A fact that came
 * from a peer server names that server's project.
 */
export const TerminalFact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dropped"),
    cause: Schema.Struct({
      kind: Schema.Literals(["participant-archived", "participant-deleted"]),
      participantId: Schema.String,
      projectId: Schema.String,
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("sender-cleared") }),
]);
export type TerminalFact = typeof TerminalFact.Type;

export const MessageSentPayload = Schema.Struct({
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  /** How the sender asked for the message to land; absent means `queue`. */
  mode: Schema.optional(SendMode),
  modeLimit: Schema.optional(SendModeLimit),
  /** Present on a terminal notice headed to a peer server: the fact it carries, fixed when the notice is written. */
  terminal: Schema.optional(TerminalFact),
  messageId: LedgerMessageId,
  text: Schema.String.check(Schema.isNonEmpty()),
  originProjectId: LedgerProjectId,
  receiverProjectId: LedgerProjectId,
  /** Present when the receiver's project lives on a peer server. */
  receiverEnvironmentId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  exchangeRole: Schema.Literals(["none", "ask", "followup", "reply", "terminal_notice"]),
  envelopeChannel: DeliveryEnvelopeChannel,
});
export type MessageSentPayload = typeof MessageSentPayload.Type;

export const MessageDeliveredPayload = Schema.Struct({
  messageId: LedgerMessageId,
  attempt: PositiveInt,
  channel: Schema.Literals(["agent", "human"]),
});
export type MessageDeliveredPayload = typeof MessageDeliveredPayload.Type;

export const MessageDeliveryFailedPayload = Schema.Struct({
  messageId: LedgerMessageId,
  attempt: PositiveInt,
  error: Schema.String.check(Schema.isNonEmpty()),
  nextAttemptAt: Schema.NullOr(Schema.String),
  alarmed: Schema.Boolean,
});
export type MessageDeliveryFailedPayload = typeof MessageDeliveryFailedPayload.Type;

export const ExchangeClosedPayload = Schema.Union([
  Schema.Struct({ replyMessageId: LedgerMessageId }),
  Schema.Struct({ closureKind: Schema.Literal("sender-cleared") }),
]);
export type ExchangeClosedPayload = typeof ExchangeClosedPayload.Type;

export const ExchangeDropDisposition = Schema.Literals(["receiver-retired", "sender-retired"]);
export type ExchangeDropDisposition = typeof ExchangeDropDisposition.Type;

export const ExchangeDroppedPayload = Schema.Struct({
  disposition: ExchangeDropDisposition,
  /**
   * What ended it, and the party it was about. A peer server's refusal of the
   * ask, or the removal of the peer, names the party on that server.
   */
  cause: Schema.Struct({
    kind: Schema.Literals([
      "participant-archived",
      "participant-deleted",
      "delivery-refused",
      "peer-removed",
    ]),
    participantId: ParticipantId,
    projectId: LedgerProjectId,
  }),
  facts: Schema.Struct({
    replyRequired: Schema.Literal(false),
    retryAllowed: Schema.Literal(false),
    replacementRequired: Schema.Literal(false),
  }),
  noticeMessageId: LedgerMessageId,
});
export type ExchangeDroppedPayload = typeof ExchangeDroppedPayload.Type;

export const ClearOwnAskInput = Schema.Struct({
  commandId: CommCommandId,
  senderThreadId: ThreadId,
  exchangeId: ExchangeId,
  acceptedAt: Schema.String,
});
export type ClearOwnAskInput = typeof ClearOwnAskInput.Type;

export const ClearOwnAskResult = Schema.Struct({
  exchangeId: ExchangeId,
  closureKind: Schema.Literal("sender-cleared"),
  closedAt: Schema.String,
});
export type ClearOwnAskResult = typeof ClearOwnAskResult.Type;

export const SendMessageInput = Schema.Struct({
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  mode: Schema.optional(SendMode),
  modeLimit: Schema.optional(SendModeLimit),
  commandId: CommCommandId,
  senderThreadId: ThreadId,
  to: ParticipantId,
  message: Schema.String.check(Schema.isNonEmpty()),
  expectReply: Schema.optional(Schema.Boolean),
  exchangeId: Schema.optional(ExchangeId),
  intent: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  urgency: Schema.optional(Urgency),
  acceptedAt: Schema.String,
});
export type SendMessageInput = typeof SendMessageInput.Type;

/** A machine sender commits a plain message only: no ask, no reply, no urgency. */
export const SendAsMachineInput = Schema.Struct({
  commandId: CommCommandId,
  senderParticipantId: ParticipantId,
  to: ParticipantId,
  message: Schema.String.check(Schema.isNonEmpty()),
  acceptedAt: Schema.String,
});
export type SendAsMachineInput = typeof SendAsMachineInput.Type;

/** An outside agent commits a plain message only, to an agent on this server. */
export const SendAsOutsideAgentInput = Schema.Struct({
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  mode: Schema.optional(SendMode),
  modeLimit: Schema.optional(SendModeLimit),
  commandId: CommCommandId,
  senderParticipantId: ParticipantId,
  /** The label the client signed in with; kept so the envelope can name the sender. */
  senderName: Schema.String,
  to: ParticipantId,
  /** The receiver's project, from `outsideAgentReceiver`: where the message is recorded. */
  receiverProjectId: LedgerProjectId,
  message: Schema.String.check(Schema.isNonEmpty()),
  acceptedAt: Schema.String,
});
export type SendAsOutsideAgentInput = typeof SendAsOutsideAgentInput.Type;

export const SendMessageResult = Schema.Struct({
  messageId: LedgerMessageId,
  exchangeId: Schema.NullOr(ExchangeId),
  exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
  joinedExistingExchange: Schema.Boolean,
  durableAtSeq: PositiveInt,
  /** Present when the receiver is busy and the message will wait behind its running turn. */
  deliveryNotice: Schema.optional(Schema.String),
  /** The name of the peer server the receiver lives on; absent for a receiver on this server. */
  receiverServer: Schema.optionalKey(Schema.String),
  /** Present when the receiver's server polls this one and is offline: the message waits for it. */
  delivery: Schema.optionalKey(Schema.Literal("waiting_for_recipient")),
  /** When that server was last available: its last poll. */
  recipientLastAvailableAt: Schema.optionalKey(Schema.String),
  /** The same facts in one sentence an agent reads at a glance. */
  note: Schema.optionalKey(Schema.String),
});
export type SendMessageResult = typeof SendMessageResult.Type;

export const ParticipantDirectoryRow = Schema.Struct({
  projectId: LedgerProjectId,
  participantId: ParticipantId,
  participant: Participant,
  archived: Schema.Boolean,
  canReceiveMessage: Schema.Boolean,
  canOpenExchange: Schema.Boolean,
  acceptsUrgency: Schema.Boolean,
  /** A person's name, once the server has recorded one for them. */
  displayName: Schema.optionalKey(Schema.String),
});
export type ParticipantDirectoryRow = typeof ParticipantDirectoryRow.Type;

export const DeliveryAlarm = Schema.Struct({
  projectId: LedgerProjectId,
  messageId: LedgerMessageId,
  attempts: PositiveInt,
  lastError: Schema.String,
});
export type DeliveryAlarm = typeof DeliveryAlarm.Type;

export const DeliveryMilestone = Schema.Struct({
  projectId: LedgerProjectId,
  messageId: LedgerMessageId,
  state: Schema.Literals(["delivered", "retry_scheduled", "alarmed", "cancelled"]),
  attempt: PositiveInt,
});
export type DeliveryMilestone = typeof DeliveryMilestone.Type;

export const LedgerCursor = Schema.Struct({
  afterSeq: NonNegativeInt,
  snapshotEnd: Schema.optional(NonNegativeInt),
});
export type LedgerCursor = typeof LedgerCursor.Type;

/**
 * `snapshotEnd` freezes one finite read batch. Reaching it does not mean the
 * caller is caught up to events committed after that snapshot was captured.
 */
export const CommEventPage = Schema.Struct({
  events: Schema.Array(StoredCommEvent),
  nextCursor: Schema.Struct({
    afterSeq: NonNegativeInt,
    snapshotEnd: NonNegativeInt,
  }),
  complete: Schema.Boolean,
});
export type CommEventPage = typeof CommEventPage.Type;

export const Membership = Schema.Struct({
  projectId: LedgerProjectId,
  participant: Participant,
  joinedSeq: PositiveInt,
  updatedSeq: PositiveInt,
});
export type Membership = typeof Membership.Type;

export const HumanInboxItem = Schema.Struct({
  personId: ParticipantId,
  projectId: LedgerProjectId,
  projectTitle: Schema.String,
  exchangeId: ExchangeId,
  senderId: ParticipantId,
  senderThreadId: Schema.NullOr(ThreadId),
  intent: Schema.String,
  urgency: Urgency,
  message: Schema.String,
  openedAt: Schema.String,
  status: Schema.Literals(["open", "answered"]),
  terminalAt: Schema.NullOr(Schema.String),
});
export type HumanInboxItem = typeof HumanInboxItem.Type;

export const HumanInboxListStatus = Schema.Literals(["open", "answered"]);
export type HumanInboxListStatus = typeof HumanInboxListStatus.Type;

export const AnswerHumanExchangeInput = Schema.Struct({
  commandId: CommCommandId,
  personId: ParticipantId,
  exchangeId: ExchangeId,
  message: Schema.String.check(Schema.isNonEmpty()),
  acceptedAt: Schema.String,
});
export type AnswerHumanExchangeInput = typeof AnswerHumanExchangeInput.Type;

export const ArchiveParticipantInput = Schema.Struct({
  participantId: ParticipantId,
  archivedAt: Schema.String,
});
export type ArchiveParticipantInput = typeof ArchiveParticipantInput.Type;

export const LifecycleArchiveResult = Schema.Struct({
  archived: Schema.Boolean,
  droppedExchangeIds: Schema.Array(ExchangeId),
});
export type LifecycleArchiveResult = typeof LifecycleArchiveResult.Type;
