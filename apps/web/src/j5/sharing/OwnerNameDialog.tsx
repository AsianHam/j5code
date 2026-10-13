import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { isPersonName } from "@t3tools/contracts/j5";
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
import { Input } from "../../components/ui/input";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { rememberOwnerName } from "./ownerName";
import { NAME_NOT_USABLE } from "./shareLink.logic";
import { refusalMessage, sharingManage } from "./sharingManage";
import { showReturnedPerson } from "./returnedPeople";

/**
 * Asks the person a server belongs to what they are called on it. A guest reading a thread, and
 * an agent told who owns the server it runs on, would otherwise meet a nameless member. It is
 * asked once at startup, again as the first step of sharing while still unanswered, and from the
 * People page to change it; `dismiss` says which, since only the wording of the way out differs.
 */
export function OwnerNameDialog({
  environmentId,
  current,
  dismissLabel,
  onDismiss,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  /** The name they have now, when they are changing it. */
  readonly current: string | null;
  readonly dismissLabel: "Not now" | "Cancel";
  readonly onDismiss: () => void;
  readonly onSaved: () => void;
}) {
  const server = useEnvironment(environmentId);
  const severalServers = useEnvironments().environments.length > 1;
  const canManage = useAtomValue(sharingManage.setOwnerName.permissionAtom(environmentId));
  const setOwnerName = useAtomCommand(sharingManage.setOwnerName, { reportFailure: false });
  const [name, setName] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const displayName = name.trim();
    if (!isPersonName(displayName)) {
      setError(NAME_NOT_USABLE);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await setOwnerName({ environmentId, input: { displayName } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(refusalMessage(result));
      return;
    }
    showReturnedPerson(environmentId, result.value);
    rememberOwnerName(environmentId, displayName);
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onDismiss())}>
      <DialogPopup className="max-w-md">
        {/* `contents`: the popup lays out its header, panel and footer itself. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {severalServers && server !== null
                ? `What should people and agents on ${server.label} call you?`
                : "What should people and agents on this server call you?"}
            </DialogTitle>
            <DialogDescription>
              Your name is shown to anyone you share a thread with, and agents are told who owns the
              server they run on.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Your name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              maxLength={80}
            />
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" disabled={busy} onClick={onDismiss}>
              {dismissLabel}
            </Button>
            <Button type="submit" disabled={busy || !canManage || name.trim() === ""}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
