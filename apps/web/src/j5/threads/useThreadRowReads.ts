import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { environmentSession } from "../../state/session";
import { requestCrewMemberships } from "../crew/CrewMembershipsClient";
import { j5Sharing } from "../state";
import { requestSpawnedChildren } from "./SpawnedChildrenClient";

/**
 * Each catalogued environment's prepared connection, or null while it is not connected. The
 * connection of someone who reaches less than the whole server is left null too once that is
 * known: these reads are the server's own (People and access AC23), and the server refuses them.
 * Nothing waits for that answer, so everyone else's rows are read at once.
 */
export const threadReadConnectionsAtom = Atom.make((get) => {
  const connections = new Map<EnvironmentId, PreparedConnection | null>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    const prepared = get(environmentSession.preparedConnectionValueAtom(id));
    const readable = state?.phase === "connected" && !get(j5Sharing.isNarrow(id));
    connections.set(id, readable ? Option.getOrNull(prepared) : null);
  }
  return connections;
});

/**
 * Keeps the Crew chips and spawned children of the sidebar's rows read. Incremental: only rows
 * not yet answered for are fetched here, and a Crew or Fleet change re-reads the involved rows
 * (`useFleetRefresh`). `ThreadCardIdentity` and `SpawnedChildren` render what these reads return.
 */
export function useThreadRowReads(refs: ReadonlyArray<ScopedThreadRef>) {
  const connections = useAtomValue(threadReadConnectionsAtom);
  // The sidebar's list spans every thread and re-renders while a turn streams, so the effect keys
  // on the serialized row set instead of the list's identity.
  const key = JSON.stringify(refs);
  // oxlint-disable-next-line t3code/react-effect-budget -- asks the servers for Crew chips and spawned children of the rows on screen, batched across rows.
  useEffect(() => {
    const requested = JSON.parse(key) as ReadonlyArray<ScopedThreadRef>;
    requestCrewMemberships(requested, connections);
    requestSpawnedChildren(requested, connections);
  }, [connections, key]);
}
