import type { EnvironmentId, ProviderApprovalOption } from "@t3tools/contracts";
import { useMemo } from "react";

import { toastManager } from "../../components/ui/toast";
import { useIsGuest } from "./guestAccess";
import { approvalOptionsFor, GUEST_NO_ATTACHMENTS } from "./guestComposer.logic";

/**
 * What a guest's composer leaves out (Shared conversations AC14 to AC16). A guest who may write
 * to a thread sends what a member does, mentions and other context included, except attachments,
 * which the server refuses from a guest for now. Their message queues behind running work and
 * never steers it, and they do not stop a run. For a member every answer here is upstream's own.
 */
export function useGuestComposer(environmentId: EnvironmentId | null) {
  const isGuest = useIsGuest(environmentId);
  return useMemo(
    () => ({
      /** Says why and returns true when a guest tries to add files, by paste or drop. */
      refusesFiles: () => {
        if (!isGuest) return false;
        toastManager.add({ type: "error", title: GUEST_NO_ATTACHMENTS });
        return true;
      },
      /** A guest's follow-up always queues, whatever this person's own setting is elsewhere. */
      followUpBehavior: <Setting>(setting: Setting): Setting | "queue" =>
        isGuest ? "queue" : setting,
      approvalOptions: (options: ReadonlyArray<ProviderApprovalOption> | undefined) =>
        approvalOptionsFor(isGuest, options),
    }),
    [isGuest],
  );
}

/** Whether this connection may stop a run: upstream's answer for a member, never for a guest. */
export function useMayInterruptThread(
  environmentId: EnvironmentId | null,
  canOperateThread: boolean,
): boolean {
  return useIsGuest(environmentId) ? false : canOperateThread;
}
