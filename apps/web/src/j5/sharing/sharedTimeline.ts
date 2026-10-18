import type { ScopedThreadRef } from "@t3tools/contracts";
import type { MessageAuthor, PromptAnswer } from "@t3tools/contracts/j5";
import { levelReaches } from "@t3tools/contracts/j5";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useThreadAuthors } from "./sharedConversation";
import { readAnswersFor, sharedMessageView, typedText } from "./sharedTimeline.logic";
import { useScopePeople } from "./scopeAccess";

interface MessageEntry {
  readonly id: string;
  readonly kind: string;
  readonly message?: {
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly createdBy?: unknown;
  };
}

// Keyed by the message object the timeline holds, so nothing is kept for a thread off screen.
const notes = new WeakSet<object>();

/** Whether the timeline's message is the notice J5 put before a message that carried a note. */
export const isSharedNote = (message: object) => notes.has(message);

// Whose each message of the thread on screen is, and who answered each prompt, for the rows that
// draw them and for code that holds a message outside the timeline, such as the action that puts
// a rewound message back in the composer.
interface OnScreen {
  readonly authors: ReadonlyMap<string, MessageAuthor>;
  readonly answers: ReadonlyMap<string, PromptAnswer>;
}
let onScreen: OnScreen = { authors: new Map(), answers: new Map() };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => onScreen;

/**
 * Who sent a message of the shared conversation on screen, when it was someone other than the
 * reader: upstream's bubble is then drawn on the left with their name (AC17).
 */
export function useSharedMessageAuthor(message: {
  readonly id: string;
}): MessageAuthor | undefined {
  const author = useSyncExternalStore(subscribe, read, read).authors.get(message.id);
  return author === undefined || author.you ? undefined : author;
}

/** Who answered one of the agent's prompts in the shared conversation on screen (AC11). */
export function usePromptAnswer(requestId: string | null): PromptAnswer | undefined {
  const all = useSyncExternalStore(subscribe, read, read);
  return requestId === null ? undefined : all.answers.get(requestId);
}

/**
 * A message's text as its author typed it, for handing back to a composer. The lines the server
 * put on it for the agent are taken off; sent again with them, the agent would read a typed
 * author's line under the real one.
 */
export function sharedMessageTypedText(message: { readonly id: string; readonly text: string }) {
  const author = onScreen.authors.get(message.id);
  return author === undefined ? message.text : typedText(message.text, author);
}

/**
 * A thread's timeline as a shared conversation shows it (Shared conversations AC17). Each
 * person's message the server records an author for is shown as typed, and the note it carried
 * to the agent becomes a notice just before it. A message whose author the server has not
 * answered for yet is shown as this client's person typed it, or held back for the moment until
 * the answer comes, so no line meant for the agent is drawn. Every other entry, and every entry
 * of a thread only one person has ever been able to write to, is returned as it came.
 */
export function useSharedConversationEntries<Entry extends MessageEntry>(
  threadRef: ScopedThreadRef | null,
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  const { record, readAt, failed, refresh } = useThreadAuthors(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
  );
  const threadScope = useMemo(
    () => (threadRef === null ? null : { kind: "thread" as const, threadId: threadRef.threadId }),
    [threadRef],
  );
  // The header's pill already reads who reaches the thread; this is the same read.
  const people = useScopePeople(threadRef?.environmentId ?? null, threadScope);
  const writers = (people.data?.people ?? []).filter((person) =>
    levelReaches(person.level, "collaborator"),
  ).length;
  const mayBeShared = record?.shared === true || writers > 1;

  useEffect(() => {
    onScreen = {
      authors: new Map((record?.authors ?? []).map((author) => [author.messageId, author])),
      answers: new Map((record?.answers ?? []).map((answer) => [answer.requestId, answer])),
    };
    for (const listener of listeners) listener();
  }, [record]);

  // When this client first saw each server copy, and what its person typed for the messages they
  // sent from here, which are first drawn from what they typed.
  const firstSeen = useRef(new Map<string, number>());
  const typedHere = useRef(new Map<string, string>());
  const now = Date.now();
  for (const entry of entries) {
    const message = entry.message;
    if (message === undefined || message.role !== "user") continue;
    if (message.createdBy === undefined) typedHere.current.set(message.id, message.text);
    else if (!firstSeen.current.has(message.id)) firstSeen.current.set(message.id, now);
  }

  const shown = useMemo(() => {
    const authors = new Map((record?.authors ?? []).map((author) => [author.messageId, author]));
    const pending: string[] = [];
    const out = entries.flatMap((entry): ReadonlyArray<Entry> => {
      const message = entry.message;
      if (message === undefined || message.role !== "user") return [entry];
      const fromServer = message.createdBy !== undefined;
      const view = sharedMessageView({
        text: message.text,
        fromServer,
        author: authors.get(message.id),
        answeredFor:
          !fromServer ||
          failed ||
          readAnswersFor({ readAt, firstSeenAt: firstSeen.current.get(message.id) ?? Infinity }),
        mayBeShared,
        typedHere: typedHere.current.get(message.id) ?? null,
      });
      if (view.kind === "plain") return [entry];
      if (view.kind === "pending") {
        pending.push(message.id);
        return view.typed === null ? [] : [{ ...entry, message: { ...message, text: view.typed } }];
      }
      const typed = { ...entry, message: { ...message, text: view.typed } };
      if (view.note === null) return [typed];
      // The note the message carried for the agent, as a notice of its own just before it.
      const note = { ...message, id: `${message.id}:shared-note`, text: view.note };
      notes.add(note);
      return [{ ...entry, id: `${entry.id}:shared-note`, message: note }, typed];
    });
    return { entries: out, pendingKey: pending.join("|") };
  }, [entries, failed, mayBeShared, readAt, record]);

  // A message waiting on its author is asked about once more; the server's change feed usually
  // brings the answer first.
  useEffect(() => {
    if (shown.pendingKey !== "") refresh();
  }, [refresh, shown.pendingKey]);

  return shown.entries;
}
