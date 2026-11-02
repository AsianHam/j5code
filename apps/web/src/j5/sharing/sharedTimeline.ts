import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { MessageAuthor, PromptAnswer } from "@t3tools/contracts/j5";
import { useEffect, useState } from "react";

import {
  authorIndex,
  mayBeSharedConversation,
  answersWithoutPrefix,
  NO_SHARED_MESSAGES_SEEN,
  observeSharedMessages,
  sharedQueuedRuns,
  isSharedNote,
  markSharedNote,
  recallableMessages,
  type SharedMessageView,
  sharedMessageAnsweredFor,
  sharedMessageAwaitsRead,
  sharedMessageView,
  typedText,
} from "@t3tools/client-runtime/j5/shared-conversation";
import {
  readThreadAuthors,
  useThreadAuthors,
  useThreadAuthorsResult,
  useThreadAuthorsValue,
} from "./sharedConversation";
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
  readonly entry?: {
    readonly questionAnswer?: {
      readonly requestId: string;
      readonly answers: Readonly<Record<string, unknown>>;
    };
  };
}

export { isSharedNote };

// How the timeline last showed each person's message, by the message object it holds, which is
// the one the composer is handed for recall.
const views = new WeakMap<object, SharedMessageView>();

/**
 * Who sent a message of a shared conversation, when it was someone other than the reader:
 * upstream's bubble is then drawn on the left with their name (AC16). Every row of a thread reads
 * the one record the thread's timeline holds.
 */
export function useSharedMessageAuthor(
  thread: ScopedThreadRef | null,
  message: { readonly id: string },
): MessageAuthor | undefined {
  const author = useAnySharedMessageAuthor(thread, message);
  return author === undefined || author.you ? undefined : author;
}

/** Who sent a message of a shared conversation, the reader included. */
export function useAnySharedMessageAuthor(
  thread: ScopedThreadRef | null,
  message: { readonly id: string },
): MessageAuthor | undefined {
  const record = useThreadAuthorsValue(thread?.environmentId ?? null, thread?.threadId ?? null);
  return authorIndex(record).authors.get(message.id);
}

/** Who answered one of the agent's prompts in a shared conversation (AC10). */
export function usePromptAnswer(
  thread: ScopedThreadRef | null,
  requestId: string | null,
): PromptAnswer | undefined {
  const record = useThreadAuthorsValue(thread?.environmentId ?? null, thread?.threadId ?? null);
  return requestId === null ? undefined : authorIndex(record).answers.get(requestId);
}

/**
 * A message's text as its author typed it, for handing back to a composer. The lines the server
 * put on it for the agent are taken off; sent again with them, the agent would read a typed
 * author's line under the real one.
 */
export function sharedMessageTypedText(
  thread: ScopedThreadRef,
  message: { readonly id: string; readonly text: string },
) {
  const author = readThreadAuthors(thread).authors.get(message.id);
  return author === undefined ? message.text : typedText(message.text, author);
}

/**
 * A thread's messages for the composer's up-arrow recall, as its timeline shows them, read
 * as the key is pressed; see `recallableMessages`. `null` for a draft, which holds only what was
 * typed here.
 */
export function sharedPromptHistoryMessages<
  Message extends { readonly role: string; readonly text: string },
>(thread: ScopedThreadRef | null, messages: ReadonlyArray<Message>): ReadonlyArray<Message> {
  if (thread === null) return messages;
  return recallableMessages(messages, (message) => views.get(message));
}

/**
 * A thread's queued messages with the words their authors typed, for the queue's rows and the
 * composer an edit loads (Shared conversations AC14): the server records a message's author when
 * it is queued. Until the thread's record has been read, or has failed, no queued row is shown,
 * as the timeline holds a message back, so no line meant for the agent is drawn or edited.
 */
export function useSharedQueuedRuns<
  Queued extends { readonly run: { readonly userMessageId: string }; readonly text: string },
>(environmentId: EnvironmentId, threadId: ThreadId, queued: ReadonlyArray<Queued>) {
  return sharedQueuedRuns(useThreadAuthorsResult(environmentId, threadId), queued);
}

/**
 * Shared conversations AC16: an authored message is shown as typed, with its note to the agent as a
 * notice just before it. A message whose author is not answered yet is shown as this client's
 * person typed it, or held back until the answer comes, so no line meant for the agent is drawn.
 * Other entries, and all of a thread only one person could write to, are returned as they came.
 */
export function useSharedConversationEntries<Entry extends MessageEntry>(
  threadRef: ScopedThreadRef | null,
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  const { record, readAt, failed, refresh } = useThreadAuthors(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
  );
  const threadScope =
    threadRef === null ? null : { kind: "thread" as const, threadId: threadRef.threadId };
  // The header's pill already reads who reaches the thread; this is the same read.
  const people = useScopePeople(threadRef?.environmentId ?? null, threadScope);

  const [stored, setStored] = useState(NO_SHARED_MESSAGES_SEEN);
  // After the state hook: computed before it, the call stops the compiler memoizing the entries,
  // and ConversationTimeline re-renders forever on entries that change each render.
  const mayBeShared = mayBeSharedConversation({
    record,
    failed,
    people: people.data?.people ?? null,
  });
  const seen = observeSharedMessages(
    stored,
    entries.flatMap((entry) => (entry.message === undefined ? [] : [entry.message])),
    mayBeShared,
    Date.now,
  );
  if (seen !== stored) setStored(seen);

  const shown = (() => {
    const { authors, answers } = authorIndex(record);
    const pending: string[] = [];
    const out = entries.flatMap((entry): ReadonlyArray<Entry> => {
      const questionAnswer = entry.entry?.questionAnswer;
      const answer =
        questionAnswer === undefined ? undefined : answers.get(questionAnswer.requestId);
      if (questionAnswer !== undefined && answer !== undefined && answer.storedPrefix !== "") {
        return [
          {
            ...entry,
            entry: {
              ...entry.entry,
              questionAnswer: {
                ...questionAnswer,
                answers: answersWithoutPrefix(questionAnswer.answers, answer.storedPrefix),
              },
            },
          },
        ];
      }
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
          sharedMessageAnsweredFor({ messageId: message.id, readAt, seen }),
        mayBeShared,
        typedHere: seen.typedHere.get(message.id) ?? null,
      });
      views.set(message, view);
      if (view.kind === "plain") {
        const awaitsRead =
          fromServer &&
          sharedMessageAwaitsRead({ messageId: message.id, readAt, seen, mayBeShared, failed });
        if (awaitsRead) pending.push(message.id);
        return [entry];
      }
      if (view.kind === "pending") {
        pending.push(message.id);
        return view.typed === null ? [] : [{ ...entry, message: { ...message, text: view.typed } }];
      }
      const typed = { ...entry, message: { ...message, text: view.typed } };
      if (view.note === null) return [typed];
      // The note the message carried for the agent, as a notice of its own just before it.
      const note = markSharedNote({ ...message, id: `${message.id}:shared-note`, text: view.note });
      return [{ ...entry, id: `${entry.id}:shared-note`, message: note }, typed];
    });
    return { entries: out, pendingKey: pending.join("|") };
  })();

  // oxlint-disable-next-line t3code/react-effect-budget -- asks once more about a message waiting on its author, in case the change feed is slow.
  useEffect(() => {
    if (shown.pendingKey !== "") refresh();
  }, [refresh, shown.pendingKey]);

  return shown.entries;
}
