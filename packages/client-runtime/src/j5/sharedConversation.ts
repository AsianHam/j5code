/**
 * How a client reads what a shared conversation stores (Shared conversations AC2 to AC9). The
 * server writes lines for the agent into a person's message and into an answer to the agent's
 * question; a client shows the person's own words and draws the rest as its own. These functions
 * only split text. Whose a message is, and whether it really carries a note, is the server's
 * record (`j5.sharing.listThreadAuthors`): a person could have typed a line that looks the same.
 */

const NOTE_OPEN = "<j5_shared_conversation>";
const NOTE_CLOSE = "</j5_shared_conversation>";

// `authorLine` in the server's `j5/sharing/SharedConversation.ts`: "[Message from Priya (guest)]",
// "[Message from a member]", or either followed by ", edited by <the same kind of label>". It is
// matched exactly, with its "(member)" or "(guest)", because J5's older envelopes also begin
// "[Message from …]" (an inbox reply, an automation, an outside agent) and none of those is a
// person's message in a shared conversation.
const LABEL = "(?:a (?:member|guest)|[^\\]\\n]* \\((?:member|guest)\\))";
const AUTHOR_LINE = `\\[Message from ${LABEL}(?:, edited by ${LABEL})?\\]\\n\\n`;
const NOTE_BLOCK = `${NOTE_OPEN}[\\s\\S]*?${NOTE_CLOSE}`;
// A stored message: the note when it carries one, a line break, the author line, a blank line,
// then what the person typed.
const STORED = new RegExp(`^(?:(${NOTE_BLOCK})\\n)?${AUTHOR_LINE}`);
const ANSWER_LINE = new RegExp(`^\\[Answer from ${LABEL}\\]`);

/** Whether a text begins the way a person's message in a shared conversation is stored. */
export const looksLikeSharedMessage = (text: string): boolean => STORED.test(text);

/**
 * A stored message split into what its author typed, the note it carries and the author line as
 * written. `recordedNote` is the record's own note for the message when the record has answered
 * (`null` for none); left out, the note is read from the text, for the moment before the record
 * answers. A text that does not begin as a stored message is returned whole, as typed.
 */
export function splitSharedMessage(
  text: string,
  recordedNote?: string | null,
): { readonly typed: string; readonly note: string | null; readonly authorLine: string | null } {
  const known = typeof recordedNote === "string" && text.startsWith(`${recordedNote}\n`);
  const afterNote = known ? text.slice(recordedNote.length + 1) : text;
  const match = STORED.exec(afterNote);
  if (match === null) return { typed: text, note: null, authorLine: null };
  // A block ahead of the author line that the record does not own is not the platform's: the
  // record said this message carries no note, or a different one.
  const read = match[1] ?? null;
  const note = known ? recordedNote : recordedNote === undefined ? read : null;
  if (known && read !== null) return { typed: text, note: null, authorLine: null };
  const lineStart = read === null ? 0 : read.length + 1;
  return {
    typed: afterNote.slice(match[0].length),
    note,
    authorLine: afterNote.slice(lineStart, match[0].length - 2),
  };
}

/** A note's words, without the tags the agent reads it by. */
export function sharedNoteText(note: string): string {
  const body = note.startsWith(NOTE_OPEN) ? note.slice(NOTE_OPEN.length) : note;
  return (
    body.trimEnd().endsWith(NOTE_CLOSE) ? body.trimEnd().slice(0, -NOTE_CLOSE.length) : body
  ).trim();
}

/**
 * One answer to the agent's question as the person gave it. In a shared conversation the server
 * puts "[Answer from Priya (guest)]" before a typed answer and first among chosen options, for
 * the agent. A value of any other shape is returned as it is.
 */
export function answerWithoutAuthor<Answer>(answer: Answer): Answer {
  if (typeof answer === "string") {
    return answer.replace(ANSWER_LINE, "").replace(/^ /, "") as Answer;
  }
  if (Array.isArray(answer)) {
    const [first, ...rest] = answer as ReadonlyArray<unknown>;
    return (
      typeof first === "string" && ANSWER_LINE.test(first) && first.replace(ANSWER_LINE, "") === ""
        ? rest
        : answer
    ) as Answer;
  }
  return answer;
}

/** Every answer of a question prompt, each as the person gave it. */
export function answersWithoutAuthor<Answers extends Readonly<Record<string, unknown>>>(
  answers: Answers,
): Answers {
  return Object.fromEntries(
    Object.entries(answers).map(([question, answer]) => [question, answerWithoutAuthor(answer)]),
  ) as Answers;
}
