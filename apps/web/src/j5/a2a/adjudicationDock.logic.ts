import type { ThreadCrewMembership } from "@t3tools/contracts/j5";

interface AskLike {
  readonly exchangeId: string;
  readonly senderThreadId: string | null;
  readonly status: "open" | "answered";
  readonly openedAt: string;
}

/** The excerpt is three lines; a body past that, or very long, offers "Show full question". */
const EXCERPT_LINES = 3;
const EXCERPT_CHARACTERS = 240;

export const hasMoreThanExcerpt = (message: string): boolean =>
  message.split("\n").length > EXCERPT_LINES || message.length > EXCERPT_CHARACTERS;

/**
 * The asks pinned above a thread's composer, oldest first: the open asks this thread made to the
 * person, read from the same list the Inbox shows, plus an ask a refused answer left behind for as
 * long as the person's words are still in its box.
 */
export function adjudicationAsks<Ask extends AskLike>(input: {
  readonly items: ReadonlyArray<Ask>;
  readonly refused: ReadonlyArray<Ask>;
  readonly threadId: string | null | undefined;
  readonly hasWords: (exchangeId: string) => boolean;
}): ReadonlyArray<Ask> {
  if (input.threadId == null) return [];
  const open = input.items.filter(
    (item) => item.status === "open" && item.senderThreadId === input.threadId,
  );
  const openIds = new Set(open.map((item) => item.exchangeId));
  const kept = input.refused.filter(
    (item) => !openIds.has(item.exchangeId) && input.hasWords(item.exchangeId),
  );
  return [...open, ...kept].toSorted(
    (left, right) =>
      left.openedAt.localeCompare(right.openedAt) ||
      left.exchangeId.localeCompare(right.exchangeId),
  );
}

/**
 * The ask shown in full, and the rest behind the "more questions" row. The person's pick wins
 * while it is still pinned; otherwise the oldest.
 */
export function pickShownAsk<Ask extends { readonly exchangeId: string }>(
  asks: ReadonlyArray<Ask>,
  pickedExchangeId: string | null,
): { readonly shown: Ask; readonly others: ReadonlyArray<Ask> } | null {
  const shown = asks.find((ask) => ask.exchangeId === pickedExchangeId) ?? asks[0];
  if (shown === undefined) return null;
  return { shown, others: asks.filter((ask) => ask !== shown) };
}

/** The refusals that mean someone else's answer, or the agent's withdrawal, closed the ask first. */
const CLOSED_ASK_CODES: ReadonlySet<string> = new Set([
  "A2AExchangeNotOpenError",
  "A2AExchangeAlreadyAnsweredError",
  "A2AAskAnsweredError",
]);

export const isAskAlreadyClosed = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  CLOSED_ASK_CODES.has(error.code);

/** Only a Captain's asks are pinned in its thread; every other agent's ask stays in the Inbox. */
export const commandsACrew = (membership: ThreadCrewMembership | undefined): boolean =>
  membership?.kind === "captain" && membership.crews.length > 0;
