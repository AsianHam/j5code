import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { j5SourceNotice } from "@t3tools/client-runtime/j5/inbox";
import { spansMultipleEnvironments } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { CaptainMark } from "../crew/CaptainMark";
import { PlaybookRunsSection } from "../playbooks/PlaybookRunsSection";
import { fleetDetailSourcesAtom, j5Environment } from "../state";
import { useLogicalProjects } from "../logicalProjects";
import { requestConfirmDialog } from "../../confirmDialog";
import { ArchiveWarningCrewSeats, type ArchiveWarningCrew } from "../a2a/ArchiveWarningContent";
import { archiveCrew } from "../crew/crewArchiveClient";
import {
  classifyCrewSeat,
  crewHasRunningSeat,
  formatCrewStateSummary,
  summarizeCrewState,
} from "../crew/crewState";
import { stopCrew } from "../crew/crewStopClient";
import {
  countFleetProjects,
  fleetCrewAnchorId,
  orderFleetRowsByProject,
  originLabel,
  partitionFleet,
  playbookRunHeader,
  retiredCrews,
  type FleetNode,
  type FleetRow,
  type FleetSectionRow,
  type FleetProjectCrew,
} from "./fleet.logic";
import {
  mergeFleetSources,
  refreshFleet,
  useFleetDetailRefresh,
  type FleetAgent,
  type FleetCrew,
  type ScopedFleetLedgerProject,
} from "./fleetClient";

/** Header and rows share one template so the Project, Status, asks, and activity columns line up. */
const FLEET_GRID_CLASS = "grid grid-cols-[minmax(0,1fr)_11rem_8rem_5rem_7rem] items-center gap-3";

type ThreadLookup = ReadonlyMap<string, EnvironmentThreadShell>;

/** The client's thread shell for an agent row, looked up on the row's own environment. */
const threadFor = (
  threadsByKey: ThreadLookup,
  environmentId: EnvironmentId,
  agent: FleetAgent,
): EnvironmentThreadShell | undefined =>
  agent.threadId === null
    ? undefined
    : threadsByKey.get(
        scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(agent.threadId))),
      );

const projectKey = (ledgerProject: ScopedFleetLedgerProject) =>
  `${ledgerProject.environmentId}:${ledgerProject.id}`;

/** A seat's badge, with the playbook step ids it owns when its Crew follows one. */
const seatBadgeWithSteps = (
  seat: string | null,
  stepsBySeat: ReadonlyMap<string, ReadonlyArray<string>>,
): string | null => {
  const steps = seat === null ? undefined : stepsBySeat.get(seat);
  return seat === null || steps === undefined ? seat : `${seat} · ${steps.join(", ")}`;
};

/**
 * The Roster (SB6): every agent on every connected environment, by project, in three
 * sections. Active holds one table of everything still in motion, indented by placement with
 * Crews as collapsible units under their Captain; Settled and Retired are collapsed expanders
 * for what upstream's settle mechanic marked done and for the Crews that were archived. Status
 * and last activity come from the client's thread state; placement, provenance, seats, and owed
 * asks come from each environment's ledger read. Unknowns render as "?" because a visibly
 * missing fact beats a plausible fake.
 */
export function FleetPage() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const sources = useAtomValue(fleetDetailSourcesAtom);
  useFleetDetailRefresh();
  const [refreshing, setRefreshing] = useState(false);
  const projects = useMemo(() => mergeFleetSources(sources), [sources]);
  const showEnvironment = spansMultipleEnvironments(projects);
  const loading = !sources.isReady || sources.sources.some((source) => source.status === "loading");
  const notices = [
    ...new Set(
      sources.sources.flatMap((source) => {
        const notice = j5SourceNotice(source);
        return notice === null ? [] : [notice];
      }),
    ),
  ];

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshFleet();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const threadsByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread,
        ]),
      ),
    [threads],
  );
  // Each machine's ledger answers per project, so every row under it shares that project.
  const logicalProjectOf = useLogicalProjects();
  const projectOf = useCallback(
    (ledgerProject: ScopedFleetLedgerProject) =>
      logicalProjectOf(ledgerProject.environmentId, ledgerProject.id),
    [logicalProjectOf],
  );
  const sections = useMemo(() => {
    const partitioned = partitionFleet(projects, (environmentId, threadId) =>
      threadsByKey.get(scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)))),
    );
    return {
      ...partitioned,
      active: orderFleetRowsByProject(partitioned.active, projectOf),
      settled: orderFleetRowsByProject(partitioned.settled, projectOf),
    };
  }, [projectOf, projects, threadsByKey]);
  const projectCount = useMemo(
    () => countFleetProjects([...sections.active, ...sections.settled], projectOf),
    [projectOf, sections],
  );
  const retired = useMemo(() => retiredCrews(projects), [projects]);
  // Playbook runs name the Crew they follow from this read, and jump to its group.
  const crewNames = useMemo(
    () =>
      new Map(
        projects.flatMap((ledgerProject) =>
          ledgerProject.crews.map(
            (crew) =>
              [
                fleetCrewAnchorId(ledgerProject.environmentId, crew.crewInstanceId),
                crew.crewName,
              ] as const,
          ),
        ),
      ),
    [projects],
  );
  // A Crew can sit inside the collapsed Settled or Retired sections, so every enclosing
  // expander opens before the group scrolls into view.
  const showCrew = useCallback((anchorId: string) => {
    const group = document.getElementById(anchorId);
    if (!(group instanceof HTMLDetailsElement)) return;
    for (let node: Element | null = group; node !== null; node = node.parentElement)
      if (node instanceof HTMLDetailsElement) node.open = true;
    group.scrollIntoView({ block: "center" });
    group.querySelector("summary")?.focus();
  }, []);
  const openThread = useCallback(
    (environmentId: EnvironmentId, threadId: string) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(threadId))),
      });
    },
    [navigate],
  );

  const { agentCount } = sections;
  const tableProps = { showEnvironment, threadsByKey, onOpenThread: openThread, projectOf };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Fleet breadcrumb">
            <WorkspaceBreadcrumbItem current>Fleet</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
              <div>
                <h1 className="text-balance text-2xl font-semibold tracking-tight">Fleet</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loading && projects.length === 0
                    ? "Reading the roster…"
                    : `${agentCount} ${agentCount === 1 ? "agent" : "agents"} across ${projectCount} ${projectCount === 1 ? "project" : "projects"}`}
                </p>
              </div>
              <Button
                aria-label="Refresh fleet"
                disabled={refreshing}
                onClick={() => void refresh()}
                size="sm"
                variant="outline"
              >
                <RefreshCwIcon aria-hidden className={cn("size-4", refreshing && "animate-spin")} />
                Refresh
              </Button>
            </div>
            {notices.length > 0 ? (
              <ul className="mt-4 space-y-1 text-sm text-muted-foreground" aria-live="polite">
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            ) : null}
            {!loading && projects.length === 0 ? (
              <p className="mt-6 text-sm text-muted-foreground">
                No agents yet. They appear here once a thread starts in a project.
              </p>
            ) : null}
            {projects.length > 0 ? (
              <div className="mt-8">
                <section aria-label="Active">
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Active
                  </h2>
                  {sections.active.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active agents.</p>
                  ) : (
                    <FleetTable rows={sections.active} {...tableProps} />
                  )}
                </section>
                {sections.settled.length === 0 ? null : (
                  <FleetSectionExpander label={`Settled (${sections.settledAgentCount})`}>
                    <FleetTable rows={sections.settled} {...tableProps} />
                  </FleetSectionExpander>
                )}
                <RetiredCrews retired={retired} {...tableProps} />
              </div>
            ) : null}
            <PlaybookRunsSection crewNames={crewNames} onShowCrew={showCrew} />
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** A collapsed section beneath the Active table: Settled and Retired share this one shape. */
function FleetSectionExpander(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <details className="group/section mt-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground outline-hidden marker:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-150 group-open/section:rotate-90"
        />
        {props.label}
      </summary>
      <div className="mt-2">{props.children}</div>
    </details>
  );
}

interface FleetRowsProps {
  readonly showEnvironment: boolean;
  readonly threadsByKey: ThreadLookup;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: string) => void;
  /** Upstream's logical project for one machine's project ledger. */
  readonly projectOf: (
    ledgerProject: ScopedFleetLedgerProject,
  ) => SidebarProjectSnapshot | undefined;
}

function FleetTable(
  props: FleetRowsProps & {
    readonly rows: ReadonlyArray<FleetSectionRow<ScopedFleetLedgerProject>>;
  },
) {
  const { rows, ...shared } = props;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div
        className={cn(
          FLEET_GRID_CLASS,
          "border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground",
        )}
      >
        <span>Agent</span>
        <span>Project</span>
        <span>Status</span>
        <span className="text-right">Open asks</span>
        <span className="text-right">Last activity</span>
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map(({ project: ledgerProject, node }) => (
          <FleetNodeRows
            key={`${projectKey(ledgerProject)}:${node.row.agent.participantId}`}
            project={ledgerProject}
            node={node}
            {...shared}
          />
        ))}
      </ul>
    </div>
  );
}

function FleetNodeRows(
  props: FleetRowsProps & {
    readonly project: ScopedFleetLedgerProject;
    readonly node: FleetNode;
    readonly seatBadge?: string | null;
  },
) {
  const { node, seatBadge, ...rows } = props;
  const { project: ledgerProject } = rows;
  const { environmentId } = ledgerProject;
  // Stop and Archive need the same grant; either command answers for both.
  const canOperate = useAtomValue(j5Environment.stopCrew.permissionAtom(environmentId));
  // "What is the state of this Crew?" from the seats' measured facts, no Playbook required.
  const crewState = (members: ReadonlyArray<FleetRow>) =>
    summarizeCrewState(
      members.map(({ agent }) => threadFor(props.threadsByKey, environmentId, agent)),
    );
  // The person's Stop crew: interrupts every running seat, retires nothing. The seats' status
  // pills tell the truth afterwards; a refused or failed call says so, since a button that does
  // nothing visible is a lying spinner.
  const [busy, setBusy] = useState<string | null>(null);
  const stop = async (crew: { crewInstanceId: string; crewName: string }) => {
    setBusy(crew.crewInstanceId);
    try {
      await stopCrew(environmentId, crew.crewInstanceId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not stop crew ${crew.crewName}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };
  // The person's Archive crew: the same unit archive the Captain has, behind one dialog that
  // lists every seat with what ends for it. The Crew moves to the Retired list.
  const archive = async (
    crew: { crewInstanceId: string; crewName: string },
    seats: ReadonlyArray<FleetRow>,
  ) => {
    const warning: ArchiveWarningCrew = {
      crewInstanceId: crew.crewInstanceId,
      crewName: crew.crewName,
      seats: seats.map(({ agent }) => {
        const thread = threadFor(props.threadsByKey, environmentId, agent);
        const displayName = thread?.title ?? agent.displayName;
        return {
          seat: agent.crew?.seat ?? agent.participantId,
          participant:
            displayName === null
              ? { displayName: "Unnamed participant", tooltipParticipantId: agent.participantId }
              : { displayName, tooltipParticipantId: null },
          runningTurn: classifyCrewSeat(thread) === "running",
          openAsks: agent.openAsks,
        };
      }),
    };
    const consequential = warning.seats.some((seat) => seat.runningTurn || seat.openAsks > 0);
    const confirmed = await (requestConfirmDialog(
      `Archive crew ${crew.crewName}?`,
      { variant: "destructive" },
      {
        content: (
          <div className="space-y-3 text-left">
            <p>Its {warning.seats.length === 1 ? "seat retires" : "seats retire"} together:</p>
            <ArchiveWarningCrewSeats crew={warning} />
            <p className="border-t border-border/60 pt-3 text-muted-foreground">
              Worktrees, branches, and pull requests remain. The roster stays readable under Retired
              crews.
            </p>
          </div>
        ),
        confirmLabel: consequential ? "Archive anyway" : "Archive",
      },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(crew.crewInstanceId);
    try {
      await archiveCrew(environmentId, crew.crewInstanceId);
      refreshFleet();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not archive crew ${crew.crewName}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <FleetRowItem
        row={node.row}
        badge={seatBadge ?? null}
        captainOf={node.crews.map((crew) => crew.crewName)}
        {...rows}
      />
      {node.crews.map((crew) => (
        <li key={crew.crewInstanceId} className="bg-muted/20">
          <details
            className="group/crew"
            id={fleetCrewAnchorId(environmentId, crew.crewInstanceId)}
          >
            <summary
              className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground outline-hidden marker:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
              style={{ paddingInlineStart: `${0.75 + (node.row.depth + 1) * 1.25}rem` }}
            >
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 transition-transform duration-150 group-open/crew:rotate-90"
              />
              <span>Crew · {crew.crewName}</span>
              {crew.playbookName === null ? null : (
                <span className="text-muted-foreground/70">Playbook: {crew.playbookName}</span>
              )}
              {(() => {
                const seats = crew.members.map((member) => member.row);
                const state = crewState(seats);
                const summary = formatCrewStateSummary(state);
                return (
                  <>
                    <span className="text-muted-foreground/70">
                      {crew.members.length} {crew.members.length === 1 ? "seat" : "seats"}
                      {summary === null ? "" : ` · ${summary}`}
                    </span>
                    {crew.playbookRun === null ? null : (
                      <span className="truncate text-foreground/80">
                        {playbookRunHeader(crew.playbookRun)}
                      </span>
                    )}
                    <span className="ms-auto flex items-center gap-1.5">
                      {canOperate && crewHasRunningSeat(state) ? (
                        <Button
                          aria-label={`Stop crew ${crew.crewName}`}
                          disabled={busy === crew.crewInstanceId}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void stop(crew);
                          }}
                          size="xs"
                          variant="outline"
                        >
                          Stop crew
                        </Button>
                      ) : null}
                      <Button
                        aria-label={`Archive crew ${crew.crewName}`}
                        disabled={!canOperate || busy === crew.crewInstanceId}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void archive(crew, seats);
                        }}
                        size="xs"
                        variant="ghost"
                      >
                        Archive crew
                      </Button>
                    </span>
                  </>
                );
              })()}
            </summary>
            <ul className="divide-y divide-border/40 border-t border-border/40">
              {crew.members.map((member) => (
                <FleetNodeRows
                  key={member.row.agent.participantId}
                  node={member}
                  seatBadge={seatBadgeWithSteps(
                    member.row.agent.crew?.seat ?? null,
                    crew.stepsBySeat,
                  )}
                  {...rows}
                />
              ))}
            </ul>
          </details>
        </li>
      ))}
      {node.children.map((child) => (
        <FleetNodeRows key={child.row.agent.participantId} node={child} {...rows} />
      ))}
    </>
  );
}

/**
 * Retired Crews of every project as one-line rows, each naming its project, that open to the
 * brief and the approved roster with each seat's approval version and reason, so a successor can
 * be proposed from what was decided rather than from memory (Crews AC20). A retired Crew comes
 * back only with its Captain (AC17), so its row offers no action beyond naming its Captain, whose
 * thread holds the ledger; handoffs live on the Artifacts page.
 */
function RetiredCrews(
  props: FleetRowsProps & {
    readonly retired: ReadonlyArray<FleetProjectCrew<ScopedFleetLedgerProject>>;
  },
) {
  const { retired, ...shared } = props;
  if (retired.length === 0) return null;
  return (
    <FleetSectionExpander label={`Retired crews (${retired.length})`}>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
        {retired.map(({ project: ledgerProject, crew }) => (
          <RetiredCrewItem
            key={`${projectKey(ledgerProject)}:${crew.crewInstanceId}`}
            project={ledgerProject}
            crew={crew}
            {...shared}
          />
        ))}
      </ul>
    </FleetSectionExpander>
  );
}

function RetiredCrewItem(props: FleetRowsProps & FleetProjectCrew<ScopedFleetLedgerProject>) {
  const { crew, project: ledgerProject } = props;
  const seatCount = crew.roster.length;
  return (
    <li>
      <details
        className="group/retired-crew"
        id={fleetCrewAnchorId(ledgerProject.environmentId, crew.crewInstanceId)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-sm outline-hidden marker:hidden hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open/retired-crew:rotate-90"
          />
          <span className="min-w-0 truncate font-medium text-foreground/80">{crew.crewName}</span>
          <ProjectLabel {...props} agent={null} />
          <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            v{crew.version} · {seatCount} {seatCount === 1 ? "seat" : "seats"} · retired{" "}
            {crew.archivedAt === null ? (
              "?"
            ) : (
              <time dateTime={crew.archivedAt}>
                {formatElapsedDurationLabel(crew.archivedAt) || "just now"}
              </time>
            )}
          </span>
        </summary>
        <div className="border-t border-border/40 px-3 py-2 ps-8.5 text-xs">
          <RetiredCrewCaptain {...props} environmentId={ledgerProject.environmentId} />
          <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{crew.brief}</p>
          {crew.playbook == null ? null : (
            <p className="mt-1 text-muted-foreground">Playbook: {crew.playbook.name}</p>
          )}
          {crew.roster.length === 0 ? (
            <p className="mt-2 text-muted-foreground">No seats were approved.</p>
          ) : (
            <ul className="mt-2 space-y-0.5">
              {crew.roster.map((member) => (
                <li key={member.seat} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="uppercase tracking-wide text-muted-foreground">
                    {member.seat}
                  </span>
                  <span className="text-foreground/80">{member.agentId ?? "Custom seat"}</span>
                  <span className="text-muted-foreground">
                    approved at v{member.addedVersion}
                    {member.reason === null ? "" : ` · ${member.reason}`}
                  </span>
                  {member.steps === undefined ? null : (
                    <span className="text-muted-foreground">steps {member.steps.join(", ")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

/**
 * The Captain's thread keeps the retired Crew's ledger. Archived threads are not in the active
 * thread shells (nor are deleted ones), and the thread route redirects home for them, so only a
 * live Captain is linked. Until the shells load, a missing thread says nothing about archive.
 */
function RetiredCrewCaptain(
  props: FleetRowsProps & { readonly environmentId: EnvironmentId; readonly crew: FleetCrew },
) {
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const { captainThreadId } = props.crew;
  if (captainThreadId === null) return null;
  const thread = props.threadsByKey.get(
    scopedThreadKey(scopeThreadRef(props.environmentId, ThreadId.make(captainThreadId))),
  );
  return (
    <p className="text-muted-foreground">
      Captain:{" "}
      {thread === undefined ? (
        shellsBootstrapped ? (
          "no longer active. If it was archived, unarchive it from Settings → Archived to read its ledger."
        ) : (
          "unavailable."
        )
      ) : (
        <button
          type="button"
          className="text-foreground/80 underline underline-offset-2 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onOpenThread(props.environmentId, captainThreadId)}
        >
          {thread.title}
        </button>
      )}
    </p>
  );
}

/**
 * The project a row belongs to, with upstream's icon and display name. The row's own machine
 * follows once several are connected, since each machine keeps its own ledger. While the project
 * is unresolved the title the read carries stands in.
 */
function ProjectLabel(
  props: Pick<FleetRowsProps, "projectOf" | "showEnvironment"> & {
    readonly project: ScopedFleetLedgerProject;
    readonly agent: FleetAgent | null;
  },
) {
  const project = props.projectOf(props.project);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {project === undefined ? null : <ProjectFavicon project={project} className="size-3.5" />}
      <span className="min-w-0 truncate">
        {project?.displayName ?? props.project.title}
        {props.showEnvironment ? (
          <span className="text-muted-foreground/70"> · {props.project.environmentLabel}</span>
        ) : null}
      </span>
    </span>
  );
}

function FleetRowItem(
  props: FleetRowsProps & {
    readonly project: ScopedFleetLedgerProject;
    readonly row: FleetRow;
    readonly badge: string | null;
    /** Names of the live Crews this row commands; non-empty rows carry the Captain mark. */
    readonly captainOf?: ReadonlyArray<string>;
  },
) {
  const { agent } = props.row;
  const { environmentId } = props.project;
  const thread = threadFor(props.threadsByKey, environmentId, agent);
  const status = thread === undefined ? null : resolveThreadStatusPill({ thread });
  const title = thread?.title ?? agent.displayName ?? agent.participantId;
  const lastActivity =
    thread === undefined ? "?" : formatElapsedDurationLabel(thread.updatedAt) || "just now";
  return (
    <li>
      <button
        type="button"
        className={cn(
          FLEET_GRID_CLASS,
          "w-full px-3 py-2 text-left text-sm outline-hidden hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
        )}
        style={{ paddingInlineStart: `${0.75 + props.row.depth * 1.25}rem` }}
        disabled={agent.threadId === null}
        onClick={() => {
          if (agent.threadId !== null) props.onOpenThread(environmentId, agent.threadId);
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {agent.outsideSpawner !== undefined ? (
            // The label is whatever the client registered, so it yields to the agent's title; the
            // name comes first so a cut keeps it, and the full text is on hover.
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground" />
                }
              >
                {originLabel(agent)}
              </TooltipTrigger>
              <TooltipPopup>{originLabel(agent)}</TooltipPopup>
            </Tooltip>
          ) : agent.origin === "human" ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">{originLabel(agent)}</span>
          )}
          {props.badge ? (
            <Badge variant="outline" size="sm" className="shrink-0">
              {props.badge}
            </Badge>
          ) : null}
          {props.captainOf !== undefined && props.captainOf.length > 0 ? (
            <CaptainMark title={`Commands ${props.captainOf.join(", ")}`} />
          ) : null}
        </span>
        {/* A placement tree lives in one project, so only its root names it. */}
        {props.row.depth === 0 ? <ProjectLabel {...props} agent={agent} /> : <span />}
        <span className="flex items-center gap-1.5 text-xs">
          {status === null ? (
            <span className="text-muted-foreground">
              {thread === undefined
                ? "?"
                : classifyCrewSeat(thread) === "settled"
                  ? "Settled"
                  : "Idle"}
            </span>
          ) : (
            <>
              <span aria-hidden className={cn("size-1.5 rounded-full", status.dotClass)} />
              <span className={status.colorClass}>{status.label}</span>
            </>
          )}
        </span>
        <span
          className={cn(
            "text-right text-xs tabular-nums",
            agent.openAsks > 0 ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {agent.openAsks}
        </span>
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {lastActivity}
        </span>
      </button>
    </li>
  );
}
