import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * What a person's name may be, how long a link lasts, and the mark on a link's address, shared
 * by the people and access requests and the web client
 * (docs/j5/product/features/people-and-access.md).
 */

// Invisible characters (direction marks, zero-width joiners, tag characters) are hidden from
// members but read as letters by a model, so a name drops them. Brackets go too (AC45): a name
// is written into `[Message from Priya (collaborator)]` and into notes an agent reads as markup.
// Parentheses stay: people write names like "Sam (QA)".
const NOT_IN_A_PERSON_NAME = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}[\]<>]/u;
// An accent or a vowel sign is one or two marks on a letter; a longer run stacks marks to draw
// over the lines around it.
const TOO_MANY_MARKS = /\p{M}{3,}/u;
// A level in parentheses is the platform's word on that line, `Priya (collaborator)`, so a name
// that holds one would read there as someone else: "Pat (owner)" collaborating would read as an
// Owner called Pat. Checked in compatibility form, so fullwidth parentheses count too.
const NAMES_A_LEVEL = /\(\s*(?:owner|collaborator|viewer)\s*\)/i;

/**
 * Whether a person's name is one line of visible, ordinary characters, up to 80 of them, with
 * no square or angle brackets and no level in parentheses. A name is shown to everyone on a
 * shared thread and goes on that person's messages to an agent, so it is held to this whoever
 * typed it.
 */
export const isPersonName = (name: string) =>
  name.trim().length > 0 &&
  name.length <= 80 &&
  !NOT_IN_A_PERSON_NAME.test(name) &&
  !TOO_MANY_MARKS.test(name) &&
  !NAMES_A_LEVEL.test(name.normalize("NFKC"));

/** A person's name: what they are called everywhere on the server. */
export const SharingPersonName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.makeFilter((name: string) => isPersonName(name), {
    title:
      "one line of visible characters, with no square or angle brackets and no level in parentheses",
  }),
);

/** How long a link can be used for once made. The dialogs offer exactly these. */
export const SharingLinkLifetime = Schema.Literals(["1h", "24h", "7d", "30d"]);
export type SharingLinkLifetime = typeof SharingLinkLifetime.Type;

/**
 * The mark J5 puts on every link it hands out, in the fragment beside upstream's `token`. The
 * page that opens the link reads it to know the link is J5's before asking the server anything,
 * so a link that no longer works is told apart from a pairing token the server simply does not
 * describe. Upstream reads the fragment as parameters and takes only `token`.
 */
const SHARE_LINK_MARK = "j5share";

/** A pairing address marked as a J5 link's. The Share dialog and the People page mark here. */
export function markedAsShareLink(address: string): string {
  const url = new URL(address);
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
  fragment.set(SHARE_LINK_MARK, "1");
  url.hash = fragment.toString();
  return url.toString();
}

/** Whether an address carries J5's mark. */
export function isMarkedShareLink(address: string): boolean {
  try {
    return new URLSearchParams(new URL(address).hash.replace(/^#/u, "")).has(SHARE_LINK_MARK);
  } catch {
    return false;
  }
}
