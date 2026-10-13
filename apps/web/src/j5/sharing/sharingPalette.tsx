import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Link2Icon, UsersIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import { useProject } from "../../state/entities";
import { j5Sharing } from "./guestAccess";
import { useCanSeePeople } from "./peopleAccess";
import { openSharingDialog } from "./sharingDialogs";
import { sharingManage } from "./sharingManage";

/**
 * Sharing's entries in the command palette: the open thread, the project in view, and a join
 * link for the open thread (Shared server AC18). A connection without "Manage access" sees them
 * disabled; a guest, who shares nothing onward, does not see them.
 */
const NOT_A_GUEST = Atom.make(false);

export function useSharingPaletteItems(input: {
  readonly activeThread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
  } | null;
  readonly projectRef: ScopedProjectRef | null;
}): ReadonlyArray<CommandPaletteActionItem> {
  const { activeThread, projectRef } = input;
  const environmentId = activeThread?.environmentId ?? projectRef?.environmentId ?? null;
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const isGuest = useAtomValue(
    environmentId === null ? NOT_A_GUEST : j5Sharing.isGuest(environmentId),
  );
  const project = useProject(
    projectRef === null ? null : scopeProjectRef(projectRef.environmentId, projectRef.projectId),
  );
  const canSeePeople = useCanSeePeople();
  const navigate = useNavigate();
  if (environmentId === null || isGuest) return [];

  const items: CommandPaletteActionItem[] = [];
  if (activeThread !== null) {
    items.push({
      kind: "action",
      value: "action:j5-share-thread",
      searchTerms: ["share thread", "invite", "guest", "people", "link", "view", "collaborate"],
      title: "Share thread",
      description: activeThread.title,
      disabled: !canManage,
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openSharingDialog({
          kind: "share",
          environmentId: activeThread.environmentId,
          target: { kind: "thread", threadId: activeThread.id },
        });
      },
    });
  }
  if (projectRef !== null && project !== null) {
    items.push({
      kind: "action",
      value: "action:j5-share-project",
      searchTerms: ["share project", "invite", "guest", "people", "link"],
      title: "Share project",
      description: project.title,
      disabled: !canManage,
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openSharingDialog({
          kind: "share",
          environmentId: projectRef.environmentId,
          target: { kind: "project", projectId: projectRef.projectId },
        });
      },
    });
  }
  if (activeThread !== null) {
    items.push({
      kind: "action",
      value: "action:j5-join-link",
      searchTerms: ["make a join link", "open link", "share thread", "invite", "people"],
      title: "Make a join link",
      description: activeThread.title,
      disabled: !canManage,
      icon: <Link2Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openSharingDialog({
          kind: "join-link",
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
        });
      },
    });
  }
  if (canSeePeople) {
    items.push({
      kind: "action",
      value: "action:j5-open-people",
      searchTerms: ["open people", "guests", "members", "share", "sharing", "devices", "settings"],
      title: "Open People",
      description: "Settings",
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/people" });
      },
    });
  }
  return items;
}
