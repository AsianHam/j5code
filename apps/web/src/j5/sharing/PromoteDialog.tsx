import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { isPersonName, type SharingGrantTarget } from "@t3tools/contracts/j5";
import { useState } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
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
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { nameToShowAgain, promotionSendsName } from "./promote.logic";
import { NAME_NOT_USABLE } from "./shareLink.logic";
import { peopleQuery, refreshSharing, refusalMessage, sharingManage } from "./sharingManage";

/**
 * A member raises someone from View to Collaborate on one thread or project. The name goes on
 * that person's messages to the agent from here on, so it is shown to be checked, and a name the
 * person typed themselves is confirmed by saving (Shared server AC27). No link is made.
 */
export function PromoteDialog({
  environmentId,
  person,
  target,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: {
    readonly personId: string;
    readonly name: string;
    readonly nameSelfGiven: boolean;
  };
  readonly target: SharingGrantTarget;
  readonly onClose: () => void;
}) {
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const rename = useAtomCommand(sharingManage.renamePerson, { reportFailure: false });
  const putGrant = useAtomCommand(sharingManage.putGrant, { reportFailure: false });
  const [name, setName] = useState(person.name);
  // The name as the server holds it now; the list is read again when anyone changes a person.
  const people = useEnvironmentQuery(canManage ? peopleQuery(environmentId) : null);
  const storedName =
    people.data?.people.find((listed) => listed.personId === person.personId)?.displayName ?? null;
  const [seenName, setSeenName] = useState(person.name);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedName = name.trim();
  const shownName = typedName === "" ? "them" : typedName;

  const save = async () => {
    if (!isPersonName(typedName)) {
      setError(NAME_NOT_USABLE);
      return;
    }
    const renamedTo = nameToShowAgain({ seen: seenName, stored: storedName });
    if (renamedTo !== null) {
      // Someone renamed them while this was open: saving now would write the older name back.
      setName(renamedTo);
      setSeenName(renamedTo);
      setError(
        `Their name was changed to ${renamedTo} while this was open. Check it, then save again.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    if (promotionSendsName({ name: seenName, typed: name, nameSelfGiven: person.nameSelfGiven })) {
      const renamed = await rename({
        environmentId,
        input: { personId: person.personId, displayName: typedName },
      });
      if (renamed._tag === "Failure") {
        setBusy(false);
        setError(refusalMessage(renamed));
        return;
      }
    }
    const purpose = note.trim();
    const result = await putGrant({
      environmentId,
      input: {
        personId: person.personId,
        target,
        level: "collaborate",
        ...(purpose === "" ? {} : { note: purpose }),
      },
    });
    setBusy(false);
    // The name may have been saved even when the level was refused.
    refreshSharing(environmentId);
    if (result._tag === "Failure") {
      setError(refusalMessage(result));
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
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
            <DialogTitle>Let {person.name} collaborate?</DialogTitle>
            <DialogDescription>
              {person.name} will be able to send messages to the agent and answer its prompts.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                Name
                {person.nameSelfGiven ? (
                  <Badge variant="warning" size="sm">
                    they gave this name themselves
                  </Badge>
                ) : null}
              </span>
              <Input
                aria-label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
                maxLength={80}
              />
              {person.nameSelfGiven ? (
                <span className="mt-1.5 block text-xs text-muted-foreground">
                  From now on this name goes on their messages to the agent. Change it if it is
                  wrong.
                </span>
              ) : null}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                What they are here for{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. reviewing the migration plan with me"
                disabled={busy}
                maxLength={280}
              />
              <span className="mt-1.5 block text-xs text-muted-foreground">
                The agent is told this. It can shape how the agent responds to your guest.
              </span>
            </label>
            <Alert variant="warning">
              <AlertDescription>
                <p>
                  <strong className="font-semibold">
                    You are inviting {shownName} to talk to and control an AI agent on your device.
                  </strong>{" "}
                  Make sure you trust them. Anything the agent can do,{" "}
                  {typedName === "" ? "they" : typedName} can ask it to do.
                </p>
              </AlertDescription>
            </Alert>
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !canManage || typedName === ""}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
