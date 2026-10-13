import {
  AuthAccessWriteScope,
  type ContextMenuItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { readEnvironmentScope } from "../../state/session";
import { openSharingDialog } from "./sharingDialogs";

const SHARE_THREAD = "j5:share-thread";
export type SharingMenuActionId = typeof SHARE_THREAD;

/**
 * Upstream's thread menu with "Share thread…" after "Copy" (Shared server AC18). It is shown to
 * everyone and disabled for a connection without "Manage access", as upstream shows an action a
 * connection lacks. Upstream's own list is left as it was built.
 */
export function withSharingMenuItems<Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>,
  thread: ScopedThreadRef,
): ReadonlyArray<ContextMenuItem<Id | SharingMenuActionId>> {
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

/** Runs the item J5 added and says so, leaving every other id to upstream's own handling. */
export function runSharingMenuAction<Id extends string>(
  action: Id | SharingMenuActionId,
  thread: ScopedThreadRef,
): action is SharingMenuActionId {
  if (action !== SHARE_THREAD) return false;
  openSharingDialog({
    kind: "share",
    environmentId: thread.environmentId,
    target: { kind: "thread", threadId: thread.threadId },
  });
  return true;
}
