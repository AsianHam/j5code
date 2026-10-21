import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  J5_SHARED_CONVERSATION_WS_METHODS,
  type ThreadAuthorsRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { failAsJ5ActionError } from "../rpcActionError.ts";
import { type PersonAccessShape, type SessionIdentity, reachPersonId } from "./PersonAccess.ts";
import type { SharedConversationShape } from "./SharedConversation.ts";

/** Anyone who can read a thread reads who wrote in it (the gate checks the thread). */
export const SHARED_CONVERSATION_RPC_SCOPES = {
  [J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors]: AuthOrchestrationReadScope,
  [J5_SHARED_CONVERSATION_WS_METHODS.subscribeThreadAuthorsChanges]: AuthOrchestrationReadScope,
} as const;

const failed = failAsJ5ActionError({
  refusals: [],
  failed: "Reading who wrote in this thread failed.",
});

export const makeSharedConversationRpcHandlers = (input: {
  readonly conversation: SharedConversationShape;
  readonly people: PersonAccessShape;
  readonly session: SessionIdentity;
}) => ({
  [J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors]: (request: ThreadAuthorsRequest) =>
    input.people.sessionReach(input.session).pipe(
      Effect.flatMap((reach) =>
        input.conversation.threadAuthors(reachPersonId(reach), request.threadId),
      ),
      Effect.catch(failed),
    ),
  [J5_SHARED_CONVERSATION_WS_METHODS.subscribeThreadAuthorsChanges]: (
    request: ThreadAuthorsRequest,
  ) => input.conversation.authorsChanges(request.threadId),
});
