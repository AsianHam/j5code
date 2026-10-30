import { detectPlaybookMention } from "./playbookMention.ts";

export { PLAYBOOK_MENTION_PREFIX, playbookMentionReplacement } from "./playbookMention.ts";

export const PERSONA_MENTION_PREFIX = "@persona:";

/** The text a picker inserts for a chosen persona; the trailing space closes the mention. */
export const agentMentionReplacement = (personaId: string) =>
  `${PERSONA_MENTION_PREFIX}${personaId} `;

/**
 * The J5 token-level hook both composer trigger detectors call before bare-`@` file search. It
 * serves `@persona:` and `@playbook:`; the playbook mention rides the `"slash-playbook"` kind.
 */
export function detectAgentMention(token: string, start: number, end: number) {
  return (
    detectPlaybookMention(token, start, end) ??
    (token.startsWith(PERSONA_MENTION_PREFIX)
      ? {
          kind: "agent" as const,
          query: token.slice(PERSONA_MENTION_PREFIX.length),
          rangeStart: start,
          rangeEnd: end,
        }
      : null)
  );
}

/** An unquoted `@persona:` or `@playbook:` token is a mention, never a file chip. */
export const isJ5MentionPath = (path: string) =>
  path.startsWith("persona:") || path.startsWith("playbook:");
