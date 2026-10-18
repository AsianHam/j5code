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

/**
 * A person renames themselves, or an Owner renames anyone (People and access AC46). The name is
 * what the agents and other people see; the agents of every shared conversation the person can
 * write to are told the old and the new.
 */
export function RenameDialog({
  environmentId,
  person,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: {
    readonly personId: string | null;
    readonly name: string | null;
    readonly you: boolean;
  };
  readonly onClose: () => void;
}) {
  const canRenameAnyone = useAtomValue(sharingManage.renamePerson.permissionAtom(environmentId));
  const canRenameSelf = useAtomValue(sharingManage.renameSelf.permissionAtom(environmentId));
  const renamePerson = useAtomCommand(sharingManage.renamePerson, { reportFailure: false });
  const renameSelf = useAtomCommand(sharingManage.renameSelf, { reportFailure: false });
  const canRename = person.you ? canRenameSelf : canRenameAnyone && person.personId !== null;
  const [name, setName] = useState(person.name ?? "");
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
    const result =
      person.you || person.personId === null
        ? await renameSelf({ environmentId, input: { name: displayName } })
        : await renamePerson({
            environmentId,
            input: { personId: person.personId, name: displayName },
          });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(refusalMessage(result));
      return;
    }
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
            <DialogTitle>
              {person.you ? "Change your name" : `Rename ${person.name ?? "this person"}`}
            </DialogTitle>
            <DialogDescription>
              {person.you
                ? "What people and agents on this server call you. Your earlier messages keep the name you had."
                : "What people and agents on this server call them. Their earlier messages keep the name they had."}
            </DialogDescription>
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
              disabled={busy || !canRename || name.trim() === "" || name.trim() === person.name}
            >
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
