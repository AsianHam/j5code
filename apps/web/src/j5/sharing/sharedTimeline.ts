import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SharingMessageAuthor, SharingPromptAnswer } from "@t3tools/contracts/j5";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useThreadAuthors } from "./sharedConversation";
import { authorRecordSignal, withoutAuthorLine } from "./sharedConversation.logic";

interface MessageEntry {
  readonly id: string;
  readonly kind: string;
  readonly message?: { readonly id: string; readonly role: string; readonly text: string };
}

// Whose each drawn message is, for the card that draws another person's. Keyed by the message
// object the timeline holds, so nothing is kept for a thread that is no longer on screen.
const authorOfMessage = new WeakMap<object, SharingMessageAuthor>();

/** Who the server records as having written this message, or nothing for any other message. */
export const sharedAuthorOf = (message: object) => authorOfMessage.get(message);

// Who answered each prompt of the thread on screen, for the line a settled prompt carries.
let answers: ReadonlyMap<string, SharingPromptAnswer> = new Map();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Who answered one of the agent's prompts in the shared conversation on screen, if anyone is recorded. */
export function usePromptAnswer(requestId: string | null): SharingPromptAnswer | undefined {
  const all = useSyncExternalStore(
    subscribe,
    () => answers,
    () => answers,
  );
  return requestId === null ? undefined : all.get(requestId);
}

/**
 * A thread's timeline as a shared conversation shows it. A message the server records an author
 * for loses its first line, "[Message from …]", which is there for the agent; whose it is stays
 * with the message for J5's card. Every other entry, and every entry of a thread that was never
 * shared, is returned as it came.
 */
export function useSharedConversationEntries<Entry extends MessageEntry>(
  threadRef: ScopedThreadRef | null,
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  const texts = useMemo(
    () => entries.flatMap((entry) => (entry.message?.role === "user" ? [entry.message.text] : [])),
    [entries],
  );
  const record = useThreadAuthors(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
    texts,
    authorRecordSignal(entries),
  );
  useEffect(() => {
    answers = record.answers;
    for (const listener of listeners) listener();
  }, [record.answers]);
  return useMemo(() => {
    if (record.authors.size === 0) return entries;
    return entries.map((entry) => {
      const author = entry.message === undefined ? undefined : record.authors.get(entry.message.id);
      if (entry.message === undefined || author === undefined) return entry;
      const message = { ...entry.message, text: withoutAuthorLine(entry.message.text) };
      authorOfMessage.set(message, author);
      return { ...entry, message };
    });
  }, [entries, record.authors]);
}
