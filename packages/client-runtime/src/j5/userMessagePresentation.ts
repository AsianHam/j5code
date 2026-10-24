import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ScheduledTaskId,
} from "@t3tools/contracts";

import { resolveUserMessagePresentation } from "../userMessage.ts";
import { participantIdsForCrewNotice, presentCrewNotice } from "./crewNotices.ts";

/**
 * How J5 shows a user-role message in a thread's timeline, grouped by who is speaking
 * (docs/j5/product/features/thread-a2a-rendering.md). Web and mobile both read this, so neither
 * keeps a parser of its own for J5's message ids and envelopes.
 */
export interface J5UserMessageInput {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
}

/** What a message asks of its reader, in the Inbox's words. */
export type J5ParticipantBadge = "expects-reply" | "replied";
/** Said of a sender that is not an agent in this app, or of a spawner's brief. */
export type J5ParticipantTag = "automation" | "outside-agent" | "brief";

export type J5NoticeKind =
  | "silence"
  | "crew-gate"
  | "crew-seats"
  | "restart-continuation"
  | "pr-watch"
  | "platform";
export type J5PromptKind = "automation" | "delegated-question" | "compaction";

export type J5UserMessagePresentation =
  | {
      /** Group 1: the person reading, on the right. */
      readonly group: "person";
      readonly side: "right";
      /** An Inbox reply's words without its envelope; any other message as stored. */
      readonly text: string;
      /** A reply sent from the Inbox, rather than typed in this thread. */
      readonly viaInbox: boolean;
      /** J5 took `text` out of an envelope: literal words, never composer context. */
      readonly unwrapped: boolean;
    }
  | {
      /**
       * Group 2: someone else, on the left. Only an Inbox reply says who sent it; a message
       * another person typed in a shared conversation is placed by that conversation's record.
       */
      readonly group: "other-person";
      readonly side: "left";
      readonly text: string;
      readonly viaInbox: true;
      readonly unwrapped: true;
      readonly senderId: string;
      /** The name the reply came with; null for a reply that carries only the id. */
      readonly senderName: string | null;
    }
  | {
      /** Group 3: an agent, machine, outside agent, peer or spawner, folded on the left. */
      readonly group: "participant";
      readonly side: "left";
      /** The letter, without the envelope's header and footer instruction. */
      readonly text: string;
      /** The letter's first non-empty line, as raw as the letter. */
      readonly preview: string;
      /** Null for a message upstream wrote, which names no J5 participant. */
      readonly senderId: string | null;
      /** A spawner's thread, which a brief names in its facts rather than on the message. */
      readonly senderThreadId: string | null;
      readonly badge: J5ParticipantBadge | null;
      readonly tag: J5ParticipantTag | null;
      readonly unwrapped: boolean;
    }
  | {
      /** Group 4: a platform notice. */
      readonly group: "notice";
      readonly side: "left";
      readonly kind: J5NoticeKind;
      /** One plain line, where J5 can say it; null where the notice has not been read yet. */
      readonly summary: string | null;
      readonly text: string;
    }
  | {
      /** Group 5: a platform prompt. */
      readonly group: "prompt";
      readonly side: "left";
      readonly kind: J5PromptKind;
      readonly text: string;
    };

/**
 * `deliveryMessageId` in the server A2A transport is deliberately stable across retries. This
 * exact prefix and a user role are the only gate; envelope-looking text alone is never A2A.
 */
export const J5_A2A_DELIVERY_MESSAGE_PREFIX = "message:j5:a2a:delivery:";

/**
 * `j5_spawn_agent` starts a Peer Agent's thread with one user-role message whose id is
 * `message:j5:a2a:mcp:<session>:spawn-brief:<request key>` (server `spawnMessageId`). The id
 * shape is the only gate; envelope-looking text alone is never a spawn brief.
 */
const SPAWN_BRIEF_MESSAGE_ID_PATTERN = /^message:j5:a2a:mcp:[^:]+:spawn-brief:/;

export const isJ5DeliveryMessage = (message: J5UserMessageInput) =>
  message.role === "user" && String(message.id ?? "").startsWith(J5_A2A_DELIVERY_MESSAGE_PREFIX);

export const isJ5SpawnBriefMessage = (message: J5UserMessageInput) =>
  message.role === "user" && SPAWN_BRIEF_MESSAGE_ID_PATTERN.test(String(message.id ?? ""));

// J5's tools gained a `j5_` prefix on 2026-10-10 (#508). Stored deliveries keep the name they
// were written with, so both are accepted.
const SEND_TOOL_NAMES = ["j5_send_message", "send_message"] as const;

// The footer of a plain message said "No reply is required." until 2026-10-12 (#566). Stored
// deliveries keep the sentence they were written with, so both are recognised. The newer one was
// never written with the older tool name.
const PLAIN_DELIVERY_INSTRUCTIONS = new Set([
  "The sender did not request a reply to this message. Use j5_send_message without exchange_id only if a new message is needed.",
  ...SEND_TOOL_NAMES.map(
    (tool) =>
      `No reply is required. Use ${tool} without exchange_id only if a new message is needed.`,
  ),
]);
const CLOSED_DELIVERY_INSTRUCTION =
  "The platform closed this exchange when this reply was sent. No further reply is required.";
const REPLY_DELIVERY_INSTRUCTION_SUFFIX =
  '", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.';
const HUMAN_DELIVERY_MARKER =
  "\n\nThis person is not watching this chat. They see only what you send back on this exchange.\n\n";
const SILENCE_DELIVERY_SUFFIX =
  "\n\nThis is a platform-authored delivery signal, not a peer reply.";
const MACHINE_DELIVERY_INSTRUCTIONS = new Set(
  SEND_TOOL_NAMES.map(
    (tool) =>
      `This message came from an automated sender outside any agent session. It cannot receive a reply; act on it directly, and take any question to a person or a peer agent with ${tool}.`,
  ),
);
// Added after the `j5_` prefix, so no stored delivery names the older tool.
const OUTSIDE_AGENT_DELIVERY_INSTRUCTION =
  "This message came from an outside agent: one that runs outside this app. You cannot reply to it with j5_send_message.";

type Exchange = "expects-reply" | "plain" | "closed";

function parseKnownInstruction(input: {
  readonly senderId: string;
  readonly instruction: string;
}): { readonly exchange: Exchange } | null {
  if (PLAIN_DELIVERY_INSTRUCTIONS.has(input.instruction)) return { exchange: "plain" };
  if (input.instruction === CLOSED_DELIVERY_INSTRUCTION) return { exchange: "closed" };

  const replyPrefix = SEND_TOOL_NAMES.map(
    (tool) => `Reply once with ${tool}(to="${input.senderId}", exchange_id="`,
  ).find((prefix) => input.instruction.startsWith(prefix));
  if (replyPrefix === undefined) return null;
  const exchangeIdAndSuffix = input.instruction.slice(replyPrefix.length);
  const separatorIndex = exchangeIdAndSuffix.indexOf(REPLY_DELIVERY_INSTRUCTION_SUFFIX);
  if (separatorIndex <= 0) return null;
  const rest = exchangeIdAndSuffix.slice(separatorIndex + REPLY_DELIVERY_INSTRUCTION_SUFFIX.length);
  return rest.length === 0 ? { exchange: "expects-reply" } : null;
}

// A header names the sender and where it works. Messages stored before Squadrons were retired
// say "in squadron <id>"; newer ones say "in project <id>" with the project's title after it,
// and a sender on a peer server adds ", on <server>". Stored history keeps the old wording, so
// both are read. The sender group is lazy because a project title may itself contain
// " in project ".
const ENVELOPE_ORIGIN = "in (?:project|squadron) [^\\]\\n]+";
const PEER_HEADER = new RegExp(
  `^\\[Cross-agent message from ([^\\]\\n]+?) ${ENVELOPE_ORIGIN}\\]\\n\\n`,
);
const MACHINE_HEADER = new RegExp(
  `^\\[Message from automation ([^\\]\\n]+?) ${ENVELOPE_ORIGIN}\\]\\n\\n`,
);
// The server's `outsideAgentMessage` template (apps/server/src/j5/a2a/envelopes.v1.json): the
// label the client signed in with, then its id in parentheses. The label is one line with no `]`
// but may itself hold parentheses, so it is matched greedily and the id closes the header.
const OUTSIDE_AGENT_HEADER =
  /^\[Message from outside agent [^\]\n]+ \((outside:[^\]\s()]+)\)\]\n\n/;

interface AgentEnvelope {
  readonly senderId: string;
  readonly letter: string;
  readonly exchange: Exchange;
  readonly tag: "automation" | "outside-agent" | null;
}

/** Splits `header\n\nletter\n\ninstruction` at its last blank line. */
function letterAndInstruction(content: string) {
  const divider = content.lastIndexOf("\n\n");
  return divider <= 0
    ? null
    : { letter: content.slice(0, divider), instruction: content.slice(divider + 2) };
}

function parsePeerEnvelope(text: string): AgentEnvelope | null {
  const header = PEER_HEADER.exec(text);
  if (!header) return null;
  const senderId = header[1]!;
  const parts = letterAndInstruction(text.slice(header[0].length));
  if (parts === null) return null;
  const instruction = parseKnownInstruction({ senderId, instruction: parts.instruction });
  return instruction === null
    ? null
    : { senderId, letter: parts.letter, exchange: instruction.exchange, tag: null };
}

/** The machine template: a plain send from a registered script, never an exchange. */
function parseMachineEnvelope(text: string): AgentEnvelope | null {
  const header = MACHINE_HEADER.exec(text);
  if (!header) return null;
  const parts = letterAndInstruction(text.slice(header[0].length));
  if (parts === null || !MACHINE_DELIVERY_INSTRUCTIONS.has(parts.instruction)) return null;
  return { senderId: header[1]!, letter: parts.letter, exchange: "plain", tag: "automation" };
}

/** The outside-agent template: a plain send from an MCP client, never an exchange. */
function parseOutsideAgentEnvelope(text: string): AgentEnvelope | null {
  const header = OUTSIDE_AGENT_HEADER.exec(text);
  if (!header) return null;
  const parts = letterAndInstruction(text.slice(header[0].length));
  if (parts === null || parts.instruction !== OUTSIDE_AGENT_DELIVERY_INSTRUCTION) return null;
  return { senderId: header[1]!, letter: parts.letter, exchange: "plain", tag: "outside-agent" };
}

/**
 * Strictly recognizes the current agent-authored delivery templates. The transport does not
 * serialize its envelope version into the text, so a changed template is unrecognized and the
 * message falls back to upstream's row with its text as stored.
 */
export function parseJ5AgentEnvelope(text: string): AgentEnvelope | null {
  return parsePeerEnvelope(text) ?? parseMachineEnvelope(text) ?? parseOutsideAgentEnvelope(text);
}

// A person's inbox reply that names them: "[Message from Priya (human:…)]", and in a shared
// conversation "[Message from Priya (collaborator) (human:…)]". The id is the trailing
// parenthesis, as in the outside-agent header; the name before it may itself hold spaces and
// parentheses. The level is the agent's to read and is not shown (Shared conversations AC16).
const HUMAN_NAMED_HEADER = /^\[Message from ([^\]\n]+) \((human:[^\]\s()]+)\)\]\n\n/;
const WRITER_LEVEL_TAG = / \((?:owner|collaborator)\)$/;

function parseHumanEnvelope(text: string) {
  // #11 c487cf8's exact template, whose whole header is the sender's id; stored replies and a
  // person with no name on record keep that form. The older v6 literal header stays unrecognized.
  const named = HUMAN_NAMED_HEADER.exec(text);
  const header = named ?? /^\[Message from ([^\]\n]+)\]\n\n/.exec(text);
  if (!header) return null;

  const senderId = named === null ? header[1]! : named[2]!;
  const senderName = named === null ? null : named[1]!.replace(WRITER_LEVEL_TAG, "");
  const content = text.slice(header[0].length);
  const parts = letterAndInstruction(content);
  if (
    parts !== null &&
    parseKnownInstruction({ senderId, instruction: parts.instruction })?.exchange === "closed"
  ) {
    return { senderId, senderName, letter: parts.letter };
  }

  const markerIndex = content.lastIndexOf(HUMAN_DELIVERY_MARKER);
  if (markerIndex <= 0) return null;
  const instruction = parseKnownInstruction({
    senderId,
    instruction: content.slice(markerIndex + HUMAN_DELIVERY_MARKER.length),
  });
  return instruction === null || instruction.exchange === "closed"
    ? null
    : { senderId, senderName, letter: content.slice(0, markerIndex) };
}

function counterpartSummary(counterpartId: string, suffix: string): string | null {
  const counterpart = counterpartId.trim();
  return counterpart ? `${counterpart}${suffix}` : null;
}

function parseSilenceSummary(noticeType: string, body: string): string | null {
  if (noticeType === "turn-ended-no-reply") {
    const neverProcessed = /^(.+?) did not start a turn for the delivered message on [^.]+\.$/.exec(
      body,
    );
    if (neverProcessed)
      return counterpartSummary(
        neverProcessed[1]!,
        " did not start a turn for the delivered message",
      );

    const processed =
      /^(.+?)'s turn ended without replying on [^.]+\. The latest delivered message was processed\.$/.exec(
        body,
      );
    return processed ? counterpartSummary(processed[1]!, "'s turn ended without replying") : null;
  }

  if (noticeType === "errored") {
    const match = /^(.+?) errored without replying on .+: .+$/.exec(body);
    return match ? counterpartSummary(match[1]!, " errored without replying") : null;
  }

  if (noticeType === "stopped/cancelled") {
    const match =
      /^(.+?) was (interrupted|cancelled|rolled_back) without replying on [^.]+\. .+$/.exec(body);
    return match ? counterpartSummary(match[1]!, ` was ${match[2]} without replying`) : null;
  }

  if (noticeType === "queued-message-removed") {
    const match = /^Your message to (.+?) was removed from its queue before it ran, /.exec(body);
    return match
      ? counterpartSummary(match[1]!, " never read a queued message: it was removed before it ran")
      : null;
  }

  if (noticeType === "awaiting-human") {
    const match = /^(.+?) is awaiting the human on .+ \(.+\)\.$/.exec(body);
    return match ? counterpartSummary(match[1]!, " is awaiting the human") : null;
  }

  if (noticeType === "blocked-on-peer") {
    const match = /^(.+?) is blocked on (.+?) via .+\.$/.exec(body);
    return match ? counterpartSummary(match[1]!, ` is blocked on ${match[2]!.trim()}`) : null;
  }

  return null;
}

function parseSilenceEnvelope(text: string): string | null {
  const header = /^\[Cross-agent messaging system notice: ([^\]\n]+)\]\n\n/.exec(text);
  if (!header || !text.endsWith(SILENCE_DELIVERY_SUFFIX)) return null;
  return parseSilenceSummary(
    header[1]!,
    text.slice(header[0].length, -SILENCE_DELIVERY_SUFFIX.length),
  );
}

const CONTEXT_OPEN = "<j5_spawn_context>\n";
const CONTEXT_CLOSE = "\n</j5_spawn_context>\n\n";
const BRIEF_ONLY_PATTERN = /^<spawner_brief>\n([\s\S]*)\n<\/spawner_brief>$/;
/** Crew seats: the crew block first, the wrapped brief last, platform prose in between. */
const CREW_SEAT_PATTERN =
  /^<j5_crew_context>\n[\s\S]*\n\n<spawner_brief>\n([\s\S]*)\n<\/spawner_brief>$/;

export interface J5SpawnBrief {
  /**
   * What the spawner told the agent, without the platform identity block. For a plain Peer Agent
   * this is the bare brief. Crew seats also receive crew facts, collaboration rules, and seat
   * instructions between the identity block and the brief; those stay verbatim here until they
   * get their own UI.
   */
  readonly brief: string;
  /** The spawner's own words: the bare brief, or a Crew seat's `<spawner_brief>`. */
  readonly spawnerBrief: string;
  readonly participantId: string;
  /** Null on briefs written before the server recorded the spawner. */
  readonly spawnedBy: string | null;
  readonly spawnerThreadId: string | null;
}

/**
 * Strictly recognizes the identity block the server's `spawnFirstTurnText` puts first, and
 * unwraps the brief when it is all that follows. A changed template returns null so the message
 * falls back to upstream's row rather than hiding text the agent actually received.
 */
export function presentJ5SpawnBrief(message: J5UserMessageInput): J5SpawnBrief | null {
  if (!isJ5SpawnBriefMessage(message)) return null;
  const text = message.text;
  if (!text.startsWith(CONTEXT_OPEN)) return null;
  const closeIndex = text.indexOf(CONTEXT_CLOSE, CONTEXT_OPEN.length);
  if (closeIndex < 0) return null;

  const facts = new Map<string, string>();
  for (const line of text.slice(CONTEXT_OPEN.length, closeIndex).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator > 0) facts.set(line.slice(0, separator), line.slice(separator + 2));
  }
  const participantId = facts.get("participant_id");
  // Briefs stored before Squadrons were retired name a Squadron where newer ones name a project.
  const projectId = facts.get("project_id") ?? facts.get("squadron_id");
  const projectTitle = facts.get("project_title") ?? facts.get("squadron_name");
  if (!participantId || !projectId || !projectTitle) return null;
  const remainder = text.slice(closeIndex + CONTEXT_CLOSE.length);
  const bareBrief = BRIEF_ONLY_PATTERN.exec(remainder)?.[1];
  const seatBrief = bareBrief === undefined ? CREW_SEAT_PATTERN.exec(remainder)?.[1] : undefined;
  const spawnerBrief = bareBrief ?? seatBrief;
  if (spawnerBrief === undefined) return null;

  return {
    brief: bareBrief ?? remainder,
    spawnerBrief,
    participantId,
    spawnedBy: facts.get("spawned_by") || null,
    spawnerThreadId: facts.get("spawner_thread_id") || null,
  };
}

/** The first non-empty line, trimmed: what a folded row shows. */
export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

const BADGE_BY_EXCHANGE: Record<Exchange, J5ParticipantBadge | null> = {
  "expects-reply": "expects-reply",
  closed: "replied",
  plain: null,
};

// Upstream's platform messages, by the id its server gives them. An id upstream changes falls
// through to the attribution upstream's own resolver gives the message.
const UPSTREAM_NOTICE_IDS: ReadonlyArray<readonly [string, J5NoticeKind]> = [
  ["message:restart-continuation:", "restart-continuation"],
  ["message:pr-watch:", "pr-watch"],
];
const UPSTREAM_PROMPT_IDS: ReadonlyArray<readonly [string, J5PromptKind]> = [
  ["message:delegated-task-question:", "delegated-question"],
  ["idle-compact:", "compaction"],
];

/**
 * Classifies a user-role message by who is speaking. Null for a message that is not
 * user-role, and for a J5 message whose envelope this does not recognize: upstream's row then
 * shows it as stored, visibly, rather than hiding text the agent received.
 *
 * `viewerParticipantId` is the reading person's participant id, when the client knows it; an
 * Inbox reply is the reader's own only when it matches.
 */
export function presentJ5UserMessage(
  message: J5UserMessageInput,
  options: { readonly viewerParticipantId?: string | null } = {},
): J5UserMessagePresentation | null {
  if (message.role !== "user") return null;
  const text = message.text;

  if (isJ5DeliveryMessage(message)) {
    if (message.createdBy === "agent") {
      const envelope = parseJ5AgentEnvelope(text);
      return envelope === null
        ? null
        : {
            group: "participant",
            side: "left",
            text: envelope.letter,
            preview: firstLine(envelope.letter),
            senderId: envelope.senderId,
            senderThreadId: null,
            badge: BADGE_BY_EXCHANGE[envelope.exchange],
            tag: envelope.tag,
            unwrapped: true,
          };
    }
    if (message.createdBy === "user") {
      const reply = parseHumanEnvelope(text);
      if (reply === null) return null;
      return reply.senderId === options.viewerParticipantId
        ? { group: "person", side: "right", text: reply.letter, viaInbox: true, unwrapped: true }
        : {
            group: "other-person",
            side: "left",
            text: reply.letter,
            viaInbox: true,
            unwrapped: true,
            senderId: reply.senderId,
            senderName: reply.senderName,
          };
    }
    if (message.createdBy === "system") {
      const summary = parseSilenceEnvelope(text);
      return summary === null
        ? null
        : { group: "notice", side: "left", kind: "silence", summary, text };
    }
    return null;
  }

  if (isJ5SpawnBriefMessage(message)) {
    const brief = presentJ5SpawnBrief(message);
    return brief === null
      ? null
      : {
          group: "participant",
          side: "left",
          text: brief.brief,
          preview: firstLine(brief.spawnerBrief),
          senderId: brief.spawnedBy,
          senderThreadId: brief.spawnerThreadId,
          badge: null,
          tag: "brief",
          unwrapped: true,
        };
  }

  const id = String(message.id ?? "");
  const notice = UPSTREAM_NOTICE_IDS.find(([prefix]) => id.startsWith(prefix));
  if (notice !== undefined) {
    return { group: "notice", side: "left", kind: notice[1], summary: null, text };
  }
  const prompt = UPSTREAM_PROMPT_IDS.find(([prefix]) => id.startsWith(prefix));
  if (prompt !== undefined) return { group: "prompt", side: "left", kind: prompt[1], text };

  if (message.createdBy === "system") {
    const crew = presentCrewNotice({ role: message.role, text, createdBy: message.createdBy });
    return {
      group: "notice",
      side: "left",
      kind: crew === null ? "platform" : crew.kind === "gate" ? "crew-gate" : "crew-seats",
      summary: null,
      text,
    };
  }

  const upstream = resolveUserMessagePresentation(message);
  if (upstream.attribution === "automation") {
    return { group: "prompt", side: "left", kind: "automation", text: upstream.text };
  }
  if (upstream.attribution === "t3code") {
    return { group: "notice", side: "left", kind: "platform", summary: null, text };
  }
  if (upstream.attribution === "agent") {
    return {
      group: "participant",
      side: "left",
      text,
      preview: firstLine(text),
      senderId: null,
      senderThreadId: null,
      badge: null,
      tag: null,
      unwrapped: false,
    };
  }
  return { group: "person", side: "right", text, viaInbox: false, unwrapped: false };
}

/**
 * Upstream's `resolveUserMessagePresentation` with J5's reading of groups 1 to 3 on top: the
 * stripped letter as `text`, so upstream's fold summary, body and copy show the words rather than
 * the envelope, and `"agent"` for every participant, so each folds. Groups 4 and 5 keep upstream's
 * answer as it is.
 */
export function resolveJ5UserMessagePresentation(
  message: J5UserMessageInput,
  options: { readonly viewerParticipantId?: string | null } = {},
) {
  const upstream = resolveUserMessagePresentation(message);
  const j5 = presentJ5UserMessage(message, options);
  if (j5 === null || j5.group === "notice" || j5.group === "prompt") {
    return { ...upstream, j5: null };
  }
  return {
    ...upstream,
    text: j5.text,
    attribution: j5.group === "participant" ? ("agent" as const) : null,
    j5,
  };
}

/** The participants a message names, for the timeline's one identity read. */
export function participantIdsForJ5UserMessage(message: J5UserMessageInput): ReadonlyArray<string> {
  const j5 = presentJ5UserMessage(message);
  if (j5?.group === "participant" || j5?.group === "other-person") {
    return j5.senderId === null ? [] : [j5.senderId];
  }
  if (j5?.group === "notice" && (j5.kind === "crew-gate" || j5.kind === "crew-seats")) {
    return participantIdsForCrewNotice({
      role: message.role,
      text: message.text,
      createdBy: "system",
    });
  }
  return [];
}
