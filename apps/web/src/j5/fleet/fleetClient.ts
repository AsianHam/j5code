import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FleetProject, FleetResponse } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { refreshCrewMembershipRows } from "../crew/CrewMembershipsClient";
import { refreshSpawnedChildrenRows } from "../threads/SpawnedChildrenClient";
import {
  fleetDetailQueryAtom,
  fleetDetailSourcesAtom,
  fleetQueryAtom,
  fleetSourcesAtom,
  j5Environment,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";
import { createFleetRowRefresher, fleetInvolvedThreadRefs } from "./fleet.logic";

export type { FleetAgent, FleetCrew, FleetResponse } from "@t3tools/contracts/j5";
/** One project's agents and Crews, as one machine's ledger answers for it. */
export type FleetLedgerProject = FleetProject;

export type ScopedFleetLedgerProject = FleetLedgerProject & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
};

/** Every connected environment's projects, each tagged with the environment its threads live on. */
export const mergeFleetSources = (
  sources: J5ReadSources<FleetResponse>,
): ReadonlyArray<ScopedFleetLedgerProject> =>
  sources.sources.flatMap((source) =>
    (source.data?.projects ?? []).map((project) => ({
      ...project,
      environmentId: source.environmentId,
      environmentLabel: source.environmentLabel,
    })),
  );

/** The page's read, retired Crews and rosters included. */
export const refreshFleet = () =>
  refreshJ5Sources(fleetDetailSourcesAtom, fleetDetailQueryAtom, { force: true });

const refreshFleetRows = createFleetRowRefresher({
  memberships: refreshCrewMembershipRows,
  children: refreshSpawnedChildrenRows,
});

/**
 * The live roster re-reads itself when the server says a Crew or the Fleet changed. Each read an
 * environment settles is handed on with the revisions it was made under, so the sidebar's Crew
 * chips and children re-read for the rows that roster names as involved (seats, their Captains,
 * spawners with placed children) and for the rows still showing a chip or children, and no
 * others. The per-thread reads stay bounded by Crew activity rather than by the length of the
 * thread list. A roster read that failed hands nothing on; the next change tries again.
 */
const followFleetRows = () =>
  appAtomRegistry.subscribe(
    fleetSourcesAtom,
    (sources) => {
      for (const source of sources.sources) {
        // A read still in flight is not yet the roster the moved revision describes.
        if (source.status !== "ready" || source.data === null || source.refreshing) continue;
        const revisions = Option.getOrNull(
          AsyncResult.value(
            appAtomRegistry.get(
              j5Environment.readChanges({ environmentId: source.environmentId, input: {} }),
            ),
          ),
        );
        if (revisions !== null)
          refreshFleetRows(source.environmentId, source.data.projects, revisions);
      }
    },
    { immediate: true },
  );

/**
 * What the change stream has no signal for (a renamed project, say) and a server too old to have
 * the stream are covered when the tab is focused or shown again: the roster is read, then the
 * rows it names.
 */
const useFleetFocusRefresh = createVisibleRefreshHook(() => {
  refreshJ5Sources(fleetSourcesAtom, fleetQueryAtom)
    .then(() => {
      const involved = fleetInvolvedThreadRefs(
        mergeFleetSources(appAtomRegistry.get(fleetSourcesAtom)),
      );
      refreshCrewMembershipRows(involved);
      refreshSpawnedChildrenRows(involved);
    })
    // A failed roster read skips these row re-reads; the next focus or change tries again.
    .catch((error: unknown) => {
      console.warn("[j5] fleet refresh failed", error);
    });
});

/** The always-mounted rail badge keeps the live roster (no retired Crews, no rosters) current. */
export function useFleetRefresh() {
  useFleetFocusRefresh();
  useEffect(followFleetRows, []);
}

/** The Fleet page's own refresh on focus while it is open; retired Crews ride only here. */
export const useFleetDetailRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(fleetDetailSourcesAtom, fleetDetailQueryAtom);
});
