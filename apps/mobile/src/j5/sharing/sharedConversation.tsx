import { useAtomValue } from "@effect/atom-react";
import {
  authorIndex,
  isSettledPrompt,
  mayBeSharedConversation,
  NO_SHARED_MESSAGES_SEEN,
  observeSharedMessages,
  sharedQueuedRuns,
  type ThreadAuthorIndex,
} from "@t3tools/client-runtime/j5/shared-conversation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadAuthors } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { appAtomRegistry } from "../../state/atom-registry";
import { j5Sharing } from "./guestAccess";
import { presentSharedConversationFeed } from "./sharedConversationFeed";

const NO_RECORD = Atom.make(AsyncResult.initial(false)) as ReturnType<
  typeof j5Sharing.threadAuthors
>;
const NO_CHANGES = Atom.make(AsyncResult.initial(false)) as ReturnType<
  typeof j5Sharing.threadAuthorsChanges
>;
const NO_PEOPLE = Atom.make(AsyncResult.initial(false)) as ReturnType<typeof j5Sharing.scopePeople>;
const NO_PEOPLE_CHANGES = Atom.make(AsyncResult.initial(false)) as ReturnType<
  typeof j5Sharing.scopePeopleChanges
>;

/**
 * Who reaches a thread, read again whenever the server says it changed, so a thread shared while
 * it is open is known to be shared before anyone else's first message arrives.
 */
function useThreadPeople(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const target =
    environmentId === null || threadId === null
      ? null
      : { environmentId, input: { scope: { kind: "thread" as const, threadId } } };
  const query = target === null ? NO_PEOPLE : j5Sharing.scopePeople(target);
  const people = useAtomValue(query);
  const changes = useAtomValue(
    target === null ? NO_PEOPLE_CHANGES : j5Sharing.scopePeopleChanges(target),
  );
  const revision = Option.getOrNull(AsyncResult.value(changes))?.revision;
  // oxlint-disable-next-line t3code/react-effect-budget -- rereads who reaches the thread when the server's change counter moves.
  useEffect(() => {
    if (revision !== undefined && revision > 0) appAtomRegistry.refresh(query);
  }, [query, revision]);
  return Option.getOrNull(AsyncResult.value(people))?.people ?? null;
}

function useThreadAuthorsResult(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const result = useAtomValue(
    environmentId === null || threadId === null
      ? NO_RECORD
      : j5Sharing.threadAuthors({ environmentId, input: { threadId } }),
  );
  const record: ThreadAuthors | null = Option.getOrNull(AsyncResult.value(result));
  return {
    record,
    failed: AsyncResult.isFailure(result),
    readAt: result._tag === "Success" ? result.timestamp : null,
  };
}

/**
 * The thread's record as its timeline last read it, by message and by prompt. Rows, the queue and
 * the work log read it and ask nothing; the timeline's own read keeps it current.
 */
export function useThreadAuthorIndex(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ThreadAuthorIndex {
  return authorIndex(useThreadAuthorsResult(environmentId, threadId).record);
}

/** The queue's rows with the words their authors typed (Shared conversations AC14). */
export function useSharedQueuedRuns<
  Queued extends { readonly run: { readonly userMessageId: string }; readonly text: string },
>(environmentId: EnvironmentId, threadId: ThreadId, queued: ReadonlyArray<Queued>) {
  return sharedQueuedRuns(useThreadAuthorsResult(environmentId, threadId), queued);
}

/**
 * Shared conversations AC16 for the native timeline (`presentSharedConversationFeed`), from the
 * record of who sent each message and who reaches the thread, each read again whenever the server
 * says it changed.
 */
export function useSharedConversationFeed(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  feed: ReadonlyArray<ThreadFeedEntry>,
): ReadonlyArray<ThreadFeedEntry> {
  const target =
    environmentId === null || threadId === null ? null : { environmentId, input: { threadId } };
  const query = target === null ? NO_RECORD : j5Sharing.threadAuthors(target);
  const { record, failed, readAt } = useThreadAuthorsResult(environmentId, threadId);
  const people = useThreadPeople(environmentId, threadId);
  const changes = useAtomValue(
    target === null ? NO_CHANGES : j5Sharing.threadAuthorsChanges(target),
  );
  const revision = Option.getOrNull(AsyncResult.value(changes))?.revision;
  // oxlint-disable-next-line t3code/react-effect-budget -- rereads message authors when the server's change counter moves.
  useEffect(() => {
    if (revision !== undefined && revision > 0) appAtomRegistry.refresh(query);
  }, [query, revision]);

  const [stored, setStored] = useState(NO_SHARED_MESSAGES_SEEN);
  const seen = observeSharedMessages(
    stored,
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    mayBeSharedConversation({ record, failed, people }),
    Date.now,
  );
  if (seen !== stored) setStored(seen);

  const { feed: shown, pendingKey } = presentSharedConversationFeed({
    feed,
    record,
    failed,
    readAt,
    seen,
    people,
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- asks once more about a message waiting on its author, in case the change feed is slow.
  useEffect(() => {
    if (pendingKey !== "") appAtomRegistry.refresh(query);
  }, [pendingKey, query]);

  return shown;
}

/**
 * The end of a work row for one of the agent's prompts: the answer, then who gave it (AC10). The
 * question truncates before either. Who is drawn only for a prompt someone is recorded as answering.
 */
export function PromptAnswerTail(props: {
  readonly environmentId: EnvironmentId;
  readonly item: { readonly threadId: ThreadId };
  readonly answer: string | null;
}) {
  const { answers } = useThreadAuthorIndex(props.environmentId, props.item.threadId);
  const by = isSettledPrompt(props.item) ? answers.get(props.item.requestId) : undefined;
  return (
    <>
      {props.answer === null ? null : (
        <Text numberOfLines={1} className="max-w-[45%] shrink pl-1 text-sm text-foreground">
          {props.answer}
        </Text>
      )}
      {by === undefined ? null : (
        <Text numberOfLines={1} className="shrink-0 pl-1 text-sm text-foreground-subtle">
          · answered by {by.you ? "you" : (by.name ?? "someone")}
        </Text>
      )}
    </>
  );
}
