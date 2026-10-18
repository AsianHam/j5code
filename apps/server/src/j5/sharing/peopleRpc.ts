import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import {
  type CreateLinkRequest,
  type DeviceRequest,
  J5_PEOPLE_WS_METHODS,
  type LinkIdRequest,
  type PersonIdRequest,
  type RemoveLevelRequest,
  type RenamePersonRequest,
  type RenameSelfRequest,
  type ScopePeopleRequest,
  type SetLevelRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { failAsJ5ActionError } from "../rpcActionError.ts";
import type { Links } from "./Links.ts";
import type { People } from "./People.ts";
import type { SessionIdentity } from "./PersonAccess.ts";

/**
 * Listing people and links needs upstream's permission to see who has access, and every change to
 * people, levels, devices and links needs its Manage access, which only an Owner's devices hold.
 * Renaming oneself and reading who reaches a thread or project need only what every device holds.
 */
export const PEOPLE_RPC_SCOPES = {
  [J5_PEOPLE_WS_METHODS.listPeople]: AuthAccessReadScope,
  [J5_PEOPLE_WS_METHODS.listScopePeople]: AuthOrchestrationReadScope,
  [J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges]: AuthOrchestrationReadScope,
  [J5_PEOPLE_WS_METHODS.setLevel]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.removeLevel]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.removePerson]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.renamePerson]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.renameSelf]: AuthOrchestrationReadScope,
  [J5_PEOPLE_WS_METHODS.revokeDevice]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.createLink]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.listLinks]: AuthAccessReadScope,
  [J5_PEOPLE_WS_METHODS.revokeLink]: AuthAccessWriteScope,
} as const;

/** What the server refuses in words of its own; anything else is logged and told generally. */
const refused = failAsJ5ActionError({
  refusals: [
    "PersonNotFoundError",
    "FirstOwnerFixedError",
    "OwnerOutsideServerError",
    "ScopeNotFoundError",
    "ScopeNotSharedError",
    "DeviceNotAPersonsError",
    "NotAPersonError",
    "PersonNameError",
    "PersonNameTakenError",
    "PersonAlreadyHereError",
    "LinkForManyIsViewerError",
    "LinkNotFoundError",
    "OwnerNameNeededError",
    "AccessRenewalError",
  ],
  failed: "People and links could not be read or changed.",
});

/**
 * Each request is one call to `People` or `Links`. The person asking, where it matters, is the
 * one the socket's session belongs to, never one the client names.
 */
export const makePeopleRpcHandlers = (options: {
  readonly people: People["Service"];
  readonly links: Links["Service"];
  readonly session: SessionIdentity;
}) => {
  const { people, links, session } = options;
  return {
    [J5_PEOPLE_WS_METHODS.listPeople]: () =>
      people.list(session).pipe(
        Effect.map((entries) => ({ people: entries })),
        Effect.catch(refused),
      ),
    [J5_PEOPLE_WS_METHODS.listScopePeople]: (input: ScopePeopleRequest) =>
      people.scopePeople(session, input.scope).pipe(Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges]: (input: ScopePeopleRequest) =>
      people.watchScopePeople(session, input.scope).pipe(
        Stream.map((revision) => ({ revision })),
        Stream.catch((cause) => Stream.fromEffect(refused(cause))),
      ),
    [J5_PEOPLE_WS_METHODS.setLevel]: (input: SetLevelRequest) =>
      people.setLevel(input).pipe(Effect.as({}), Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.removeLevel]: (input: RemoveLevelRequest) =>
      people.removeLevel(input).pipe(Effect.as({}), Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.removePerson]: (input: PersonIdRequest) =>
      people.remove(input.personId).pipe(Effect.as({}), Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.renamePerson]: (input: RenamePersonRequest) =>
      people.rename(input).pipe(Effect.as({}), Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.renameSelf]: (input: RenameSelfRequest) =>
      people.renameSelf(session, input.name).pipe(Effect.as({}), Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.revokeDevice]: (input: DeviceRequest) =>
      people.revokeDevice(input.sessionId).pipe(Effect.as({}), Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.createLink]: (input: CreateLinkRequest) =>
      links.create(session, input).pipe(Effect.catch(refused)),
    [J5_PEOPLE_WS_METHODS.listLinks]: () =>
      links.list.pipe(
        Effect.map((entries) => ({ links: entries })),
        Effect.catch(refused),
      ),
    [J5_PEOPLE_WS_METHODS.revokeLink]: (input: LinkIdRequest) =>
      links.revoke(input.linkId).pipe(Effect.as({}), Effect.catch(refused)),
  };
};
