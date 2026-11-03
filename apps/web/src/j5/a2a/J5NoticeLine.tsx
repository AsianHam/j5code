import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import { use, useState, type ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { findRevealRef } from "../../components/chat/markdownFindContext";
import { MESSAGE_HEADING_LEVEL } from "../../components/chat/TimelineRowParts";
import { TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { InlineButton } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";

const TONE_CLASS = {
  bad: "text-destructive",
  warn: "text-warning",
  none: "",
} as const;

/**
 * A platform notice (group 4): one grey line on the left, with an icon, a plain summary, the time
 * and, when there is something to open, a chevron. Opened, its detail hangs under a thin rule.
 */
export function J5NoticeLine(props: {
  /** Which notice this is, for finding the row in tests and captures. */
  readonly kind: string;
  readonly icon: LucideIcon;
  readonly tone?: keyof typeof TONE_CLASS;
  readonly summary: string;
  readonly timestampLabel?: string | undefined;
  readonly children?: ReactNode;
}) {
  const { findActive } = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const Icon = props.icon;
  const hasDetail = props.children !== undefined && props.children !== null;
  const content = (
    <>
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", TONE_CLASS[props.tone ?? "none"])}
        data-j5-notice-tone={props.tone}
      />
      {/* Find can only show a match in a summary that isn't cut off. */}
      <span className={cn("min-w-0", !findActive && "truncate")} data-thread-find-text="true">
        {props.summary}
      </span>
      {props.timestampLabel ? (
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {props.timestampLabel}
        </span>
      ) : null}
    </>
  );
  const lineClass = "flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left";
  return (
    <div
      className="flex min-w-0 max-w-[80%] flex-col items-start gap-1 text-xs text-muted-foreground"
      data-j5-notice={props.kind}
    >
      {hasDetail ? (
        <button
          type="button"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          onClick={() => setExpanded((value) => !value)}
          className={cn(lineClass, "rounded-sm focus-visible:outline-2 focus-visible:outline-ring")}
        >
          {content}
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
          />
        </button>
      ) : (
        <div className={lineClass}>{content}</div>
      )}
      {/* Find reads the DOM, so a folded detail stays mounted but hidden while find is open. */}
      {hasDetail && (expanded || findActive) ? (
        <div
          ref={revealRef}
          hidden={!expanded}
          className={cn(
            "ms-1.5 min-w-0 max-w-full border-l border-border ps-3",
            !findActive && "max-h-96 overflow-auto",
          )}
          data-j5-notice-detail
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

/** A notice's words, as markdown so a link or a list in them reads as one. */
export function J5NoticeDetailText({ text }: { readonly text: string }) {
  const ctx = use(TimelineRowCtx);
  return (
    <div data-thread-find-text="true">
      <ChatMarkdown
        text={text}
        cwd={ctx.markdownCwd}
        threadRef={ctx.threadRef ?? undefined}
        skills={ctx.skills}
        className="text-xs text-muted-foreground"
        lineBreaks
        parseRawHtml={false}
        headingLevelOffset={MESSAGE_HEADING_LEVEL}
      />
    </div>
  );
}

/** The row of things a notice opens, under its words. */
export function J5NoticeActions({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2" data-thread-find-ignore>
      {children}
    </div>
  );
}

export function J5OpenThread({
  threadRef,
  label = "Open thread",
}: {
  readonly threadRef: ScopedThreadRef;
  readonly label?: string;
}) {
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
      {label}
    </InlineButton>
  );
}
