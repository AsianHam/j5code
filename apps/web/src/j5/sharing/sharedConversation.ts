import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { J5_SHARING_WS_METHODS, type SharingPromptAnswer } from "@t3tools/contracts/j5";
import { useEffect, useMemo, useRef } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useIsGuest } from "./guestAccess";
import {
  authoredMessageIds,
  authorsByMessage,
  messagesToAskAgainAbout,
  queuedMessageRules,
  queuedMessageTexts,
  type AuthorsByMessage,
} from "./sharedConversation.logic";

const threadAuthors = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:j5-sharing:thread-authors",
  tag: J5_SHARING_WS_METHODS.listThreadAuthors,
  staleTimeMs: 0,
});

const NO_AUTHORS: AuthorsByMessage = new Map();
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
  // A read can cross a message on its way in; what it missed is asked about once more.
  const askedAgain = useRef(new Set<string>());
  useEffect(() => {
    if (record === null || record === undefined) return;
    const missed = messagesToAskAgainAbout({
      authored: authoredKey === "" ? [] : authoredKey.split("|"),
      recorded: result.authors,
      askedAgain: askedAgain.current,
    });
    if (missed.length === 0) return;
    for (const id of missed) askedAgain.current.add(id);
    refresh();
  }, [authoredKey, record, refresh, result.authors]);
  return result;
}

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
  const { authors } = useThreadAuthors(
    environmentId,
    threadId,
    queued.map((item) => ({ id: item.messageId, text: item.text })),
    "",
  );
  const items = queued.map((item) => {
    const author = item.messageId === null ? undefined : authors.get(item.messageId);
    const { typed, shown } = queuedMessageTexts(item.text, author);
    // `text` goes to the editor and back to the server; `preview` is only ever drawn.
    return { ...item, text: typed, preview: shown, ...queuedMessageRules({ isGuest, author }) };
  });
  return { items, mayReorder: !isGuest };
}
