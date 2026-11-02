import { writesNowhere } from "@t3tools/client-runtime/j5/inbox";
import {
  createJ5ReadSourcesAtom,
  type J5ReadSources,
} from "@t3tools/client-runtime/j5/readSources";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";

// A person who can answer nothing, a Viewer everywhere or a device not yet placed, has no inbox
// (Inbox AC14): their source reads as unsupported and is not asked.
const writesNowhereAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => writesNowhere(get(j5Sharing.connectionAccess(environmentId)))),
);

const sourcesInput = {
  capability: "j5ProjectLedger" as const,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  guestAtom: writesNowhereAtom,
};

export const openInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "open" } });
export const answeredInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "answered" } });
export const inboxCountQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.openCount({ environmentId, input: {} });

/** Every connected server's open asks for this person; the server's inbox signal rereads them. */
export const openInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "mobile-j5:inbox-open-sources",
  queryAtom: openInboxQueryAtom,
});
export const answeredInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "mobile-j5:inbox-answered-sources",
  queryAtom: answeredInboxQueryAtom,
});
export const inboxCountSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "mobile-j5:inbox-count-sources",
  queryAtom: inboxCountQueryAtom,
});

/**
 * Reads each connected server's source again, as the Inbox screen does when it comes into view.
 * A read already in flight is left to finish.
 */
export function refreshInboxSources<A>(
  sourcesAtom: Atom.Atom<J5ReadSources<A>>,
  queryAtom: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  for (const source of appAtomRegistry.get(sourcesAtom).sources) {
    if (!source.connected || source.status === "unsupported" || source.refreshing) continue;
    appAtomRegistry.refresh(queryAtom(source.environmentId));
  }
}

const readConnectedSources = <A>(
  sourcesAtom: Atom.Atom<J5ReadSources<A>>,
  queryAtom: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) =>
  appAtomRegistry.get(sourcesAtom).sources.flatMap((source) =>
    !source.connected || source.status === "unsupported"
      ? []
      : [
          executeAtomQuery(appAtomRegistry, queryAtom(source.environmentId), {
            refresh: true,
            reportFailure: false,
            reportDefect: false,
          }),
        ],
  );

/** Reads every connected server's open and answered asks, and settles when all have answered. */
export const readInboxSources = () =>
  Promise.all([
    ...readConnectedSources(openInboxSourcesAtom, openInboxQueryAtom),
    ...readConnectedSources(answeredInboxSourcesAtom, answeredInboxQueryAtom),
  ]);
