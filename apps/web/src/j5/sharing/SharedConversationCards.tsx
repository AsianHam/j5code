import type { ReactNode } from "react";

import { authorName, sharedConversationNote } from "./sharedConversation.logic";
import { sharedAuthorOf } from "./sharedTimeline";
import { initialsOf } from "./shareLink.logic";

interface SharedMessageInput {
  readonly message: { readonly createdBy?: string | undefined; readonly text: string };
  readonly timestampLabel?: string | undefined;
}

/**
 * Draws the two kinds of message only a shared conversation holds, in the place upstream's
 * timeline draws a person's message: the platform's note to the agent about who can write, and
 * a message another person wrote. Everything else, the reader's own messages among them, is
 * `null` and stays upstream's to draw.
 *
 * The look of another person's message is a first draft on the pattern of the agent-to-agent
 * cards: the name, a "guest" or "member" tag, and initials where a picture would go.
 */
export function renderSharedConversationMessage(props: SharedMessageInput): ReactNode {
  const note = sharedConversationNote(props.message);
  if (note !== null) {
    return (
      <details className="text-xs text-muted-foreground" data-j5-shared-conversation="note">
        <summary className="cursor-pointer select-none">
          The agent was told who can write to this thread
          {props.timestampLabel ? ` · ${props.timestampLabel}` : null}
        </summary>
        <p className="mt-1.5 whitespace-pre-wrap break-words border-l border-border pl-3">{note}</p>
      </details>
    );
  }
  const author = sharedAuthorOf(props.message);
  if (author === undefined || author.you) return null;
  const name = authorName(author);
  return (
    <section className="rounded-lg bg-accent px-3 py-2.5" data-j5-shared-conversation="message">
      <div className="flex items-center gap-2 text-xs">
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-4xs font-semibold text-foreground"
        >
          {initialsOf(name)}
        </span>
        <p className="min-w-0 truncate font-medium text-foreground">{name}</p>
        <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
          {author.kind}
        </span>
        {props.timestampLabel ? (
          <span className="ml-auto shrink-0 text-muted-foreground">{props.timestampLabel}</span>
        ) : null}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm" data-thread-find-text="true">
        {props.message.text}
      </p>
    </section>
  );
}
