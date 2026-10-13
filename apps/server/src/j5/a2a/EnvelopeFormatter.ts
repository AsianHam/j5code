import config from "./envelopes.v1.json" with { type: "json" };

import type { LedgerProjectId, ExchangeId, ParticipantId } from "./contracts.ts";

export const A2A_ENVELOPE_VERSION = config.version;
export const A2A_SEND_TOOL_DESCRIPTION = config.sendToolDescription;
export const A2A_LIST_TOOL_DESCRIPTION = config.listToolDescription;
export const A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION = config.clearOwnAskToolDescription;

const render = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{([^{}]+)\}\}/g, (placeholder, name: string) => values[name] ?? placeholder);

/**
 * How a header names the sender's project: its id, with the title beside it when this server
 * knows one. The title is kept on the header's one line and clear of its closing bracket.
 */
const originLabel = (input: {
  readonly originProjectId: LedgerProjectId;
  readonly originProjectTitle?: string | undefined;
}) => {
  const title = input.originProjectTitle?.replace(/[\]\s]+/g, " ").trim() ?? "";
  return title.length === 0 ? input.originProjectId : `${input.originProjectId} (${title})`;
};

const deliveryInstruction = (input: {
  readonly senderId: ParticipantId;
  readonly exchangeId: ExchangeId | null;
}) =>
  input.exchangeId === null
    ? config.oneShotInstruction
    : render(config.replyInstruction, {
        senderId: input.senderId,
        exchangeId: input.exchangeId,
      });

/** A sender on a peer server is named with the server it lives on; a local sender's line is unchanged. */
const senderServer = (serverName: string | undefined) =>
  serverName === undefined ? "" : render(config.senderServer, { serverName });

export const formatPeerEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originProjectId: LedgerProjectId;
  readonly originProjectTitle?: string | undefined;
  readonly exchangeId: ExchangeId | null;
  readonly message: string;
  readonly senderServerName?: string;
}): string =>
  render(config.peerMessage, {
    senderId: input.senderId,
    origin: originLabel(input),
    senderServer: senderServer(input.senderServerName),
    message: input.message,
    exchangeInstruction: deliveryInstruction(input),
  });

/** A machine sender never opens an exchange, so its envelope carries no reply instruction. */
export const formatMachineEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originProjectId: LedgerProjectId;
  readonly originProjectTitle?: string | undefined;
  readonly message: string;
}): string =>
  render(config.machineMessage, {
    senderId: input.senderId,
    origin: originLabel(input),
    message: input.message,
    machineInstruction: config.machineInstruction,
  });

/**
 * An outside agent is named by the label its client signed in with, kept on the header's one
 * line and clear of its closing bracket. It has no project, so the header names none.
 */
export const formatOutsideAgentEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly senderName?: string | undefined;
  readonly message: string;
}): string => {
  const name = input.senderName?.replace(/[\]\s]+/g, " ").trim() ?? "";
  return render(config.outsideAgentMessage, {
    senderName: name.length === 0 ? "unnamed" : name,
    senderId: input.senderId,
    message: input.message,
    outsideAgentInstruction: config.outsideAgentInstruction,
  });
};

export const formatClosedPeerEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originProjectId: LedgerProjectId;
  readonly originProjectTitle?: string | undefined;
  readonly message: string;
  readonly senderServerName?: string;
}): string =>
  render(config.peerClosedMessage, {
    senderId: input.senderId,
    origin: originLabel(input),
    senderServer: senderServer(input.senderServerName),
    message: input.message,
    closedExchangeInstruction: config.closedExchangeInstruction,
  });

/** A person's only ledger message is the inbox answer that closes an exchange. */
/**
 * A person's reply from the inbox to an agent's ask. With a name on record for the person the
 * header says it, with the id after it as the outside-agent header has it:
 * `[Message from Jackson (human:…)]`. In a shared conversation the label also says where the
 * person stands, as the author line of a message typed in the thread does:
 * `[Message from Jackson (member) (human:…)]`. With no name on record the header is the id
 * alone, as it has always been.
 */
export const formatClosedHumanEnvelope = (input: {
  readonly senderId: ParticipantId;
  /** `Jackson`, or `Jackson (member)` in a shared conversation; already fit for one line. */
  readonly senderLabel?: string | undefined;
  readonly message: string;
}): string => {
  const label = input.senderLabel?.replace(/[\]\s]+/g, " ").trim() ?? "";
  return label.length === 0
    ? render(config.humanClosedMessage, {
        senderId: input.senderId,
        message: input.message,
        closedExchangeInstruction: config.closedExchangeInstruction,
      })
    : render(config.humanNamedClosedMessage, {
        senderLabel: label,
        senderId: input.senderId,
        message: input.message,
        closedExchangeInstruction: config.closedExchangeInstruction,
      });
};

/** A3 supplies notice derivation; A2 owns this channel's stable rendering shape. */
export const formatSilenceNoticeEnvelope = (input: {
  readonly noticeType: string;
  readonly message: string;
}): string =>
  render(config.silenceNotice, {
    noticeType: input.noticeType,
    message: input.message,
  });

/** Told to a sender whose message will wait behind the receiver's running turn. */
export const formatReceiverBacklogNotice = (input: {
  readonly receiverId: ParticipantId;
  readonly waiting: number;
  readonly fromYou: number;
}): string =>
  render(config.receiverBacklogNotice, {
    receiverId: input.receiverId,
    waiting: String(input.waiting),
    fromYou: String(input.fromYou),
  });
