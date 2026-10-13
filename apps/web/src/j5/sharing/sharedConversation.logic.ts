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
 * The messages whose text begins as an authored one does: the ones the server's record is asked
 * about. A person's own message is first drawn from what they typed, with no such line, and gains
 * it when the server's copy arrives, which is when its author row can be read; so the list moves
 * at the right moment, where the message's id alone appears too early.
 */
export function authoredMessageIds(
  messages: ReadonlyArray<{ readonly id: string | null; readonly text: string }>,
): ReadonlyArray<string> {
  return messages.flatMap((message) =>
    message.id !== null && mayHaveAuthorLine(message.text) ? [message.id] : [],
  );
}

/**
 * The authored-looking messages the record does not hold, now that it has been read since each
 * one appeared: lines someone typed, such as before the thread was shared. `seenUnder` is the
 * record the client held when it first saw each message; a different record now is a later read.
 * One read settles it: the server writes a message's author before the message itself, and a
 * read asked for while another is out is sent again, so a read made after a message arrived
 * cannot miss its author.
 */
export function messagesTheRecordDoesNotHold<Record>(input: {
  readonly authored: ReadonlyArray<string>;
  readonly recorded: { has(messageId: string): boolean };
  readonly seenUnder: {
    has(messageId: string): boolean;
    get(messageId: string): Record | undefined;
  };
  readonly record: Record;
}): ReadonlyArray<string> {
  return input.authored.filter(
    (id) =>
      !input.recorded.has(id) &&
      input.seenUnder.has(id) &&
      input.seenUnder.get(id) !== input.record,
  );
}

/**
 * How a message stands with the server's record, which decides whose it is. "recorded": the
 * record names its author. "plain": it does not begin as an authored message does, or the record
 * has been read for it and does not hold it, so it is a line someone typed. "waiting": it begins
 * as an authored one does and the record has not answered for it yet, a moment in which the line
 * is kept off the screen: "own" when this client first drew the message from what its person
 * typed, "unknown" otherwise.
 */
export function messageStanding(input: {
  readonly looksAuthored: boolean;
  readonly recorded: boolean;
  /** The record was read for this message and does not hold it. */
  readonly unrecorded: boolean;
  /** This client drew the message before the server's copy, without an author line. */
  readonly typedHere: boolean;
}): "recorded" | "plain" | "waiting-own" | "waiting-unknown" {
  if (input.recorded) return "recorded";
  if (!input.looksAuthored || input.unrecorded) return "plain";
  return input.typedHere ? "waiting-own" : "waiting-unknown";
}

/**
 * The agent's prompts that have settled, as one value that moves when another does. The server
 * records who is answering before a prompt settles, so the name is there by then; a prompt still
 * open is never a reason to read, since an answer the provider goes on to refuse would show a
 * name on it.
 */
export function settledPromptSignal(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly entry?: { readonly toolData?: unknown } | undefined;
  }>,
): string {
  return entries
    .flatMap((entry) =>
      entry.kind !== "message" && isSettledPrompt(entry.entry?.toolData) ? [entry.id] : [],
    )
    .join("|");
}
