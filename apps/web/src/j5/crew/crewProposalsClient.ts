import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CrewProposal,
  CrewProposalResolveRequest,
  CrewProposalPreviewRequest,
  ScopedCrewProposal,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  crewProposalSourcesAtom,
  crewProposalsQueryAtom,
  j5Environment,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";

export type { CrewProposal, CrewProposalSeat, ScopedCrewProposal } from "@t3tools/contracts/j5";

/** Every environment's open gates, each tagged with the environment it must be answered on. */
export const mergeCrewProposalSources = (
  sources: J5ReadSources<ReadonlyArray<CrewProposal>>,
): ReadonlyArray<ScopedCrewProposal> =>
  sources.sources.flatMap((source) =>
    (source.data ?? []).map((proposal) => ({ ...proposal, environmentId: source.environmentId })),
  );

/** Resolve runtime settings on the environment that will launch these exact seats. */
export async function previewCrewProposal(
  environmentId: EnvironmentId,
  input: CrewProposalPreviewRequest,
) {
  const result = await j5Environment.previewCrewProposal.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Approve (with the final seats) or decline one proposal on the environment that holds it. */
export async function resolveCrewProposal(
  environmentId: EnvironmentId,
  input: CrewProposalResolveRequest,
) {
  const result = await j5Environment.resolveCrewProposal.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Forced re-read after a decision, so the gate leaves the screen as the answer returns. */
export const refreshCrewProposals = (environmentId?: EnvironmentId) =>
  refreshJ5Sources(crewProposalSourcesAtom, crewProposalsQueryAtom, {
    force: true,
    ...(environmentId === undefined ? {} : { environmentId }),
  });

/** The bell, the inbox page, and every composer's inline gate share this one refresh on focus. */
export const useCrewProposalsRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(crewProposalSourcesAtom, crewProposalsQueryAtom);
});
