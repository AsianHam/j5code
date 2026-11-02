import { useAtomValue } from "@effect/atom-react";
import {
  createSharingEnvironmentAtoms,
  createSharingOwnershipAtoms,
} from "@t3tools/client-runtime/j5/sharing";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentScope } from "../../state/session";
import { j5Environment } from "../state";

/** What this device's connection is on each server; read again when people or levels change. */
export const j5Sharing = createSharingEnvironmentAtoms(connectionAtomRuntime, {
  rereadOn: j5Environment.rereadOn("sharing"),
});

const NOTHING_WITHHELD = Atom.make(true);

/**
 * Whether this connection may write to a thread: upstream's server-wide "Operate tasks"
 * permission, and for a guest's connection also a Collaborate level on that thread. The chat
 * view calls this where it read the permission alone, so a guest with View gets what upstream
 * already shows a connection that lacks it. For a member's connection it is upstream's answer.
 */
export function useCanOperateThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): boolean {
  const permitted = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const shared = useAtomValue(
    environmentId === null ? NOTHING_WITHHELD : j5Sharing.threadOperable(environmentId, threadId),
  );
  return permitted && shared;
}

const ownership = createSharingOwnershipAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  sharing: j5Sharing,
});

/**
 * The connected servers this person owns, which are the ones Settings, Personas and Playbooks
 * manage (People and access AC27). One that has not answered yet is counted, so an Owner's page
 * does not flicker.
 */
export function useOwnedEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return useAtomValue(ownership.ownedEnvironmentIds);
}

/** Whether the person owns a connected server, or `"loading"`; see `ownerSomewhereState`. */
export function useOwnerSomewhere(): boolean | "loading" {
  return useAtomValue(ownership.ownerSomewhere);
}

/** Whether the person can write to anything on a connected server, so has an agent to ask. */
export function useWritesSomewhere(): boolean {
  return useAtomValue(ownership.writesSomewhere);
}
