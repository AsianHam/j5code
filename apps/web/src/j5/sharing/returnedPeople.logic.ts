import type { SharingPerson } from "@t3tools/contracts/j5";

/**
 * The list of people with the rows a request of this client's just returned put in place of the
 * list's own. The server answers a rename, a grant change and the owner's name with the person
 * as they now are, so the client that made the change shows it at once; the list is read again
 * for everyone when the server counts the change, and the returned rows are dropped then.
 */
export function peopleWithReturnedRows(
  listed: ReadonlyArray<SharingPerson>,
  returned: ReadonlyMap<string, SharingPerson>,
): ReadonlyArray<SharingPerson> {
  if (returned.size === 0) return listed;
  return listed.map((person) => returned.get(person.personId) ?? person);
}
