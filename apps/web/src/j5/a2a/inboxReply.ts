/** The sentence the platform puts after a person's inbox reply, closing the agent's ask. */
export const CLOSED_DELIVERY_INSTRUCTION =
  "The platform closed this exchange when this reply was sent. No further reply is required.";

/**
 * A person's inbox reply as the words they typed, once the lines before it are taken off: the
 * platform's closing sentence follows the words, and goes too. `null` for any other text.
 */
export function inboxReplyWords(text: string): string | null {
  const ending = `\n\n${CLOSED_DELIVERY_INSTRUCTION}`;
  return text.endsWith(ending) ? text.slice(0, -ending.length) : null;
}
