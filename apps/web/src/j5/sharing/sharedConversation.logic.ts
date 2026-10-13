import type { SharingMessageAuthor, SharingPromptAnswer } from "@t3tools/contracts/j5";

// The line the server puts first on a person's message once a thread is a shared conversation
// (`authorLine` in the server's `j5/sharing/SharedConversation.ts`): "[Message from Priya (guest)]",
// "[Message from a member]", or either followed by ", edited by <the same kind of label>". It is
// matched exactly, with its "(member)" or "(guest)", because J5's older envelopes also begin
// "[Message from …]" (an inbox reply, an automation, an outside agent) and none of those is a
// reason to ask the server who wrote a message.
const AUTHOR_LABEL = "(?:a (?:member|guest)|[^\\]\\n]* \\((?:member|guest)\\))";
const AUTHOR_LINE = new RegExp(
  `^\\[Message from ${AUTHOR_LABEL}(?:, edited by ${AUTHOR_LABEL})?\\]\\n\\n`,
);

/** Whether a text begins the way an authored message does; only the server's record says it is one. */
export const mayHaveAuthorLine = (text: string) => AUTHOR_LINE.test(text);

/** A message's text as its author typed it. */
export const withoutAuthorLine = (text: string) => text.replace(AUTHOR_LINE, "");

export type AuthorsByMessage = ReadonlyMap<string, SharingMessageAuthor>;

export const authorsByMessage = (authors: ReadonlyArray<SharingMessageAuthor>): AuthorsByMessage =>
  new Map(authors.map((author) => [author.messageId, author]));

/**
 * "Priya", or "A guest" for someone the server holds no name for. A parenthesised "member" or
 * "guest" inside a name is left out, as the server leaves it out of the line the agent reads, so
 * the only such word beside a name is the platform's own tag: a guest named "Jackson (member)"
 * is drawn as Jackson, tagged guest.
 */
export function authorName(author: Pick<SharingMessageAuthor, "displayName" | "kind">): string {
  const name = (author.displayName ?? "")
    .replace(/\(\s*(?:member|guest)\s*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name !== "" ? name : author.kind === "guest" ? "A guest" : "A member";
}

/**
 * What one queued message offers one person (Shared conversations AC14 to AC16). A member may
 * change, withdraw and steer any of them. A guest changes and withdraws their own and nothing
 * else, and never steers: the server holds whose each one is and refuses the rest.
 */
export function queuedMessageRules(input: {
  readonly isGuest: boolean;
  readonly author: Pick<SharingMessageAuthor, "you"> | undefined;
}): { readonly mayChange: boolean; readonly maySteer: boolean } {
  if (!input.isGuest) return { mayChange: true, maySteer: true };
  return { mayChange: input.author?.you === true, maySteer: false };
}

/**
 * A queued message's two texts. `typed` is what its author typed: what an editor is handed and
 * what is sent back when it is saved. `shown` is what the queue's line reads, with the name first
 * on someone else's; it is for display only, since the agent would read a name sent back as part
 * of the message. A text the server holds no author for is both, as it is: a line that looks like
 * an author's may have been typed before the thread was shared.
 */
export function queuedMessageTexts(
  text: string,
  author: Pick<SharingMessageAuthor, "displayName" | "kind" | "you"> | undefined,
): { readonly typed: string; readonly shown: string } {
  if (author === undefined) return { typed: text, shown: text };
  const typed = withoutAuthorLine(text);
  return { typed, shown: author.you ? typed : `${authorName(author)}: ${typed}` };
}

const NOTE_OPEN = "<j5_shared_conversation>";
const NOTE_CLOSE = "</j5_shared_conversation>";

/**
 * What the platform told the agent about who can write to the thread, without its tags, or
 * `null` for any other message. Only the platform sends one: a person's message in a shared
 * conversation begins with the author line.
 */
export function sharedConversationNote(message: {
  readonly createdBy?: string | undefined;
  readonly text: string;
}): string | null {
  if (message.createdBy !== "system" || !message.text.startsWith(NOTE_OPEN)) return null;
  const body = message.text.slice(NOTE_OPEN.length).trim();
  return (body.endsWith(NOTE_CLOSE) ? body.slice(0, -NOTE_CLOSE.length) : body).trim();
}

/** "Priya answered", "You answered", "A guest answered": who settled one of the agent's prompts. */
export const answeredBy = (answer: Pick<SharingPromptAnswer, "displayName" | "kind" | "you">) =>
  answer.you ? "You" : authorName(answer);

/** Whether one of the agent's prompts has been settled, read from the thread's own item for it. */
export function isSettledPrompt(toolData: unknown): toolData is {
  readonly type: "approval_request" | "user_input_request";
  readonly requestId: string;
} {
  const item = toolData as
    | { readonly type?: unknown; readonly requestId?: unknown; readonly completedAt?: unknown }
    | undefined;
  return (
    (item?.type === "approval_request" || item?.type === "user_input_request") &&
    typeof item.requestId === "string" &&
    item.completedAt !== null &&
    item.completedAt !== undefined
  );
}

/**
 * What moves when the server's record can have gained a row this client should read: a person's
 * message arriving, or a prompt of the agent's settling. The server records who is answering
 * before a prompt settles, so the name is there by then; a prompt still open is never a reason
 * to read, since an answer the provider goes on to refuse would show a name on it. The agent's
 * own text and work leave the signal as it was.
 */
export function authorRecordSignal(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly message?: { readonly role: string } | undefined;
    readonly entry?: { readonly toolData?: unknown } | undefined;
  }>,
): string {
  const parts: Array<string> = [];
  for (const entry of entries) {
    if (entry.kind === "message") {
      if (entry.message?.role === "user") parts.push(entry.id);
    } else if (isSettledPrompt(entry.entry?.toolData)) parts.push(entry.id);
  }
  return parts.join("|");
}
