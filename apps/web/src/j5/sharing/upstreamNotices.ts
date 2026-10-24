import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { j5Sharing } from "../state";
import { permissionNoticeApplies } from "./upstreamNotices.logic";

const noticeEnvironmentIdsAtom = Atom.make((get) => {
  const ids = new Set<EnvironmentId>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    if (
      permissionNoticeApplies(get(j5Sharing.connectionAccessQuery({ environmentId, input: {} })))
    ) {
      ids.add(environmentId);
    }
  }
  return ids as ReadonlySet<EnvironmentId>;
}).pipe(Atom.withLabel("j5:access:permission-notice-environments"));

/**
 * The servers upstream's "Permissions have changed" notice is for: those whose connection is no
 * person's, such as a server from before people.
 */
export function useEnvironmentsForPermissionNotice<
  Environment extends { readonly environmentId: EnvironmentId },
>(environments: ReadonlyArray<Environment>): ReadonlyArray<Environment> {
  const noticed = useAtomValue(noticeEnvironmentIdsAtom);
  return useMemo(
    () => environments.filter((environment) => noticed.has(environment.environmentId)),
    [environments, noticed],
  );
}
