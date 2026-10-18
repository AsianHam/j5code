import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { PersonScope, ProjectOrThreadScope, ScopePeople } from "@t3tools/contracts/j5";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { type AccessRow, accessRowsForServer, accessRowsFromScope } from "./people.logic";
import { peopleQuery, sharingManage } from "./sharingManage";

/**
 * A thing that can be shared, by the names a person knows it by: "Share <title>" and a line
 * saying what it is, with the project whose icon goes beside it.
 */
export function useScopeTitle(environmentId: EnvironmentId, scope: PersonScope | null) {
  const server = useEnvironment(environmentId);
  const thread = useThreadShell(
    scope?.kind === "thread" ? scopeThreadRef(environmentId, scope.threadId) : null,
  );
  const project = useProject(
    scope?.kind === "project"
      ? scopeProjectRef(environmentId, scope.projectId)
      : thread === null
        ? null
        : scopeProjectRef(environmentId, thread.projectId),
  );
  const projectThreads = useThreadShells(scope?.kind === "project").filter(
    (shell) =>
      scope?.kind === "project" &&
      shell.environmentId === environmentId &&
      shell.projectId === scope.projectId,
  ).length;
  const serverName = server?.label ?? "this server";
  if (scope === null) return { title: null, detail: null, project: null, serverName };
  switch (scope.kind) {
    case "server":
      return { title: serverName, detail: "Whole server", project: null, serverName };
    case "project":
      return {
        title: project?.title ?? "A project that is no longer listed",
        detail: `Project · ${projectThreads} ${projectThreads === 1 ? "thread" : "threads"}`,
        project,
        serverName,
      };
    case "thread":
      return {
        title: thread?.title ?? "A thread that is no longer listed",
        detail: project === null ? "Thread" : `Thread in ${project.title}`,
        project,
        serverName,
      };
  }
}

/**
 * Who reaches one thread or project, as the server tells anyone who reaches it (AC26). The
 * server counts each time its answer changes, and the answer is asked again then.
 */
export function useScopePeople(
  environmentId: EnvironmentId | null,
  scope: ProjectOrThreadScope | null,
): { readonly data: ScopePeople | null; readonly error: string | null } {
  const key = scope === null || environmentId === null ? null : JSON.stringify(scope);
  const target = useMemo(
    () =>
      key === null || environmentId === null
        ? null
        : { environmentId, input: { scope: JSON.parse(key) as ProjectOrThreadScope } },
    [environmentId, key],
  );
  const query = target === null ? null : sharingManage.scopePeople(target);
  const people = useEnvironmentQuery(query);
  const revision = useEnvironmentQuery(
    target === null ? null : sharingManage.scopePeopleChanges(target),
  ).data?.revision;
  useEffect(() => {
    if (query !== null && revision !== undefined && revision > 0) appAtomRegistry.refresh(query);
  }, [query, revision]);
  return { data: people.data, error: people.error };
}

/**
 * Everyone who reaches a thing, as the Share dialog lists them: from who reaches a thread or
 * project, or, for the whole server, from an Owner's list of everyone on it.
 */
export function useAccessRows(
  environmentId: EnvironmentId,
  scope: PersonScope | null,
): { readonly rows: ReadonlyArray<AccessRow> | null; readonly error: string | null } {
  const narrow = scope === null || scope.kind === "server" ? null : scope;
  const scoped = useScopePeople(environmentId, narrow);
  const everyone = useEnvironmentQuery(
    scope?.kind === "server" ? peopleQuery(environmentId) : null,
  );
  return useMemo(() => {
    if (scope === null) return { rows: null, error: null };
    if (scope.kind === "server") {
      return {
        rows: everyone.data === null ? null : accessRowsForServer(everyone.data.people),
        error: everyone.error,
      };
    }
    return {
      rows: scoped.data === null ? null : accessRowsFromScope(scoped.data.people, scope),
      error: scoped.error,
    };
  }, [everyone.data, everyone.error, scope, scoped.data, scoped.error]);
}
