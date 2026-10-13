import type { PersonKind } from "./PersonAccess.ts";

/**
 * How a person is named in the text an agent reads: on the author line of their messages, in the
 * platform's notes, and on a reply they send from the inbox.
 */

// The name rule already refuses brackets and line breaks (`isPersonName`). They are taken out
// here as well, so that a name which reached the record some other way cannot close the line
// early or open what looks like a second one. A parenthesised "member" or "guest" in a name is
// taken out too, so the only such word on the line is the platform's, at the end: a guest named
// "Jackson (member)" is written `Jackson (guest)`. The name is first put in its compatibility
// form, so that fullwidth or other look-alike brackets are the plain ones this looks for. Angle
// brackets go as square ones do: a name sits inside the platform's note, which a tag closes.
export const personNameInLine = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/\(\s*(?:member|guest)\s*\)/gi, " ")
    .replace(/[[\]<>\s]+/g, " ")
    .trim();

/** How an author is named to the agent: `Priya (guest)`, `Jackson (member)`, `a member`. */
export const authorLabel = (author: {
  readonly kind: PersonKind;
  readonly displayName: string | null;
}) => {
  const name = author.displayName === null ? "" : personNameInLine(author.displayName);
  return name.length === 0 ? `a ${author.kind}` : `${name} (${author.kind})`;
};
