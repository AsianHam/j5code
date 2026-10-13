import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import {
  J5_SHARING_WS_METHODS,
  SharingAccessError,
  type SharingCreateGuestRequest,
  type SharingCreateLinkRequest,
  type SharingCreateOpenLinkRequest,
  type SharingRenamePersonRequest,
  type SharingOpenLinkRequest,
  type SharingDeviceRequest,
  type SharingGrantRequest,
  type SharingLeaveGrantRequest,
  type SharingLinkRequest,
  type SharingPersonRequest,
  type SharingPutGrantRequest,
  type SharingThreadAccess,
  type SharingThreadAccessRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { failAsJ5ActionError } from "../rpcActionError.ts";
import type { OpenLinks } from "./OpenLinks.ts";
import type { People } from "./People.ts";
import type { SharedConversation } from "./SharedConversation.ts";
import {
  type Access,
  GUEST_SESSION_SUBJECT,
  type PersonAccess,
  type SessionIdentity,
} from "./PersonAccess.ts";

/**
 * Listing people needs upstream's permission to see who has access, and every change to people,
 * grants, devices and links needs its Manage access permission (Shared server AC17). A guest's
 * session holds neither, and `GUEST_RPC_RULES` lists none of them. The two requests about a
 * connection's own grants need only what every paired device holds: a guest asks them of itself.
 */
export const SHARING_RPC_SCOPES = {
  [J5_SHARING_WS_METHODS.getConnectionAccess]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.subscribeThreadAccess]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.listOwnGrants]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.leaveGrant]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.listPeople]: AuthAccessReadScope,
  [J5_SHARING_WS_METHODS.createGuest]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.putGrant]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.removeGrant]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.removePerson]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.revokeDevice]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.createLink]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.renamePerson]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.setOwnerName]: AuthAccessWriteScope,
  // Any member reads who is on a thread; a guest reads it of a thread its grants cover.
  [J5_SHARING_WS_METHODS.listThreadPeople]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.subscribeThreadPeopleChanges]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.listThreadAuthors]: AuthOrchestrationReadScope,
  [J5_SHARING_WS_METHODS.revokeLink]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.listOpenLinks]: AuthAccessReadScope,
  [J5_SHARING_WS_METHODS.createOpenLink]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.revokeOpenLink]: AuthAccessWriteScope,
} as const;

/** What the server refuses in words of its own; anything else is logged and told generally. */
const refused = failAsJ5ActionError({
  refusals: [
    "PersonNotFoundError",
    "GrantOnMemberError",
    "MemberNotRemovableError",
    "GrantTargetNotFoundError",
    "DeviceNotAGuestsError",
    "LinkForMemberError",
    "LinkLifetimeError",
    "PersonNameError",
    "PersonNameTakenError",
    "OwnerNameRequiredError",
    "ThreadNotSharedError",
    "LinkNotAGuestsError",
    "NotAGuestError",
    "GrantNotHeldError",
    "OpenLinkNotFoundError",
    "NameNotConfirmedError",
  ],
  failed: "Sharing could not be changed.",
});

const toThreadAccess = (access: Access): SharingThreadAccess =>
  access === "member" ? { kind: "member", level: "collaborate" } : { kind: "guest", level: access };

/**
 * Tells one connection what it holds on a shared server: whether it is a guest's, its level on a
 * thread and its own grants, and lets a guest leave one. Each answers for the session the socket
 * was opened with, so nothing a client sends chooses whose access is read or given up. The rest
 * are the requests of a member who manages access, each one call to `People`. A storage failure
 * is logged here and told to the client plainly.
 */
export const makeSharingRpcHandlers = (options: {
  readonly access: Pick<PersonAccess["Service"], "watchThreadAccess" | "operatorName">;
  readonly people: People["Service"];
  readonly openLinks: OpenLinks["Service"];
  readonly conversation: Pick<SharedConversation, "threadAuthors">;
  readonly session: SessionIdentity;
}) => ({
  [J5_SHARING_WS_METHODS.listThreadAuthors]: (input: SharingThreadAccessRequest) =>
    options.conversation.threadAuthors(options.session, input.threadId).pipe(
      Effect.map((authors) => ({ authors })),
      Effect.catch(refused),
    ),
  [J5_SHARING_WS_METHODS.listOpenLinks]: () =>
    options.openLinks.list.pipe(
      Effect.map((links) => ({ links })),
      Effect.catch(refused),
    ),
  [J5_SHARING_WS_METHODS.createOpenLink]: (input: SharingCreateOpenLinkRequest) =>
    options.openLinks.create(input.threadId, input.lifetime).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.revokeOpenLink]: (input: SharingOpenLinkRequest) =>
    options.openLinks.revoke(input.linkId).pipe(Effect.as({}), Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.listOwnGrants]: () =>
    options.people.ownGrants(options.session).pipe(
      Effect.map((grants) => ({ grants })),
      Effect.catch(refused),
    ),
  [J5_SHARING_WS_METHODS.leaveGrant]: (input: SharingLeaveGrantRequest) =>
    options.people
      .leaveGrant(options.session, input.target)
      .pipe(Effect.as({}), Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.listPeople]: () =>
    options.people.list.pipe(
      Effect.map((people) => ({ people })),
      Effect.catch(refused),
    ),
  [J5_SHARING_WS_METHODS.createGuest]: (input: SharingCreateGuestRequest) =>
    options.people.createGuest(input).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.putGrant]: (input: SharingPutGrantRequest) =>
    options.people.putGrant(input).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.removeGrant]: (input: SharingGrantRequest) =>
    options.people.removeGrant(input).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.removePerson]: (input: SharingPersonRequest) =>
    options.people.removePerson(input.personId).pipe(Effect.as({}), Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.revokeDevice]: (input: SharingDeviceRequest) =>
    options.people.revokeDevice(input.sessionId).pipe(Effect.as({}), Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.createLink]: (input: SharingCreateLinkRequest) =>
    options.people.createLink(input.personId, input.lifetime).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.setOwnerName]: (input: SharingCreateGuestRequest) =>
    options.people.setOwnerName(input).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.renamePerson]: (input: SharingRenamePersonRequest) =>
    options.people.rename(input).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.listThreadPeople]: (input: SharingThreadAccessRequest) =>
    options.openLinks.threadPeople(options.session, input.threadId).pipe(Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.subscribeThreadPeopleChanges]: (input: SharingThreadAccessRequest) =>
    options.openLinks.watchThreadPeople(options.session, input.threadId).pipe(
      Stream.map((revision) => ({ revision })),
      Stream.catch((cause) => Stream.fromEffect(refused(cause))),
    ),
  [J5_SHARING_WS_METHODS.revokeLink]: (input: SharingLinkRequest) =>
    options.people.revokeLink(input.linkId).pipe(Effect.as({}), Effect.catch(refused)),
  [J5_SHARING_WS_METHODS.getConnectionAccess]: () =>
    options.session.subject === GUEST_SESSION_SUBJECT
      ? Effect.succeed({ kind: "guest" as const })
      : // One read per connection, of one row: a member's client learns here whether the owner
        // has a name yet. If it cannot be read the client is told there is none it knows of.
        options.access.operatorName.pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((ownerName) => ({ kind: "member" as const, ownerName })),
        ),
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
