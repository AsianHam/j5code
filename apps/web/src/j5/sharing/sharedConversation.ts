import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  authorIndex,
  type ThreadAuthorIndex,
} from "@t3tools/client-runtime/j5/shared-conversation";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ThreadAuthors } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { j5Sharing } from "../state";

/**
 * Reads a thread's atoms again when the thread comes to be listed. A draft keeps the id its thread
 * will have, and a person narrower than the server is refused a thread the server does not have
 * yet; the refusal would otherwise stay with that id after the thread exists.
 */
export function useRereadWhenListed(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  read: Atom.Atom<unknown> | null,
  changes: Atom.Atom<unknown> | null,
) {
  const listed =
    useThreadShell(
      environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
    ) !== null;
  const wasListed = useRef(listed);
  // oxlint-disable-next-line t3code/react-effect-budget -- rereads a shared conversation when its thread is listed again, which the server's snapshot decides.
  useEffect(() => {
    if (listed && !wasListed.current) {
      if (read !== null) appAtomRegistry.refresh(read);
      if (changes !== null) appAtomRegistry.refresh(changes);
    }
    wasListed.current = listed;
  }, [listed, read, changes]);
}

const { threadAuthors, threadAuthorsChanges } = j5Sharing;

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
  const target =
    environmentId === null || threadId === null ? null : { environmentId, input: { threadId } };
  const query = target === null ? null : threadAuthors(target);
  const changes = target === null ? null : threadAuthorsChanges(target);
  const authors = useEnvironmentQuery(query);
  const revision = useEnvironmentQuery(changes).data?.revision;
  useRereadWhenListed(environmentId, threadId, query, changes);
  // oxlint-disable-next-line t3code/react-effect-budget -- rereads message authors when the server's change counter moves.
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
