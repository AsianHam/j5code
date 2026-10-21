import type { EnvironmentId } from "@t3tools/contracts";

import { useConnectionAccess } from "./access";
import { viewOnlyComposerProps } from "./viewOnlyComposer.logic";

/** What the composer says to someone whose level over the thread is Viewer; see `viewOnlyComposerProps`. */
export function useViewOnlyComposerProps(
  environmentId: EnvironmentId | null,
  canOperateThread: boolean,
): { readonly placeholder?: string } {
  const access = useConnectionAccess(environmentId);
  return viewOnlyComposerProps({
    personNotOwner: access?.kind === "person" && !access.owner,
    canOperateThread,
  });
}
