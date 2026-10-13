import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  J5_SHARING_WS_METHODS,
  type SharingMessageAuthor,
  type SharingPromptAnswer,
} from "@t3tools/contracts/j5";
import { useEffect, useMemo, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useIsGuest } from "./guestAccess";
import {
  authoredMessageIds,
  authorsByMessage,
  mayHaveAuthorLine,
  messagesTheRecordDoesNotHold,
  queuedMessageRules,
  queuedMessageTexts,
  withoutAuthorLine,
  type AuthorsByMessage,
} from "./sharedConversation.logic";

const threadAuthors = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:j5-sharing:thread-authors",
  tag: J5_SHARING_WS_METHODS.listThreadAuthors,
  staleTimeMs: 0,
});

const NO_AUTHORS: AuthorsByMessage = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const NO_ANSWERS: ReadonlyMap<string, SharingPromptAnswer> = new Map();

/**
 * Who wrote each message of a shared conversation and who answered each of the agent's prompts,
 * from the server's record. It is asked only when the thread holds a message that begins as an
 * authored one does, so a thread that was never shared costs nothing. It is asked again when
 * another such message appears or `settled` moves: the server has no feed for it, and a new row
 * only ever comes with a message or an answer the thread's own stream already brings.
 */
export function useThreadAuthors(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  messages: ReadonlyArray<{ readonly id: string | null; readonly text: string }>,
  settled: string,
) {
  const authored = authoredMessageIds(messages);
  const authoredKey = authored.join("|");
  const wanted = environmentId !== null && threadId !== null && authored.length > 0;
  const query = useEnvironmentQuery(
    wanted ? threadAuthors({ environmentId, input: { threadId } }) : null,
  );
  const { refresh } = query;
  useEffect(() => {
    if (wanted) refresh();
  }, [authoredKey, refresh, settled, wanted]);
  const record = query.data;
  const result = useMemo(
    () =>
      record === null || record === undefined
        ? { authors: NO_AUTHORS, answers: NO_ANSWERS }
        : {
            authors: authorsByMessage(record.authors),
            answers: new Map(record.answers.map((answer) => [answer.requestId, answer])),
          },
    [record],
  );
  // What the record turns out not to hold is a line someone typed, and is said to be so once a
  // read made after the message appeared has come back without it.
  const seenUnder = useRef(new Map<string, typeof record>());
  const [unrecorded, setUnrecorded] = useState<ReadonlySet<string>>(NO_IDS);
  useEffect(() => {
    const authoredIds = authoredKey === "" ? [] : authoredKey.split("|");
    for (const id of authoredIds) {
      if (!seenUnder.current.has(id)) seenUnder.current.set(id, record);
    }
    if (record === null || record === undefined) return;
    const typed = messagesTheRecordDoesNotHold({
      authored: authoredIds,
      recorded: result.authors,
      seenUnder: seenUnder.current,
      record,
    });
    setUnrecorded((current) =>
      typed.every((id) => current.has(id)) ? current : new Set([...current, ...typed]),
    );
  }, [authoredKey, record, result.authors]);
  return useMemo(() => ({ ...result, unrecorded }), [result, unrecorded]);
}

// Whose each queued message was, by thread and typed words. A queued message is given a new id
// when its turn starts, so for the moment before the record is read for that id the timeline
// would not know whose it is; the queue did, and this carries it across. Bounded: the oldest
// entries go first.
const queuedAuthors = new Map<string, SharingMessageAuthor>();
const QUEUED_AUTHORS_KEPT = 200;
const queuedAuthorKey = (threadId: string, typed: string) => `${threadId}\n${typed}`;

/** Whose a message just started from the queue was, as the queue knew it; nothing otherwise. */
export const authorWhileQueued = (threadId: string, typed: string) =>
  queuedAuthors.get(queuedAuthorKey(threadId, typed));

/**
 * The queue of a shared conversation as one person may use it: each message with the words its
 * author typed, a name on someone else's, and whether this person may change or withdraw it. A
 * guest neither steers nor reorders. For a thread that is not shared every item is as upstream
 * made it and everything is allowed.
 */
export function useSharedQueue<
  Item extends { readonly messageId: string | null; readonly text: string },
>(environmentId: EnvironmentId, threadId: ThreadId, queued: ReadonlyArray<Item>) {
  const isGuest = useIsGuest(environmentId);
  const { authors, unrecorded } = useThreadAuthors(
    environmentId,
    threadId,
    queued.map((item) => ({ id: item.messageId, text: item.text })),
    "",
  );
  const items = queued.map((item) => {
    const author = item.messageId === null ? undefined : authors.get(item.messageId);
    // Until the record answers for a message, its line for the agent is kept off the queue.
    const waiting =
      author === undefined &&
      item.messageId !== null &&
      !unrecorded.has(item.messageId) &&
      mayHaveAuthorLine(item.text);
    const { typed, shown } = waiting
      ? { typed: withoutAuthorLine(item.text), shown: withoutAuthorLine(item.text) }
      : queuedMessageTexts(item.text, author);
    if (author !== undefined) {
      const key = queuedAuthorKey(threadId, typed);
      queuedAuthors.delete(key);
      queuedAuthors.set(key, author);
      if (queuedAuthors.size > QUEUED_AUTHORS_KEPT) {
        queuedAuthors.delete(queuedAuthors.keys().next().value as string);
      }
    }
    // `text` goes to the editor and back to the server; `preview` is only ever drawn.
    return { ...item, text: typed, preview: shown, ...queuedMessageRules({ isGuest, author }) };
  });
  return { items, mayReorder: !isGuest };
}
