import type { ScopedThreadRef } from "@t3tools/contracts";
import type { MessageAuthor } from "@t3tools/contracts/j5";
import type { ReactNode } from "react";

import { PersonAvatar } from "./PersonAvatar";
import { isSettledPrompt } from "./sharedTimeline.logic";
import { isSharedNote, usePromptAnswer } from "./sharedTimeline";

/**
 * The note the platform gave the agent with a message (who can write, how to read the author's
 * line), drawn where upstream draws a person's message, as a notice that opens to its words. Its
 * words are the server's, and nothing here reads them. Everything else is `null` and stays
 * upstream's to draw.
 */
export function renderSharedConversationNote(props: {
  readonly message: { readonly text: string };
  readonly timestampLabel?: string | undefined;
}): ReactNode {
  if (!isSharedNote(props.message)) return null;
  return (
    <details className="text-xs text-muted-foreground" data-j5-shared-conversation="note">
      <summary className="cursor-pointer select-none">
        The agent was given a note with the next message
        {props.timestampLabel ? ` · ${props.timestampLabel}` : null}
      </summary>
      <p className="mt-1.5 border-l border-border pl-3 break-words whitespace-pre-wrap">
        {props.message.text}
      </p>
    </details>
  );
}

/**
 * The line above another person's message in a shared conversation: their initials and name, and
 * who edited it while it was queued. The level the agent is told is not drawn (AC17).
 */
export function SharedMessageAuthorLine({ author }: { readonly author: MessageAuthor }) {
  const name = author.name ?? "Someone without a name";
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-j5-shared-conversation="author"
    >
      <PersonAvatar name={author.name} size="xs" />
      <span className="font-medium text-foreground">{name}</span>
      {author.editedBy === null ? null : <span>· edited by {author.editedBy}</span>}
    </p>
  );
}

/**
 * Who answered one of the agent's prompts, after the prompt's own line: "· answered by Priya". It
 * draws nothing for a prompt nobody is recorded as answering, which is every prompt of a thread
 * that is not shared, and nothing for a prompt still open (AC11).
 */
export function PromptAnsweredBy({
  threadRef,
  toolData,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly toolData: unknown;
}) {
  const answer = usePromptAnswer(threadRef, isSettledPrompt(toolData) ? toolData.requestId : null);
  if (answer === undefined) return null;
  return (
    <span className="shrink-0 text-muted-foreground" data-j5-shared-conversation="answered-by">
      · answered by {answer.you ? "you" : (answer.name ?? "someone")}
    </span>
  );
}
