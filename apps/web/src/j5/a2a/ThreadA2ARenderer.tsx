import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isJ5DeliveryMessage,
  parseJ5AgentEnvelope,
  participantIdsForJ5UserMessage,
  presentJ5UserMessage,
  resolveJ5UserMessagePresentation,
} from "@t3tools/client-runtime/j5/user-message";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { use, type ReactNode } from "react";

import { TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { Badge } from "../../components/ui/badge";
import { InlineButton } from "../../components/ui/button";
import { useQuietThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ResolvedUserMessageContext } from "~/lib/composerContextRecords";
import type { ChatMessage } from "~/types";
import { renderCrewNotice } from "../crew/CrewNoticeRenderer";
import { useConnectionAccess } from "../sharing/access";
import { PersonAvatar } from "../sharing/PersonAvatar";
import {
  renderSharedConversationNote,
  SharedMessageAuthorLine,
} from "../sharing/SharedConversationCards";
import { presentParticipantIdentity } from "./ParticipantIdentity";

export { J5_A2A_DELIVERY_MESSAGE_PREFIX } from "@t3tools/client-runtime/j5/user-message";

export interface ThreadA2ADeliveryCompositionInput {
  readonly message: ChatMessage;
  /**
   * Preformatted by the surrounding timeline. This renderer deliberately has
   * no clock or formatter so its notice dialect always matches that timeline.
   */
  readonly timestampLabel?: string | undefined;
  /** The identity read's labels, which name the seats a Crew notice lists. */
  readonly participantLabels?: ReadonlyMap<string, string> | undefined;
  /** The shown thread, for notices that open seats and render markdown. */
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly markdownCwd?: string | undefined;
}

export function participantIdsForThreadA2ADelivery(message: ChatMessage): ReadonlyArray<string> {
  return participantIdsForJ5UserMessage(message);
}

export function formatThreadA2AQueuedDelivery(
  text: string,
  participantLabels: ReadonlyMap<string, string>,
): { readonly label: string; readonly tooltipParticipantId: string | null } | null {
  const envelope = parseJ5AgentEnvelope(text);
  if (envelope === null) return null;
  const sender = presentParticipantIdentity({
    participantId: envelope.senderId,
    participantLabels,
  });
  const firstLine = envelope.letter.split("\n")[0]?.trim() ?? "";
  return {
    label: `From ${sender.label}: ${firstLine || "Message content unavailable"}`,
    tooltipParticipantId: sender.tooltipParticipantId,
  };
}

export function participantIdsForThreadA2AEnvelope(text: string): ReadonlyArray<string> {
  const envelope = parseJ5AgentEnvelope(text);
  return envelope === null ? [] : [envelope.senderId];
}

function RawEnvelopeExpander({ rawEnvelope }: { readonly rawEnvelope: string }) {
  return (
    <details className="mt-2 rounded-md border border-border/60 bg-background/55" open>
      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
        Show raw envelope
      </summary>
      <pre className="overflow-x-auto border-t border-border/50 p-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {rawEnvelope}
      </pre>
    </details>
  );
}

/**
 * J5's platform notices (group 4), drawn in place of upstream's user row: Crew notices, a shared
 * conversation's note, and the platform's notices about deliveries. Every other user message,
 * agents' letters and Inbox replies included, is upstream's row (`useJ5UserMessagePresentation`).
 */
export function renderThreadA2ADelivery(props: ThreadA2ADeliveryCompositionInput): ReactNode {
  const crewNotice = renderCrewNotice(props);
  if (crewNotice !== null) return crewNotice;
  const sharedNote = renderSharedConversationNote(props);
  if (sharedNote !== null) return sharedNote;
  if (!isJ5DeliveryMessage(props.message) || props.message.createdBy !== "system") return null;

  const presentation = presentJ5UserMessage(props.message);
  if (presentation?.group === "notice" && presentation.kind === "silence") {
    return (
      <section className="text-xs text-muted-foreground" data-j5-a2a-renderer="silence">
        <span data-j5-a2a-silence-summary>
          ⚠ {presentation.summary}
          {props.timestampLabel ? ` · ${props.timestampLabel}` : null}
        </span>
      </section>
    );
  }

  // A platform notice this client cannot read yet keeps today's raw card until the notices are
  // redrawn: upstream's row would draw it as the reader's own message.
  return (
    <section
      className="rounded-md border border-border/60 bg-muted/20 p-2.5"
      data-j5-a2a-renderer="raw"
    >
      <p className="text-xs font-medium text-muted-foreground">Raw A2A delivery</p>
      <RawEnvelopeExpander rawEnvelope={props.message.text} />
    </section>
  );
}

export function literalUserMessageContext(text: string): ResolvedUserMessageContext {
  return { text, records: [], recordsById: new Map() };
}

/**
 * `authorName` is null for the reader's own message. Words J5 took out of an envelope or a brief
 * are literal authored text, so `literalContext` stands in for upstream's context resolution:
 * upstream's upgrade of legacy trailing blocks (`<terminal_context>`, `<element_context>`, preview
 * annotations) would cut the tail off a letter that quotes one.
 */
export function useJ5UserMessagePresentation(message: ChatMessage) {
  const ctx = use(TimelineRowCtx);
  const access = useConnectionAccess(ctx.activeThreadEnvironmentId);
  const presentation = resolveJ5UserMessagePresentation(message, {
    viewerParticipantId: access?.kind === "person" ? access.personId : null,
  });
  const j5 = presentation.j5;
  const senderId = j5?.group === "participant" || j5?.group === "other-person" ? j5.senderId : null;
  const localThreadId =
    message.senderThreadId ?? (j5?.group === "participant" ? j5.senderThreadId : null);
  const senderThreadRef =
    (senderId === null ? undefined : ctx.participantThreads.get(senderId)) ??
    (localThreadId
      ? scopeThreadRef(ctx.activeThreadEnvironmentId, ThreadId.make(localThreadId))
      : null);
  // A peer's thread opens only from a client connected to that peer, and only if the person can
  // see it there; the client's own thread list answers both.
  const senderThread = useQuietThreadShell(j5?.group === "participant" ? senderThreadRef : null);
  const label = senderId === null ? undefined : ctx.participantLabels.get(senderId);
  const authorName =
    j5?.group === "participant"
      ? label || senderThread?.title.trim() || "Agent"
      : j5?.group === "other-person"
        ? (j5.senderName ?? label ?? "Someone without a name")
        : null;
  const literalContext = j5?.unwrapped ? literalUserMessageContext(presentation.text) : null;
  return {
    ...presentation,
    literalContext,
    authorName,
    senderThreadRef: senderThread === null ? null : senderThreadRef,
    side: j5?.side ?? "right",
    // Upstream's own fold summary reads a message J5 did not unwrap.
    preview: j5?.group === "participant" && j5.unwrapped ? j5.preview : null,
  };
}

export type J5UserMessageRowPresentation = ReturnType<typeof useJ5UserMessagePresentation>;

/**
 * The line above a user message, in case 80's slot: an Inbox reply's caption, the identity line
 * of an agent or other participant, or else a shared conversation's author line.
 */
export function J5MessageAuthorLine({
  message,
  presentation,
}: {
  readonly message: ChatMessage;
  readonly presentation: J5UserMessageRowPresentation;
}) {
  const ctx = use(TimelineRowCtx);
  const j5 = presentation.j5;
  if (j5?.group === "person" && j5.viaInbox) {
    return (
      <p className="me-1 text-2xs text-muted-foreground/70" data-j5-message-author="inbox">
        You · via Inbox
      </p>
    );
  }
  if (j5?.group === "other-person") {
    return (
      <p
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-j5-message-author="inbox"
      >
        <PersonAvatar
          name={j5.senderName ?? ctx.participantLabels.get(j5.senderId) ?? null}
          size="xs"
        />
        <span className="font-medium text-foreground">{presentation.authorName}</span>
        <span>· via Inbox</span>
      </p>
    );
  }
  if (j5?.group !== "participant") {
    return <SharedMessageAuthorLine threadRef={ctx.threadRef} message={message} />;
  }
  const name = presentation.authorName ?? "Agent";
  return (
    <p
      className="flex min-w-0 max-w-[80%] items-center gap-1.5 text-xs text-muted-foreground"
      data-j5-message-author="participant"
    >
      <BotIcon aria-hidden className="size-3.5 shrink-0" />
      {presentation.senderThreadRef === null ? (
        <span className="truncate font-medium text-foreground">{name}</span>
      ) : (
        <Link
          className="truncate font-medium text-foreground hover:underline"
          params={buildThreadRouteParams(presentation.senderThreadRef)}
          title="Open the sender's thread"
          to="/$environmentId/$threadId"
        >
          {name}
        </Link>
      )}
      {j5.tag === "brief" ? <span className="shrink-0">· brief</span> : null}
      {j5.tag === "automation" ? (
        <Badge variant="outline" size="sm">
          Automation
        </Badge>
      ) : null}
      {j5.tag === "outside-agent" ? (
        <Badge variant="outline" size="sm">
          Outside agent
        </Badge>
      ) : null}
      {j5.badge === "expects-reply" ? (
        <Badge variant="warning" size="sm">
          Expects reply
        </Badge>
      ) : null}
      {j5.badge === "replied" ? (
        <Badge variant="success" size="sm">
          Replied
        </Badge>
      ) : null}
    </p>
  );
}

/**
 * The expanded row's "Open thread" for a message J5 read. It opens the sender's resolved thread,
 * which upstream's footer cannot reach for a spawn brief or a peer's message (no `senderThreadId`).
 */
export function J5OpenSenderThread({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  return (
    <InlineButton
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        })
      }
      tone="muted"
    >
      Open thread
    </InlineButton>
  );
}
