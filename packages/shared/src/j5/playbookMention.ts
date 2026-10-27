export const PLAYBOOK_MENTION_PREFIX = "@playbook:";

/** The text a picker inserts for a chosen playbook; the trailing space closes the mention. */
export const playbookMentionReplacement = (name: string) => `${PLAYBOOK_MENTION_PREFIX}${name} `;

/**
 * Claims every token that starts with `@playbook:` so it never becomes a file search. The query is
 * the raw token after the prefix, so `@playbook:review,` matches no playbook and picking a row
 * never swallows the punctuation typed after it.
 * It shares the `"slash-playbook"` kind; callers tell the forms apart by the text at `rangeStart`.
 */
export function detectPlaybookMention(token: string, start: number, end: number) {
  return token.startsWith(PLAYBOOK_MENTION_PREFIX)
    ? {
        kind: "slash-playbook" as const,
        query: token.slice(PLAYBOOK_MENTION_PREFIX.length),
        rangeStart: start,
        rangeEnd: end,
      }
    : null;
}
