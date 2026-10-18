import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  J5_SHARED_CONVERSATION_WS_METHODS,
  type MessageAuthor,
  type PromptAnswer,
  type ThreadAuthors,
} from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentQuery } from "../../state/query";

const threadAuthors = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:j5-shared-conversation:authors",
  tag: J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors,
  staleTimeMs: 0,
});
const threadAuthorsChanges = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:j5-shared-conversation:authors-changes",
  tag: J5_SHARED_CONVERSATION_WS_METHODS.subscribeThreadAuthorsChanges,
});

/**
 * Who sent each message of a thread and who answered each of the agent's prompts, from the
 * server's record (Shared conversations), read again each time the server says it changed.
 * `readAt` is when the latest read came back, `null` before one has. A server that cannot answer
 * leaves the thread as upstream draws it.
 */
export function useThreadAuthors(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): {
  readonly record: ThreadAuthors | null;
  readonly readAt: number | null;
  /** The latest read failed, as on a server without the record: nothing is held for it. */
  readonly failed: boolean;
  readonly refresh: () => void;
} {
  const target = useMemo(
    () =>
      environmentId === null || threadId === null ? null : { environmentId, input: { threadId } },
    [environmentId, threadId],
  );
  const query = target === null ? null : threadAuthors(target);
  const authors = useEnvironmentQuery(query);
  const revision = useEnvironmentQuery(target === null ? null : threadAuthorsChanges(target)).data
    ?.revision;
  useEffect(() => {
    if (query !== null && revision !== undefined && revision > 0) appAtomRegistry.refresh(query);
  }, [query, revision]);
  return {
    record: authors.data,
    readAt: authors.data === null ? null : authors.dataUpdatedAt,
    failed: authors.error !== null,
    refresh: authors.refresh,
  };
}

const NO_RECORD = Atom.make(AsyncResult.initial(false)) as ReturnType<typeof threadAuthors>;

/**
 * The record as the thread's timeline last read it, for each row and the queue: they read it and
 * ask nothing, so a thread with many messages opens one read and one change feed, not one each.
 */
export function useThreadAuthorsValue(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ThreadAuthors | null {
  return useThreadAuthorsResult(environmentId, threadId).record;
}

/** The same, with whether the latest read failed, as on a server without the record. */
export function useThreadAuthorsResult(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): { readonly record: ThreadAuthors | null; readonly failed: boolean } {
  const result = useAtomValue(
    environmentId === null || threadId === null
      ? NO_RECORD
      : threadAuthors({ environmentId, input: { threadId } }),
  );
  return {
    record: Option.getOrNull(AsyncResult.value(result)),
    failed: AsyncResult.isFailure(result),
  };
}

/** A thread's record by message and by prompt, built once per answer the server gives. */
export interface ThreadAuthorIndex {
  readonly authors: ReadonlyMap<string, MessageAuthor>;
  readonly answers: ReadonlyMap<string, PromptAnswer>;
}
const EMPTY_INDEX: ThreadAuthorIndex = { authors: new Map(), answers: new Map() };
const indexes = new WeakMap<ThreadAuthors, ThreadAuthorIndex>();

export function authorIndex(record: ThreadAuthors | null): ThreadAuthorIndex {
  if (record === null) return EMPTY_INDEX;
  const known = indexes.get(record);
  if (known !== undefined) return known;
  const index = {
    authors: new Map(record.authors.map((author) => [author.messageId, author])),
    answers: new Map(record.answers.map((answer) => [answer.requestId, answer])),
  };
  indexes.set(record, index);
  return index;
}

/**
 * The same record for code that is not rendering, such as the action that puts a rewound message
 * back in the composer. It reads what the thread's view already holds.
 */
export function readThreadAuthors(thread: ScopedThreadRef): ThreadAuthorIndex {
  const result = appAtomRegistry.get(
    threadAuthors({ environmentId: thread.environmentId, input: { threadId: thread.threadId } }),
  );
  return authorIndex(Option.getOrNull(AsyncResult.value(result)));
}
