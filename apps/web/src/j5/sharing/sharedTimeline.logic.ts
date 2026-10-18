import type { MessageAuthor } from "@t3tools/contracts/j5";

/**
 * A message's words as its author typed them: the stored text without the platform's lines at its
 * start (the note, the author's line and any edited-by line), which the server names exactly in
 * `storedPrefix` so that nothing here reads their format. Text that does not begin with them is
 * returned as it is.
 */
export function typedText(text: string, author: Pick<MessageAuthor, "storedPrefix">): string {
  return author.storedPrefix !== "" && text.startsWith(author.storedPrefix)
    ? text.slice(author.storedPrefix.length)
    : text;
}

/**
 * How one person's message in a thread is shown:
 * - `authored`: the server records who sent it. It is shown as typed, with the note it carried
 *   to the agent, and whose it is.
 * - `plain`: the server has answered for it and records no one, so it is a message as upstream
 *   draws it, from before the thread was shared or from a thread only one person writes to.
 * - `pending`: the server's copy has arrived but no read of who sent it has come back since. Its
 *   stored text may begin with lines for the agent, so it is shown as this client's person typed
 *   it when they sent it here (`typed`), and otherwise not yet.
 *
 * Whose a message is is read by its id, never from its words: two people can send the same words,
 * and anyone can type a line that looks like the platform's.
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
  /** The thread can be a shared conversation: more than one person can write to it, or did. */
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
 * Whether a read answers for a message: it came back after this client first saw the message.
 * The server records a message's author before the message is committed, and one socket carries
 * both in order, so a read answered before the commit arrives before the message does.
 */
export const readAnswersFor = (input: {
  readonly readAt: number | null;
  readonly firstSeenAt: number;
}) => input.readAt !== null && input.readAt >= input.firstSeenAt;

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
 * writes its mark, named exactly in `storedPrefix`, at the start of a typed answer, or as the
 * first of the options someone chose. Any other value, and any value that does not carry the
 * mark, is returned as it is.
 */
export function answerWithoutPrefix(answer: unknown, storedPrefix: string): unknown {
  if (storedPrefix === "") return answer;
  if (typeof answer === "string") {
    return answer.startsWith(storedPrefix) ? answer.slice(storedPrefix.length) : answer;
  }
  if (Array.isArray(answer)) {
    const [first, ...rest] = answer as ReadonlyArray<unknown>;
    // The mark stands alone as the first option, without its trailing space.
    return first === storedPrefix.trimEnd() ? rest : answer;
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
