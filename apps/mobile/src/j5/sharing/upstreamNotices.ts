import { permissionNoticeApplies } from "@t3tools/client-runtime/j5/sharing";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { j5Sharing } from "./guestAccess";

/**
 * The saved servers upstream's "Permissions have changed" notice is for: those whose connection
 * is no person's, such as a server from before people. A person's session renews instead.
 */
export const permissionNoticeEnvironmentIdsAtom = Atom.make((get) => {
  const ids = new Set<EnvironmentId>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    if (
      permissionNoticeApplies(get(j5Sharing.connectionAccessQuery({ environmentId, input: {} })))
    ) {
      ids.add(environmentId);
    }
  }
  return ids as ReadonlySet<EnvironmentId>;
}).pipe(Atom.withLabel("mobile-j5:access:permission-notice-environments"));
