import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { GUEST_LINKS_OFFERED } from "~/j5/sharing/guestLinks";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";

/**
 * Whether this environment offers "Share with guest": the user may create links there, and its
 * Guest links beta is on (Settings > Labs). The server refuses links while the beta is off.
 */
export const canShareWithGuestAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      // J5 (decision 12): guest links need T3 Connect, which J5 does not ship.
      GUEST_LINKS_OFFERED &&
      get(serverEnvironment.createGuestShare.permissionAtom(environmentId)) &&
      get(environmentPresentations.serverConfigsAtom).get(environmentId)?.settings
        .guestSharingEnabled === true,
  ).pipe(Atom.withLabel(`guest-share:available:${environmentId}`)),
);
