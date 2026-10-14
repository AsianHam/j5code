import {
  answersWithoutAuthor,
  sharedNoteText,
} from "@t3tools/client-runtime/j5/shared-conversation";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SharingMessageAuthor, SharingPromptAnswer } from "@t3tools/contracts/j5";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useThreadAuthors } from "./sharedConversation";
import {
  mayHaveAuthorLine,
  settledPromptSignal,
  sharedMessageView,
  unstampedCommandAuthor,
  type AuthorsByMessage,
} from "./sharedConversation.logic";
import { splitSharedMessage } from "@t3tools/client-runtime/j5/shared-conversation";

interface MessageEntry {
  readonly id: string;
  readonly kind: string;
  readonly message?: {
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly createdBy?: unknown;
  };
  readonly entry?: {
    readonly toolData?: unknown;
    readonly questionAnswer?: {
      readonly requestId: string;
      readonly answers: Readonly<Record<string, unknown>>;
    };
  };
}

/**
 * What J5 draws in place of upstream's bubble for a message the timeline holds: another person's
 * message (`author`, or "waiting" for the moment before the record says whose it is), or the
 * notice for the note a message carries.
 */
export type SharedMark =
  | { readonly kind: "message"; readonly author: SharingMessageAuthor | "waiting" }
  | { readonly kind: "note" };

// Keyed by the message object the timeline holds, so nothing is kept for a thread off screen.
const marks = new WeakMap<object, SharedMark>();

/** What J5 draws for this message, or nothing when it is upstream's to draw. */
export const sharedMarkOf = (message: object) => marks.get(message);

// Whose each message of the thread on screen is, for code that holds a message outside the
// timeline, such as the action that puts a reverted message back in the composer.
let recordedAuthors: AuthorsByMessage = new Map();

/**
 * A message's text as its author typed it, for handing back to a composer. A message the server
 * records an author for loses the line that is there for the agent; sent again with it, the agent
 * would read a typed author line under the real one. Any other message is returned as it is.
 */
export function sharedMessageTypedText(message: { readonly id: string; readonly text: string }) {
  const author = recordedAuthors.get(message.id);
  return author === undefined ? message.text : splitSharedMessage(message.text, author.note).typed;
}

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
 * for is shown as what its author typed: the note it carries becomes a notice just before it,
 * and the author line, which is there for the agent, is taken off; whose it is stays with the
 * message for J5's card. An answer to the agent's question loses the line the server put on it,
 * as soon as the thread is known to be shared: the record names its answerer a moment after the
 * answer itself arrives. Every other entry, and every entry of a thread that was never shared, is
 * returned as it came.
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
    if (!record.shared && !messages.some((message) => mayHaveAuthorLine(message.text))) {
      return entries;
    }
    return entries.flatMap((entry): ReadonlyArray<Entry> => {
      const answer = entry.entry?.questionAnswer;
      if (answer !== undefined && (record.shared || record.answers.has(answer.requestId))) {
        return [
          {
            ...entry,
            entry: {
              ...entry.entry,
              questionAnswer: { ...answer, answers: answersWithoutAuthor(answer.answers) },
            },
          },
        ];
      }
      if (entry.message === undefined || entry.message.role !== "user") return [entry];
      const view = sharedMessageView({
        text: entry.message.text,
        recorded: record.authors.get(entry.message.id),
        unrecorded: record.unrecorded.has(entry.message.id),
        typedHere: typedHere.current.has(entry.message.id),
      });
      if (view === null) {
        // A member's slash command, which the server leaves as typed, on a guest's screen.
        const author = unstampedCommandAuthor({
          readerIsGuest: record.guest,
          message: entry.message,
        });
        if (author === null) return [entry];
        const message = { ...entry.message };
        marks.set(message, { kind: "message", author });
        return [{ ...entry, message }];
      }
      const message = { ...entry.message, text: view.typed };
      // The reader's own message stays upstream's bubble; anyone else's is J5's card.
      if (view.author === "waiting" || (view.author !== null && !view.author.you)) {
        marks.set(message, { kind: "message", author: view.author });
      }
      const shown = { ...entry, message };
      if (view.note === null) return [shown];
      // The note the message carried for the agent, as a notice of its own just before it.
      const note = {
        ...entry.message,
        id: `${entry.message.id}:shared-note`,
        text: sharedNoteText(view.note),
      };
      marks.set(note, { kind: "note" });
      return [{ ...entry, id: `${entry.id}:shared-note`, message: note }, shown];
    });
  }, [
    entries,
    messages,
    record.answers,
    record.authors,
    record.guest,
    record.shared,
    record.unrecorded,
  ]);
}
