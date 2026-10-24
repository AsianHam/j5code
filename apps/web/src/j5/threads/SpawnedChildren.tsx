import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { Badge } from "../../components/ui/badge";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeAge } from "../RelativeAge";
import { stopCrew } from "../crew/crewStopClient";
import { j5Environment } from "../state";
import { useSpawnedChildren, type SpawnedChild } from "./SpawnedChildrenClient";
import {
  groupSpawnedChildren,
  readExpandedSpawnParents,
  selectSpawnedChildRows,
  spawnedGroupExpansionKey,
  stoppableCrew,
  writeExpandedSpawnParents,
  type SpawnedChildGroup,
} from "./spawnedChildren.logic";

// One process-wide expansion set, mirrored to localStorage, shared by every card.
const expansionListeners = new Set<() => void>();
let expanded: ReadonlySet<string> = readExpandedSpawnParents(
  typeof localStorage === "undefined" ? undefined : localStorage,
);
const subscribeExpansion = (listener: () => void) => {
  expansionListeners.add(listener);
  return () => expansionListeners.delete(listener);
};
const getExpansion = () => expanded;
const toggleExpansion = (expansionKey: string) => {
  const next = new Set(expanded);
  if (next.has(expansionKey)) next.delete(expansionKey);
  else next.add(expansionKey);
  expanded = next;
  writeExpandedSpawnParents(typeof localStorage === "undefined" ? undefined : localStorage, next);
  expansionListeners.forEach((listener) => listener());
};

/** The parent row's thread actions, so a child row gets the same menu and inline rename. */
export interface SpawnedChildActions {
  readonly renamingThreadKey: string | null;
  readonly onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  readonly onCommitRename: (
    threadRef: ScopedThreadRef,
    title: string,
    originalTitle: string,
  ) => void;
  readonly onCancelRename: () => void;
}

/**
 * SB5 refinement: agent-spawned Peer Agents stay out of the flat list, but the row that spawned
 * them (a Captain or any spawner) can expand into its placed children so the work is one click
 * away. Each Crew the row commands is its own named, collapsible group, and the solo peers it
 * spawned form one more; collapsed by default, with a measured "needs a human" fact on any child
 * shown on the collapsed header.
 */
export function SpawnedChildren(
  props: SpawnedChildActions & { readonly thread: EnvironmentThreadShell },
) {
  // Every sidebar row mounts this; most rows have no children. Only the cheap children snapshot
  // is read here, so a row without children never subscribes to the shell list and the
  // SidebarThreadRow memo keeps its value on every shell change.
  const children = useSpawnedChildren(scopeThreadRef(props.thread.environmentId, props.thread.id));
  if (children.length === 0) return null;
  return <SpawnedChildrenRows {...props} spawned={children} />;
}

function SpawnedChildrenRows(
  props: SpawnedChildActions & {
    readonly thread: EnvironmentThreadShell;
    readonly spawned: ReadonlyArray<SpawnedChild>;
  },
) {
  const children = props.spawned;
  const threads = useThreadShells();
  const expandedSet = useSyncExternalStore(subscribeExpansion, getExpansion, getExpansion);
  const navigate = useNavigate();
  // Children are placed on the parent's environment; the same local id elsewhere is unrelated.
  const threadsById = useMemo(
    () =>
      new Map(
        threads
          .filter((thread) => thread.environmentId === props.thread.environmentId)
          .map((thread) => [thread.id as string, thread]),
      ),
    [props.thread.environmentId, threads],
  );
  const rows = useMemo(
    () => selectSpawnedChildRows(children, threadsById),
    [children, threadsById],
  );
  const open = useCallback(
    (child: EnvironmentThreadShell) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(child.environmentId, child.id)),
      });
    },
    [navigate],
  );
  const groups = useMemo(() => groupSpawnedChildren(rows), [rows]);
  // Seat rows show their provider the way the parent card does; entries are the parent's
  // environment's, since a child is placed where its parent runs.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const providerEntries = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(
          serverConfigs.get(props.thread.environmentId)?.providers ?? [],
        ).map((entry) => [entry.instanceId as string, entry] as const),
      ),
    [props.thread.environmentId, serverConfigs],
  );
  if (groups.length === 0) return null;
  return (
    <div
      className="ms-6 me-2 mb-1 flex flex-col gap-0.5"
      data-testid={`spawned-children-${props.thread.id}`}
    >
      {groups.map((group) => (
        <SpawnedChildGroupRows
          key={group.key}
          environmentId={props.thread.environmentId}
          group={group}
          providerEntries={providerEntries}
          isOpen={expandedSet.has(
            spawnedGroupExpansionKey(props.thread.environmentId, props.thread.id, group.key),
          )}
          onToggle={() =>
            toggleExpansion(
              spawnedGroupExpansionKey(props.thread.environmentId, props.thread.id, group.key),
            )
          }
          onOpen={open}
          renamingThreadKey={props.renamingThreadKey}
          onContextMenu={props.onContextMenu}
          onCommitRename={props.onCommitRename}
          onCancelRename={props.onCancelRename}
        />
      ))}
    </div>
  );
}

const childRowClassName =
  "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function SpawnedChildGroupRows(
  props: SpawnedChildActions & {
    readonly environmentId: EnvironmentId;
    readonly group: SpawnedChildGroup<EnvironmentThreadShell>;
    readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
    readonly isOpen: boolean;
    readonly onToggle: () => void;
    readonly onOpen: (child: EnvironmentThreadShell) => void;
  },
) {
  const { group, isOpen } = props;
  const canOperate = useAtomValue(j5Environment.stopCrew.permissionAtom(props.environmentId));
  const stoppable = canOperate ? stoppableCrew(group) : null;
  const [stopping, setStopping] = useState(false);
  return (
    <div data-testid={`spawned-group-${group.key}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle();
          }}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform duration-150", isOpen && "rotate-90")}
          />
          {group.crew !== null ? (
            <span className="truncate text-foreground">{group.crew.crewName}</span>
          ) : null}
          <span className="truncate">{group.summary}</span>
          {group.needsAttention && !isOpen ? (
            <span
              aria-label="An agent needs a human"
              className="ms-auto size-1.5 shrink-0 rounded-full bg-warning"
            />
          ) : null}
        </button>
        {stoppable !== null ? (
          // The person's Stop for this Crew alone: interrupts its running seats, retires nothing.
          <button
            type="button"
            aria-label={`Stop crew ${stoppable.crewName}`}
            disabled={stopping}
            className="shrink-0 rounded border border-border/60 px-1.5 py-px text-3xs leading-4 text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
            onClick={(event) => {
              event.stopPropagation();
              setStopping(true);
              void stopCrew(props.environmentId, stoppable.crewInstanceId)
                .catch((error: unknown) => {
                  toastManager.add({
                    type: "error",
                    title: `Could not stop crew ${stoppable.crewName}`,
                    description: error instanceof Error ? error.message : String(error),
                  });
                })
                .finally(() => setStopping(false));
            }}
          >
            Stop
          </button>
        ) : null}
      </div>
      {isOpen ? (
        <ul className="mt-0.5 flex flex-col gap-0.5 border-s border-border/60 ps-2">
          {group.rows.map(({ child, thread }) => {
            // A seat the client holds no facts for is listed, not opened: there may be no thread.
            if (thread === undefined)
              return (
                <li
                  key={child.threadId}
                  className="flex min-w-0 flex-col gap-0.5 px-1.5 py-1 text-xs"
                >
                  <span className="truncate text-foreground">{child.seat?.seat ?? "Seat"}</span>
                  <span className="text-2xs text-muted-foreground">Unknown</span>
                </li>
              );
            const status = resolveThreadStatusPill({ thread });
            const providerEntry =
              props.providerEntries.get(
                thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
              ) ?? null;
            // A seat thread is titled by its seat, so the badge repeats it only once renamed.
            const showSeat = child.seat !== null && child.seat.seat !== thread.title;
            const threadRef = scopeThreadRef(thread.environmentId, thread.id);
            const isRenaming = props.renamingThreadKey === scopedThreadKey(threadRef);
            const rowBody = (
              <>
                {/* Same anatomy as the parent card: time on the top line, provider on the bottom. */}
                <span className="flex min-w-0 items-center gap-1.5 text-xs">
                  {showSeat && child.seat !== null ? (
                    <Badge variant="outline" size="sm" className="shrink-0">
                      {child.seat.seat}
                    </Badge>
                  ) : null}
                  {isRenaming ? (
                    <SpawnedChildRenameInput
                      title={thread.title}
                      onCommit={(title) => props.onCommitRename(threadRef, title, thread.title)}
                      onCancel={props.onCancelRename}
                    />
                  ) : (
                    <span className="truncate text-foreground">{thread.title}</span>
                  )}
                  <span className="ms-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
                    <RelativeAge timestamp={thread.updatedAt} fallback="" />
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                  {status === null ? (
                    <span>Idle</span>
                  ) : (
                    <>
                      <span aria-hidden className={cn("size-1.5 rounded-full", status.dotClass)} />
                      <span className={status.colorClass}>{status.label}</span>
                    </>
                  )}
                  {providerEntry === null ? null : (
                    <span aria-hidden className="ms-auto inline-flex shrink-0 items-center">
                      <ProviderInstanceIcon
                        driverKind={providerEntry.driverKind}
                        displayName={providerEntry.displayName}
                        accentColor={providerEntry.accentColor}
                        showBadge={false}
                        iconClassName="size-3.5 opacity-60"
                      />
                    </span>
                  )}
                </span>
              </>
            );
            return (
              <li key={child.threadId}>
                {isRenaming ? (
                  // An input cannot live inside a button, so the row is inert while renaming.
                  <div className={childRowClassName}>{rowBody}</div>
                ) : (
                  <button
                    type="button"
                    className={childRowClassName}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onOpen(thread);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
                    }}
                  >
                    {rowBody}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Inline rename for a child row; the draft is local so typing re-renders only this input. */
function SpawnedChildRenameInput(props: {
  readonly title: string;
  readonly onCommit: (title: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.title);
  // Enter and Escape unmount the input; its blur must not commit a second time.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={draft}
      aria-label="Thread title"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit(draft);
      }}
      onClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-xs text-card-foreground outline-none focus:border-foreground"
    />
  );
}
