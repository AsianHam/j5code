import {
  AuthAccessWriteScope,
  type ContextMenuItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const granted = new Set<string>();
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthAccessWriteScope && granted.has(environmentId),
}));

import { closeSharingDialog, sharingDialogStore } from "./sharingDialogs";
import { runSharingMenuAction, withSharingMenuItems } from "./sharingMenu";

const thread = { environmentId: "env-1", threadId: "thread-1" } as ScopedThreadRef;
const upstream: ReadonlyArray<ContextMenuItem<"rename" | "copy" | "project-settings">> = [
  { id: "rename", label: "Rename thread" },
  { id: "copy", label: "Copy" },
  { id: "project-settings", label: "Project settings" },
];

afterEach(() => {
  granted.clear();
  closeSharingDialog();
});

describe("the thread menu's Share item", () => {
  it("sits after Copy and before Project settings", () => {
    granted.add("env-1");
    const items = withSharingMenuItems(upstream, thread);
    expect(items.map((item) => item.label)).toEqual([
      "Rename thread",
      "Copy",
      "Share thread…",
      "Project settings",
    ]);
    expect(items[2]?.disabled).toBe(false);
  });

  it("is shown disabled to a connection that cannot manage access", () => {
    expect(withSharingMenuItems(upstream, thread)[2]).toMatchObject({
      label: "Share thread…",
      disabled: true,
    });
  });

  it("opens the Share dialog for the thread and leaves upstream's actions alone", () => {
    expect(runSharingMenuAction("copy", thread)).toBe(false);
    expect(sharingDialogStore.read().request).toBeNull();

    expect(runSharingMenuAction("j5:share-thread", thread)).toBe(true);
    expect(sharingDialogStore.read().request).toEqual({
      kind: "share",
      environmentId: "env-1",
      target: { kind: "thread", threadId: "thread-1" },
    });
  });
});
