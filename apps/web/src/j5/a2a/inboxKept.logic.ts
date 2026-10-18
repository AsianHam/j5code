/**
 * Inbox items someone had typed an answer into when they closed (Inbox AC17): they stay in place,
 * with the words, until the person clears them or leaves the page. `previous` and `current` are
 * the open items before and after a read, `answers` what is typed into each, and `submitting` the
 * item whose answer this client is sending, which closes because of that and is not kept.
 */
export function nextKeptItems<Item>(input: {
  readonly previous: ReadonlyArray<Item>;
  readonly current: ReadonlyArray<Item>;
  readonly kept: ReadonlyMap<string, Item>;
  readonly answers: Readonly<Record<string, string>>;
  readonly submitting: string | null;
  readonly keyOf: (item: Item) => string;
}): ReadonlyMap<string, Item> {
  const open = new Set(input.current.map(input.keyOf));
  const typed = (key: string) => (input.answers[key] ?? "").trim() !== "";
  const next = new Map<string, Item>();
  for (const [key, item] of input.kept) {
    if (!open.has(key) && typed(key)) next.set(key, item);
  }
  for (const item of input.previous) {
    const key = input.keyOf(item);
    if (!open.has(key) && typed(key) && key !== input.submitting) next.set(key, item);
  }
  return next.size === input.kept.size && [...next.keys()].every((key) => input.kept.has(key))
    ? input.kept
    : next;
}

/**
 * Who answered an ask, as the Replied shelf and a kept item say it: "You answered", "Priya
 * answered" (Inbox AC16). `null` when the server names no one.
 */
export function answeredByLine(
  answeredBy: string | null | undefined,
  ownName: string | null,
): string | null {
  if (answeredBy === null || answeredBy === undefined) return null;
  return ownName !== null && answeredBy === ownName ? "You answered" : `${answeredBy} answered`;
}
