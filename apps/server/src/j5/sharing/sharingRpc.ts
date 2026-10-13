import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  J5_SHARING_WS_METHODS,
  SharingAccessError,
  type SharingThreadAccess,
  type SharingThreadAccessRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  type Access,
  GUEST_SESSION_SUBJECT,
  type PersonAccess,
  type SessionIdentity,
} from "./PersonAccess.ts";

export const SHARING_RPC_SCOPES = {
  [J5_SHARING_WS_METHODS.getConnectionAccess]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.subscribeThreadAccess]: AuthOrchestrationReadScope,
} as const;

const toThreadAccess = (access: Access): SharingThreadAccess =>
  access === "member" ? { kind: "member", level: "collaborate" } : { kind: "guest", level: access };

/**
 * Tells one connection what it holds on a shared server: whether it is a guest's, and its level on
 * a thread. Both answer for the session the socket was opened with, so nothing a client sends
 * chooses whose access is read. A storage failure is logged here and told to the client plainly.
 */
export const makeSharingRpcHandlers = (options: {
  readonly access: Pick<PersonAccess["Service"], "watchThreadAccess">;
  readonly session: SessionIdentity;
}) => ({
  [J5_SHARING_WS_METHODS.getConnectionAccess]: () =>
    Effect.succeed({
      kind: options.session.subject === GUEST_SESSION_SUBJECT ? "guest" : "member",
    } as const),
  [J5_SHARING_WS_METHODS.subscribeThreadAccess]: (input: SharingThreadAccessRequest) =>
    options.access.watchThreadAccess(options.session, input.threadId).pipe(
      Stream.map(toThreadAccess),
      Stream.catch((cause) =>
        Stream.fromEffect(
          Effect.logError("J5 sharing could not read a thread's access", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new SharingAccessError({ message: "Could not read what is shared with you." }),
              ),
            ),
          ),
        ),
      ),
    ),
});
