import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { environmentSession } from "../../state/session";
import { requestCrewMemberships } from "../crew/CrewMembershipsClient";
import { j5Sharing } from "../sharing/guestAccess";
import { requestSpawnedChildren } from "./SpawnedChildrenClient";

/**
 * Each catalogued environment's prepared connection, or null while it is not connected. A guest's
 * connection is left null too once it is known to be one: the server refuses a guest these reads
 * (Shared server AC24). Nothing waits for that answer, so a member's rows are read at once.
 */
export const threadReadConnectionsAtom = Atom.make((get) => {
  const connections = new Map<EnvironmentId, PreparedConnection | null>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    const prepared = get(environmentSession.preparedConnectionValueAtom(id));
    const readable = state?.phase === "connected" && !get(j5Sharing.isGuest(id));
    connections.set(id, readable ? Option.getOrNull(prepared) : null);
  }
  return connections;
});

/** A row set with the key that identifies it, so several reads share one serialization. */
export interface KeyedThreadRefs {
  readonly key: string;
  readonly refs: ReadonlyArray<ScopedThreadRef>;
}

/**
 * Serializes a row set once per render and keeps one array identity while its contents are
 * unchanged. The sidebar's list spans every thread and re-renders while a turn streams, so the
 * reads that follow it take this instead of each serializing the list again.
 */
export function useKeyedThreadRefs(refs: ReadonlyArray<ScopedThreadRef>): KeyedThreadRefs {
  const key = JSON.stringify(refs);
  return useMemo(() => ({ key, refs: JSON.parse(key) as ReadonlyArray<ScopedThreadRef> }), [key]);
}

/**
 * Keeps the Crew chips and spawned children of the sidebar's rows read. Incremental: only rows
 * not yet answered for are fetched here, and a Crew or Fleet change re-reads the involved rows
 * (`useFleetRefresh`). `ThreadCardIdentity` and `SpawnedChildren` render what these reads return.
 */
export function useThreadRowReads({ refs: requested }: KeyedThreadRefs) {
  const connections = useAtomValue(threadReadConnectionsAtom);
  useEffect(() => {
    requestCrewMemberships(requested, connections);
    requestSpawnedChildren(requested, connections);
  }, [connections, requested]);
}
