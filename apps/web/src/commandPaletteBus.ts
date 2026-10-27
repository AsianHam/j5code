import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@t3tools/contracts";

import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";
import { startCommandPaletteSourcePick } from "./j5/skills/commandPaletteSourcePicker";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export interface CommandPaletteSourcePicker {
  readonly environmentId: EnvironmentId;
  readonly onSelect: (source: string) => void;
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /** Select an existing folder or repository URL without creating a project or cloning. */
  readonly sourcePicker?: CommandPaletteSourcePicker;
}

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  if (detail.open === "new-thread-in") {
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({ _tag: "OpenAddProject" });
    if (detail.sourcePicker) startCommandPaletteSourcePick(detail.sourcePicker);
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
