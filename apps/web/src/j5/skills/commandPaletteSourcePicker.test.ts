import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { dispatchCommandPalette, useCommandPaletteStore } from "../../commandPaletteStore";
import {
  readCommandPaletteSourcePicker,
  startCommandPaletteSourcePick,
} from "./commandPaletteSourcePicker";

const ENVIRONMENT_ID = "environment-1" as EnvironmentId;

function openPick() {
  dispatchCommandPalette({ _tag: "SetOpen", open: false });
  dispatchCommandPalette({ _tag: "OpenAddProject" });
  const onSelect = vi.fn();
  startCommandPaletteSourcePick({ environmentId: ENVIRONMENT_ID, onSelect });
  const active = readCommandPaletteSourcePicker();
  if (active === null) throw new Error("The pick did not start.");
  return { onSelect, active };
}

describe("the Skills source pick in upstream's palette (case 42)", () => {
  it("hands the chosen source to the caller and closes the palette", () => {
    const { onSelect, active } = openPick();
    expect(active.environmentId).toBe(ENVIRONMENT_ID);
    active.onSelect("/srv/catalog");
    expect(onSelect).toHaveBeenCalledWith("/srv/catalog");
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(readCommandPaletteSourcePicker()).toBeNull();
  });

  it("ends when the palette closes, so a late lookup fills nothing", () => {
    const { onSelect, active } = openPick();
    dispatchCommandPalette({ _tag: "SetOpen", open: false });
    expect(readCommandPaletteSourcePicker()).toBeNull();
    active.onSelect("https://example.com/catalog.git");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ends when the palette switches mode or opens to another intent", () => {
    openPick();
    dispatchCommandPalette({ _tag: "ToggleMode", mode: "files" });
    expect(readCommandPaletteSourcePicker()).toBeNull();

    openPick();
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
    expect(readCommandPaletteSourcePicker()).toBeNull();
  });
});
