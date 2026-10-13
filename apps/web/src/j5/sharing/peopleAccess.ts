import { AuthAccessReadScope } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useIsGuestEverywhere } from "./guestAccess";
import { settingsNavShown } from "./peopleAccess.logic";

/**
 * Whether Settings lists the People page: the primary server's connection holds upstream's
 * "access:read", which a guest's never does. The page itself checks again, and the server
 * answers the reads.
 */
export function useCanSeePeople(): boolean {
  return useEnvironmentScope(usePrimaryEnvironmentId(), AuthAccessReadScope);
}

/**
 * Whether Settings lists a section; see `settingsNavShown`. Upstream's nav asks this one question.
 */
export function useSettingsNavShown(): (path: string) => boolean {
  const canSeePeople = useCanSeePeople();
  const guestEverywhere = useIsGuestEverywhere();
  return (path) => settingsNavShown({ path, canSeePeople, guestEverywhere });
}
