import {
  type PlaybookStagesView,
  playbookRunSelection,
  playbookStagesView,
  presentPlaybookStages,
  rememberPlaybookStagesView,
  selectedPlaybookRun,
} from "@t3tools/client-runtime/j5/playbooks";
import type { PlaybookProgress } from "@t3tools/contracts/j5";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  CheckIcon,
  CircleDotIcon,
  CircleIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { cn } from "../../lib/utils";

/** A compact Tasks-style view of the playbook's live stage progress. */
export function PlaybookStages({
  runs,
  stale,
  viewKey,
}: {
  runs: readonly PlaybookProgress[];
  stale: boolean;
  /** The thread the bar belongs to, so its view survives being hidden for a question. */
  viewKey: string;
}) {
  const [view, setViewState] = useState(() => playbookStagesView(viewKey));
  const setView = (next: PlaybookStagesView) => {
    rememberPlaybookStagesView(viewKey, next);
    setViewState(next);
  };
  const { expanded } = view;
  const contentId = useId();
  const run = selectedPlaybookRun(runs, view.selectedRunId);
  if (!run) return null;
  const display = presentPlaybookStages(run);
  const historical = run.runId !== runs[0]?.runId;
  const warning = stale || Boolean(run.issue);
  const runItems = runs.map((entry, index) => ({
    value: entry.runId,
    label: `${index === 0 ? "Latest: " : ""}${entry.title} · ${entry.status} · ${new Date(entry.createdAt).toLocaleString()}`,
  }));
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" variant={warning ? "warning" : "default"}>
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-expanded={expanded}
          aria-controls={expanded ? contentId : undefined}
          aria-label={`${expanded ? "Collapse" : "Expand"} playbook: ${run.title}. ${display.status}. ${display.position}. ${display.currentTitle}${historical ? ". Earlier run" : ""}${stale ? ". Progress out of date" : ""}`}
          onClick={() => setView({ ...view, expanded: !expanded })}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ComposerBanner.Icon>
            {warning ? <AlertTriangleIcon /> : <BookOpenIcon />}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
              {run.title}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {historical && (
              <span className="hidden text-muted-foreground @min-[400px]:inline">History</span>
            )}
            {stale ? (
              <span className="text-warning">Out of date</span>
            ) : run.status !== "active" || run.issue ? (
              <span
                className={
                  warning
                    ? "text-warning"
                    : run.status === "completed"
                      ? "text-success"
                      : "text-muted-foreground"
                }
              >
                {display.status}
              </span>
            ) : null}
            <ComposerBanner.Count
              aria-label={`${display.completedSteps} of ${run.total} stages complete`}
              className={run.status === "completed" ? "text-success" : undefined}
            >
              <span className="sr-only">Stage </span>
              {display.completedSteps}/{run.total}
            </ComposerBanner.Count>
            {display.steps.length > 1 && display.steps.length <= 10 && (
              <span
                aria-hidden
                className="hidden w-20 shrink-0 items-center gap-0.5 @min-[560px]:flex"
              >
                {display.steps.map((step) => (
                  <span
                    key={step.id}
                    className={cn(
                      "h-[3px] min-w-0 flex-1 rounded-full",
                      step.status === "completed"
                        ? "bg-success"
                        : step.status === "inProgress"
                          ? "bg-primary"
                          : "bg-muted-foreground/25",
                    )}
                  />
                ))}
              </span>
            )}
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {expanded && (
          <ComposerBanner.Scroll
            id={contentId}
            role="region"
            aria-label="Playbook stages"
            className="max-h-[min(16rem,30dvh)]"
          >
            <ComposerBanner.Body>
              {runs.length > 1 && (
                <div className="my-2 pe-2">
                  <Select
                    items={runItems}
                    value={run.runId}
                    onValueChange={(runId) =>
                      runId &&
                      setView({ ...view, selectedRunId: playbookRunSelection(runs, runId) })
                    }
                  >
                    <SelectTrigger size="xs" aria-label="Playbook run">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {runItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              )}
              {stale && (
                <p role="status" className="my-2 text-warning">
                  Progress could not refresh. Showing the last received state.
                </p>
              )}
              {run.issue && (
                <p role="status" className="my-2 text-warning">
                  {run.issue.message}
                </p>
              )}
            </ComposerBanner.Body>
            <ComposerBanner.Children render={<ol />} aria-label="Playbook stage list">
              {display.steps.map((step, index) => (
                <ComposerBanner.Row
                  key={step.id}
                  render={<li />}
                  className="items-start py-1 pe-2"
                  aria-current={step.current ? "step" : undefined}
                >
                  <ComposerBanner.Icon
                    className={cn(
                      "h-4",
                      step.status === "completed"
                        ? "text-success"
                        : step.status === "inProgress"
                          ? "text-primary"
                          : "text-muted-foreground/40",
                    )}
                  >
                    {step.status === "completed" ? (
                      <CheckIcon />
                    ) : step.status === "inProgress" ? (
                      <CircleDotIcon />
                    ) : (
                      <CircleIcon />
                    )}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content
                    className={cn(
                      "block wrap-anywhere",
                      step.status === "completed"
                        ? "text-muted-foreground/55"
                        : step.status === "inProgress"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                    )}
                  >
                    <span className="sr-only">{step.label}: </span>
                    {index + 1}. {step.title}
                  </ComposerBanner.Content>
                </ComposerBanner.Row>
              ))}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        )}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
