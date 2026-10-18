import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { J5ActionError, J5_SHARED_CONVERSATION_WS_METHODS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

/** Anyone who can read a thread reads who wrote in it. */
export const SHARED_CONVERSATION_RPC_SCOPES = {
  [J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors]: AuthOrchestrationReadScope,
} as const;

// The wire is fixed so the web client can be built against it; the handler is the shared
// conversation's, built next.
export const makeSharedConversationRpcHandlers = () => ({
  [J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors]: () =>
    Effect.fail(
      new J5ActionError({
        code: "NotBuiltYet",
        message: "This is not available on this server yet.",
      }),
    ),
});
