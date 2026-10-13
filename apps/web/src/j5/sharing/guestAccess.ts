import { useAtomValue } from "@effect/atom-react";
import { createSharingEnvironmentAtoms } from "@t3tools/client-runtime/j5/sharing";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { SharingThreadLevel } from "@t3tools/contracts/j5";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentScope } from "../../state/session";
import { provideSharingMenuGuestRead } from "./sharingMenu";
import { provideSharingThreadOperability } from "./threadOperability";

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

// Upstream's thread action menu asks through `threadOperability.ts`, which holds none of this
// module's imports; the open thread's view already holds the level, so the read asks nothing.
provideSharingThreadOperability((thread) =>
  j5Sharing.readCanOperateThread(appAtomRegistry, {
    environmentId: thread.environmentId,
    threadId: thread.threadId,
    permitted: true,
  }),
);

provideSharingMenuGuestRead((thread) =>
  appAtomRegistry.get(j5Sharing.isGuest(thread.environmentId)),
);

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

const NOT_A_GUEST = Atom.make(false);

/** Whether the connection to one server is known to be a guest's; false until the server says so. */
export function useIsGuest(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(environmentId === null ? NOT_A_GUEST : j5Sharing.isGuest(environmentId));
}

const NO_GUEST_LEVEL = Atom.make<SharingThreadLevel | null>(null);

/**
 * What a guest holds on a thread: `null` for a member, else "view", "collaborate" or "none". For
 * the places a collaborating guest is offered less than a member (no Stop, no steering, text
 * only); whether the thread can be written to at all stays `useCanOperateThread`.
 */
export function useGuestThreadLevel(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): SharingThreadLevel | null {
  return useAtomValue(
    environmentId === null ? NO_GUEST_LEVEL : j5Sharing.guestThreadLevel(environmentId, threadId),
  );
}

/** What J5's Skills page says when every connected server is a guest one. */
export const GUEST_SKILLS_UNAVAILABLE = "Skills are not available on a server you are a guest on.";

/** What J5's Personas and Playbooks pages say when every connected server is a guest one. */
export const GUEST_LIBRARY_UNAVAILABLE =
  "Personas and Playbooks are not available on a server you are a guest on.";

const memberSomewhereAtom = Atom.make((get) => {
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    if (get(j5Sharing.connectionKind(id)) === "member") return true;
  }
  return false;
});

/** Whether some connected server has said this person is a member of it. */
export function useIsMemberSomewhere(): boolean {
  return useAtomValue(memberSomewhereAtom);
}

/** Whether there is at least one server and this person is a guest on all of them. */
export function useIsGuestEverywhere(): boolean {
  const guests = useAtomValue(guestEnvironmentIdsAtom);
  const total = useAtomValue(environmentCatalog.catalogValueAtom).entries.size;
  return total > 0 && guests.size === total;
}
