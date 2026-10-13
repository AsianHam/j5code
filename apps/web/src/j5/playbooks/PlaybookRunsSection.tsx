import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { presentPlaybook, sortPlaybookRuns } from "@t3tools/client-runtime/j5/playbooks";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { PLAYBOOK_RUNS_PAGE_SIZE, type PlaybookProgress } from "@t3tools/contracts/j5";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useNowMinute } from "../../hooks/useNowMinute";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { j5Environment } from "../state";
import { useVisibleRefresh } from "../useVisibleRefresh";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { fleetCrewAnchorId } from "../fleet/fleet.logic";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";

/** The Fleet page's Crews, so a Crew-linked run can name its Crew and jump to its group. */
interface PlaybookRunCrewLinks {
  /** Crew names by `fleetCrewAnchorId`. */
  readonly crewNames?: ReadonlyMap<string, string>;
  readonly onShowCrew?: (anchorId: string) => void;
  /** Called when an environment's playbooks change, so the Crews' step headers refresh too. */
  readonly onPlaybookChange?: () => void;
}

function PlaybookRunCard({
  run,
  thread,
  environment,
  live,
  provider,
  nowMs,
  crewNames,
  onShowCrew,
}: {
  run: PlaybookProgress;
  thread: EnvironmentThreadShell | undefined;
  environment: EnvironmentPresentation;
  live: boolean;
  provider: ProviderInstanceEntry | undefined;
  nowMs: number;
} & PlaybookRunCrewLinks) {
  const crewAnchorId = run.crewInstanceId
    ? fleetCrewAnchorId(environment.environmentId, run.crewInstanceId)
    : null;
  const crewName = crewAnchorId === null ? undefined : crewNames?.get(crewAnchorId);
  const display = presentPlaybook(run);
  const owner = thread?.deletedAt === null ? thread : undefined;
  const activity =
    owner && live
      ? (resolveThreadStatusPill({ thread: owner })?.label ?? "Idle")
      : "Activity unavailable";
  const age = formatElapsedDurationLabel(run.updatedAt, nowMs);
  return (
    <article className="relative rounded-lg border border-border bg-card p-4 hover:bg-accent/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          {owner && environment.connection.phase === "connected" ? (
            <Link
              className="outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(
                scopeThreadRef(environment.environmentId, run.ownerThreadId),
              )}
            >
              {run.title}
            </Link>
          ) : (
            run.title
          )}
        </h3>
        <Badge
          variant={
            run.issue
              ? "warning"
              : run.status === "completed"
                ? "success"
                : run.status === "active"
                  ? "default"
                  : "secondary"
          }
        >
          {display.status}
        </Badge>
      </div>
      {run.position !== null && run.total > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="progressbar"
                aria-label="Playbook position"
                aria-valuemin={0}
                aria-valuemax={run.total}
                aria-valuenow={run.position}
                aria-valuetext={`${display.position} · ${display.currentTitle}`}
                tabIndex={0}
                className="relative z-10 mt-2 h-2 overflow-hidden rounded-sm bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <div
              className={
                run.status === "active" ? "h-full bg-primary" : "h-full bg-muted-foreground/60"
              }
              style={{ width: `${(run.position / run.total) * 100}%` }}
            />
          </TooltipTrigger>
          <TooltipPopup>
            {display.position} · {display.currentTitle}
          </TooltipPopup>
        </Tooltip>
      )}
      <p className="mt-1 text-sm">
        {display.position} · {display.currentTitle}
      </p>
      <p className="mt-3 break-words text-sm">
        {owner ? owner.title : `Owner unavailable · ${run.ownerThreadId}`}
      </p>
      {crewAnchorId !== null && crewName !== undefined && (
        <p className="relative z-10 mt-1 text-xs">
          <Button size="xs" variant="link" onClick={() => onShowCrew?.(crewAnchorId)}>
            Crew · {crewName}
          </Button>
        </p>
      )}
      {owner && (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {provider?.displayName ?? owner.runtime?.providerName ?? owner.modelSelection.instanceId}
          {" · "}
          {owner.modelSelection.model} · Thread: {activity}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Updated <time dateTime={run.updatedAt}>{age === "just now" ? age : `${age} ago`}</time>
      </p>
      {run.issue && (
        <p role="status" className="mt-3 text-sm text-warning">
          {run.issue.message}
        </p>
      )}
    </article>
  );
}

function EnvironmentRuns({
  environment,
  status,
  threads,
  showEnvironmentLabel,
  crewNames,
  onShowCrew,
  onPlaybookChange,
}: {
  environment: EnvironmentPresentation;
  status: "active" | "all";
  threads: ReadonlyMap<string, EnvironmentThreadShell>;
  showEnvironmentLabel: boolean;
} & PlaybookRunCrewLinks) {
  const [offset, setOffset] = useState(0);
  // A guest is shown none of a server's Playbooks (Shared server AC24), so none is read.
  const guest = useGuestEnvironmentIds().has(environment.environmentId);
  const unsupported = guest || j5LedgerSupported(environment.serverConfig) === false;
  const query = useEnvironmentQuery(
    unsupported
      ? null
      : j5Environment.playbookRuns({
          environmentId: environment.environmentId,
          input: { status, offset },
        }),
  );
  const shell = useEnvironmentQuery(environmentShell.stateAtom(environment.environmentId));
  const connected = environment.connection.phase === "connected";
  const { data } = query;
  const changes = useEnvironmentQuery(
    data
      ? j5Environment.playbookChanges({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  useVisibleRefresh(
    query.refresh,
    data?.runs.some((run) => run.status === "active") ? 30_000 : null,
    connected && !unsupported && !query.isPending,
    JSON.stringify([
      changes.data,
      ...Array.from(threads.values(), (thread) => [
        thread.id,
        thread.latestRun?.runId,
        thread.latestRun?.status,
      ]),
    ]),
  );
  // The first revision is the one the page loaded with; only later changes refresh Fleet.
  const seenRevision = useRef<unknown>(undefined);
  useEffect(() => {
    if (changes.data === undefined || changes.data === null) return;
    if (seenRevision.current !== undefined && seenRevision.current !== changes.data)
      onPlaybookChange?.();
    seenRevision.current = changes.data;
  }, [changes.data, onPlaybookChange]);
  const runs = useMemo(() => sortPlaybookRuns(data?.runs ?? []), [data?.runs]);
  const providerEntries = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(environment.serverConfig?.providers ?? []).map((entry) => [
          entry.instanceId as string,
          entry,
        ]),
      ),
    [environment.serverConfig?.providers],
  );
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  return (
    <section aria-label={`${environment.label} playbook runs`} className="space-y-3">
      <div className="flex items-center justify-end gap-3">
        {showEnvironmentLabel && (
          <h2 className="mr-auto text-sm font-medium">{environment.label}</h2>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={!connected || unsupported || query.isPending}
          onClick={query.refresh}
        >
          Refresh
        </Button>
      </div>
      {!connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          {connectionStatusText(environment.connection)}
          {data ? " · Showing the last received runs." : " · Runs are unavailable."}
        </p>
      ) : unsupported ? (
        <p role="status" className="text-sm text-muted-foreground">
          This environment does not support the playbook overview yet.
        </p>
      ) : query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
          {data ? " Showing the last received runs." : ""}
        </p>
      ) : query.isPending && !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading playbook runs…
        </p>
      ) : null}
      {connected && !query.error && data?.runs.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {offset > 0
            ? "No runs on this page. Return to the previous page."
            : status === "active"
              ? "No active playbook runs. Start one from a thread with /playbook, or choose All to see finished runs."
              : "No playbook runs yet. Start one from a thread with /playbook."}
        </p>
      )}
      {runs.map((run) => {
        const thread = threads.get(run.ownerThreadId);
        return (
          <PlaybookRunCard
            key={run.runId}
            run={run}
            thread={thread}
            environment={environment}
            live={connected && shell.data?.status === "live"}
            provider={thread ? providerEntries.get(thread.modelSelection.instanceId) : undefined}
            nowMs={nowMs}
            {...(crewNames === undefined ? {} : { crewNames })}
            {...(onShowCrew === undefined ? {} : { onShowCrew })}
          />
        );
      })}
      {(offset > 0 || (data?.total ?? 0) > PLAYBOOK_RUNS_PAGE_SIZE) && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {data
              ? `${data.runs.length === 0 ? 0 : offset + 1}–${offset + data.runs.length} of ${data.total} runs`
              : "Run pages"}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0 || query.isPending || !connected}
              onClick={() => setOffset(Math.max(0, offset - PLAYBOOK_RUNS_PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !data ||
                offset + PLAYBOOK_RUNS_PAGE_SIZE >= data.total ||
                query.isPending ||
                !connected
              }
              onClick={() => setOffset(offset + PLAYBOOK_RUNS_PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function PlaybookRunsSection(props: PlaybookRunCrewLinks = {}) {
  const { environments, isReady } = useEnvironments();
  const threads = useThreadShells();
  const [status, setStatus] = useState<"active" | "all">("active");
  const threadsByEnvironment = useMemo(() => {
    const groups = new Map<string, Map<string, EnvironmentThreadShell>>();
    for (const thread of threads) {
      let group = groups.get(thread.environmentId);
      if (!group) groups.set(thread.environmentId, (group = new Map()));
      group.set(thread.id, thread);
    }
    return groups;
  }, [threads]);
  return (
    <section aria-label="Playbook runs" className="mt-8 space-y-4 border-t border-border pt-6">
      <h2 className="text-lg font-semibold">Playbook runs</h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Follow playbook runs across your threads.</p>
        <div className="flex gap-2" role="group" aria-label="Run status">
          {(["active", "all"] as const).map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant={status === filter ? "secondary" : "outline"}
              aria-pressed={status === filter}
              onClick={() => setStatus(filter)}
            >
              {filter === "active" ? "Active" : "All"}
            </Button>
          ))}
        </div>
      </div>
      {!isReady ? (
        <p role="status">Loading environments…</p>
      ) : environments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Connect an environment to see playbook runs.
        </p>
      ) : null}
      {environments.map((environment) => (
        <EnvironmentRuns
          key={`${environment.environmentId}:${status}`}
          environment={environment}
          status={status}
          threads={threadsByEnvironment.get(environment.environmentId) ?? new Map()}
          showEnvironmentLabel={environments.length > 1}
          {...props}
        />
      ))}
    </section>
  );
}
