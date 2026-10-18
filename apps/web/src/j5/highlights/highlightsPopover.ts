import { useSyncExternalStore } from "react";

// Whether the highlights popover is open, and which list it shows: "new" is the unseen entries
// with a dismiss on each, opened from the sidebar button; "all" is every entry, opened from the
// palette's "What's new". The palette and the button are far apart in the tree, so they share
// this instead of React state.
export type HighlightsPopoverState =
  | { readonly open: false }
  | { readonly open: true; readonly mode: "new" | "all" };

const CLOSED: HighlightsPopoverState = { open: false };

let state: HighlightsPopoverState = CLOSED;
const listeners = new Set<() => void>();

function set(next: HighlightsPopoverState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHighlightsPopover(): HighlightsPopoverState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => CLOSED,
  );
}

export const openHighlights = (mode: "new" | "all") => set({ open: true, mode });

export const closeHighlights = () => set(CLOSED);
