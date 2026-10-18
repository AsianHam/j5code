import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type AuthSessionState,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { j5Sharing } from "../state";

const NO_SESSION = Atom.make(AsyncResult.initial<AuthSessionState>());

// A connection J5 places as a person, or as a device it will ask about, has its permissions set
// from that person's level and renewed when it changes, so upstream's "pair again" never applies
// to it. One not answered yet is held back, so the notice does not show before the answer.
const placedOrUnansweredAtom = Atom.make((get) => {
  const ids = new Set<EnvironmentId>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const result = get(j5Sharing.connectionAccessQuery({ environmentId, input: {} }));
    const access = Option.getOrNull(AsyncResult.value(result));
    if (result._tag === "Initial" || access?.kind === "person" || access?.kind === "unknown") {
      ids.add(environmentId);
    }
  }
  return ids as ReadonlySet<EnvironmentId>;
}).pipe(Atom.withLabel("j5:access:placed-or-unanswered"));

/**
 * The servers upstream's "Permissions have changed" notice is for: those whose connection is no
 * person's, such as a server from before people.
 */
export function useEnvironmentsForPermissionNotice<
  Environment extends { readonly environmentId: EnvironmentId },
>(environments: ReadonlyArray<Environment>): ReadonlyArray<Environment> {
  const placed = useAtomValue(placedOrUnansweredAtom);
  return useMemo(
    () => environments.filter((environment) => !placed.has(environment.environmentId)),
    [environments, placed],
  );
}

/**
 * Whether upstream's provider update notice is mounted: where upstream mounts it, until the
 * session is known not to hold Manage providers. Anyone without it is told nothing they can act
 * on. It mounts as early as upstream's does, before the session is read: mounted only once the
 * updates are known, a remount (React's development replay among them) would close the notice
 * and count it as already shown.
 */
export function useProviderUpdateNoticeShown(primaryEnvironmentAuthenticated: boolean): boolean {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const session = useAtomValue(
    primaryEnvironmentId === null
      ? NO_SESSION
      : environmentSession.sessionStateAtom(primaryEnvironmentId),
  );
  const value = Option.getOrNull(AsyncResult.value(session));
  const knownWithout =
    session._tag === "Success" &&
    value !== null &&
    !sessionGrantsScope(value, AuthProvidersManageScope);
  return primaryEnvironmentAuthenticated && !knownWithout;
}
