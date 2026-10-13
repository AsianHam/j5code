import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { J5_SHARING_WS_METHODS } from "@t3tools/contracts/j5";
import { useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useIsGuest } from "./guestAccess";
import {
  authorsByMessage,
  mayHaveAuthorLine,
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

/**
 * Who wrote each message of a shared conversation, from the server's record. It is asked only
 * when the thread holds a text that begins as an authored one does, so a thread that was never
 * shared costs nothing, and asked again when `changes` does: the server has no feed for it, and
 * a new row only ever comes with a message or an answer the thread's own stream already brings.
 */
export function useThreadAuthors(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  texts: ReadonlyArray<string>,
  changes: string,
): AuthorsByMessage {
  const wanted = environmentId !== null && threadId !== null && texts.some(mayHaveAuthorLine);
  const query = useEnvironmentQuery(
    wanted ? threadAuthors({ environmentId, input: { threadId } }) : null,
  );
  const { refresh } = query;
  useEffect(() => {
    if (wanted) refresh();
  }, [changes, refresh, wanted]);
  const authors = query.data?.authors;
  return useMemo(() => (authors === undefined ? NO_AUTHORS : authorsByMessage(authors)), [authors]);
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
  const authors = useThreadAuthors(
    environmentId,
    threadId,
    queued.map((item) => item.text),
    queued.map((item) => item.messageId).join(),
  );
  const items = queued.map((item) => {
    const author = item.messageId === null ? undefined : authors.get(item.messageId);
    const { typed, shown } = queuedMessageTexts(item.text, author);
    // `text` goes to the editor and back to the server; `preview` is only ever drawn.
    return { ...item, text: typed, preview: shown, ...queuedMessageRules({ isGuest, author }) };
  });
  return { items, mayReorder: !isGuest };
}
