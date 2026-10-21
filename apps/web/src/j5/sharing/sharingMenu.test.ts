import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));

import { closeSharingDialog, sharingDialogStore } from "./sharingDialogs";
import { runSharingMenuAction, sharingMenuItems } from "./sharingMenu";

type UpstreamId = "rename" | "mark-unread" | "copy" | "project-settings" | "archive" | "delete";

const upstream: ReadonlyArray<ContextMenuItem<UpstreamId>> = [
  { id: "rename", label: "Rename thread" },
  { id: "mark-unread", label: "Mark unread" },
  { id: "copy", label: "Copy" },
  { id: "project-settings", label: "Project settings" },
  { id: "archive", label: "Archive thread" },
  { id: "delete", label: "Delete" },
];

const labels = (items: ReadonlyArray<ContextMenuItem>) => items.map((item) => item.label);

afterEach(() => closeSharingDialog());

describe("the thread menu for an Owner", () => {
  it("adds Share after Copy and keeps everything upstream listed", () => {
    expect(labels(sharingMenuItems(upstream, null, { canShare: true }))).toEqual([
      "Rename thread",
      "Mark unread",
      "Copy",
      "Share thread…",
      "Project settings",
      "Archive thread",
      "Delete",
    ]);
  });

  it("offers Leave on a thread the Owner holds a level on, whatever their device manages", () => {
    expect(
      labels(
        sharingMenuItems(
          upstream,
          { owner: true, level: "owner", holdsThread: true },
          { canShare: false },
        ),
      ),
    ).toEqual([
      "Rename thread",
      "Mark unread",
      "Copy",
      "Share thread…",
      "Project settings",
      "Leave thread",
      "Archive thread",
      "Delete",
    ]);
  });

  it("greys Share on a device without Manage access, with no notice", () => {
    const share = sharingMenuItems(upstream, null, { canShare: false }).find(
      (item) => item.label === "Share thread…",
    );
    expect(share?.disabled).toBe(true);
  });
});

describe("the thread menu for someone who is not an Owner", () => {
  it("leaves out archiving, deleting and project settings for a Collaborator", () => {
    const items = sharingMenuItems(
      upstream,
      { owner: false, level: "collaborator", holdsThread: false },
      { canShare: false },
    );
    expect(labels(items)).toEqual(["Rename thread", "Mark unread", "Copy", "Share thread…"]);
    expect(items.find((item) => item.label === "Share thread…")?.disabled).toBe(true);
  });

  it("offers Leave where Archive stood to someone holding a level on the thread", () => {
    expect(
      labels(
        sharingMenuItems(
          upstream,
          { owner: false, level: "collaborator", holdsThread: true },
          { canShare: false },
        ),
      ),
    ).toEqual(["Rename thread", "Mark unread", "Copy", "Share thread…", "Leave thread"]);
  });

  it("gives a Viewer no Mark unread, since the read marker is everyone's", () => {
    expect(
      labels(
        sharingMenuItems(
          upstream,
          { owner: false, level: "viewer", holdsThread: true },
          { canShare: false },
        ),
      ),
    ).toEqual(["Rename thread", "Copy", "Share thread…", "Leave thread"]);
  });

  it("offers no Leave to someone who reaches the thread only through a wider scope", () => {
    expect(
      labels(
        sharingMenuItems(
          upstream,
          { owner: false, level: "viewer", holdsThread: false },
          { canShare: false },
        ),
      ),
    ).not.toContain("Leave thread");
  });
});

describe("running an item J5 added", () => {
  const thread = { environmentId: "env-1", threadId: "thread-1" } as ScopedThreadRef;

  it("opens the Share dialog on the thread", () => {
    expect(runSharingMenuAction("j5:share-thread", thread)).toBe(true);
    expect(sharingDialogStore.read().request).toEqual({
      kind: "share",
      environmentId: "env-1",
      scope: { kind: "thread", threadId: "thread-1" },
    });
  });

  it("opens the Leave confirmation on the thread", () => {
    expect(runSharingMenuAction("j5:leave-thread", thread)).toBe(true);
    expect(sharingDialogStore.read().request).toEqual({
      kind: "leave",
      environmentId: "env-1",
      scope: { kind: "thread", threadId: "thread-1" },
    });
  });

  it("leaves upstream's own items to upstream", () => {
    expect(runSharingMenuAction("rename", thread)).toBe(false);
  });
});
