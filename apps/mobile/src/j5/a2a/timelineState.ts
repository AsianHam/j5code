import { useAtomValue } from "@effect/atom-react";
import {
  participantIdsForJ5UserMessage,
  type J5UserMessageInput,
} from "@t3tools/client-runtime/j5/user-message";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { j5Sharing } from "../sharing/guestAccess";
import { useThreadAuthorIndex } from "../sharing/sharedConversation";
import { useParticipantIdentities } from "./participantIdentities";
import type { J5Timeline } from "./timelinePresentation";

/** The reader and the identity read's names for one thread's timeline, read once for its rows. */
export function useJ5Timeline(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messages: ReadonlyArray<J5UserMessageInput>,
): J5Timeline {
  const access = useAtomValue(j5Sharing.connectionAccess(environmentId));
  const { authors } = useThreadAuthorIndex(environmentId, threadId);
  const identities = useParticipantIdentities(
    environmentId,
    messages.flatMap((message) => participantIdsForJ5UserMessage(message)),
  );
  return {
    ...identities,
    environmentId,
    viewerParticipantId: access?.kind === "person" ? access.personId : null,
    sharedAuthors: authors,
  };
}
