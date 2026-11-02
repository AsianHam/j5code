import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type KnownConnectionAccess, sharingAllowsStart } from "@t3tools/client-runtime/j5/sharing";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { j5Sharing } from "./guestAccess";

// Where this connection may start something, read across every saved server at once. A server
// not yet in the catalog, or not yet answered, withholds nothing; the server checks every start.
const startsAtom = Atom.make((get) => {
  const accessById = new Map<EnvironmentId, KnownConnectionAccess>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    accessById.set(id, get(j5Sharing.connectionAccess(id)));
  }
  return (environmentId: EnvironmentId, projectId: ProjectId | null) =>
    sharingAllowsStart(accessById.get(environmentId) ?? null, projectId);
}).pipe(Atom.withLabel("mobile-j5:access:starts"));

/**
 * Whether this connection may start a thread in a project: upstream's "Operate tasks", and a
 * Collaborator's or Owner's level over the project or the server (People and access AC14). A
 * Viewer, or a Collaborator on one thread, is not offered a thread the server would refuse.
 */
export function useCanStartTaskIn(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): boolean {
  const permitted = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const starts = useAtomValue(startsAtom);
  return permitted && (environmentId === null || starts(environmentId, projectId));
}

/** `useCanStartTaskIn` read when called, for a send that runs outside render. */
export function readCanStartTaskIn(environmentId: EnvironmentId, projectId: ProjectId): boolean {
  return (
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) &&
    appAtomRegistry.get(startsAtom)(environmentId, projectId)
  );
}

/** Keeps the projects this connection may start a thread in, for the New thread project picker. */
export function useStartableProjects<
  Project extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(projects: ReadonlyArray<Project>): ReadonlyArray<Project> {
  const starts = useAtomValue(startsAtom);
  return useMemo(
    () => projects.filter((project) => starts(project.environmentId, project.id)),
    [projects, starts],
  );
}

/**
 * Whether this connection may add a project to a server: upstream's "Operate tasks", and a
 * Collaborator's or Owner's level at server scope (AC19).
 */
export function useCanAddProject(environmentId: EnvironmentId | null): boolean {
  return useCanStartTaskIn(environmentId, null);
}

/**
 * Whether this connection may fork a thread. A fork is a new thread in the thread's project, so
 * the project's level decides, not the thread's.
 */
export function useCanForkThread(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  const projectId = useThreadShell(scopeThreadRef(environmentId, threadId))?.projectId ?? null;
  const starts = useAtomValue(startsAtom);
  return starts(environmentId, projectId);
}

/**
 * What New thread's project picker says when the server reports projects but the person may start
 * a thread in none of them, in place of upstream's "No projects found".
 */
export function noStartableProjectState(input: {
  readonly projectCount: number;
  readonly startableScopeCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: false } | null {
  if (input.projectCount === 0 || input.startableScopeCount > 0) return null;
  return {
    title: "Nothing to start a thread in",
    detail:
      "You can write only in the threads shared with you. To start one, ask an Owner to share a project with you.",
    loading: false,
  };
}
