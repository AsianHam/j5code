import { useAtomValue } from "@effect/atom-react";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useLogicalProjects } from "../logicalProjects";
import {
  decidedWorktreeCleanupSourcesAtom,
  j5Environment,
  openWorktreeCleanupSourcesAtom,
} from "../state";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";
import { answerCrewWorktreeCleanup, refreshWorktreeCleanups } from "./crewWorktreeCleanupClient";
import {
  answerFailure,
  answeredAgeLabel,
  cleanupButtons,
  cleanupNeedsAttention,
  cleanupTitle,
  commitsAheadLabel,
  groupCleanupOutcomes,
  mergeWorktreeCleanupSources,
  orderCleanupRows,
  outcomeReason,
  outcomeSummary,
  pickedCleanupPaths,
  pullRequestLabel,
  sliceCleanupRows,
  toggleCleanupPath,
  uncommittedFilesLabel,
  worktreeCleanupKey,
  type ScopedWorktreeCleanup,
} from "./crewWorktreeCleanup.logic";

/**
 * The cleanup approvals as the Inbox page shows them. An item answered on this device stays in
 * place with its result, as does one whose second answer was refused, until the page is left;
 * the others that are decided go to the Answered shelf.
 */
export function useWorktreeCleanupInbox() {
  const openSources = useAtomValue(openWorktreeCleanupSourcesAtom);
  const decidedSources = useAtomValue(decidedWorktreeCleanupSourcesAtom);
  const open = mergeWorktreeCleanupSources(openSources);
  const decided = mergeWorktreeCleanupSources(decidedSources);
  // The answer's own item stands in until the decided read arrives; null is a refused answer.
  const [pinned, setPinned] = useState<ReadonlyMap<string, ScopedWorktreeCleanup | null>>(
    new Map(),
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const decidedByKey = new Map(decided.map((item) => [worktreeCleanupKey(item), item]));
  const openKeys = open.map(worktreeCleanupKey);
  const inPlace = [...new Set([...openKeys, ...pinned.keys()])].flatMap((key) => {
    const item = pinned.has(key)
      ? (decidedByKey.get(key) ?? pinned.get(key))
      : open[openKeys.indexOf(key)];
    return item === null || item === undefined ? [] : [item];
  });
  const shelf = decided.filter((item) => !pinned.has(worktreeCleanupKey(item)));

  const answer = async (item: ScopedWorktreeCleanup, removePaths: ReadonlyArray<string>) => {
    const key = worktreeCleanupKey(item);
    setPendingKey(key);
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([errorKey]) => errorKey !== key)),
    );
    try {
      const decidedItem = await answerCrewWorktreeCleanup(item.environmentId, {
        itemId: item.id,
        removePaths,
      });
      setPinned((current) => new Map(current).set(key, { ...item, ...decidedItem }));
      notifyHumanInboxChanged(item.environmentId);
    } catch (cause) {
      const failure = answerFailure(cause);
      setErrors((current) => ({ ...current, [key]: failure.message }));
      if (failure.alreadyAnswered) setPinned((current) => new Map(current).set(key, null));
    }
    try {
      await refreshWorktreeCleanups(item.environmentId);
    } catch {
      setErrors((current) => ({
        ...current,
        [key]: current[key] ?? "The inbox could not be refreshed. The list may be stale.",
      }));
    }
    setPendingKey(null);
  };

  return {
    inPlace,
    shelf,
    openCount: inPlace.filter((item) => item.status === "open").length,
    pendingKey,
    errors,
    answer,
  };
}

const unavailable = "This environment is unavailable, or only an Owner of this server can answer.";

function ItemHeader({
  item,
  showEnvironment,
}: {
  readonly item: ScopedWorktreeCleanup;
  readonly showEnvironment: boolean;
}) {
  const projectOf = useLogicalProjects();
  const needsAttention = cleanupNeedsAttention(item.entries);
  const since = item.status === "open" ? item.filedAt : item.decidedAt;
  const age = since === null ? "" : formatElapsedDurationLabel(since);
  return (
    <summary className="flex cursor-pointer list-none items-start gap-3 px-1 py-4 outline-hidden marker:hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-4 [&::-webkit-details-marker]:hidden">
      {item.status === "open" ? (
        <Badge className="mt-0.5" variant="secondary">
          <span className="uppercase tracking-wide">FYI</span>
        </Badge>
      ) : needsAttention ? (
        <TriangleAlertIcon aria-hidden className="mt-1 size-4 shrink-0 text-warning" />
      ) : (
        <CircleCheckIcon aria-hidden className="mt-1 size-4 shrink-0 text-success" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">J5</span>
          <span aria-hidden>·</span>
          <span className="truncate">
            {projectOf(item.environmentId, item.projectId)?.displayName ?? item.projectId}
          </span>
          {showEnvironment || !item.connected ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">
                {showEnvironment ? item.environmentLabel : ""}
                {item.connected ? "" : showEnvironment ? " (offline)" : "offline"}
              </span>
            </>
          ) : null}
          {age ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {item.status === "open" ? `open ${age}` : answeredAgeLabel(age)}
              </span>
            </>
          ) : null}
        </div>
        <h2 className="mt-1 break-words text-pretty text-base font-semibold leading-snug text-foreground">
          {cleanupTitle(item)}
        </h2>
      </div>
      <ChevronRightIcon
        aria-hidden
        className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/details:rotate-90"
      />
    </summary>
  );
}

function PendingRows({
  item,
  disabled,
  selected,
  onToggle,
}: {
  readonly item: ScopedWorktreeCleanup;
  readonly disabled: boolean;
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (path: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = sliceCleanupRows(orderCleanupRows(item.entries), showAll);
  return (
    <>
      <ul className="divide-y divide-border/60 rounded-lg border border-border bg-card">
        {shown.map((entry) => (
          <li key={entry.path}>
            <label className="flex min-w-0 cursor-pointer items-start gap-3 px-3 py-2.5">
              <Checkbox
                checked={selected.has(entry.path)}
                className="mt-0.5"
                disabled={disabled}
                onCheckedChange={() => onToggle(entry.path)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words text-sm font-medium">
                    {entry.threadTitle}
                  </span>
                  {entry.pullRequestUrl === null ? null : (
                    <a
                      className="inline-flex shrink-0 items-center gap-0.5 text-xs underline underline-offset-4 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      href={entry.pullRequestUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {pullRequestLabel(entry.pullRequestUrl)}
                      <ArrowUpRightIcon aria-hidden className="size-3" />
                    </a>
                  )}
                </span>
                <span className="block break-all font-mono text-xs text-muted-foreground">
                  {entry.branch ?? entry.path}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  <span className={entry.uncommittedFiles === 0 ? undefined : "text-foreground"}>
                    {uncommittedFilesLabel(entry.uncommittedFiles)}
                  </span>
                  {" · "}
                  <span className={entry.commitsAhead ? "text-foreground" : undefined}>
                    {commitsAheadLabel(entry.commitsAhead)}
                  </span>
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <Button
          className="mt-1.5"
          onClick={() => setShowAll(true)}
          size="sm"
          type="button"
          variant="ghost-muted"
        >
          Show {hidden} more
        </Button>
      ) : null}
    </>
  );
}

function OpenBody({
  item,
  pending,
  error,
  onAnswer,
}: {
  readonly item: ScopedWorktreeCleanup;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onAnswer: (item: ScopedWorktreeCleanup, removePaths: ReadonlyArray<string>) => void;
}) {
  const mayAnswer = useAtomValue(
    j5Environment.answerCrewWorktreeCleanup.permissionAtom(item.environmentId),
  );
  const canAnswer = item.sourceReady && mayAnswer;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const buttons = cleanupButtons(selected, item.entries);
  const hold = !canAnswer || pending;
  return (
    <div className="border-t border-border/50 px-1 pb-5 pt-4 sm:ms-24 sm:px-0 sm:pe-1">
      <p className="mb-2.5 text-sm text-foreground/85">
        Removing a worktree keeps its branch and discards its uncommitted changes.
      </p>
      <PendingRows
        disabled={hold}
        item={item}
        onToggle={(path) => setSelected((current) => toggleCleanupPath(current, path))}
        selected={selected}
      />
      {error === undefined ? null : (
        <p aria-live="polite" className="mt-3 text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button
          disabled={hold}
          onClick={() => onAnswer(item, [])}
          size="sm"
          title={canAnswer ? undefined : unavailable}
          type="button"
          variant="outline"
        >
          Keep all
        </Button>
        <div className="flex gap-2">
          <Button
            disabled={hold || buttons.selectAllDisabled}
            onClick={() => setSelected(new Set(item.entries.map((entry) => entry.path)))}
            size="sm"
            type="button"
            variant="outline"
          >
            Select all
          </Button>
          <Button
            disabled={hold || buttons.removeDisabled}
            onClick={() => onAnswer(item, pickedCleanupPaths(selected, item.entries))}
            size="sm"
            type="button"
            variant="destructive"
          >
            {pending ? "Removing…" : buttons.removeLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

const groupIcon = {
  removed: <CircleCheckIcon aria-hidden className="size-3.5 text-success" />,
  kept: <CircleMinusIcon aria-hidden className="size-3.5 text-muted-foreground" />,
  skipped: <TriangleAlertIcon aria-hidden className="size-3.5 text-warning" />,
  failed: <CircleXIcon aria-hidden className="size-3.5 text-destructive-foreground" />,
};

function ResultBody({
  item,
  error,
}: {
  readonly item: ScopedWorktreeCleanup;
  readonly error: string | undefined;
}) {
  return (
    <div className="border-t border-border/50 px-1 pb-5 pt-4 sm:ms-24 sm:px-0 sm:pe-1">
      {error === undefined ? null : (
        <p aria-live="polite" className="mb-3 text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <p className="mb-2.5 text-xs text-muted-foreground">{outcomeSummary(item.entries)}</p>
      {groupCleanupOutcomes(item.entries).map((group) => (
        <div className="mb-2.5" key={group.outcome}>
          <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium">
            {groupIcon[group.outcome]}
            {group.label}
          </div>
          <ul>
            {group.rows.map((entry) => {
              const reason = outcomeReason(entry);
              return (
                <li
                  className="flex min-w-0 items-start justify-between gap-3 border-t border-border/50 py-1.5 ps-5 text-sm"
                  key={entry.path}
                >
                  <span className="min-w-0">
                    {entry.threadTitle}
                    <span className="block break-all font-mono text-xs text-muted-foreground">
                      {entry.branch ?? entry.path}
                    </span>
                  </span>
                  {reason === null ? null : (
                    <span
                      className={
                        entry.outcome === "failed"
                          ? "max-w-[55%] break-words font-mono text-xs text-destructive-foreground"
                          : "max-w-[45%] text-right text-xs text-muted-foreground"
                      }
                    >
                      {reason}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function CrewWorktreeCleanupSection({
  items,
  pendingKey,
  errors,
  onAnswer,
  showEnvironment,
}: {
  readonly items: ReadonlyArray<ScopedWorktreeCleanup>;
  readonly pendingKey: string | null;
  readonly errors: Readonly<Record<string, string>>;
  readonly onAnswer: (item: ScopedWorktreeCleanup, removePaths: ReadonlyArray<string>) => void;
  readonly showEnvironment: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <ol aria-label="Worktree cleanup" className="divide-y divide-border/70">
      {items.map((item) => {
        const key = worktreeCleanupKey(item);
        return (
          <li className="border-b border-border/70 last:border-b-0" key={key}>
            <details className="group/details" open>
              <ItemHeader item={item} showEnvironment={showEnvironment} />
              {item.status === "open" ? (
                <OpenBody
                  error={errors[key]}
                  item={item}
                  onAnswer={onAnswer}
                  pending={pendingKey === key}
                />
              ) : (
                <ResultBody error={errors[key]} item={item} />
              )}
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/** A decided item's row on the Answered shelf. */
export function DecidedCleanupRow({
  item,
  showEnvironment,
}: {
  readonly item: ScopedWorktreeCleanup;
  readonly showEnvironment: boolean;
}) {
  const projectOf = useLogicalProjects();
  const age = item.decidedAt === null ? "" : formatElapsedDurationLabel(item.decidedAt);
  return (
    <li className="flex min-w-0 items-start gap-3 py-3">
      {cleanupNeedsAttention(item.entries) ? (
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      ) : (
        <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      )}
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium text-foreground/80">{cleanupTitle(item)}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          J5 · {projectOf(item.environmentId, item.projectId)?.displayName ?? item.projectId}
          {showEnvironment ? ` · ${item.environmentLabel}` : ""}
          {` · ${answeredAgeLabel(age)}`}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{outcomeSummary(item.entries)}</p>
      </div>
    </li>
  );
}
