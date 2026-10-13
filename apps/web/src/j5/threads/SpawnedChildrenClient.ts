import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createScopedThreadReadStore } from "@t3tools/client-runtime/j5/scopedThreadReadStore";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { SpawnedChild, SpawnedChildrenEntry } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { useMemo, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type { SpawnedChild, SpawnedChildrenEntry } from "@t3tools/contracts/j5";

/** What the read says about one visible row: the agents placed under it, and how it came to be. */
export interface SpawnedChildrenRow {
  readonly children: ReadonlyArray<SpawnedChild>;
  /** An agent spawned this thread, so it shows under its spawner (register D22). */
  readonly spawnedByAgent: boolean;
}
type RowEntry = SpawnedChildrenRow & { readonly threadId: ThreadId };

/** One entry per requested row the read has something to say about. */
export const spawnedChildrenRows = (response: {
  readonly entries: ReadonlyArray<SpawnedChildrenEntry>;
  readonly spawnedByAgent: ReadonlyArray<ThreadId>;
}): ReadonlyArray<RowEntry> => {
  const children = new Map(response.entries.map((entry) => [entry.threadId, entry.children]));
  const spawned = new Set(response.spawnedByAgent);
  return [...new Set([...children.keys(), ...spawned])].map((threadId) => ({
    threadId,
    children: children.get(threadId) ?? [],
    spawnedByAgent: spawned.has(threadId),
  }));
};

/** The visible rows are the whole truth for their children; parents that lost all children lose their entry. */
export const replaceSpawnedChildren = (
  previous: ReadonlyMap<string, SpawnedChildrenRow>,
  environmentId: EnvironmentId,
  requested: ReadonlyArray<ThreadId>,
  entries: ReadonlyArray<RowEntry>,
) => {
  const next = new Map(previous);
  for (const threadId of requested)
    next.delete(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  for (const { threadId, ...row } of entries)
    next.set(scopedThreadKey(scopeThreadRef(environmentId, threadId)), row);
  return next;
};

const store = createScopedThreadReadStore<SpawnedChildrenRow, RowEntry>({
  load: async (environmentId, threadIds) => {
    const result = await j5Environment.listSpawnedChildren.run(appAtomRegistry, {
      environmentId,
      input: { threadIds },
    });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return spawnedChildrenRows(result.value);
  },
  replace: replaceSpawnedChildren,
});

/** Incremental, from `useThreadRowReads`; a Crew or Fleet change re-reads the involved rows. */
export const requestSpawnedChildren = (
  refs: ReadonlyArray<ScopedThreadRef>,
  connections: ReadonlyMap<EnvironmentId, PreparedConnection | null>,
  force = false,
) => {
  store.setConnections(connections);
  store.request(refs, force);
};

/**
 * The re-read a Crew or Fleet change causes: the rows the roster says have placed children or sit in a Crew, plus
 * every row still showing children, so a parent whose children all archived loses them.
 */
export const refreshSpawnedChildrenRows = (refs: ReadonlyArray<ScopedThreadRef>) =>
  store.refreshRows(refs, { held: true });

const EMPTY: ReadonlyArray<SpawnedChild> = [];

export function useSpawnedChildren(ref: ScopedThreadRef): ReadonlyArray<SpawnedChild> {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return snapshot.get(scopedThreadKey(ref))?.children ?? EMPTY;
}

/** The scoped keys of the rows an agent spawned, for the sidebar's membership rule. */
export function useAgentSpawnedThreadKeys(): ReadonlySet<string> {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(
    () => new Set([...snapshot].flatMap(([key, row]) => (row.spawnedByAgent ? [key] : []))),
    [snapshot],
  );
}
