import {
  looksLikeSharedMessage,
  splitSharedMessage,
} from "@t3tools/client-runtime/j5/shared-conversation";
import type { SharingMessageAuthor, SharingPromptAnswer } from "@t3tools/contracts/j5";

/**
 * Whether a text begins the way a person's message in a shared conversation is stored (a note,
 * when it carries one, then the author line); only the server's record says it is one.
 */
export const mayHaveAuthorLine = looksLikeSharedMessage;

/** A message's text as its author typed it, read from the text alone. */
export const withoutAuthorLine = (text: string) => splitSharedMessage(text).typed;

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
  author: Pick<SharingMessageAuthor, "displayName" | "kind" | "you" | "note"> | undefined,
): { readonly typed: string; readonly shown: string } {
  if (author === undefined) return { typed: text, shown: text };
  const { typed } = splitSharedMessage(text, author.note);
  return { typed, shown: author.you ? typed : `${authorName(author)}: ${typed}` };
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

/**
 * Whether the record of who wrote and who answered is asked for at all. A thread that was never
 * shared costs nothing: it is asked only when the thread holds a message stored as a shared
 * conversation stores one, or when a prompt has settled in a thread known to be shared (this
 * connection is a guest's, or someone on the thread can write to it). The second case is a
 * prompt answered before anyone has sent a message, where no stored line says the thread is shared.
 */
export const authorRecordWanted = (input: {
  readonly authoredMessages: number;
  readonly settledPrompts: boolean;
  readonly knownShared: boolean;
}) => input.authoredMessages > 0 || (input.settledPrompts && input.knownShared);

/**
 * How one message of a thread is shown: `null` to leave it as it came, or the words its author
 * typed, the note it carries, and whose it is. The record decides, by the message's id
 * (`recorded`), never by its words: two people can send the same words, and a member can type a
 * line that looks like the platform's. Before the record has answered for a message stored as a
 * shared conversation stores one, the lines for the agent are kept off the screen and the author
 * is the reader, when this client first drew the message from what its person typed
 * (`author: null`), or not known yet (`"waiting"`). A message that does not begin as a stored
 * one, or that the record has been read for and does not hold, is a plain message.
 */
export function sharedMessageView(input: {
  readonly text: string;
  readonly recorded: SharingMessageAuthor | undefined;
  readonly unrecorded: boolean;
  readonly typedHere: boolean;
}): {
  readonly typed: string;
  readonly note: string | null;
  readonly author: SharingMessageAuthor | "waiting" | null;
} | null {
  if (input.recorded !== undefined) {
    const { typed, note } = splitSharedMessage(input.text, input.recorded.note);
    return { typed, note, author: input.recorded };
  }
  if (input.unrecorded) return null;
  const { typed, note, authorLine } = splitSharedMessage(input.text);
  if (authorLine === null) return null;
  return { typed, note, author: input.typedHere ? null : "waiting" };
}

/**
 * Whose a message is that the record does not hold, for a guest reading a shared conversation: a
 * member's, when it is the server's copy (`createdBy` is set; the reader's own copy, drawn before
 * the server's came, has none) and begins with `/`. The server stamps every message a guest sends,
 * and leaves a member's slash command as typed so the agent can run it; so an unstamped command
 * is never the guest's own. Which member sent it is not known. `null` when the message is not
 * such a command, or when the reader is a member, who cannot tell their own from another's.
 */
export function unstampedCommandAuthor(input: {
  readonly readerIsGuest: boolean;
  readonly message: { readonly id: string; readonly text: string; readonly createdBy?: unknown };
}): SharingMessageAuthor | null {
  if (!input.readerIsGuest || input.message.createdBy === undefined) return null;
  if (!input.message.text.trimStart().startsWith("/")) return null;
  return { messageId: input.message.id, displayName: null, kind: "member", you: false, note: null };
}
