import type { ScopedThreadRef } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { MessageCopyButton } from "../../components/chat/MessageCopyButton";

import { authorName } from "./sharedConversation.logic";
import { sharedMarkOf } from "./sharedTimeline";
import { initialsOf } from "./shareLink.logic";

interface SharedMessageInput {
  readonly message: { readonly createdBy?: string | undefined; readonly text: string };
  readonly timestampLabel?: string | undefined;
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly markdownCwd?: string | undefined;
}

// Upstream's own level for a message's headings, under the heading that names its author.
const MESSAGE_HEADING_LEVEL = 3;
const NO_SKILLS: ReadonlyArray<never> = [];

/**
 * Draws the two kinds of message only a shared conversation holds, in the place upstream's
 * timeline draws a person's message: the note the platform gave the agent with a message (who can
 * write; its words are the server's and nothing here reads them), and
 * a message another person wrote. Everything else, the reader's own messages among them, is
 * `null` and stays upstream's to draw.
 *
 * The look of another person's message is a first draft on the pattern of the agent-to-agent
 * cards: the name, a "guest" or "member" tag, and initials where a picture would go.
 */
export function renderSharedConversationMessage(props: SharedMessageInput): ReactNode {
  const mark = sharedMarkOf(props.message);
  if (mark === undefined) return null;
  if (mark.kind === "note") {
    return (
      <details className="text-xs text-muted-foreground" data-j5-shared-conversation="note">
        <summary className="cursor-pointer select-none">
          The agent was given a note with this message
          {props.timestampLabel ? ` · ${props.timestampLabel}` : null}
        </summary>
        <p className="mt-1.5 whitespace-pre-wrap break-words border-l border-border pl-3">
          {props.message.text}
        </p>
      </details>
    );
  }
  const { author } = mark;
  // For the moment before the server says whose it is, the card is drawn without a name.
  const name = author === "waiting" ? null : authorName(author);
  return (
    <section className="rounded-lg bg-accent px-3 py-2.5" data-j5-shared-conversation="message">
      <div className="flex items-center gap-2 text-xs">
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-4xs font-semibold text-foreground"
        >
          {name === null ? "" : initialsOf(name)}
        </span>
        <p className="min-w-0 truncate font-medium text-foreground">{name ?? "\u00a0"}</p>
        {author === "waiting" ? null : (
          <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
            {author.kind}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          {props.timestampLabel}
          {/* The typed words, without the line that is there for the agent. Upstream's other
              control on a person's own message, "Edit from here", is not offered on someone
              else's: it would hand their words to the reader's composer. */}
          <MessageCopyButton
            // As upstream's Copy on a person's own message: a mention is copied as its label.
            text={replaceComposerContextReferences(
              props.message.text,
              (reference) => reference.label,
            )}
            size="icon-xs"
            variant="ghost"
          />
        </span>
      </div>
      {/* Drawn as upstream draws a person's own words, so markdown reads the same and a mention
          shows its label and not its link. Upstream's chip for a mention needs the row's own
          state, which this card does not have. */}
      <div className="mt-1.5 text-sm" data-thread-find-text="true">
        <ChatMarkdown
          text={props.message.text}
          cwd={props.markdownCwd}
          threadRef={props.threadRef ?? undefined}
          skills={NO_SKILLS}
          className="text-foreground"
          lineBreaks
          parseRawHtml={false}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
        />
      </div>
    </section>
  );
}
