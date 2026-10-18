import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { J5_ACCESS_WS_METHODS, J5_PEOPLE_WS_METHODS } from "@t3tools/contracts/j5";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment, j5Sharing } from "../state";
import { NAME_IN_USE } from "./shareLink.logic";

const command = <Tag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(tag: Tag) =>
  createEnvironmentRpcCommand(connectionAtomRuntime, { label: `environment-data:${tag}`, tag });

/**
 * What a person does about people and access on one server (People and access). Each command's
 * `permissionAtom` says whether this device holds what the request needs there: an Owner's
 * changes need upstream's "Manage access", which only an Owner's devices hold, and a person's
 * own requests need only what every device holds. The server checks again when each runs.
 */
export const sharingManage = {
  /** Everyone on the server, for an Owner. */
  people: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-people:list",
    tag: J5_PEOPLE_WS_METHODS.listPeople,
    staleTimeMs: 0,
    // The server moves this when a person, level, device or link changes, here or on another
    // client; a link that expires by time does not move it.
    refreshTrigger: j5Environment.rereadOn("sharing"),
  }),
  links: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-people:links",
    tag: J5_PEOPLE_WS_METHODS.listLinks,
    staleTimeMs: 0,
    refreshTrigger: j5Environment.rereadOn("sharing"),
  }),
  /** Who reaches one thread or project, for anyone who reaches it (AC26). */
  scopePeople: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-people:scope",
    tag: J5_PEOPLE_WS_METHODS.listScopePeople,
    staleTimeMs: 0,
  }),
  scopePeopleChanges: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-people:scope-changes",
    tag: J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges,
  }),
  /** For a device the server cannot place: everyone it could be (AC5). */
  claimablePeople: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-access:claimable",
    tag: J5_ACCESS_WS_METHODS.listClaimablePeople,
    staleTimeMs: 0,
  }),
  setLevel: command(J5_PEOPLE_WS_METHODS.setLevel),
  removeLevel: command(J5_PEOPLE_WS_METHODS.removeLevel),
  removePerson: command(J5_PEOPLE_WS_METHODS.removePerson),
  renamePerson: command(J5_PEOPLE_WS_METHODS.renamePerson),
  renameSelf: command(J5_PEOPLE_WS_METHODS.renameSelf),
  revokeDevice: command(J5_PEOPLE_WS_METHODS.revokeDevice),
  createLink: command(J5_PEOPLE_WS_METHODS.createLink),
  revokeLink: command(J5_PEOPLE_WS_METHODS.revokeLink),
  claimDevice: command(J5_ACCESS_WS_METHODS.claimDevice),
  setFirstOwnerName: command(J5_ACCESS_WS_METHODS.setFirstOwnerName),
  leave: command(J5_ACCESS_WS_METHODS.leave),
};

export const peopleQuery = (environmentId: EnvironmentId) =>
  sharingManage.people({ environmentId, input: {} });
export const linksQuery = (environmentId: EnvironmentId) =>
  sharingManage.links({ environmentId, input: {} });

/** Reads the server's people, links and this connection's own access again after a change here. */
export function refreshSharing(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(peopleQuery(environmentId));
  appAtomRegistry.refresh(linksQuery(environmentId));
  j5Sharing.refreshConnectionAccess(appAtomRegistry, environmentId);
}

/**
 * What the server said when it refused, shown to the person as it is. A name that is someone
 * else's gets one wording wherever a name is typed.
 */
export function refusalMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  if (nameIsInUse(error)) return NAME_IN_USE;
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The server did not say why.";
}

const refusalCode = (error: unknown) => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

/** Whether a refusal is the server's "that name is someone else's", by the refusal's stable name. */
export const nameIsInUse = (error: unknown) => refusalCode(error) === "PersonNameTakenError";
