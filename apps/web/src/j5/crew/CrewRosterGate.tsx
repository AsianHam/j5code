import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { notifyHumanInboxChanged } from "../a2a/humanInboxRefresh";
import { crewProposalsQueryAtom } from "../state";
import { CrewProposalCard } from "./CrewProposalCard";
import { rosterGatesForThread } from "./crewProposals.logic";
import {
  refreshCrewProposals,
  resolveCrewProposal,
  useCrewProposalsRefresh,
  type CrewProposal,
  type CrewProposalSeat,
} from "./crewProposalsClient";

/**
 * The Captain's roster proposal, answered where it was asked: above the composer of the thread
 * that launched the crew, like a planning question. Reads the thread's own environment and shares
 * the crew-gate read with the bell, so ordinary threads pay nothing extra.
 */
export function CrewRosterGate(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null | undefined;
}) {
  const { environmentId, threadId } = props;
  const query = useEnvironmentQuery(
    environmentId !== undefined && threadId != null ? crewProposalsQueryAtom(environmentId) : null,
  );
  useCrewProposalsRefresh();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = useCallback(
    async (
      proposal: CrewProposal,
      decision: "approve" | "decline",
      seats: ReadonlyArray<CrewProposalSeat>,
      approvalToken?: string,
    ) => {
      if (environmentId === undefined) return;
      setBusyId(proposal.id);
      setError(null);
      try {
        if (decision === "approve" && approvalToken === undefined)
          throw new Error("Refresh the runtime preview before approving.");
        await resolveCrewProposal(
          environmentId,
          decision === "approve"
            ? { proposalId: proposal.id, decision, seats, approvalToken: approvalToken! }
            : { proposalId: proposal.id, decision },
        );
        notifyHumanInboxChanged(environmentId);
        await refreshCrewProposals(environmentId).catch(() => undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not resolve the crew request.");
      } finally {
        setBusyId(null);
      }
    },
    [environmentId],
  );

  const gates = rosterGatesForThread(query.data ?? [], threadId);
  if (gates.length === 0 || environmentId === undefined) return null;
  return (
    <div
      className="mb-3 max-h-[60dvh] min-h-0 shrink overflow-y-auto overscroll-contain"
      data-testid="crew-roster-gate"
    >
      {error ? (
        <p className="mb-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="space-y-3">
        {gates.map((proposal) => (
          <CrewProposalCard
            key={proposal.id}
            proposal={proposal}
            environmentId={environmentId}
            busy={busyId === proposal.id}
            onResolve={(decision, seats, approvalToken) =>
              void resolve(proposal, decision, seats, approvalToken)
            }
          />
        ))}
      </ul>
    </div>
  );
}
