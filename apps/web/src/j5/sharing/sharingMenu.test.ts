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
import {
  provideSharingMenuGuestRead,
  runSharingMenuAction,
  withSharingMenuItems,
} from "./sharingMenu";

const thread = { environmentId: "env-1", threadId: "thread-1" } as ScopedThreadRef;
const upstream: ReadonlyArray<ContextMenuItem<"rename" | "copy" | "project-settings">> = [
  { id: "rename", label: "Rename thread" },
  { id: "copy", label: "Copy" },
  { id: "project-settings", label: "Project settings" },
];

afterEach(() => {
  provideSharingMenuGuestRead(() => false);
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

describe("a guest's thread menu", () => {
  const withLifecycle: ReadonlyArray<ContextMenuItem<string>> = [
    ...upstream,
    { id: "archive", label: "Archive thread", separatorBefore: true },
    { id: "delete", label: "Delete", destructive: true },
  ];

  it("has Leave thread where Archive was, and no Archive, Delete, Share or Project settings", () => {
    provideSharingMenuGuestRead(() => true);
    const items = withSharingMenuItems(withLifecycle, thread);
    expect(items.map((item) => item.label)).toEqual(["Rename thread", "Copy", "Leave thread"]);
    expect(items.at(-1)).toMatchObject({ separatorBefore: true });
  });

  it("opens the leave confirmation for the thread", () => {
    expect(runSharingMenuAction("j5:leave-thread", thread)).toBe(true);
    expect(sharingDialogStore.read().request).toEqual({
      kind: "leave",
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("is left as a member's when the connection is not a guest's", () => {
    granted.add("env-1");
    const labels = withSharingMenuItems(withLifecycle, thread).map((item) => item.label);
    expect(labels).toContain("Archive thread");
    expect(labels).toContain("Delete");
    expect(labels).not.toContain("Leave thread");
  });
});
