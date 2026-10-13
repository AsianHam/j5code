import { presentPlaybook } from "@t3tools/client-runtime/j5/playbooks";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironment } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { j5Environment } from "../state";
import { PlaybookStepStrip } from "./PlaybookStepStrip";
import { useVisibleRefresh } from "../useVisibleRefresh";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";

/**
 * The visible thread owns this bounded read. It reads again when the server says a playbook run
 * or the YAML of an active one changed, when the thread's turn does, and on focus. No timer.
 */
export function PlaybookBoard(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const environment = useEnvironment(props.environmentId);
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  // A guest is shown none of a server's Playbooks (Shared server AC24), so none is read.
  const guest = useGuestEnvironmentIds().has(props.environmentId);
  const unsupported = guest || j5LedgerSupported(environment?.serverConfig) === false;
  const query = useEnvironmentQuery(
    unsupported
      ? null
      : j5Environment.playbooks({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        }),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const changes = useEnvironmentQuery(
    query.data
      ? j5Environment.playbookChanges({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const runs = query.data?.runs ?? [];
  useVisibleRefresh(
    query.refresh,
    environment?.connection.phase === "connected" && !unsupported && !query.isPending,
    `${thread?.latestRun?.runId}:${thread?.latestRun?.status}:${changes.data}`,
  );
  const run = runs.find((entry) => entry.runId === selectedRunId) ?? runs[0];
  if (!run) return null;
  const display = presentPlaybook(run);
  return (
    <section
      aria-label="Playbook progress"
      className="shrink-0 border-b border-border bg-card px-4 py-3"
    >
      <details open key={`${props.environmentId}:${props.threadId}:${run.runId}`}>
        <summary className="cursor-pointer text-sm">
          <span className="font-medium">{run.title}</span>
          <span className="ml-3 text-muted-foreground">
            {display.status} · {display.position} · {display.currentTitle}
          </span>
        </summary>
        {runs.length > 1 && (
          <label className="mt-2 block text-xs text-muted-foreground">
            Run{" "}
            <select
              aria-label="Playbook run"
              value={run.runId}
              onChange={(event) => setSelectedRunId(event.target.value)}
              className="ml-2 rounded border border-border bg-background p-1 text-foreground"
            >
              {runs.map((entry, index) => (
                <option key={entry.runId} value={entry.runId}>
                  {index === 0 ? "Latest: " : ""}
                  {entry.title} · {entry.status} · {new Date(entry.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        )}
        {run.description && <p className="mt-2 text-xs text-muted-foreground">{run.description}</p>}
        {query.error && (
          <p role="status" className="mt-2 text-xs text-warning">
            Progress could not refresh. Showing the last received state.
          </p>
        )}
        {run.issue && (
          <p role="status" className="mt-2 text-xs text-warning">
            {run.issue.message}
          </p>
        )}
        <div className="mt-2">
          <PlaybookStepStrip steps={display.steps} />
        </div>
      </details>
    </section>
  );
}
