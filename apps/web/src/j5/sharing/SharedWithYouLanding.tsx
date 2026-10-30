import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useProject, useThreadShell, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useConnectionAccess } from "./access";
import { landingFor } from "./landing.logic";

/**
 * The first screen; see `landingFor`. Anyone at server scope gets `children`, upstream's own
 * landing, at once and without waiting on the server.
 */
export function SharedWithYouLanding({ children }: { readonly children: ReactNode }) {
  const environmentId = usePrimaryEnvironmentId();
  const access = useConnectionAccess(environmentId);
  const landing = landingFor(access);
  if (environmentId === null || landing.kind === "upstream") return children;
  return <Landing environmentId={environmentId} landing={landing} />;
}

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
            Shared with you
          </span>
        </WorkspacePageHeader>
        {children}
      </div>
    </SidebarInset>
  );
}

function Landing({
  environmentId,
  landing,
}: {
  readonly environmentId: EnvironmentId;
  readonly landing: Exclude<ReturnType<typeof landingFor>, { readonly kind: "upstream" }>;
}) {
  const navigate = useNavigate();
  const openThreadId = landing.kind === "open" ? landing.threadId : null;
  // Opened once the server's list holds it: upstream's thread page leaves an address its list
  // does not hold yet, and the list can arrive after the answer that named it.
  const listed = useThreadShell(
    openThreadId === null ? null : scopeThreadRef(environmentId, openThreadId),
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- opens the shared thread once the server lists it, which happens after the landing renders.
  useEffect(() => {
    if (openThreadId === null || listed === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, openThreadId)),
      replace: true,
    });
  }, [environmentId, listed, navigate, openThreadId]);

  if (landing.kind === "open") return null;
  if (landing.kind === "nothing") {
    return (
      <Frame>
        <Empty className="flex-1">
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Nothing is shared with you</EmptyTitle>
            <EmptyDescription>
              Ask an Owner of this server to share a thread or project with you. This device stays
              paired, so a new share will appear here on its own.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Frame>
    );
  }
  return (
    <Frame>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-1 overflow-y-auto px-4 py-8">
        {landing.projectIds.map((projectId) => (
          <SharedProject
            key={`project:${projectId}`}
            environmentId={environmentId}
            projectId={projectId}
          />
        ))}
        {landing.threadIds.map((threadId) => (
          <SharedThread
            key={`thread:${threadId}`}
            environmentId={environmentId}
            threadId={threadId}
          />
        ))}
      </div>
    </Frame>
  );
}

const ROW_CLASSNAME =
  "flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-foreground hover:bg-accent";

function SharedThread({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  // The sidebar's feed can arrive after the levels do; the row waits for the thread it names.
  if (thread === null) return null;
  return (
    <Link
      className={ROW_CLASSNAME}
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.id))}
    >
      {project === null ? null : <ProjectFavicon project={project} />}
      <span className="min-w-0 truncate">{thread.title}</span>
      {project === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">· {project.title}</span>
      )}
    </Link>
  );
}

// A shared project can hold a great many threads; the landing lists the most recent few and the
// sidebar holds them all.
const MOST_THREADS_LISTED = 8;

function SharedProject({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const project = useProject(scopeProjectRef(environmentId, projectId));
  // Most recently active first, as the sidebar lists them.
  const lastActive = (thread: { latestUserMessageAt?: string | null; updatedAt: string }) =>
    thread.latestUserMessageAt ?? thread.updatedAt;
  const threads = useThreadShells()
    .filter((thread) => thread.environmentId === environmentId && thread.projectId === projectId)
    .toSorted((left, right) => lastActive(right).localeCompare(lastActive(left)));
  if (project === null) return null;
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex min-h-8 items-center gap-2 px-2.5 text-xs font-medium text-muted-foreground">
        <ProjectFavicon project={project} />
        <span className="min-w-0 truncate">{project.title}</span>
        <span className="shrink-0 font-normal">· project</span>
      </div>
      {threads.slice(0, MOST_THREADS_LISTED).map((thread) => (
        <Link
          key={thread.id}
          className={ROW_CLASSNAME}
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.id))}
        >
          <span className="min-w-0 truncate pl-5.5">{thread.title}</span>
        </Link>
      ))}
      {threads.length > MOST_THREADS_LISTED ? (
        <p className="px-2.5 pl-8 text-xs text-muted-foreground">
          and {threads.length - MOST_THREADS_LISTED} more in the sidebar
        </p>
      ) : null}
    </div>
  );
}
