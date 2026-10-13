import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { ThreadId } from "../baseSchemas.ts";

/**
 * What a connection is told about its own place on a shared server
 * (docs/j5/product/features/shared-server.md). A member's connection reaches everything, so it is
 * told once that it is a member's and asks nothing more. A guest's is told the level it holds on
 * each thread it opens, worked out by the server: a grant covers the agents beneath a thread and
 * the threads of a granted project, which a client cannot tell from the grants themselves.
 */
export const J5_SHARING_WS_METHODS = {
  getConnectionAccess: "j5.sharing.getConnectionAccess",
  subscribeThreadAccess: "j5.sharing.subscribeThreadAccess",
} as const;

export const SharingConnectionKind = Schema.Literals(["member", "guest"]);
export type SharingConnectionKind = typeof SharingConnectionKind.Type;

/** The level a guest holds on one thread; `none` when no grant covers it. */
export const SharingThreadLevel = Schema.Literals(["view", "collaborate", "none"]);
export type SharingThreadLevel = typeof SharingThreadLevel.Type;

export const SharingConnectionAccess = Schema.Struct({ kind: SharingConnectionKind });
export type SharingConnectionAccess = typeof SharingConnectionAccess.Type;

export const SharingThreadAccessRequest = Schema.Struct({ threadId: ThreadId });
export type SharingThreadAccessRequest = typeof SharingThreadAccessRequest.Type;

export const SharingThreadAccess = Schema.Struct({
  kind: SharingConnectionKind,
  /** A member's connection is not held to a level, and is always told `collaborate`. */
  level: SharingThreadLevel,
});
export type SharingThreadAccess = typeof SharingThreadAccess.Type;

export class SharingAccessError extends Schema.TaggedError<SharingAccessError>()(
  "SharingAccessError",
  { message: Schema.String },
) {}

export const J5SharingRpcGroup = RpcGroup.make(
  Rpc.make(J5_SHARING_WS_METHODS.getConnectionAccess, {
    payload: Schema.Struct({}),
    success: SharingConnectionAccess,
    error: Schema.Union([SharingAccessError, EnvironmentAuthorizationError]),
  }),
  // The current level, then the new one each time a change to the guest's grants alters it.
  Rpc.make(J5_SHARING_WS_METHODS.subscribeThreadAccess, {
    payload: SharingThreadAccessRequest,
    success: SharingThreadAccess,
    error: Schema.Union([SharingAccessError, EnvironmentAuthorizationError]),
    stream: true,
  }),
);
