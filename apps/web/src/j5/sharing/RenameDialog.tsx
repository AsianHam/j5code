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
import { useAtomCommand } from "../../state/use-atom-command";
import { NAME_NOT_USABLE } from "./shareLink.logic";
import { refreshSharing, refusalMessage, sharingManage } from "./sharingManage";
import { showReturnedPerson } from "./returnedPeople";

/**
 * A member changes what a guest is called. The name is what the agent and other people see, so a
 * name a guest gave themselves stops being marked as such once a member has typed one.
 */
export function RenameDialog({
  environmentId,
  person,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: { readonly personId: string; readonly name: string };
  readonly onClose: () => void;
}) {
  const canManage = useAtomValue(sharingManage.renamePerson.permissionAtom(environmentId));
  const rename = useAtomCommand(sharingManage.renamePerson, { reportFailure: false });
  const [name, setName] = useState(person.name);
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
    const result = await rename({
      environmentId,
      input: { personId: person.personId, displayName },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(refusalMessage(result));
      return;
    }
    showReturnedPerson(environmentId, result.value);
    refreshSharing(environmentId);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-sm">
        {/* `contents`: the popup lays out its header, panel and footer itself. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {person.name}</DialogTitle>
            <DialogDescription>What the agent and other people call them.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              maxLength={80}
            />
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !canManage || name.trim() === "" || name.trim() === person.name}
            >
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
