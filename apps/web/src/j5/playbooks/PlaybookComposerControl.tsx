import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEnvironment } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { PlaybookStages } from "./PlaybookStages";
import { j5Environment } from "../state";
import { useVisibleRefresh } from "../useVisibleRefresh";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";

/**
 * The visible thread owns this bounded read. It reads again when the server says a playbook run
 * or the YAML of an active one changed, when the thread's turn does, and on focus. No timer.
 */
export function PlaybookComposerControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
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
  return (
    <PlaybookStages
      runs={runs}
      stale={Boolean(query.error)}
      viewKey={`${props.environmentId}:${props.threadId}`}
    />
  );
}
