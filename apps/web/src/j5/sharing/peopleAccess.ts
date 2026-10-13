import { AuthAccessReadScope } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";

/**
 * Whether Settings lists the People page: the primary server's connection holds upstream's
 * "access:read", which a guest's never does. The page itself checks again, and the server
 * answers the reads.
 */
export function useCanSeePeople(): boolean {
  return useEnvironmentScope(usePrimaryEnvironmentId(), AuthAccessReadScope);
}
