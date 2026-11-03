import type { EnvironmentId } from "@t3tools/contracts";

import type { CrewProposalRow } from "./crewProposalDraft";

// The composer unmounts the roster card while an approval or question is up, so saved edits
// live here until the proposal is resolved. It is memory only: a reload discards them.
const drafts = new Map<string, ReadonlyArray<CrewProposalRow>>();

const draftKey = (environmentId: EnvironmentId | null, proposalId: string) =>
  JSON.stringify([environmentId, proposalId]);

export const readCrewProposalDraft = (environmentId: EnvironmentId | null, proposalId: string) =>
  drafts.get(draftKey(environmentId, proposalId));

export const saveCrewProposalDraft = (
  environmentId: EnvironmentId | null,
  proposalId: string,
  rows: ReadonlyArray<CrewProposalRow>,
) => {
  drafts.set(draftKey(environmentId, proposalId), rows);
};

export const clearCrewProposalDraft = (environmentId: EnvironmentId | null, proposalId: string) => {
  drafts.delete(draftKey(environmentId, proposalId));
};
