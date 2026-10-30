import { useAtomValue } from "@effect/atom-react";
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import { useState } from "react";

import { ComposerPendingApprovalActions } from "../../components/chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../../components/chat/ComposerPendingApprovalPanel";
import { Badge } from "../../components/ui/badge";
import { notifyHumanInboxChanged } from "../a2a/humanInboxRefresh";
import { j5Environment } from "../state";
import { toPendingApproval, type ScopedCrewRuntimeRequest } from "./crewRuntimeRequests.logic";
import { refreshCrewRuntimeRequests, respondCrewRuntimeRequest } from "./crewRuntimeRequestsClient";

const itemKey = (request: ScopedCrewRuntimeRequest) =>
  `${request.environmentId}:${request.threadId}:${request.requestId}`;

/**
 * Provider approvals from Crew seats, answered here with the composer's own approval UI instead of
 * in the seat's thread (Crews AC9); the Captain's requests stay in its thread. An answer that lost
 * a race with another device is refused by the server and the message says so; either way the
 * item re-reads and leaves once it has resolved.
 */
export function CrewRuntimeRequestsSection(props: {
  readonly requests: ReadonlyArray<ScopedCrewRuntimeRequest>;
  readonly onOpenThread: (request: ScopedCrewRuntimeRequest) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (props.requests.length === 0) return null;

  const submit = async (request: ScopedCrewRuntimeRequest, decision: ProviderApprovalDecision) => {
    setBusyKey(itemKey(request));
    setError(null);
    try {
      await respondCrewRuntimeRequest(request.environmentId, {
        threadId: request.threadId,
        requestId: request.requestId,
        decision,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer the request.");
    }
    notifyHumanInboxChanged(request.environmentId);
    await refreshCrewRuntimeRequests(request.environmentId).catch(() => undefined);
    setBusyKey(null);
  };

  return (
    <section aria-label="Crew agent requests" className="mt-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Crew agent requests
      </h2>
      {error ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="space-y-4">
        {props.requests.map((request) => (
          <CrewRuntimeRequestRow
            key={itemKey(request)}
            request={request}
            responding={busyKey === itemKey(request)}
            onOpenThread={props.onOpenThread}
            onRespond={submit}
          />
        ))}
      </ul>
    </section>
  );
}

/** One seat's approval. Its environment's session decides whether this client may answer it. */
function CrewRuntimeRequestRow(props: {
  readonly request: ScopedCrewRuntimeRequest;
  readonly responding: boolean;
  readonly onOpenThread: (request: ScopedCrewRuntimeRequest) => void;
  readonly onRespond: (
    request: ScopedCrewRuntimeRequest,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}) {
  const { request } = props;
  const canRespond = useAtomValue(
    j5Environment.respondCrewRuntimeRequest.permissionAtom(request.environmentId),
  );
  return (
    <li className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{request.crewName}</span>
        <Badge variant="outline" size="sm">
          {request.seat}
        </Badge>
        <button
          type="button"
          className="min-w-0 truncate text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => props.onOpenThread(request)}
        >
          {request.threadTitle}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <ComposerPendingApprovalPanel approval={toPendingApproval(request)} pendingCount={1} />
        <div className="flex shrink-0 items-center gap-2">
          <ComposerPendingApprovalActions
            requestId={request.requestId}
            isResponding={props.responding}
            canRespond={canRespond}
            options={request.options}
            onRespondToApproval={(_requestId, decision) => props.onRespond(request, decision)}
          />
        </div>
      </div>
    </li>
  );
}
