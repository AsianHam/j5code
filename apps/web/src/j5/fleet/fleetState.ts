import {
  createFleetFactsAtom,
  summarizeFleetProblems,
  mergeFleetDeliveryFacts,
  type FleetFactRow,
} from "@t3tools/client-runtime/j5/fleetFacts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";

import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { fleetSourcesAtom } from "../state";
import { fleetAgentKey, fleetSourceIsLive, fleetSeatState } from "./fleetPresentation";

export const fleetEnvironmentLivenessAtom = Atom.make(
  (get) =>
    new Map(
      get(fleetSourcesAtom).sources.map((source) => {
        const shell = get(environmentShell.stateValueAtom(source.environmentId));
        return [
          source.environmentId,
          fleetSourceIsLive(source, shell.status) && Option.isNone(shell.error),
        ] as const;
      }),
    ),
);

const fleetFactRowsAtom = Atom.make((get): ReadonlyArray<FleetFactRow> => {
  const threads = new Map(
    get(environmentThreadShells.threadShellsAtom).map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const environments = get(fleetEnvironmentLivenessAtom);
  const sources = get(fleetSourcesAtom);
  const deliveries = mergeFleetDeliveryFacts(sources, environments);
  return sources.sources.flatMap((source) => {
    const live = environments.get(source.environmentId) === true;
    return (source.data?.projects ?? []).flatMap((project) =>
      project.agents.map((agent) => {
        const thread =
          agent.threadId === null
            ? undefined
            : threads.get(
                scopedThreadKey(
                  scopeThreadRef(source.environmentId, ThreadId.make(agent.threadId)),
                ),
              );
        const key = fleetAgentKey(source.environmentId, agent.participantId);
        const delivery = deliveries.get(key);
        return {
          key,
          shell: thread?.source,
          pendingSubagentRequest: thread?.pendingSubagentRequest,
          ledger: delivery?.ledger,
          problemsIncomplete: delivery?.problemsIncomplete ?? true,
          live,
        };
      }),
    );
  });
});

export const fleetFactsAtom = createFleetFactsAtom(fleetFactRowsAtom);
export const fleetAgentFactsAtom = Atom.family((key: string) =>
  Atom.make((get) => get(fleetFactsAtom).get(key)),
);
export const fleetLiveRowsAtom = Atom.make(
  (get) => new Map(get(fleetFactRowsAtom).map((row) => [row.key, row.live])),
);
export const fleetLiveAgentAtom = Atom.family((key: string) =>
  Atom.make((get) => get(fleetLiveRowsAtom).get(key) === true),
);

export const fleetProblemSummaryAtom = Atom.make((get) => {
  const sources = get(fleetSourcesAtom);
  const environments = get(fleetEnvironmentLivenessAtom);
  const readable = sources.sources.filter(
    (source) => environments.get(source.environmentId) === true,
  );
  const summary = summarizeFleetProblems(
    get(fleetFactsAtom),
    get(fleetLiveRowsAtom),
    readable.length === 0
      ? "unavailable"
      : sources.isReady &&
          readable.length === sources.sources.length &&
          readable.every((source) => source.data?.asOf !== undefined)
        ? "complete"
        : "partial",
  );
  const previous = Option.getOrUndefined(get.self<typeof summary>());
  return previous !== undefined &&
    previous.agentsWithProblems === summary.agentsWithProblems &&
    previous.unmeasuredAgents === summary.unmeasuredAgents &&
    previous.incompleteSources === summary.incompleteSources &&
    previous.hasReadableSource === summary.hasReadableSource
    ? previous
    : summary;
});

/** Only classification changes rebuild the placement sections; activity and elapsed time do not. */
export const fleetSeatStatesAtom = Atom.make((get) => {
  const live = get(fleetLiveRowsAtom);
  const states = new Map(
    [...get(fleetFactsAtom)].map(([key, facts]) => [
      key,
      fleetSeatState(facts, live.get(key) === true),
    ]),
  );
  const previous = Option.getOrUndefined(get.self<typeof states>());
  return previous !== undefined &&
    previous.size === states.size &&
    [...states].every(([key, state]) => previous.get(key) === state)
    ? previous
    : states;
});

export const fleetReadTimeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(fleetSourcesAtom).sources.find((source) => source.environmentId === environmentId)?.data
        ?.asOf,
  ),
);
