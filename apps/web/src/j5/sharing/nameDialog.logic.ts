import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";
import type { HeldPersonLevel, PersonLevel } from "@t3tools/contracts/j5";
import { highestLevel } from "@t3tools/contracts/j5";

/**
 * Which server, if any, is asked "What should people and agents on <server> call you?" now:
 * a device the server cannot place (People and access AC5), or the first owner with no name yet
 * (AC6). One server at a time, in the order they are listed. Neither can be put off: each is
 * asked before the device uses that server.
 */
export function serverToAskNameFor<Id>(
  servers: ReadonlyArray<{ readonly id: Id; readonly access: KnownConnectionAccess }>,
): { readonly id: Id; readonly kind: "claim" | "first-owner" } | null {
  for (const server of servers) {
    if (server.access?.kind === "unknown") return { id: server.id, kind: "claim" };
    if (
      server.access?.kind === "person" &&
      server.access.firstOwner &&
      server.access.name === null
    ) {
      return { id: server.id, kind: "first-owner" };
    }
  }
  return null;
}

/** The level a person is offered by, in the list of people a device could be: their highest. */
export const offeredLevel = (levels: ReadonlyArray<HeldPersonLevel>): PersonLevel | null =>
  highestLevel(levels.map((held) => held.level));
