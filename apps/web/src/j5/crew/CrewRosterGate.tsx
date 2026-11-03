import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { useEnvironmentQuery } from "../../state/query";
import { notifyHumanInboxChanged } from "../a2a/humanInboxRefresh";
import { crewProposalsQueryAtom } from "../state";
import { CrewProposalCard } from "./CrewProposalCard";
import { clearCrewProposalDraft } from "./crewProposalDraftStore";
import { rosterGatesForThread } from "./crewProposals.logic";
import {
  refreshCrewProposals,
  resolveCrewProposal,
  useCrewProposalsRefresh,
  type CrewProposal,
  type CrewProposalSeat,
} from "./crewProposalsClient";

const proposalViews = new Map<string, boolean>();

export function CrewRosterGate(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null | undefined;
}) {
  const { environmentId, threadId } = props;
  const query = useEnvironmentQuery(
    environmentId !== undefined && threadId != null ? crewProposalsQueryAtom(environmentId) : null,
  );
  useCrewProposalsRefresh();
  const viewKey = JSON.stringify([environmentId, threadId]);
  const [expanded, setExpanded] = useState(() => proposalViews.get(viewKey) ?? false);
  const contentId = useId();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (
    proposal: CrewProposal,
    decision: "approve" | "decline",
    seats: ReadonlyArray<CrewProposalSeat>,
    approvalToken?: string,
  ) => {
    if (environmentId === undefined) return;
    if (decision === "approve" && approvalToken === undefined) {
      setBusyId(null);
      setError("Refresh the runtime preview before approving.");
      return;
    }
    setBusyId(proposal.id);
    setError(null);
    try {
      await resolveCrewProposal(
        environmentId,
        decision === "approve"
          ? { proposalId: proposal.id, decision, seats, approvalToken: approvalToken! }
          : { proposalId: proposal.id, decision },
      );
      clearCrewProposalDraft(environmentId, proposal.id);
      notifyHumanInboxChanged(environmentId);
      await refreshCrewProposals(environmentId).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resolve the crew request.");
    }
    setBusyId(null);
  };

  const gates = rosterGatesForThread(query.data ?? [], threadId);
  if (gates.length === 0 || environmentId === undefined) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-testid="crew-roster-gate">
        {error ? (
          <p className="mb-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <ul className="divide-y divide-border">
          {gates.map((proposal) => (
            <CrewProposalCard
              key={proposal.id}
              proposal={proposal}
              environmentId={environmentId}
              busy={busyId === proposal.id}
              disclosure={{
                expanded,
                contentId: `${contentId}-${proposal.id}`,
                onToggle: () => {
                  const next = !expanded;
                  proposalViews.set(viewKey, next);
                  setExpanded(next);
                },
              }}
              onResolve={(decision, seats, approvalToken) =>
                void resolve(proposal, decision, seats, approvalToken)
              }
            />
          ))}
        </ul>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
