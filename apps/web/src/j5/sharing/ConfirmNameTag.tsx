import type { EnvironmentId } from "@t3tools/contracts";
import { isPersonName, type SharingPerson } from "@t3tools/contracts/j5";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { useAtomCommand } from "../../state/use-atom-command";
import { NAME_NOT_USABLE } from "./shareLink.logic";
import { refreshSharing, refusalMessage, sharingManage } from "./sharingManage";

/**
 * The "name they gave" tag on a person who typed their own name when joining by link (Shared
 * server AC27), and the popover it opens, where a member confirms the name or corrects it. The
 * parent may open the popover too, for the "Confirm name…" item in the person's menu.
 */
export function ConfirmNameTag({
  environmentId,
  person,
  canManage,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: SharingPerson;
  readonly canManage: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const given = person.displayName ?? "";
  const confirm = useAtomCommand(sharingManage.renamePerson, { reportFailure: false });
  const [name, setName] = useState(given);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!isPersonName(name.trim())) {
      setError(NAME_NOT_USABLE);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await confirm({
      environmentId,
      input: { personId: person.personId, displayName: name.trim() },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(refusalMessage(result));
      return;
    }
    refreshSharing(environmentId);
    onOpenChange(false);
  };

  const tag = (
    <Badge variant="warning" size="sm">
      name they gave
    </Badge>
  );
  if (!canManage) return tag;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(given);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <PopoverTrigger
        render={<Badge variant="warning" size="sm" render={<button type="button" />} />}
        aria-label={`Confirm the name ${given}`}
      >
        name they gave
      </PopoverTrigger>
      <PopoverPopup width="md" align="start">
        <div className="flex flex-col gap-3">
          <PopoverTitle>Confirm this name</PopoverTitle>
          <p className="text-xs text-muted-foreground">
            {given} typed it when they joined. Once you confirm it, it goes on their messages to the
            agent and the tag is cleared.
          </p>
          <Input
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            maxLength={80}
          />
          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="xs" disabled={busy || name.trim() === ""} onClick={() => void save()}>
              {busy ? "Confirming…" : "Confirm"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
