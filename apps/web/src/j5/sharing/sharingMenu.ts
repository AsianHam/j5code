import {
  AuthAccessWriteScope,
  type ContextMenuItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { readEnvironmentScope } from "../../state/session";
import { openSharingDialog } from "./sharingDialogs";

const SHARE_THREAD = "j5:share-thread";
const LEAVE_THREAD = "j5:leave-thread";
export type SharingMenuActionId = typeof SHARE_THREAD | typeof LEAVE_THREAD;

// Whether the thread's server knows this connection as a guest's. `guestAccess.ts`, which owns
// the connection runtime, hands the read over when it loads; until then no one is a guest.
let isGuestOn: (thread: ScopedThreadRef) => boolean = () => false;

export function provideSharingMenuGuestRead(read: (thread: ScopedThreadRef) => boolean) {
  isGuestOn = read;
}

/**
 * Upstream's thread menu as sharing changes it. For a member, "Share thread…" goes after "Copy"
 * (Shared server AC18), shown to everyone and disabled for a connection without "Manage access",
 * as upstream shows an action a connection lacks. For a guest, who can neither archive nor delete
 * nor share onward nor change a project's settings, those items go and "Leave thread" takes Archive's place (AC25). Upstream's own
 * list is left as it was built.
 */
export function withSharingMenuItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  thread: ScopedThreadRef,
): ReadonlyArray<ContextMenuItem<Id | SharingMenuActionId>> {
  if (isGuestOn(thread)) {
    const leave: ContextMenuItem<SharingMenuActionId> = {
      id: LEAVE_THREAD,
      label: "Leave thread",
      separatorBefore: true,
    };
    // Archive and Delete are not a guest's to do, and Project settings opens a page a guest can
    // change nothing on.
    const notAGuests = (item: ContextMenuItem<Id>) =>
      item.id === "archive" || item.id === "delete" || item.id === "project-settings";
    const kept = items.filter((item) => !notAGuests(item));
    const archive = items.findIndex((item) => item.id === "archive");
    if (archive === -1) return [...kept, leave];
    const before = items.slice(0, archive).filter((item) => !notAGuests(item));
    return [...before, leave, ...kept.slice(before.length)];
  }
  const share: ContextMenuItem<SharingMenuActionId> = {
    id: SHARE_THREAD,
    label: "Share thread…",
    icon: "users",
    disabled: !readEnvironmentScope(thread.environmentId, AuthAccessWriteScope),
  };
  const after = items.findIndex((item) => item.id === "copy");
  return after === -1
    ? [...items, share]
    : [...items.slice(0, after + 1), share, ...items.slice(after + 1)];
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
      target: { kind: "thread", threadId: thread.threadId },
    });
    return true;
  }
  if (action === LEAVE_THREAD) {
    openSharingDialog({
      kind: "leave",
      environmentId: thread.environmentId,
      threadId: thread.threadId,
    });
    return true;
  }
  return false;
}
