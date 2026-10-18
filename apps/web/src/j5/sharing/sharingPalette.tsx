import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PencilIcon, UsersIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import { useProject } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useConnectionAccess } from "./access";
import { openSharingDialog, type SharingDialogRequest } from "./sharingDialogs";
import { sharingManage } from "./sharingManage";

/**
 * People and access in the command palette: share the open thread, the project in view or the
 * server (design §2), open People, and change your own name (AC46). Sharing is disabled on a
 * device without "Manage access", as upstream shows an action a device lacks (AC34).
 */
export function useSharingPaletteItems(input: {
  readonly activeThread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
  } | null;
  readonly projectRef: ScopedProjectRef | null;
}): ReadonlyArray<CommandPaletteActionItem> {
  const { activeThread, projectRef } = input;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId =
    activeThread?.environmentId ?? projectRef?.environmentId ?? primaryEnvironmentId;
  const canManage = useAtomValue(sharingManage.createLink.permissionAtom(environmentId));
  const access = useConnectionAccess(environmentId);
  const project = useProject(
    projectRef === null ? null : scopeProjectRef(projectRef.environmentId, projectRef.projectId),
  );
  const navigate = useNavigate();
  if (environmentId === null) return [];

  const share = (
    value: string,
    title: string,
    description: string,
    request: SharingDialogRequest & { readonly kind: "share" },
  ): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [title.toLowerCase(), "invite", "people", "link", "viewer", "collaborator"],
    title,
    description,
    disabled: !canManage,
    icon: <UsersIcon className={ITEM_ICON_CLASS} />,
    run: async () => openSharingDialog(request),
  });

  const items: CommandPaletteActionItem[] = [];
  if (activeThread !== null) {
    items.push(
      share("action:j5-share-thread", "Share thread", activeThread.title, {
        kind: "share",
        environmentId: activeThread.environmentId,
        scope: { kind: "thread", threadId: activeThread.id },
      }),
    );
  }
  if (projectRef !== null && project !== null) {
    items.push(
      share("action:j5-share-project", "Share project", project.title, {
        kind: "share",
        environmentId: projectRef.environmentId,
        scope: { kind: "project", projectId: projectRef.projectId },
      }),
    );
  }
  items.push(
    share("action:j5-share-server", "Share server", "Everything on this server", {
      kind: "share",
      environmentId,
      scope: { kind: "server" },
    }),
    {
      kind: "action",
      value: "action:j5-open-people",
      searchTerms: ["open people", "share", "sharing", "devices", "links", "settings", "leave"],
      title: "Open People",
      description: "Settings",
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/people" });
      },
    },
  );
  if (access?.kind === "person") {
    items.push({
      kind: "action",
      value: "action:j5-change-your-name",
      searchTerms: ["change your name", "rename yourself", "my name", "people"],
      title: "Change your name",
      description: access.name ?? "What people and agents call you",
      icon: <PencilIcon className={ITEM_ICON_CLASS} />,
      run: async () =>
        openSharingDialog({
          kind: "rename",
          environmentId,
          person: { personId: access.personId, name: access.name, you: true },
        }),
    });
  }
  return items;
}
