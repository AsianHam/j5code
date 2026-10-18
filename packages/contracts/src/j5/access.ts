import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { J5ActionError } from "./actionError.ts";
import { PersonLevel, PersonScope } from "./levels.ts";
import { SharingPersonName } from "./sharing.ts";

/**
 * What one connection is on its server, and the few things it does about its own place there
 * (docs/j5/product/features/people-and-access.md). Every request here answers for the session
 * the socket was opened with: nothing a client sends chooses whose access is read or changed.
 */
export const J5_ACCESS_WS_METHODS = {
  getConnectionAccess: "j5.access.getConnectionAccess",
  /** The level the connection's person holds over one thread, then again each time it changes. */
  subscribeThreadLevel: "j5.access.subscribeThreadLevel",
  /** For a device the server cannot place: everyone it could be, with their levels (AC5). */
  listClaimablePeople: "j5.access.listClaimablePeople",
  claimDevice: "j5.access.claimDevice",
  /** The first owner gives their name on their first device (AC6). */
  setFirstOwnerName: "j5.access.setFirstOwnerName",
  /** A person leaves a scope they hold (AC48). */
  leave: "j5.access.leave",
} as const;

/** Where a device whose session J5 ended for renewal gets a new one, proving itself with the old. */
export const J5_SESSION_RENEW_PATH = "/api/j5/session/renew";

export const HeldPersonLevel = Schema.Struct({ scope: PersonScope, level: PersonLevel });
export type HeldPersonLevel = typeof HeldPersonLevel.Type;

export const ConnectionAccess = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    personId: TrimmedNonEmptyString,
    /** `null` only for a first owner who has not given their name yet. */
    name: Schema.NullOr(Schema.String),
    firstOwner: Schema.Boolean,
    levels: Schema.Array(HeldPersonLevel),
    /** Writes to the whole server: Collaborator or Owner at server scope. */
    wide: Schema.Boolean,
    owner: Schema.Boolean,
    /**
     * For an Owner, how many unused links stopped working when the server moved to levels,
     * while that is recent enough to say; `null` otherwise.
     */
    retiredLinks: Schema.NullOr(Schema.Number),
  }),
  /** A paired device the server cannot place, which says whose it is before anything else. */
  Schema.Struct({ kind: Schema.Literal("unknown") }),
  /** A session that is no person's, such as a peer server's. */
  Schema.Struct({ kind: Schema.Literal("service") }),
]);
export type ConnectionAccess = typeof ConnectionAccess.Type;

export const ThreadLevelRequest = Schema.Struct({ threadId: ThreadId });
export type ThreadLevelRequest = typeof ThreadLevelRequest.Type;

export const ThreadLevel = Schema.Struct({ level: Schema.NullOr(PersonLevel) });
export type ThreadLevel = typeof ThreadLevel.Type;

export const ClaimablePerson = Schema.Struct({
  personId: TrimmedNonEmptyString,
  name: Schema.String,
  levels: Schema.Array(HeldPersonLevel),
});
export type ClaimablePerson = typeof ClaimablePerson.Type;

export const ClaimablePeople = Schema.Struct({ people: Schema.Array(ClaimablePerson) });
export type ClaimablePeople = typeof ClaimablePeople.Type;

export const ClaimDeviceRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("person"), personId: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("new"), name: SharingPersonName }),
]);
export type ClaimDeviceRequest = typeof ClaimDeviceRequest.Type;

export const FirstOwnerNameRequest = Schema.Struct({ name: SharingPersonName });
export type FirstOwnerNameRequest = typeof FirstOwnerNameRequest.Type;

export const LeaveScopeRequest = Schema.Struct({ scope: PersonScope });
export type LeaveScopeRequest = typeof LeaveScopeRequest.Type;

/**
 * What the renewal route answers. `renewed: false` means the session presented is still live
 * and there was nothing to renew. A bearer client is given its new token here; a browser's comes
 * as its cookie.
 */
export const SessionRenewal = Schema.Struct({
  renewed: Schema.Boolean,
  token: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type SessionRenewal = typeof SessionRenewal.Type;

const AccessError = Schema.Union([J5ActionError, EnvironmentAuthorizationError]);
const Done = Schema.Struct({});

export const J5AccessRpcGroup = RpcGroup.make(
  Rpc.make(J5_ACCESS_WS_METHODS.getConnectionAccess, {
    payload: Schema.Struct({}),
    success: ConnectionAccess,
    error: AccessError,
  }),
  Rpc.make(J5_ACCESS_WS_METHODS.subscribeThreadLevel, {
    payload: ThreadLevelRequest,
    success: ThreadLevel,
    error: AccessError,
    stream: true,
  }),
  Rpc.make(J5_ACCESS_WS_METHODS.listClaimablePeople, {
    payload: Schema.Struct({}),
    success: ClaimablePeople,
    error: AccessError,
  }),
  // Ends this device's session for renewal once it is claimed: the client renews and reconnects.
  Rpc.make(J5_ACCESS_WS_METHODS.claimDevice, {
    payload: ClaimDeviceRequest,
    success: Done,
    error: AccessError,
  }),
  Rpc.make(J5_ACCESS_WS_METHODS.setFirstOwnerName, {
    payload: FirstOwnerNameRequest,
    success: Done,
    error: AccessError,
  }),
  Rpc.make(J5_ACCESS_WS_METHODS.leave, {
    payload: LeaveScopeRequest,
    success: Done,
    error: AccessError,
  }),
);
