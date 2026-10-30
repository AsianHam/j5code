import type { WriterLevel } from "@t3tools/contracts/j5";

/**
 * How a person is named in the text an agent reads: on the author line of their messages, in the
 * platform's notes, and on a reply they send from the inbox.
 */

// `isPersonName` already refuses brackets, line breaks and a parenthesized level, so two people
// never read as one. These are stripped here too, after compatibility folding catches look-alikes,
// for a name that reached the record another way; angle brackets go as well, since a name sits
// inside the platform's note, which a tag would close.
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
 * Whether the first non-whitespace character is `/`. Upstream and providers read commands
 * (`/compact`, skills) from a message's start, so such a message goes on exactly as typed, with no
 * author's line or note, whoever sent it (AC5).
 */
export const beginsWithSlash = (text: string) => text.trimStart().startsWith("/");
