import type { EnvironmentId } from "@t3tools/contracts";
import type { SharingPerson } from "@t3tools/contracts/j5";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { peopleWithReturnedRows } from "./returnedPeople.logic";

// The rows this client's own requests just returned, by server and person.
type Returned = ReadonlyMap<EnvironmentId, ReadonlyMap<string, SharingPerson>>;
const NONE: ReadonlyMap<string, SharingPerson> = new Map();
let returned: Returned = new Map();
const listeners = new Set<() => void>();
const publish = (next: Returned) => {
  returned = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => returned;

/**
 * Keeps the person a rename, a grant change or the owner's name was answered with, so the client
 * that made the change shows it at once. Everyone else, and this client too, is brought up to
 * date when the server counts the change and the list is read again.
 */
export function showReturnedPerson(environmentId: EnvironmentId, person: SharingPerson) {
  const rows = new Map(returned.get(environmentId) ?? NONE).set(person.personId, person);
  publish(new Map(returned).set(environmentId, rows));
}

/** The list of people as read, with this client's just-returned rows until it is read again. */
export function usePeopleNow(
  environmentId: EnvironmentId,
  listed: ReadonlyArray<SharingPerson> | undefined,
): ReadonlyArray<SharingPerson> {
  const rows = useSyncExternalStore(subscribe, read, read).get(environmentId) ?? NONE;
  // A list read again is newer than anything a request returned before it.
  const lastListed = useRef(listed);
  useEffect(() => {
    if (lastListed.current !== listed && lastListed.current !== undefined) {
      if (returned.has(environmentId)) {
        const next = new Map(returned);
        next.delete(environmentId);
        publish(next);
      }
    }
    lastListed.current = listed;
  }, [environmentId, listed]);
  return useMemo(() => peopleWithReturnedRows(listed ?? [], rows), [listed, rows]);
}
