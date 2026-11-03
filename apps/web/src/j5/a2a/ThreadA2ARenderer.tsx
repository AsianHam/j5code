import {
  j5MessageAuthorName,
  j5SenderThreadRef,
  nameJ5NoticeParticipants,
} from "@t3tools/client-runtime/j5/participant-identity";
import {
  participantIdsForJ5UserMessage,
  presentJ5UserMessage,
  resolveJ5UserMessagePresentation,
  type J5NoticeKind,
  type J5PromptKind,
  type J5UserMessagePresentation,
} from "@t3tools/client-runtime/j5/user-message";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  CircleHelpIcon,
  ListChecksIcon,
  type LucideIcon,
  MailWarningIcon,
  MessageCircleOffIcon,
  UndoIcon,
  UnlinkIcon,
} from "lucide-react";
import { use, type ReactNode } from "react";

import { TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { Badge } from "../../components/ui/badge";
import { useQuietThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ResolvedUserMessageContext } from "~/lib/composerContextRecords";
import type { ChatMessage } from "~/types";
import { renderCrewNotice } from "../crew/CrewNoticeRenderer";
import { useConnectionAccess } from "../sharing/access";
import { J5NoticeDetailText, J5NoticeLine } from "./J5NoticeLine";
import { PersonAvatar } from "../sharing/PersonAvatar";
import {
  renderSharedConversationNote,
  SharedMessageAuthorLine,
} from "../sharing/SharedConversationCards";

export { J5OpenThread as J5OpenSenderThread } from "./J5NoticeLine";
export { J5_A2A_DELIVERY_MESSAGE_PREFIX } from "@t3tools/client-runtime/j5/user-message";
export {
  formatJ5QueuedDelivery as formatThreadA2AQueuedDelivery,
  participantIdsForJ5Envelope as participantIdsForThreadA2AEnvelope,
} from "@t3tools/client-runtime/j5/participant-identity";

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

const NOTICE_ICONS: Partial<Record<J5NoticeKind, LucideIcon>> = {
  silence: MessageCircleOffIcon,
  "not-delivered": MailWarningIcon,
  "exchange-dropped": UnlinkIcon,
  "exchange-withdrawn": UndoIcon,
};

function J5PlatformNotice(props: {
  readonly notice: Extract<J5UserMessagePresentation, { group: "notice" }>;
  readonly timestampLabel: string | undefined;
}) {
  const { participantLabels } = use(TimelineRowCtx);
  const { notice } = props;
  const named = (text: string) =>
    nameJ5NoticeParticipants(text, notice.participantIds, participantLabels);
  return (
    <J5NoticeLine
      kind={notice.kind}
      icon={NOTICE_ICONS[notice.kind] ?? BellIcon}
      summary={named(notice.summary ?? "")}
      timestampLabel={props.timestampLabel}
    >
      {notice.detail === null ? null : <J5NoticeDetailText text={named(notice.detail)} />}
    </J5NoticeLine>
  );
}

/**
 * J5's platform notices (group 4), drawn in place of upstream's user row: Crew notices, a shared
 * conversation's note, and any notice the classifier has a summary for. Every other user message is
 * upstream's row, including a notice nothing here can read. Upstream's own platform messages never
 * get here: they are its notification and compaction rows.
 */
export function renderThreadA2ADelivery(props: ThreadA2ADeliveryCompositionInput): ReactNode {
  const crewNotice = renderCrewNotice(props);
  if (crewNotice !== null) return crewNotice;
  const sharedNote = renderSharedConversationNote(props);
  if (sharedNote !== null) return sharedNote;
  const presentation = presentJ5UserMessage(props.message);
  if (presentation?.group !== "notice" || presentation.summary === null) return null;
  return <J5PlatformNotice notice={presentation} timestampLabel={props.timestampLabel} />;
}

const PROMPT_ICONS: Record<Exclude<J5PromptKind, "automation">, LucideIcon> = {
  "playbook-step": ListChecksIcon,
  "native-question": CircleHelpIcon,
};

/**
 * What upstream's Automation row shows for J5's other platform prompts (group 5). Null for anything
 * else, an automation run included: that row reads its own.
 */
export function j5PromptRow(message: ChatMessage) {
  const j5 = presentJ5UserMessage(message);
  if (j5?.group !== "prompt" || j5.kind === "automation") return null;
  return {
    text: j5.text,
    scheduledTaskId: undefined,
    label: j5.label,
    summary: j5.preview,
    icon: PROMPT_ICONS[j5.kind],
  };
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
  const senderThreadRef = j5SenderThreadRef({
    environmentId: ctx.activeThreadEnvironmentId,
    presentation: j5,
    messageSenderThreadId: message.senderThreadId,
    participantThreads: ctx.participantThreads,
  });
  // A peer's thread opens only from a client connected to that peer, and only if the person can
  // see it there; the client's own thread list answers both.
  const senderThread = useQuietThreadShell(j5?.group === "participant" ? senderThreadRef : null);
  const authorName = j5MessageAuthorName({
    presentation: j5,
    participantLabels: ctx.participantLabels,
    senderThreadTitle: senderThread?.title,
  });
  const literalContext = j5?.unwrapped ? literalUserMessageContext(presentation.text) : null;
  return {
    ...presentation,
    literalContext,
    authorName,
    senderThreadRef: senderThread === null ? null : senderThreadRef,
    // The platform's words are never the reader's, even in a notice nothing here can read.
    side: j5?.side ?? (message.createdBy === "system" ? "left" : "right"),
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
