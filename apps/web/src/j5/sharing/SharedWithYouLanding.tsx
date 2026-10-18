import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SharingOwnGrant } from "@t3tools/contracts/j5";
import { Link, useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

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
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useThreadShell, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { j5Sharing } from "./guestAccess";
import { landingFor } from "./joinPage.logic";
import { forgetLandingThread, landingThread } from "./landingThread";
import {
  rememberPairedThroughShareLink,
  wasPairedThroughShareLink,
} from "./pairedThroughShareLink";
import { ownGrantsQuery } from "./sharingManage";

/**
 * The first screen. A member gets `children`, upstream's own landing, at once and without
 * waiting on the server. A guest never starts a draft, which they could not send: they land on the one thread they were given, on a list when
 * they hold several things, and on a plain statement when nothing is shared with them
 * (Shared server AC23).
 */
export function GuestLanding({ children }: { readonly children: ReactNode }) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return children;
  return <KnownServerLanding environmentId={environmentId}>{children}</KnownServerLanding>;
}

function KnownServerLanding({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const kind = useAtomValue(j5Sharing.connectionKind(environmentId));
  const [pairedThroughShareLink] = useState(wasPairedThroughShareLink);
  // What the server says replaces what this browser remembered, for the next time it opens.
  useEffect(() => {
    if (kind !== null) rememberPairedThroughShareLink(kind === "guest");
  }, [kind]);
  switch (landingFor({ kind, pairedThroughShareLink })) {
    case "upstream":
      return children;
    case "hold":
      return null;
    case "guest":
      return <GuestHome environmentId={environmentId} />;
  }
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

function GuestHome({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const grants = useEnvironmentQuery(ownGrantsQuery(environmentId));
  // A member shares and stops sharing while this client is open, and the guest may just have
  // left something. Each landing reads again, and acts on nothing it read before that.
  const [asked, setAsked] = useState(false);
  // The server restarts a guest's sidebar feed when their grants change, so a change in how many
  // threads they are sent is the cue to read the grants again: a new share appears on its own.
  const threadsSent = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId,
  ).length;
  useEffect(() => {
    appAtomRegistry.refresh(ownGrantsQuery(environmentId));
    setAsked(true);
  }, [environmentId, threadsSent]);
  const held = asked && !grants.isPending ? (grants.data?.grants ?? null) : null;
  const only = held !== null && held.length === 1 ? held[0]!.target : null;
  const onlyThreadId = only?.kind === "thread" ? only.threadId : null;
  // A thread just joined by an open link is opened once the server's list holds it, and not
  // before: upstream's thread page leaves an address its list does not hold yet.
  const [joinedThreadId] = useState(landingThread);
  const joinedThread = useThreadShell(
    joinedThreadId === null ? null : scopeThreadRef(environmentId, joinedThreadId),
  );
  const openThreadId = joinedThread?.id ?? onlyThreadId;

  useEffect(() => {
    if (openThreadId === null) return;
    forgetLandingThread();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, openThreadId)),
      replace: true,
    });
  }, [environmentId, navigate, openThreadId]);

  if (held === null) {
    return grants.error === null || grants.isPending || !asked ? null : (
      <Frame>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>What is shared with you could not be read</EmptyTitle>
            <EmptyDescription>{grants.error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Frame>
    );
  }
  if (openThreadId !== null) return null;
  if (held.length === 0) {
    return (
      <Frame>
        <Empty className="flex-1">
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Nothing is shared with you</EmptyTitle>
            <EmptyDescription>
              Ask a member of this server to share a thread or project with you. This device stays
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
        {held.map((grant) =>
          grant.target.kind === "thread" ? (
            <SharedThread
              key={`thread:${grant.target.threadId}`}
              environmentId={environmentId}
              grant={grant}
            />
          ) : (
            <SharedProject
              key={`project:${grant.target.projectId}`}
              environmentId={environmentId}
              grant={grant}
            />
          ),
        )}
      </div>
    </Frame>
  );
}

const ROW_CLASSNAME =
  "flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-foreground hover:bg-accent";

function SharedThread({
  environmentId,
  grant,
}: {
  readonly environmentId: EnvironmentId;
  readonly grant: SharingOwnGrant;
}) {
  const threadId = grant.target.kind === "thread" ? grant.target.threadId : null;
  const thread = useThreadShell(threadId === null ? null : scopeThreadRef(environmentId, threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  // The sidebar's feed can arrive after the grants do; the row waits for the thread it names.
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
  grant,
}: {
  readonly environmentId: EnvironmentId;
  readonly grant: SharingOwnGrant;
}) {
  const projectId = grant.target.kind === "project" ? grant.target.projectId : null;
  const project = useProject(projectId === null ? null : scopeProjectRef(environmentId, projectId));
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
