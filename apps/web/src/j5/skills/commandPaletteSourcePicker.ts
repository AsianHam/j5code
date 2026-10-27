import { create } from "zustand";

import type { CommandPaletteSourcePicker } from "~/commandPaletteBus";
import { dispatchCommandPalette, useCommandPaletteStore } from "~/commandPaletteStore";

// FORK.md case 42: the Skills source picker borrows upstream's Add project palette for one
// session. It lives beside upstream's palette store, so the palette reads it without a prop.
const useSourcePickerStore = create<{ readonly picker: CommandPaletteSourcePicker | null }>(() => ({
  picker: null,
}));

let stopWatchingPalette: (() => void) | null = null;

function clearSourcePick(): void {
  stopWatchingPalette?.();
  stopWatchingPalette = null;
  useSourcePickerStore.setState({ picker: null }, true);
}

/** Call right after the palette opens to Add project: the pick lasts for that palette session. */
export function startCommandPaletteSourcePick(picker: CommandPaletteSourcePicker): void {
  clearSourcePick();
  const { session } = useCommandPaletteStore.getState();
  const active: CommandPaletteSourcePicker = {
    ...picker,
    onSelect: (source) => {
      // A cancelled lookup must not fill the field or close a newer picker.
      if (useSourcePickerStore.getState().picker !== active) return;
      picker.onSelect(source);
      dispatchCommandPalette({ _tag: "SetOpen", open: false });
    },
  };
  useSourcePickerStore.setState({ picker: active }, true);
  // Closing the palette, switching its mode or opening it to a new intent ends the pick.
  stopWatchingPalette = useCommandPaletteStore.subscribe((state) => {
    if (!state.open || state.mode !== "command" || state.session !== session) clearSourcePick();
  });
}

export function useCommandPaletteSourcePicker(): CommandPaletteSourcePicker | undefined {
  return useSourcePickerStore((state) => state.picker) ?? undefined;
}

export function readCommandPaletteSourcePicker(): CommandPaletteSourcePicker | null {
  return useSourcePickerStore.getState().picker;
}
