import type { EnvironmentId, ProviderApprovalOption } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { toastManager } from "../../components/ui/toast";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Sharing, useIsGuest } from "./guestAccess";
import { approvalOptionsFor, GUEST_TEXT_ONLY, queuedEditFor } from "./guestComposer.logic";

/**
 * What a guest's composer leaves out (Shared conversations AC14 to AC16). A guest who may write
 * to a thread sends text: the server rebuilds their message from it and refuses attachments and
 * context. Their message queues behind running work and never steers it, and they do not stop a
 * run. For a member every answer here is upstream's own.
 */
export function useGuestComposer(environmentId: EnvironmentId | null) {
  const isGuest = useIsGuest(environmentId);
  return useMemo(
    () => ({
      /** No attach control, and no @, $ or / menu, since each adds what the server refuses. */
      textOnly: isGuest,
      /** Says why and returns true when a guest tries to add files, by paste or drop. */
      refusesFiles: () => {
        if (!isGuest) return false;
        toastManager.add({ type: "error", title: GUEST_TEXT_ONLY });
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

/**
 * Wraps upstream's command that changes a queued message so that a guest's carries its text
 * alone; see `queuedEditFor`. Whose connection it is is read when the command runs.
 */
export function useGuestEditsAsText<
  Target extends {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly edit?: unknown };
  },
  Result,
>(command: (target: Target) => Result): (target: Target) => Result {
  return useCallback(
    (target: Target) =>
      command({
        ...target,
        input: queuedEditFor(
          appAtomRegistry.get(j5Sharing.isGuest(target.environmentId)),
          target.input,
        ),
      }),
    [command],
  );
}
