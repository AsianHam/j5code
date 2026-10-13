import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SharingMessageAuthor, SharingPromptAnswer } from "@t3tools/contracts/j5";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useThreadAuthors } from "./sharedConversation";
import {
  mayHaveAuthorLine,
  messageStanding,
  settledPromptSignal,
  withoutAuthorLine,
} from "./sharedConversation.logic";

interface MessageEntry {
  readonly id: string;
  readonly kind: string;
  readonly message?: { readonly id: string; readonly role: string; readonly text: string };
}

// Whose each drawn message is, for the card that draws another person's. Keyed by the message
// object the timeline holds, so nothing is kept for a thread that is no longer on screen.
const authorOfMessage = new WeakMap<object, SharingMessageAuthor | "waiting">();

/**
 * Who the server records as having written this message; "waiting" for one whose answer has not
 * come yet and that this client did not draw from its own person's typing; nothing otherwise.
 */
export const sharedAuthorOf = (message: object) => authorOfMessage.get(message);

// Whose each message of the thread on screen is, for code that holds a message outside the
// timeline, such as the action that puts a reverted message back in the composer.
let recordedAuthors: { has(messageId: string): boolean } = new Set<string>();

/**
 * A message's text as its author typed it, for handing back to a composer. A message the server
 * records an author for loses the line that is there for the agent; sent again with it, the agent
 * would read a typed author line under the real one. Any other message is returned as it is.
 */
export const sharedMessageTypedText = (message: { readonly id: string; readonly text: string }) =>
  recordedAuthors.has(message.id) ? withoutAuthorLine(message.text) : message.text;

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
  const messages = useMemo(
    () => entries.flatMap((entry) => (entry.message?.role === "user" ? [entry.message] : [])),
    [entries],
  );
  const record = useThreadAuthors(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
    messages,
    settledPromptSignal(entries),
  );
  useEffect(() => {
    answers = record.answers;
    for (const listener of listeners) listener();
  }, [record.answers]);
  useEffect(() => {
    recordedAuthors = record.authors;
  }, [record.authors]);
  // The messages this client drew from what its person typed, before the server's copy came.
  const typedHere = useRef(new Set<string>());
  for (const message of messages) {
    if (!mayHaveAuthorLine(message.text)) typedHere.current.add(message.id);
  }
  return useMemo(() => {
    if (!messages.some((message) => mayHaveAuthorLine(message.text))) return entries;
    return entries.map((entry) => {
      if (entry.message === undefined || entry.message.role !== "user") return entry;
      const author = record.authors.get(entry.message.id);
      const standing = messageStanding({
        looksAuthored: mayHaveAuthorLine(entry.message.text),
        recorded: author !== undefined,
        unrecorded: record.unrecorded.has(entry.message.id),
        typedHere: typedHere.current.has(entry.message.id),
      });
      if (standing === "plain") return entry;
      const message = { ...entry.message, text: withoutAuthorLine(entry.message.text) };
      // Until the record answers, the reader's own message stays their own bubble and anyone
      // else's is a card with no name yet; neither shows the line meant for the agent.
      if (author !== undefined) authorOfMessage.set(message, author);
      else if (standing === "waiting-unknown") authorOfMessage.set(message, "waiting");
      return { ...entry, message };
    });
  }, [entries, messages, record.authors, record.unrecorded]);
}
