import { useIsMemberSomewhere } from "./guestAccess";
import { firstRunSetupOffered, usePairedThroughShareLink } from "./pairedThroughShareLink";

/** Whether the root route's first-run gate is on; see `firstRunSetupOffered`. */
export function useFirstRunSetupOffered(authenticated: boolean): boolean {
  return firstRunSetupOffered({
    authenticated,
    pairedThroughShareLink: usePairedThroughShareLink(),
    memberSomewhere: useIsMemberSomewhere(),
  });
}
