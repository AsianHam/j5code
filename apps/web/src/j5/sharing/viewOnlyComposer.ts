import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { j5Sharing } from "./guestAccess";
import { viewOnlyComposerProps } from "./viewOnlyComposer.logic";

const NOT_A_GUEST = Atom.make(false);

/** What a guest's composer says when their level on the thread is View; see `viewOnlyComposerProps`. */
export function useViewOnlyComposerProps(
  environmentId: EnvironmentId | null,
  canOperateThread: boolean,
): { readonly placeholder?: string } {
  const isGuest = useAtomValue(
    environmentId === null ? NOT_A_GUEST : j5Sharing.isGuest(environmentId),
  );
  return viewOnlyComposerProps({ isGuest, canOperateThread });
}
