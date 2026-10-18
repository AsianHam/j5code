import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSettledConnectionAccess } from "./access";
import { firstRunSetupOffered } from "./firstRunSetup.logic";

/** Whether the root route's first-run gate is on; see `firstRunSetupOffered`. */
export function useFirstRunSetupOffered(authenticated: boolean): boolean {
  return firstRunSetupOffered({
    authenticated,
    ...useSettledConnectionAccess(usePrimaryEnvironmentId()),
  });
}
