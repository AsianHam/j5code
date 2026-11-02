import { serverToAskNameFor } from "@t3tools/client-runtime/j5/sharing";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { J5_ACCESS_WS_METHODS } from "@t3tools/contracts/j5";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { j5Sharing } from "./guestAccess";

/** What a device does to say whose it is on a server (People and access AC5, AC6). */
export const identityCommands = {
  /** For a device the server cannot place: everyone it could be. */
  claimablePeople: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile-j5-access:claimable",
    tag: J5_ACCESS_WS_METHODS.listClaimablePeople,
    staleTimeMs: 0,
  }),
  claimDevice: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: `mobile-j5:${J5_ACCESS_WS_METHODS.claimDevice}`,
    tag: J5_ACCESS_WS_METHODS.claimDevice,
  }),
  setFirstOwnerName: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: `mobile-j5:${J5_ACCESS_WS_METHODS.setFirstOwnerName}`,
    tag: J5_ACCESS_WS_METHODS.setFirstOwnerName,
  }),
};

/**
 * The servers whose name question was put off with "Not now", until the app next starts. Only
 * that server stays unanswered; every other one is usable meanwhile.
 */
export const putOffNameQuestionsAtom = Atom.make(new Set<EnvironmentId>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-j5:name-question-put-off"),
);

// Every saved server's answer, which each connection asks for when it connects, so this costs no
// request and holds nothing up.
export const nameToAskAtom = Atom.make((get) => {
  const putOff = get(putOffNameQuestionsAtom);
  return serverToAskNameFor(
    [...get(environmentCatalog.catalogValueAtom).entries.keys()]
      .filter((id) => !putOff.has(id))
      .map((id) => ({ id, access: get(j5Sharing.connectionAccess(id)) })),
  );
}).pipe(Atom.withLabel("mobile-j5:name-to-ask"));
