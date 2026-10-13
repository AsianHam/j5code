/** The line the Share dialog and the promotion dialog put under Collaborate. */
export const COLLABORATE_DESCRIPTION = "Also send messages to the agent and answer its prompts.";

/**
 * Whether raising someone to Collaborate must first send their name. A name they typed when they
 * joined is confirmed by a member sending it, changed or not, and the server refuses Collaborate
 * until then (Shared server AC27). A name a member gave is sent only when it was changed.
 */
export const promotionSendsName = (input: {
  readonly name: string;
  readonly typed: string;
  readonly nameSelfGiven: boolean;
}) => input.nameSelfGiven || input.typed.trim() !== input.name;

/**
 * The name to show the member again before anything is saved, or `null` to go ahead. The dialog
 * opens with a person's name and may stay open while someone else renames them; saving would
 * then write the older name back over the newer one unseen. `seen` is the stored name the member
 * last had in front of them, `stored` the one the server holds now (`null` while it is not known).
 */
export const nameToShowAgain = (input: {
  readonly seen: string;
  readonly stored: string | null;
}): string | null => (input.stored !== null && input.stored !== input.seen ? input.stored : null);
