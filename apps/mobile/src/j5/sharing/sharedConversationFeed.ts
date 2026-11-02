import {
  answersWithoutPrefix,
  authorIndex,
  markSharedNote,
  mayBeSharedConversation,
  type SeenSharedMessages,
  sharedMessageAnsweredFor,
  sharedMessageAwaitsRead,
  sharedMessageView,
} from "@t3tools/client-runtime/j5/shared-conversation";
import { MessageId } from "@t3tools/contracts";
import type { ScopePerson, ThreadAuthors } from "@t3tools/contracts/j5";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

/**
 * The native feed as a shared conversation shows it (`useSharedConversationFeed`), with the ids of
 * the messages still waiting on their author's read.
 */
export function presentSharedConversationFeed(input: {
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly record: ThreadAuthors | null;
  readonly failed: boolean;
  /** When the latest read came back; null before one has. */
  readonly readAt: number | null;
  readonly seen: SeenSharedMessages;
  /** Who reaches the thread; null until that read answers, or when it fails. */
  readonly people: ReadonlyArray<ScopePerson> | null;
}): { readonly feed: ReadonlyArray<ThreadFeedEntry>; readonly pendingKey: string } {
  const { record, failed, readAt, seen } = input;
  const mayBeShared = mayBeSharedConversation({ record, failed, people: input.people });
  const { authors, answers } = authorIndex(record);
  const pending: string[] = [];
  const shown = input.feed.flatMap((entry): ReadonlyArray<ThreadFeedEntry> => {
    if (entry.type === "activity-group") {
      if (answers.size === 0) return [entry];
      const activities = entry.activities.map((activity) => {
        const questionAnswer = activity.workEntry.questionAnswer;
        const answer =
          questionAnswer === undefined ? undefined : answers.get(questionAnswer.requestId);
        if (questionAnswer === undefined || answer === undefined || answer.storedPrefix === "") {
          return activity;
        }
        return {
          ...activity,
          workEntry: {
            ...activity.workEntry,
            questionAnswer: {
              ...questionAnswer,
              answers: answersWithoutPrefix(questionAnswer.answers, answer.storedPrefix),
            },
          },
        };
      });
      return [{ ...entry, activities }];
    }
    if (entry.type !== "message" || entry.message.role !== "user") return [entry];
    const { message } = entry;
    const fromServer = message.createdBy !== undefined;
    const view = sharedMessageView({
      text: message.text,
      fromServer,
      author: authors.get(message.id),
      answeredFor:
        !fromServer || failed || sharedMessageAnsweredFor({ messageId: message.id, readAt, seen }),
      mayBeShared,
      typedHere: seen.typedHere.get(message.id) ?? null,
    });
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
    const note = markSharedNote({
      ...message,
      id: MessageId.make(`${message.id}:shared-note`),
      text: view.note,
    });
    return [{ ...entry, id: `${entry.id}:shared-note`, message: note }, typed];
  });

  return { feed: shown, pendingKey: pending.join("|") };
}
