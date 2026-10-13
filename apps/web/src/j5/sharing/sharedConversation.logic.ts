import type { SharingMessageAuthor } from "@t3tools/contracts/j5";

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
