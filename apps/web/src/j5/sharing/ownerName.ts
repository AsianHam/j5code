import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentQuery } from "../../state/query";

import { j5Sharing } from "./guestAccess";
import { peopleQuery } from "./sharingManage";

interface OwnerNames {
  /**
   * Names set or changed from this client. The server tells a member's connection the owner's
   * name once, when it connects, so a later change is kept here until the next connection.
   */
  readonly setHere: ReadonlyMap<EnvironmentId, string>;
  /**
   * Servers the person answered "Not now" for. Kept only until the client is closed, so the
   * question comes back at the next start.
   */
  readonly askedLater: ReadonlySet<EnvironmentId>;
}

// Replaced whole on every change: a reader that holds the old value sees that it is old.
let state: OwnerNames = { setHere: new Map(), askedLater: new Set() };
const listeners = new Set<() => void>();

const publish = (next: OwnerNames) => {
  state = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => state;

export function rememberOwnerName(environmentId: EnvironmentId, name: string) {
  publish({ ...state, setHere: new Map(state.setHere).set(environmentId, name) });
}

export function askForOwnerNameLater(environmentId: EnvironmentId) {
  publish({ ...state, askedLater: new Set(state.askedLater).add(environmentId) });
}

const NOT_TOLD = Atom.make<string | null | undefined>(undefined);

/**
 * The name of the person a server belongs to: a name, `null` when none is set yet, and
 * `undefined` when this connection was not told (the server has not answered, the connection is
 * a guest's, or the server is from before owners had names).
 */
export function useOwnerName(environmentId: EnvironmentId | null): string | null | undefined {
  const { setHere } = useSyncExternalStore(subscribe, read, read);
  const told = useAtomValue(environmentId === null ? NOT_TOLD : j5Sharing.ownerName(environmentId));
  return environmentId === null ? undefined : (setHere.get(environmentId) ?? told);
}

/**
 * The owner's name as the server holds it now, for a flow about to ask for one or show it: the
 * list of people is read again, since what the connection was told is as old as the connection.
 * `listed` is `undefined` until the list answers. Only a connection that manages access reads it.
 */
export function useOwnerNameNow(environmentId: EnvironmentId, enabled: boolean) {
  const known = useOwnerName(environmentId);
  const people = useEnvironmentQuery(enabled ? peopleQuery(environmentId) : null);
  // Read again each time a flow opens: the cached list may be as old as the connection too.
  useEffect(() => {
    if (enabled) appAtomRegistry.refresh(peopleQuery(environmentId));
  }, [enabled, environmentId]);
  const owner = people.data?.people.find((person) => person.kind === "member" && person.you);
  const listed =
    people.data === null || people.isPending ? undefined : (owner?.displayName ?? null);
  // A name the list holds is kept as this client's own knowledge, so the flow that asked does not
  // wait again each time the list is re-read.
  useEffect(() => {
    if (enabled && typeof listed === "string") rememberOwnerName(environmentId, listed);
  }, [enabled, environmentId, listed]);
  return { known, listed, listFailed: people.error !== null };
}

/** The servers "Not now" was chosen for since this client was opened. */
export function useOwnerNameAskedLater(): ReadonlySet<EnvironmentId> {
  return useSyncExternalStore(subscribe, read, read).askedLater;
}
