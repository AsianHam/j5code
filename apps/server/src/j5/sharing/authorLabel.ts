import type { WriterLevel } from "@t3tools/contracts/j5";

/**
 * How a person is named in the text an agent reads: on the author line of their messages, in the
 * platform's notes, and on a reply they send from the inbox.
 */

// The name rule already refuses brackets, line breaks and a level in parentheses
// (`isPersonName`), so the line carries the name exactly as it is stored and two people never
// read as one. Brackets and line breaks are taken out here as well, so that a name which reached
// the record some other way cannot close the line early or open what looks like a second one,
// after the name is put in its compatibility form, so that fullwidth or other look-alike brackets
// are the plain ones this looks for. Angle brackets go as square ones do: a name sits inside the
// platform's note, which a tag closes.
export const personNameInLine = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/[[\]<>\s]+/g, " ")
    .trim();

/** How an author is named to the agent: `Priya (collaborator)`, or `an owner` with no name. */
export const authorLabel = (author: {
  readonly level: WriterLevel;
  readonly displayName: string | null;
}) => {
  const name = author.displayName === null ? "" : personNameInLine(author.displayName);
  if (name.length > 0) return `${name} (${author.level})`;
  return author.level === "owner" ? "an owner" : "a collaborator";
};

/**
 * Whether a message begins with a slash: its first character that is not whitespace is `/`.
 * Upstream and the providers read a command from the start of a message (`/compact`, `/goal`, a
 * provider's own commands and skills), trimming it the same way. Such a message goes on exactly
 * as typed, with no author's line and no note, whoever sent it (AC5), so that the command is
 * still one.
 */
export const beginsWithSlash = (text: string) => text.trimStart().startsWith("/");
