import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

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

/**
 * What the setup wizard's own address shows someone it is not offered to, or `null` for an Owner
 * the server has a name for: nothing until the server answers, and then anyone else is sent to the
 * first screen, where a name the server asks for is asked (AC5, AC6, AC30). The hosted app, which
 * has no server of its own (`serverAuthenticated` false), is upstream's to decide.
 */
export function useSetupWizardRefusal(serverAuthenticated: boolean): ReactNode | null {
  const { settled, access } = useSettledConnectionAccess(usePrimaryEnvironmentId());
  if (!serverAuthenticated) return null;
  if (firstRunSetupOffered({ authenticated: true, settled, access })) return null;
  return settled ? <Navigate to="/" replace /> : <></>;
}
