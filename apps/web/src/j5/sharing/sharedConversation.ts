import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { J5_SHARED_CONVERSATION_WS_METHODS, type ThreadAuthors } from "@t3tools/contracts/j5";
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
