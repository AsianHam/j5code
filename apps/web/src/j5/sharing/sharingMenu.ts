import {
  AuthAccessWriteScope,
  type ContextMenuItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { PersonLevel } from "@t3tools/contracts/j5";

import { readEnvironmentScope } from "../../state/session";
import { openSharingDialog } from "./sharingDialogs";

const SHARE_THREAD = "j5:share-thread";
const LEAVE_THREAD = "j5:leave-thread";
export type SharingMenuActionId = typeof SHARE_THREAD | typeof LEAVE_THREAD;

/**
 * What the thread's server says of someone who does not own it: their level over the thread,
 * and whether they hold a level on the thread itself, which is what they can leave. `null` for
 * an Owner, and while the server has not answered.
 */
export interface SharingMenuAccess {
  readonly level: PersonLevel | null;
  readonly holdsThread: boolean;
}

// `access.ts`, which owns the connection runtime, hands the read over when it loads; until then
// everyone is read as an Owner, and the server refuses what is not theirs.
let accessOn: (thread: ScopedThreadRef) => SharingMenuAccess | null = () => null;

export function provideSharingMenuAccess(
  read: (thread: ScopedThreadRef) => SharingMenuAccess | null,
) {
  accessOn = read;
}

// Not an Owner's: for now archiving and deleting are for Owners, and project settings are part of
// Settings, which is theirs (People and access AC14, AC27). A Viewer changes nothing, the read
// marker included, which is one value for everyone on the thread (Shared conversations AC20).
const OWNERS_ONLY: ReadonlySet<string> = new Set(["archive", "delete", "project-settings"]);
const NOT_A_VIEWERS: ReadonlySet<string> = new Set(["mark-unread"]);

/**
 * Upstream's thread menu as People and access changes it. "Share thread…" goes after "Copy"
 * (AC34), disabled on a device without "Manage access", as upstream shows an action a device
 * lacks. For someone who is not an Owner, the items that are Owners' go, and "Leave thread" takes
 * Archive's place when they hold a level on the thread itself (AC48). Upstream's own list is left
 * as it was built.
 */
export function withSharingMenuItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  thread: ScopedThreadRef,
): ReadonlyArray<ContextMenuItem<Id | SharingMenuActionId>> {
  return sharingMenuItems(items, accessOn(thread), {
    canShare: readEnvironmentScope(thread.environmentId, AuthAccessWriteScope),
  });
}

/** `withSharingMenuItems` with what it reads given; see there. */
export function sharingMenuItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  access: SharingMenuAccess | null,
  device: { readonly canShare: boolean },
): ReadonlyArray<ContextMenuItem<Id | SharingMenuActionId>> {
  const share: ContextMenuItem<SharingMenuActionId> = {
    id: SHARE_THREAD,
    label: "Share thread…",
    icon: "users",
    disabled: !device.canShare,
  };
  const removed = (item: ContextMenuItem<Id>) =>
    access !== null &&
    (OWNERS_ONLY.has(item.id) || (access.level === "viewer" && NOT_A_VIEWERS.has(item.id)));
  const kept = items.filter((item) => !removed(item));
  const copy = kept.findIndex((item) => item.id === "copy");
  const withShare: ReadonlyArray<ContextMenuItem<Id | SharingMenuActionId>> =
    copy === -1 ? [...kept, share] : [...kept.slice(0, copy + 1), share, ...kept.slice(copy + 1)];
  if (access === null || !access.holdsThread) return withShare;
  const leave: ContextMenuItem<SharingMenuActionId> = {
    id: LEAVE_THREAD,
    label: "Leave thread",
    icon: "log-out",
    destructive: true,
    separatorBefore: true,
  };
  // Where Archive stood: before whatever upstream listed after it, or at the end.
  const archive = items.findIndex((item) => item.id === "archive");
  const after =
    archive === -1
      ? -1
      : withShare.findIndex((item) => items.indexOf(item as ContextMenuItem<Id>) > archive);
  const before = after === -1 ? withShare.length : after;
  return [...withShare.slice(0, before), leave, ...withShare.slice(before)];
}

/**
 * `withSharingMenuItems` around a builder of upstream's, for a call site that builds the list
 * inside the call that shows it: wrapping the builder leaves that call's arguments where they are.
 */
export const buildWithSharingMenuItems =
  <State, Id extends string>(
    build: (state: State) => ReadonlyArray<ContextMenuItem<Id>>,
    thread: ScopedThreadRef,
  ) =>
  (state: State) =>
    withSharingMenuItems(build(state), thread);

/** Runs an item J5 added and says so, leaving every other id to upstream's own handling. */
export function runSharingMenuAction<Id extends string>(
  action: Id | SharingMenuActionId,
  thread: ScopedThreadRef,
): action is SharingMenuActionId {
  if (action === SHARE_THREAD) {
    openSharingDialog({
      kind: "share",
      environmentId: thread.environmentId,
      scope: { kind: "thread", threadId: thread.threadId },
    });
    return true;
  }
  if (action === LEAVE_THREAD) {
    openSharingDialog({
      kind: "leave",
      environmentId: thread.environmentId,
      scope: { kind: "thread", threadId: thread.threadId },
    });
    return true;
  }
  return false;
}
