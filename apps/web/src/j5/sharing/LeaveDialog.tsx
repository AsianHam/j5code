import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { PersonScope } from "@t3tools/contracts/j5";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
import { useEnvironment } from "../../state/environments";
import { useProject, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { leaveWording } from "./people.logic";
import { refreshSharing, refusalMessage, sharingManage } from "./sharingManage";

/**
 * A person gives up a level they hold, at a thread, a project or the server (People and access
 * AC48). What it covered goes from their view, and coming back takes an Owner; the confirmation
 * says so.
 */
export function LeaveDialog({
  environmentId,
  scope,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: PersonScope;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const server = useEnvironment(environmentId);
  const thread = useThreadShell(
    scope.kind === "thread" ? scopeThreadRef(environmentId, scope.threadId) : null,
  );
  const project = useProject(
    scope.kind === "project" ? scopeProjectRef(environmentId, scope.projectId) : null,
  );
  const title =
    scope.kind === "thread"
      ? (thread?.title ?? "this thread")
      : scope.kind === "project"
        ? (project?.title ?? "this project")
        : (server?.label ?? "this server");
  const leave = useAtomCommand(sharingManage.leave, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wording = leaveWording(scope, title);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = await leave({ environmentId, input: { scope } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(`You could not leave. ${refusalMessage(result)}`);
      return;
    }
    refreshSharing(environmentId);
    onClose();
    // What was left may be the thread on screen; the first screen shows what is still shared.
    if (scope.kind !== "server") void navigate({ to: "/", replace: true });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{wording.title}</DialogTitle>
          <DialogDescription>{wording.description}</DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <DialogPanel>
            <p className="text-xs text-destructive">{error}</p>
          </DialogPanel>
        )}
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Leaving…" : "Leave"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
