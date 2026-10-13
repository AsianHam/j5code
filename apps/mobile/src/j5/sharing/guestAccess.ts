import { useAtomValue } from "@effect/atom-react";
import { createSharingEnvironmentAtoms } from "@t3tools/client-runtime/j5/sharing";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentScope } from "../../state/session";

export const j5Sharing = createSharingEnvironmentAtoms(connectionAtomRuntime);

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

/** The connected servers this person is a guest on, by environment id. */
const guestEnvironmentIdsAtom = Atom.make((get) => {
  const ids = new Set<EnvironmentId>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    if (get(j5Sharing.isGuest(id))) ids.add(id);
  }
  return ids as ReadonlySet<EnvironmentId>;
});

/**
 * The servers whose Personas and Playbooks are not this person's to see or use (Shared server
 * AC24). J5's own pages leave these servers out, and say so when there is no other server.
 */
export function useGuestEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return useAtomValue(guestEnvironmentIdsAtom);
}

/** What J5's Personas and Playbooks pages say when every connected server is a guest one. */
export const GUEST_LIBRARY_UNAVAILABLE =
  "Personas and Playbooks are not available on a server you are a guest on.";

/** Whether there is at least one server and this person is a guest on all of them. */
export function useIsGuestEverywhere(): boolean {
  const guests = useAtomValue(guestEnvironmentIdsAtom);
  const total = useAtomValue(environmentCatalog.catalogValueAtom).entries.size;
  return total > 0 && guests.size === total;
}
