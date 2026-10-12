import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import type { ChatMessage } from "~/types";
import { useNowMinute } from "~/hooks/useNowMinute";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon, InboxIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useFindRevealRef } from "../../components/chat/markdownFindContext";
import { renderCrewNotice } from "../crew/CrewNoticeRenderer";
import { participantIdsForCrewNotice } from "../crew/crewNotices.logic";
import { presentParticipantIdentity } from "./ParticipantIdentity";

/**
 * `deliveryMessageId` in the server A2A transport is deliberately stable across
 * retries. The upstream composition seam requires this exact prefix and a user
 * role; envelope-looking text alone is never A2A UI.
 */
export const J5_A2A_DELIVERY_MESSAGE_PREFIX = "message:j5:a2a:delivery:";

// J5's tools gained a `j5_` prefix on 2026-10-10 (#508). Stored deliveries keep the name they
// were written with, so everything here that reads the timeline accepts both.
const SEND_TOOL_NAMES = ["j5_send_message", "send_message"] as const;

const PLAIN_DELIVERY_INSTRUCTIONS = new Set(
  SEND_TOOL_NAMES.map(
    (tool) =>
      `No reply is required. Use ${tool} without exchange_id only if a new message is needed.`,
  ),
);
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

export interface ThreadA2ADeliveryCompositionInput {
  readonly message: ChatMessage;
  /**
   * Preformatted by the surrounding timeline. This renderer deliberately has
   * no clock or formatter so its notice dialect always matches that timeline.
   */
  readonly timestampLabel?: string | undefined;
  /**
   * Optional participant-identities read result. Missing identities remain
   * explicitly unnamed, with the durable id available only as a tooltip.
   */
  readonly participantLabels?: ReadonlyMap<string, string> | undefined;
  /** The caller supplies this only when it can prove the authenticated viewer. */
  readonly resolveViewerParticipantId?: (() => string | null) | undefined;
  /** The shown thread, for Crew cards that open seats and render the brief's markdown. */
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly markdownCwd?: string | undefined;
  /** Test-only clock injection; production cards read the current wall clock once per render. */
  readonly now?: number | undefined;
}

export type ThreadA2ADeliveryPresentation =
  | {
      readonly kind: "peer";
      readonly rawEnvelope: string;
      readonly senderId: string;
      readonly senderLabel: string;
      readonly senderTooltipParticipantId: string | null;
      readonly body: string;
      readonly exchange: "expects-reply" | "plain" | "closed";
      /** Kept as a pairing fact only; protocol identifiers never render. */
      readonly exchangeId: string | null;
      /** A registered machine sender (script, watchdog) rather than an agent. */
      readonly automated: boolean;
      /** An MCP client signed in from outside the app. It has no thread to open. */
      readonly outsideAgent: boolean;
    }
  | {
      readonly kind: "human";
      readonly rawEnvelope: string;
      readonly senderId: string;
      readonly body: string;
      readonly exchange: "expects-reply" | "plain" | "closed";
    }
  | {
      readonly kind: "silence";
      readonly rawEnvelope: string;
      readonly summary: string;
    }
  | {
      readonly kind: "raw";
      readonly rawEnvelope: string;
    };

/**
 * Transport identity is intentionally the only composition gate. Creator and
 * source values describe a known delivery after it enters this renderer; they
 * must not make a delivery disappear from the raw fallback.
 */
export function isThreadA2ADeliveryMessage(message: ChatMessage): boolean {
  return message.role === "user" && String(message.id).startsWith(J5_A2A_DELIVERY_MESSAGE_PREFIX);
}

function parseKnownInstruction(input: {
  readonly senderId: string;
  readonly instruction: string;
}): {
  readonly exchange: "expects-reply" | "plain" | "closed";
  readonly exchangeId: string | null;
} | null {
  if (PLAIN_DELIVERY_INSTRUCTIONS.has(input.instruction)) {
    return { exchange: "plain", exchangeId: null };
  }
  if (input.instruction === CLOSED_DELIVERY_INSTRUCTION) {
    return { exchange: "closed", exchangeId: null };
  }

  const replyPrefix = SEND_TOOL_NAMES.map(
    (tool) => `Reply once with ${tool}(to="${input.senderId}", exchange_id="`,
  ).find((prefix) => input.instruction.startsWith(prefix));
  if (replyPrefix === undefined) return null;
  const exchangeIdAndSuffix = input.instruction.slice(replyPrefix.length);
  const separatorIndex = exchangeIdAndSuffix.indexOf(REPLY_DELIVERY_INSTRUCTION_SUFFIX);
  if (separatorIndex <= 0) return null;
  if (
    exchangeIdAndSuffix.slice(separatorIndex + REPLY_DELIVERY_INSTRUCTION_SUFFIX.length).length !==
    0
  ) {
    return null;
  }
  return { exchange: "expects-reply", exchangeId: exchangeIdAndSuffix.slice(0, separatorIndex) };
}

// A header names the sender and where it works. Messages stored before Squadrons were retired
// say "in squadron <id>"; newer ones say "in project <id>" with the project's title after it.
// Stored history keeps the old wording, so both are read. The sender group is lazy because a
// project title may itself contain " in project ".
const ENVELOPE_ORIGIN = "in (?:project|squadron) [^\\]\\n]+";
const PEER_HEADER = new RegExp(
  `^\\[Cross-agent message from ([^\\]\\n]+?) ${ENVELOPE_ORIGIN}\\]\\n\\n`,
);
const MACHINE_HEADER = new RegExp(
  `^\\[Message from automation ([^\\]\\n]+?) ${ENVELOPE_ORIGIN}\\]\\n\\n`,
);

function parsePeerEnvelope(rawEnvelope: string) {
  const header = PEER_HEADER.exec(rawEnvelope);
  if (!header) return null;

  const senderId = header[1]!;
  const content = rawEnvelope.slice(header[0].length);
  const divider = content.lastIndexOf("\n\n");
  if (divider <= 0) return null;
  const body = content.slice(0, divider);
  const instruction = parseKnownInstruction({
    senderId,
    instruction: content.slice(divider + 2),
  });
  return instruction === null
    ? null
    : {
        senderId,
        body,
        automated: false as const,
        outsideAgent: false as const,
        ...instruction,
      };
}

/** The machine template: a plain send from a registered script, never an exchange. */
function parseMachineEnvelope(rawEnvelope: string) {
  const header = MACHINE_HEADER.exec(rawEnvelope);
  if (!header) return null;
  const content = rawEnvelope.slice(header[0].length);
  const divider = content.lastIndexOf("\n\n");
  if (divider <= 0 || !MACHINE_DELIVERY_INSTRUCTIONS.has(content.slice(divider + 2))) return null;
  return {
    senderId: header[1]!,
    body: content.slice(0, divider),
    exchange: "plain" as const,
    exchangeId: null,
    automated: true as const,
    outsideAgent: false as const,
  };
}

// The server's `outsideAgentMessage` template (apps/server/src/j5/a2a/envelopes.v1.json): the
// label the client signed in with, then its id in parentheses. The label is one line with no `]`
// but may itself hold parentheses, so it is matched greedily and the id closes the header. The
// card names the sender from the participant-identities read, as it does every sender.
const OUTSIDE_AGENT_HEADER =
  /^\[Message from outside agent [^\]\n]+ \((outside:[^\]\s()]+)\)\]\n\n/;

/** The outside-agent template: a plain send from an MCP client, never an exchange. */
function parseOutsideAgentEnvelope(rawEnvelope: string) {
  const header = OUTSIDE_AGENT_HEADER.exec(rawEnvelope);
  if (!header) return null;
  const content = rawEnvelope.slice(header[0].length);
  const divider = content.lastIndexOf("\n\n");
  if (divider <= 0 || content.slice(divider + 2) !== OUTSIDE_AGENT_DELIVERY_INSTRUCTION) {
    return null;
  }
  return {
    senderId: header[1]!,
    body: content.slice(0, divider),
    exchange: "plain" as const,
    exchangeId: null,
    automated: false as const,
    outsideAgent: true as const,
  };
}

function parseAgentAuthoredEnvelope(rawEnvelope: string) {
  return (
    parsePeerEnvelope(rawEnvelope) ??
    parseMachineEnvelope(rawEnvelope) ??
    parseOutsideAgentEnvelope(rawEnvelope)
  );
}

function parseHumanEnvelope(rawEnvelope: string) {
  // #11 c487cf8's exact template. The older v6 literal header remains raw.
  const header = /^\[Message from ([^\]\n]+)\]\n\n/.exec(rawEnvelope);
  if (!header) return null;

  const senderId = header[1]!;
  const content = rawEnvelope.slice(header[0].length);
  const divider = content.lastIndexOf("\n\n");
  if (divider > 0) {
    const closedInstruction = parseKnownInstruction({
      senderId,
      instruction: content.slice(divider + 2),
    });
    if (closedInstruction?.exchange === "closed") {
      return { senderId, body: content.slice(0, divider), ...closedInstruction };
    }
  }

  const markerIndex = content.lastIndexOf(HUMAN_DELIVERY_MARKER);
  if (markerIndex <= 0) return null;
  const body = content.slice(0, markerIndex);
  const instruction = parseKnownInstruction({
    senderId,
    instruction: content.slice(markerIndex + HUMAN_DELIVERY_MARKER.length),
  });
  return instruction === null || instruction.exchange === "closed"
    ? null
    : { senderId, body, ...instruction };
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

function parseSilenceEnvelope(rawEnvelope: string) {
  const header = /^\[Cross-agent messaging system notice: ([^\]\n]+)\]\n\n/.exec(rawEnvelope);
  if (!header || !rawEnvelope.endsWith(SILENCE_DELIVERY_SUFFIX)) return null;
  const body = rawEnvelope.slice(header[0].length, -SILENCE_DELIVERY_SUFFIX.length);
  const noticeType = header[1]!;
  const summary = parseSilenceSummary(noticeType, body);
  return summary === null ? null : { summary };
}

/**
 * Strictly recognizes the current delivery templates. The transport currently
 * does not serialize its numeric envelope version into the text, so a changed
 * template is intentionally treated as unrecognized and shown raw.
 */
export function presentThreadA2ADelivery(
  input: ThreadA2ADeliveryCompositionInput,
): ThreadA2ADeliveryPresentation | null {
  const { message } = input;
  if (!isThreadA2ADeliveryMessage(message)) return null;

  if (message.createdBy === "agent") {
    const peer = parseAgentAuthoredEnvelope(message.text);
    if (peer) {
      const sender = presentParticipantIdentity({
        participantId: peer.senderId,
        participantLabels: input.participantLabels ?? new Map(),
      });
      return {
        kind: "peer",
        rawEnvelope: message.text,
        senderId: peer.senderId,
        senderLabel: sender.label,
        senderTooltipParticipantId: sender.tooltipParticipantId,
        body: peer.body,
        exchange: peer.exchange,
        exchangeId: peer.exchangeId,
        automated: peer.automated,
        outsideAgent: peer.outsideAgent,
      };
    }
  } else if (message.createdBy === "user") {
    const human = parseHumanEnvelope(message.text);
    if (human) {
      return {
        kind: "human",
        rawEnvelope: message.text,
        senderId: human.senderId,
        body: human.body,
        exchange: human.exchange,
      };
    }
  } else if (message.createdBy === "system") {
    const silence = parseSilenceEnvelope(message.text);
    if (silence) {
      return {
        kind: "silence",
        rawEnvelope: message.text,
        summary: silence.summary,
      };
    }
  }

  return { kind: "raw", rawEnvelope: message.text };
}

export function participantIdsForThreadA2ADelivery(message: ChatMessage): ReadonlyArray<string> {
  const presentation = presentThreadA2ADelivery({ message });
  return presentation?.kind === "peer"
    ? [presentation.senderId]
    : participantIdsForCrewNotice(message);
}

export function formatThreadA2AQueuedDelivery(
  text: string,
  participantLabels: ReadonlyMap<string, string>,
): { readonly label: string; readonly tooltipParticipantId: string | null } | null {
  const peer = parseAgentAuthoredEnvelope(text);
  if (peer === null) return null;
  const sender = presentParticipantIdentity({ participantId: peer.senderId, participantLabels });
  const firstLine = peer.body.split("\n")[0]?.trim() ?? "";
  return {
    label: `From ${sender.label} — ${firstLine || "Message content unavailable"}`,
    tooltipParticipantId: sender.tooltipParticipantId,
  };
}

export function participantIdsForThreadA2AEnvelope(text: string): ReadonlyArray<string> {
  const peer = parseAgentAuthoredEnvelope(text);
  return peer === null ? [] : [peer.senderId];
}

function RawEnvelopeExpander({
  rawEnvelope,
  open = false,
}: {
  readonly rawEnvelope: string;
  readonly open?: boolean;
}) {
  return (
    <details
      className="mt-2 rounded-md border border-border/60 bg-background/55"
      open={open || undefined}
    >
      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
        Show raw envelope
      </summary>
      <pre className="overflow-x-auto border-t border-border/50 p-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {rawEnvelope}
      </pre>
    </details>
  );
}

export function formatTimeSinceSent(sentAt: string, now = Date.now()): string {
  const sentAtMs = Date.parse(sentAt);
  if (!Number.isFinite(sentAtMs)) return "sent earlier";

  const elapsedSeconds = Math.max(0, Math.floor((now - sentAtMs) / 1_000));
  if (elapsedSeconds < 60) return "just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

function A2ABodyClamp({ body }: { readonly body: string }) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hiddenLineCount, setHiddenLineCount] = useState(0);
  // In-thread find opens the body when it selects a match in the clamped part.
  const revealForFind = useCallback(() => setExpanded(true), []);
  const findRevealRef = useFindRevealRef(revealForFind);
  const setBodyRef = useCallback(
    (element: HTMLParagraphElement | null) => {
      bodyRef.current = element;
      return findRevealRef(element);
    },
    [findRevealRef],
  );

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;

    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      const totalLines = Math.ceil(element.scrollHeight / lineHeight);
      setHiddenLineCount(Math.max(0, totalLines - 2));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [body]);

  const canExpand = hiddenLineCount > 0;
  return (
    <div className="mt-2">
      <p
        ref={setBodyRef}
        className={
          expanded
            ? "whitespace-pre-wrap break-words text-sm leading-5"
            : "line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5"
        }
        data-j5-a2a-card-body
        data-thread-find-text="true"
        data-thread-find-fold={expanded ? undefined : ""}
      >
        {body}
      </p>
      {canExpand ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRightIcon
            aria-hidden
            className={expanded ? "size-3 shrink-0 rotate-90" : "size-3 shrink-0"}
          />
          {expanded
            ? "Collapse"
            : `${hiddenLineCount} more ${hiddenLineCount === 1 ? "line" : "lines"}`}
        </button>
      ) : null}
    </div>
  );
}

function PeerDeliveryCard({
  automated = false,
  body,
  exchange,
  now,
  outsideAgent = false,
  senderLabel,
  senderTooltipParticipantId,
  sentAt,
}: {
  readonly automated?: boolean | undefined;
  readonly body: string;
  readonly exchange: "expects-reply" | "plain" | "closed";
  readonly now?: number | undefined;
  readonly outsideAgent?: boolean | undefined;
  readonly senderLabel: string;
  readonly senderTooltipParticipantId: string | null;
  readonly sentAt: string;
}) {
  const nowMinute = useNowMinute();
  const currentNow = now ?? Date.parse(`${nowMinute}:00.000Z`);
  const isOpen = exchange === "expects-reply";
  const isClosed = exchange === "closed";
  return (
    <section
      className="max-w-[88%] rounded-lg border border-border/70 bg-muted/25 px-3.5 py-2.5"
      data-j5-a2a-renderer="peer"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <InboxIcon className="size-3.5 shrink-0" aria-hidden />
          From
        </span>
        {senderTooltipParticipantId === null ? (
          <span className="font-medium text-foreground">{senderLabel}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="font-medium text-foreground" />}>
              {senderLabel}
            </TooltipTrigger>
            <TooltipPopup>{senderTooltipParticipantId}</TooltipPopup>
          </Tooltip>
        )}
        {automated ? (
          <span
            className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground"
            data-j5-a2a-automated
          >
            Automation
          </span>
        ) : null}
        {outsideAgent ? (
          <span
            className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground"
            data-j5-a2a-outside-agent
          >
            Outside agent
          </span>
        ) : null}
        {isOpen ? (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-2xs font-semibold text-warning-foreground">
            Expects reply
          </span>
        ) : null}
        {isClosed ? (
          <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
            Closed your exchange
          </span>
        ) : null}
        <time className="ml-auto tabular-nums text-muted-foreground" dateTime={sentAt}>
          {formatTimeSinceSent(sentAt, currentNow)}
        </time>
      </div>
      <A2ABodyClamp body={body} />
    </section>
  );
}

/**
 * The upstream user-row seam calls this function directly. It deliberately
 * returns null for non-A2A messages so the existing renderer owns that path.
 */
export function renderThreadA2ADelivery(props: ThreadA2ADeliveryCompositionInput): ReactNode {
  // Crew notices share this user-row seam: the platform's gate decisions and seat notices render
  // as cards here, so the upstream row never shows their tagged blocks.
  const crewNotice = renderCrewNotice(props);
  if (crewNotice !== null) return crewNotice;
  const presentation = presentThreadA2ADelivery(props);
  if (presentation === null) return null;

  if (presentation.kind === "peer") {
    return (
      <PeerDeliveryCard
        automated={presentation.automated}
        body={presentation.body}
        exchange={presentation.exchange}
        now={props.now}
        outsideAgent={presentation.outsideAgent}
        senderLabel={presentation.senderLabel}
        senderTooltipParticipantId={presentation.senderTooltipParticipantId}
        sentAt={props.message.createdAt}
      />
    );
  }

  if (presentation.kind === "human") {
    const viewerParticipantId = props.resolveViewerParticipantId?.() ?? null;
    const attribution =
      viewerParticipantId !== null && viewerParticipantId === presentation.senderId
        ? "You · via Inbox"
        : `Via Inbox · ${presentation.senderId}`;
    return (
      <section className="rounded-lg bg-accent px-3 py-2.5" data-j5-a2a-renderer="human">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <p className="font-medium text-muted-foreground">{attribution}</p>
          {presentation.exchange === "closed" ? (
            <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
              Closed your exchange
            </span>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm" data-thread-find-text="true">
          {presentation.body}
        </p>
      </section>
    );
  }

  if (presentation.kind === "silence") {
    return (
      <section className="text-xs text-muted-foreground" data-j5-a2a-renderer="silence">
        <span data-j5-a2a-silence-summary>
          ⚠ {presentation.summary}
          {props.timestampLabel ? ` · ${props.timestampLabel}` : null}
        </span>
      </section>
    );
  }

  return (
    <section
      className="rounded-md border border-border/60 bg-muted/20 p-2.5"
      data-j5-a2a-renderer="raw"
    >
      <p className="text-xs font-medium text-muted-foreground">Raw A2A delivery</p>
      <RawEnvelopeExpander rawEnvelope={presentation.rawEnvelope} open />
    </section>
  );
}

/** Standalone component form for focused tests and future J5-owned surfaces. */
export function ThreadA2ADeliveryRenderer(props: ThreadA2ADeliveryCompositionInput) {
  return renderThreadA2ADelivery(props);
}
