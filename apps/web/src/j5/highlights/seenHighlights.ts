import { useMemo, useSyncExternalStore } from "react";
import {
  HIGHLIGHTS,
  highlightsForClient,
  withHighlightSeen,
} from "@t3tools/client-runtime/j5/highlights";

import { isElectron } from "../../env";

// The ids this client has seen, in its own storage: per browser origin, and per install on
// desktop (whose renderer has one fixed origin). A missing record means none written yet;
// unseenHighlights reads that as "show everything" once first run is finished.
const KEY = "j5:highlights:seen";

export const highlightClient = isElectron ? "desktop" : "web";
export const clientHighlights = highlightsForClient(HIGHLIGHTS, highlightClient);

const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): ReadonlyArray<string> | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
  } catch {
    return null;
  }
}

function write(ids: ReadonlyArray<string>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage that cannot be written shows the entry again next time.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The seen record. Snapshots are the raw string, so an unchanged record never re-renders. */
export function useSeenHighlights(): ReadonlyArray<string> | null {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  return useMemo(() => parse(raw), [raw]);
}

export function dismissHighlight(id: string): void {
  write(withHighlightSeen(parse(readRaw()), id));
}

/**
 * First run calls this before it marks itself finished, so a new client never meets the entries
 * it shipped with as new.
 */
export function markAllHighlightsSeen(): void {
  write(clientHighlights.map((entry) => entry.id));
}
