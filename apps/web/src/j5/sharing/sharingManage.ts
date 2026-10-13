import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { J5_SHARING_WS_METHODS } from "@t3tools/contracts/j5";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";
import { NAME_IN_USE } from "./shareLink.logic";

const command = <Tag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(tag: Tag) =>
  createEnvironmentRpcCommand(connectionAtomRuntime, { label: `environment-data:${tag}`, tag });

/**
 * What a member who manages access does on a shared server (Shared server AC17 to AC20). Each
 * command's `permissionAtom` says whether this connection holds "Manage access" there, and the
 * server checks again when it runs.
 */
export const sharingManage = {
  people: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-sharing:people",
    tag: J5_SHARING_WS_METHODS.listPeople,
    staleTimeMs: 0,
    // The server moves this when a person, grant, device or link changes, here or on another
    // client; a link that expires by time does not move it.
    refreshTrigger: j5Environment.rereadOn("sharing"),
  }),
  openLinks: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-sharing:open-links",
    tag: J5_SHARING_WS_METHODS.listOpenLinks,
    staleTimeMs: 0,
    refreshTrigger: j5Environment.rereadOn("sharing"),
  }),
  // Names the person the server belongs to; a guest and an agent know them by it.
  setOwnerName: command(J5_SHARING_WS_METHODS.setOwnerName),
  createGuest: command(J5_SHARING_WS_METHODS.createGuest),
  putGrant: command(J5_SHARING_WS_METHODS.putGrant),
  createLink: command(J5_SHARING_WS_METHODS.createLink),
  createOpenLink: command(J5_SHARING_WS_METHODS.createOpenLink),
  revokeOpenLink: command(J5_SHARING_WS_METHODS.revokeOpenLink),
  removeGrant: command(J5_SHARING_WS_METHODS.removeGrant),
  removePerson: command(J5_SHARING_WS_METHODS.removePerson),
  revokeDevice: command(J5_SHARING_WS_METHODS.revokeDevice),
  revokeLink: command(J5_SHARING_WS_METHODS.revokeLink),
  // Renaming also confirms a name a guest gave themselves; the two are one request.
  renamePerson: command(J5_SHARING_WS_METHODS.renamePerson),
};

export const peopleQuery = (environmentId: EnvironmentId) =>
  sharingManage.people({ environmentId, input: {} });
export const openLinksQuery = (environmentId: EnvironmentId) =>
  sharingManage.openLinks({ environmentId, input: {} });

/** Reads both lists again after a change this client made. */
export function refreshSharing(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(peopleQuery(environmentId));
  appAtomRegistry.refresh(openLinksQuery(environmentId));
}

// The server shows a link's secret once, when it is made. What this client made is kept here
// until the page is closed, as upstream's Connections settings keep the pairing links they made,
// so a link can be copied again from this client and from no other.
const madeHere = new Map<string, string>();

export const rememberLinkSecret = (linkId: string, secret: string) => {
  madeHere.set(linkId, secret);
};
export const linkSecretMadeHere = (linkId: string) => madeHere.get(linkId) ?? null;

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
