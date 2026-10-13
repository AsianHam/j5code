import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { grantsToLeave, leaveChoiceFor, leaveWording } from "./leave.logic";
import { ownGrantsQuery, refusalMessage, sharingManage } from "./sharingManage";

/**
 * A guest leaves what a thread was shared with them through (Shared server AC25). Coming back
 * takes a new grant from a member, and the confirmation says so.
 */
export function LeaveDialog({
  environmentId,
  threadId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const grants = useEnvironmentQuery(ownGrantsQuery(environmentId));
  useEffect(() => appAtomRegistry.refresh(ownGrantsQuery(environmentId)), [environmentId]);
  const leaveGrant = useAtomCommand(sharingManage.leaveGrant, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choice =
    grants.data === null
      ? null
      : leaveChoiceFor(grants.data.grants, { threadId, projectId: thread?.projectId ?? null });
  const wording =
    choice === null
      ? null
      : leaveWording(choice, {
          thread: thread?.title ?? "this thread",
          project: project?.title ?? null,
        });

  const leave = async () => {
    if (choice === null || choice.kind === "through-another-thread") return;
    setBusy(true);
    setError(null);
    for (const target of grantsToLeave(choice)) {
      const left = await leaveGrant({ environmentId, input: { target } });
      if (left._tag === "Failure") {
        setBusy(false);
        setError(`You could not leave. ${refusalMessage(left)}`);
        return;
      }
    }
    setBusy(false);
    onClose();
    // What was left is gone from this client; the landing shows what is still shared.
    void navigate({ to: "/", replace: true });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{wording?.title ?? "Leave this thread?"}</DialogTitle>
          <DialogDescription>
            {wording?.description ?? grants.error ?? "Reading what was shared with you…"}
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <DialogPanel>
            <p className="text-xs text-destructive">{error}</p>
          </DialogPanel>
        )}
        <DialogFooter variant="bare">
          {choice?.kind === "through-another-thread" ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={busy || choice === null} onClick={() => void leave()}>
                {busy
                  ? "Leaving…"
                  : choice?.kind === "thread-and-project"
                    ? "Leave project"
                    : "Leave"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
