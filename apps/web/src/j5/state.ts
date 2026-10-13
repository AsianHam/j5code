import { createJ5EnvironmentAtoms } from "@t3tools/client-runtime/j5/state";
import {
  createJ5ReadSourcesAtom,
  type J5ReadSources,
} from "@t3tools/client-runtime/j5/readSources";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { j5Sharing } from "./sharing/guestAccess";
import { crewApprovalPollPlan, type CrewApprovalPollPlan } from "./crew/crewRuntimeRequests.logic";

export const j5Environment = createJ5EnvironmentAtoms(connectionAtomRuntime);

const sourcesInput = {
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  guestAtom: j5Sharing.isGuest,
};

export const openInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "open" } });
export const answeredInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "answered" } });
export const inboxCountQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.openCount({ environmentId, input: {} });
export const crewProposalsQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.crewProposals({ environmentId, input: {} });
export const crewRuntimeRequestsQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.crewRuntimeRequests({ environmentId, input: {} });
export const fleetQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.fleet({ environmentId, input: {} });
export const fleetDetailQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.fleet({ environmentId, input: { includeRetired: true } });
export const peersQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.peers({ environmentId, input: {} });

export const openInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:inbox-sources",
  capability: "j5ProjectLedger",
  queryAtom: openInboxQueryAtom,
});
export const answeredInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:answered-inbox-sources",
  capability: "j5ProjectLedger",
  queryAtom: answeredInboxQueryAtom,
});
export const crewProposalSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:crew-proposal-sources",
  capability: "j5ProjectLedger",
  queryAtom: crewProposalsQueryAtom,
});
let lastCrewApprovalPoll: CrewApprovalPollPlan = { key: "", environmentIds: [] };
/** The environments with a thread waiting on an approval; the same object until that changes. */
export const crewApprovalPollAtom = Atom.make((get) => {
  const next = crewApprovalPollPlan(get(environmentThreadShells.threadShellsAtom));
  if (next.key !== lastCrewApprovalPoll.key) lastCrewApprovalPoll = next;
  return lastCrewApprovalPoll;
}).pipe(Atom.withLabel("web-j5:crew-approval-poll"));
const NO_CREW_RUNTIME_REQUESTS = AsyncResult.success<ReadonlyArray<CrewRuntimeRequestItem>>([]);
// An environment with no thread waiting on an approval has no seat approval to list, so it is
// not asked; the read starts when one of its threads raises the flag.
const polledCrewRuntimeRequestsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(crewApprovalPollAtom).environmentIds.includes(environmentId)
      ? get(crewRuntimeRequestsQueryAtom(environmentId))
      : NO_CREW_RUNTIME_REQUESTS,
  ).pipe(Atom.withLabel(`web-j5:polled-crew-runtime-requests:${environmentId}`)),
);
// A server without the route fails its source alone; the Inbox shows the rest.
export const crewRuntimeRequestSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:crew-runtime-request-sources",
  capability: "j5ProjectLedger",
  queryAtom: polledCrewRuntimeRequestsAtom,
});
export const fleetSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:fleet-sources",
  capability: "j5ProjectLedger",
  queryAtom: fleetQueryAtom,
});
export const fleetDetailSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:fleet-detail-sources",
  capability: "j5ProjectLedger",
  queryAtom: fleetDetailQueryAtom,
});
export const inboxCountSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:inbox-count-sources",
  capability: "j5ProjectLedger",
  queryAtom: inboxCountQueryAtom,
});

/** Background refresh never interrupts an in-flight read; explicit mutations can force a newer read. */
export async function refreshJ5Sources<A>(
  sourcesAtom: Atom.Atom<J5ReadSources<A>>,
  queryAtom: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  options: { readonly environmentId?: EnvironmentId; readonly force?: boolean } = {},
) {
  const { sources } = appAtomRegistry.get(sourcesAtom);
  return Promise.all(
    sources.flatMap((source) => {
      if (
        !source.connected ||
        (options.environmentId !== undefined && source.environmentId !== options.environmentId)
      )
        return [];
      if (source.status === "unsupported" || (options.force !== true && source.refreshing))
        return [];
      const atom = queryAtom(source.environmentId);
      appAtomRegistry.refresh(atom);
      return [executeAtomQuery(appAtomRegistry, atom, { reportFailure: false })];
    }),
  );
}
