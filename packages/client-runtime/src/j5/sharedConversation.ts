import {
  levelReaches,
  type MessageAuthor,
  type PromptAnswer,
  type ScopePerson,
  type ThreadAuthors,
  type ThreadSearchAuthor,
  typedText,
} from "@t3tools/contracts/j5";

export { typedText };

/** A thread's record by message and by prompt, built once per answer the server gives. */
export interface ThreadAuthorIndex {
  readonly authors: ReadonlyMap<string, MessageAuthor>;
  readonly answers: ReadonlyMap<string, PromptAnswer>;
}
const EMPTY_INDEX: ThreadAuthorIndex = { authors: new Map(), answers: new Map() };
const indexes = new WeakMap<ThreadAuthors, ThreadAuthorIndex>();

export function authorIndex(record: ThreadAuthors | null): ThreadAuthorIndex {
  if (record === null) return EMPTY_INDEX;
  const known = indexes.get(record);
  if (known !== undefined) return known;
  const index = {
    authors: new Map(record.authors.map((author) => [author.messageId, author])),
    answers: new Map(record.answers.map((answer) => [answer.requestId, answer])),
  };
  indexes.set(record, index);
  return index;
}

/**
 * Who a message search hit is from, as its label reads: an agent, the reader, or another person by
 * the name the server tells. A user-role hit the server names no one for keeps upstream's "You".
 */
export function threadSearchMatchLabel(match: {
  readonly source: "user" | "assistant";
  readonly author?: ThreadSearchAuthor | undefined;
}): string {
  if (match.source === "assistant") return "Agent";
  if (match.author?._tag === "person") return match.author.name ?? "Someone";
  return "You";
}

// Keyed by the message object the timeline holds, so nothing is kept for a thread off screen.
const notes = new WeakSet<object>();

/** Marks the notice J5 puts in the timeline before a message that carried a note. */
export function markSharedNote<Message extends object>(message: Message): Message {
  notes.add(message);
  return message;
}

/** Whether the timeline's message is the notice J5 put before a message that carried a note. */
export const isSharedNote = (message: object) => notes.has(message);

/**
 * `authored`: shown as typed, with its note to the agent and whose it is. `plain`: no sender
 * recorded, drawn as upstream does. `pending`: no sender read yet and the stored text may begin
 * with lines for the agent, so it shows only as this client's person `typed` it. The sender is
 * read by message id, never its words: anyone can type a line that looks like the platform's.
 */
export type SharedMessageView =
  | { readonly kind: "plain" }
  | {
      readonly kind: "authored";
      readonly typed: string;
      readonly note: string | null;
      readonly author: MessageAuthor;
    }
  | { readonly kind: "pending"; readonly typed: string | null };

export function sharedMessageView(input: {
  readonly text: string;
  /** The server's copy, as against this client's own copy drawn before the server's came. */
  readonly fromServer: boolean;
  readonly author: MessageAuthor | undefined;
  /** A read of who wrote what has come back since this client first saw the server's copy. */
  readonly answeredFor: boolean;
  /**
   * A read may name who wrote a message: more than one person can write to the thread, or did,
   * or the reader is not the first owner.
   */
  readonly mayBeShared: boolean;
  /** What this client's person typed, when they sent it from here. */
  readonly typedHere: string | null;
}): SharedMessageView {
  if (input.author !== undefined) {
    return {
      kind: "authored",
      typed: typedText(input.text, input.author),
      note: input.author.note,
      author: input.author,
    };
  }
  if (!input.fromServer || input.answeredFor || !input.mayBeShared) return { kind: "plain" };
  return { kind: "pending", typed: input.typedHere };
}

/**
 * Up-arrow recall shows each message as the timeline does (`viewOf`, `undefined` if not drawn):
 * authored by the words typed, unrecorded as stored, held back by what this client's person typed
 * or not at all. A line meant for the agent is never recalled, since a draft is not cleaned again.
 */
export function recallableMessages<
  Message extends { readonly role: string; readonly text: string },
>(
  messages: ReadonlyArray<Message>,
  viewOf: (message: Message) => SharedMessageView | undefined,
): ReadonlyArray<Message> {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [message];
    const view = viewOf(message);
    if (view === undefined) return [];
    if (view.kind === "plain") return [message];
    if (view.kind === "authored") return [{ ...message, text: view.typed }];
    return view.typed === null ? [] : [{ ...message, text: view.typed }];
  });
}

/**
 * Whether a read answers for a message: it came back after this client first saw the message.
 * The server records a message's author before the message is committed, and one socket carries
 * both in order, so a read answered before the commit arrives before the message does.
 */
export const readAnswersFor = (input: {
  readonly readAt: number | null;
  readonly firstSeenAt: number;
}) => input.readAt !== null && input.readAt >= input.firstSeenAt;

/**
 * Whether a message nobody is recorded for yet may carry lines for the agent. Who reaches the
 * thread says so as soon as it is shared: more than one writer, or anyone else at all to a reader
 * who is not the first owner. Until the first read answers or fails, any thread may be shared.
 */
export function mayBeSharedConversation(input: {
  readonly record: ThreadAuthors | null;
  readonly failed: boolean;
  readonly people: ReadonlyArray<Pick<ScopePerson, "level" | "you" | "firstOwner">> | null;
}): boolean {
  const reaching = input.people ?? [];
  const writers = reaching.filter((person) => levelReaches(person.level, "collaborator")).length;
  const readsOthers = reaching.length > 1 && !reaching.some((p) => p.you && p.firstOwner);
  return (
    input.record?.shared === true ||
    writers > 1 ||
    readsOthers ||
    (input.record === null && !input.failed)
  );
}

/**
 * When this client first saw each server copy of a person's message, and what its person typed for
 * the messages they sent from here, which are first drawn from what they typed.
 */
export interface SeenSharedMessages {
  readonly firstSeen: ReadonlyMap<string, number>;
  readonly typedHere: ReadonlyMap<string, string>;
  /** Since when this client has held the thread may be shared; null while it holds it isn't. */
  readonly sharedSince: number | null;
}

export const NO_SHARED_MESSAGES_SEEN: SeenSharedMessages = {
  firstSeen: new Map(),
  typedHere: new Map(),
  sharedSince: null,
};

/** `seen` itself when nothing it records has changed, so render stores a new record only then. */
export function observeSharedMessages(
  seen: SeenSharedMessages,
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly createdBy?: unknown;
  }>,
  mayBeShared: boolean,
  now: () => number,
): SeenSharedMessages {
  let at: number | null = null;
  const stamp = () => (at ??= now());
  let firstSeen: Map<string, number> | null = null;
  let typedHere: Map<string, string> | null = null;
  const sharedSince = mayBeShared ? (seen.sharedSince ?? stamp()) : null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (message.createdBy === undefined) {
      if ((typedHere ?? seen.typedHere).get(message.id) === message.text) continue;
      typedHere ??= new Map(seen.typedHere);
      typedHere.set(message.id, message.text);
    } else if (!(firstSeen ?? seen.firstSeen).has(message.id)) {
      firstSeen ??= new Map(seen.firstSeen);
      firstSeen.set(message.id, stamp());
    }
  }
  if (firstSeen === null && typedHere === null && sharedSince === seen.sharedSince) return seen;
  return {
    firstSeen: firstSeen ?? seen.firstSeen,
    typedHere: typedHere ?? seen.typedHere,
    sharedSince,
  };
}

/**
 * Whether nothing more is coming about who wrote a server message, so it need not be held: the
 * read came back after this client first saw it, or it was on screen before the thread could be
 * shared. A row already drawn never leaves the list to wait for a read.
 */
export function sharedMessageAnsweredFor(input: {
  readonly messageId: string;
  readonly readAt: number | null;
  readonly seen: SeenSharedMessages;
}): boolean {
  const firstSeenAt = input.seen.firstSeen.get(input.messageId) ?? Infinity;
  const { sharedSince } = input.seen;
  return (
    readAnswersFor({ readAt: input.readAt, firstSeenAt }) ||
    (sharedSince !== null && firstSeenAt < sharedSince)
  );
}

/**
 * Whether a message left on screen still wants a read: the record may yet name who wrote it, so it
 * is asked once more, though the row stays put meanwhile.
 */
export function sharedMessageAwaitsRead(input: {
  readonly messageId: string;
  readonly readAt: number | null;
  readonly seen: SeenSharedMessages;
  readonly mayBeShared: boolean;
  readonly failed: boolean;
}): boolean {
  return (
    input.mayBeShared &&
    !input.failed &&
    !readAnswersFor({
      readAt: input.readAt,
      firstSeenAt: input.seen.firstSeen.get(input.messageId) ?? Infinity,
    })
  );
}

/**
 * A thread's queued messages with the words their authors typed, for the queue's rows and the
 * composer an edit loads (Shared conversations AC14): the server records a message's author when
 * it is queued. Until the thread's record has been read, or has failed, no queued row is shown,
 * as the timeline holds a message back, so no line meant for the agent is drawn or edited.
 */
export function sharedQueuedRuns<
  Queued extends { readonly run: { readonly userMessageId: string }; readonly text: string },
>(
  result: { readonly record: ThreadAuthors | null; readonly failed: boolean },
  queued: ReadonlyArray<Queued>,
): ReadonlyArray<Queued> {
  const { authors } = authorIndex(result.record);
  if (result.record === null && !result.failed) return [];
  if (authors.size === 0) return queued;
  return queued.map((item) => {
    const author = authors.get(item.run.userMessageId);
    return author === undefined ? item : { ...item, text: typedText(item.text, author) };
  });
}

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
 * One answer to the agent's question as the person gave it. In a shared conversation the server
 * writes its mark, named exactly in `storedPrefix`, at the start of a typed answer, or at the
 * start of the first of the options someone chose. Any other value, and any value that does not
 * begin with the mark, is returned as it is.
 */
function answerWithoutPrefix(answer: unknown, storedPrefix: string): unknown {
  if (storedPrefix === "") return answer;
  const strip = (text: string) =>
    text.startsWith(storedPrefix) ? text.slice(storedPrefix.length) : text;
  if (typeof answer === "string") return strip(answer);
  if (Array.isArray(answer)) {
    const [first, ...rest] = answer as ReadonlyArray<unknown>;
    return typeof first === "string" && first.startsWith(storedPrefix)
      ? [strip(first), ...rest]
      : answer;
  }
  return answer;
}

/** Every answer of a question prompt, each as the person gave it; see `answerWithoutPrefix`. */
export function answersWithoutPrefix<Answers extends Readonly<Record<string, unknown>>>(
  answers: Answers,
  storedPrefix: string,
): Answers {
  return Object.fromEntries(
    Object.entries(answers).map(([question, answer]) => [
      question,
      answerWithoutPrefix(answer, storedPrefix),
    ]),
  ) as Answers;
}
