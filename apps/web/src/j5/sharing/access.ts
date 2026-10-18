import { useAtomValue } from "@effect/atom-react";
import {
  isOwnerAccess,
  reachesServer,
  type KnownConnectionAccess,
} from "@t3tools/client-runtime/j5/sharing";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { PersonLevel } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentScope } from "../../state/session";
import { j5Sharing } from "../state";
import { ownerSomewhereState } from "./settingsAccess.logic";
import { provideSharingMenuAccess } from "./sharingMenu";
import { provideSharingThreadOperability } from "./threadOperability";

export { j5Sharing };

const NOT_ANSWERED = Atom.make<KnownConnectionAccess>(null);

/**
 * What the server says this connection is (People and access): a person with their levels, a
 * device it cannot place yet, or a session that is no person's. `null` until it has answered.
 */
export function useConnectionAccess(environmentId: EnvironmentId | null): KnownConnectionAccess {
  return useAtomValue(
    environmentId === null ? NOT_ANSWERED : j5Sharing.connectionAccess(environmentId),
  );
}

const NEVER_ASKED = Atom.make(AsyncResult.initial(false)) as ReturnType<
  typeof j5Sharing.connectionAccessQuery
>;

/**
 * The server's answer and whether it has come: `settled` is false only until the first answer or
 * failure. A server that cannot answer, one from before people, settles with `null`, which holds
 * this client to nothing.
 */
export function useSettledConnectionAccess(environmentId: EnvironmentId | null): {
  readonly settled: boolean;
  readonly access: KnownConnectionAccess;
} {
  const result = useAtomValue(
    environmentId === null
      ? NEVER_ASKED
      : j5Sharing.connectionAccessQuery({ environmentId, input: {} }),
  );
  return {
    settled: result._tag !== "Initial",
    access: Option.getOrNull(AsyncResult.value(result)),
  };
}

const NO_LEVEL = Atom.make<PersonLevel | null>(null);

/** The level this connection's person holds over a thread; `null` for none or not yet known. */
export function useThreadLevel(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): PersonLevel | null {
  return useAtomValue(
    environmentId === null ? NO_LEVEL : j5Sharing.threadLevel(environmentId, threadId),
  );
}

const NOTHING_WITHHELD = Atom.make(true);

/**
 * Whether this connection may write to a thread: upstream's server-wide "Operate tasks"
 * permission, and a Collaborator's or Owner's level over that thread. The chat view calls this
 * where it read the permission alone, so a Viewer of one thread gets what upstream shows a
 * connection that lacks it, while writing to another.
 */
export function useCanOperateThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): boolean {
  const permitted = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const level = useAtomValue(
    environmentId === null ? NOTHING_WITHHELD : j5Sharing.threadOperable(environmentId, threadId),
  );
  return permitted && level;
}

// Upstream's thread action menu asks through `threadOperability.ts` and `sharingMenu.ts`, which
// hold none of this module's imports; the open thread's view already holds the level, so these
// reads ask nothing.
provideSharingThreadOperability((thread) =>
  j5Sharing.readCanOperateThread(appAtomRegistry, {
    environmentId: thread.environmentId,
    threadId: thread.threadId,
    permitted: true,
  }),
);

provideSharingMenuAccess((thread) => {
  const access = appAtomRegistry.get(j5Sharing.connectionAccess(thread.environmentId));
  if (access === null || access.kind === "service") return null;
  return {
    owner: isOwnerAccess(access),
    level: appAtomRegistry.get(j5Sharing.threadLevel(thread.environmentId, thread.threadId)),
    holdsThread:
      access.kind === "person" &&
      !access.firstOwner &&
      access.levels.some(
        (held) => held.scope.kind === "thread" && held.scope.threadId === thread.threadId,
      ),
  };
});

const environmentIdsWhere = (label: string, test: (access: KnownConnectionAccess) => boolean) =>
  Atom.make((get) => {
    const ids = new Set<EnvironmentId>();
    for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
      if (test(get(j5Sharing.connectionAccess(id)))) ids.add(id);
    }
    return ids as ReadonlySet<EnvironmentId>;
  }).pipe(Atom.withLabel(label));

// Known to reach less than the whole server: nothing is left out before a server has answered.
const narrowEnvironmentIdsAtom = environmentIdsWhere(
  "j5:access:narrow-environments",
  (access) => access !== null && !reachesServer(access),
);

// Owned, or not yet answered: a server is not taken away from its Owner while it answers.
const ownedEnvironmentIdsAtom = environmentIdsWhere("j5:access:owned-environments", isOwnerAccess);

/**
 * The servers whose own pages (the Fleet page, Personas, Playbooks, skills) are not this person's
 * to see, because they reach less than the whole server (People and access AC23). J5's own pages
 * leave these servers out, and say so when there is no other server.
 */
export function useNarrowEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return useAtomValue(narrowEnvironmentIdsAtom);
}

/** Whether there is at least one server and this person reaches less than the whole of each. */
export function useIsNarrowEverywhere(): boolean {
  const narrow = useAtomValue(narrowEnvironmentIdsAtom);
  const total = useAtomValue(environmentCatalog.catalogValueAtom).entries.size;
  return total > 0 && narrow.size === total;
}

/**
 * The connected servers this person owns, which are the ones Settings and the People page manage
 * (People and access AC27). A server that has not answered yet is counted, so an Owner's page
 * does not flicker; one whose answer says otherwise drops out when it arrives.
 */
export function useOwnedEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return useAtomValue(ownedEnvironmentIdsAtom);
}

const ownerSomewhereAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return ownerSomewhereState({
    catalogReady: catalog.isReady,
    // A server that cannot answer, one from before people, settles with no answer and holds
    // this client to nothing, as `isOwnerAccess` does; only one still being asked is unknown.
    answers: [...catalog.entries.keys()].map((environmentId) => {
      const result = get(j5Sharing.connectionAccessQuery({ environmentId, input: {} }));
      if (result._tag === "Initial") return null;
      return isOwnerAccess(Option.getOrNull(AsyncResult.value(result))) ? "owner" : "other";
    }),
  });
}).pipe(Atom.withLabel("j5:access:owner-somewhere"));

/** Whether the person owns a connected server, or `"loading"`; see `ownerSomewhereState`. */
export function useOwnerSomewhere(): boolean | "loading" {
  return useAtomValue(ownerSomewhereAtom);
}

/**
 * Whether the person owns at least one connected server, counting one not yet known: J5's own
 * Settings pages ask, and are reached only once Settings knows.
 */
export function useIsOwnerSomewhere(): boolean {
  return useOwnerSomewhere() !== false;
}

/** Whether the person owns this server; see `useOwnedEnvironmentIds`. */
export function useIsOwner(environmentId: EnvironmentId | null): boolean {
  return isOwnerAccess(useConnectionAccess(environmentId)) && environmentId !== null;
}

/** What J5's Skills page says to someone who owns no connected server. */
export const SKILLS_FOR_OWNERS = "Skills are managed by a server's Owners.";

/** What J5's Personas and Playbooks pages say to someone who owns no connected server. */
export const LIBRARY_FOR_OWNERS = "Personas and Playbooks are managed by a server's Owners.";
