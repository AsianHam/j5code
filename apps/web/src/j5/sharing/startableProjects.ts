import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

import {
  buildSidebarProjectPickerEntries,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { readCanStartThreadIn } from "./startAccess";

/**
 * Upstream's project picker for a new thread, narrowed to the checkouts the person may start a
 * thread in. A group keeps only those checkouts, so its chosen one, and the one a click in it
 * falls back to, is one that can take a thread; a group with none is left out.
 */
export function startableProjectPicker(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly preferredProjectRef: ScopedProjectRef | null;
  readonly canStartIn: (environmentId: EnvironmentId, projectId: ProjectId) => boolean;
}) {
  const groups = input.groups.flatMap((group): SidebarProjectSnapshot[] => {
    const memberProjects = group.memberProjects.filter((member) =>
      input.canStartIn(member.environmentId, member.id),
    );
    if (memberProjects.length === 0) return [];
    if (memberProjects.length === group.memberProjects.length) return [group];
    return [
      {
        ...group,
        memberProjects,
        memberProjectRefs: group.memberProjectRefs.filter((ref) =>
          input.canStartIn(ref.environmentId, ref.projectId),
        ),
      },
    ];
  });
  const entries = buildSidebarProjectPickerEntries({
    groups,
    preferredProjectRef: input.preferredProjectRef,
  });
  return {
    projects: entries.map(
      ({ group, targetProject }): SidebarProjectGroupMember & { displayName: string } => ({
        ...targetProject,
        displayName: group.displayName,
      }),
    ),
    groupByTargetKey: new Map(
      entries.map(({ group, targetProject }) => [
        `${targetProject.environmentId}:${targetProject.id}`,
        group,
      ]),
    ),
  };
}

/**
 * Where a new thread starts when the person picks this project and it has none: the checkout
 * picked, or, when that one cannot take a thread, the first of its group that can. `null` when
 * none can, so the pick creates no draft the server would refuse.
 */
export function startableMemberRef(input: {
  readonly project: { readonly environmentId: EnvironmentId; readonly id: ProjectId };
  readonly group: SidebarProjectSnapshot | undefined;
  readonly canStartIn: (environmentId: EnvironmentId, projectId: ProjectId) => boolean;
}): ScopedProjectRef | null {
  const picked = { environmentId: input.project.environmentId, projectId: input.project.id };
  return (
    [picked, ...(input.group?.memberProjectRefs ?? [])].find((ref) =>
      input.canStartIn(ref.environmentId, ref.projectId),
    ) ?? null
  );
}

/**
 * Whether picking this project in search does anything: it has a thread to open, or a checkout
 * the person may start one in. `projectKeysWithThreads` holds `environmentId:projectId` for each
 * project with a thread that is not archived.
 */
export function openableFromSearch(input: {
  readonly project: { readonly environmentId: EnvironmentId; readonly id: ProjectId };
  readonly group: SidebarProjectSnapshot | undefined;
  readonly projectKeysWithThreads: ReadonlySet<string>;
  readonly canStartIn: (environmentId: EnvironmentId, projectId: ProjectId) => boolean;
}): boolean {
  const refs = input.group?.memberProjectRefs ?? [
    { environmentId: input.project.environmentId, projectId: input.project.id },
  ];
  return (
    refs.some((ref) => input.projectKeysWithThreads.has(`${ref.environmentId}:${ref.projectId}`)) ||
    startableMemberRef(input) !== null
  );
}

/**
 * The checkout a plain New thread click starts in when the open project cannot take a thread:
 * the one the filtered picker would choose first, read when clicked so the sidebar does not
 * render again on every access refresh.
 */
export function readStartableProjectRef(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
): ScopedProjectRef | null {
  const target = startableProjectPicker({
    groups,
    preferredProjectRef: null,
    canStartIn: (environmentId, projectId) => readCanStartThreadIn({ environmentId, projectId }),
  }).projects[0];
  return target ? { environmentId: target.environmentId, projectId: target.id } : null;
}
