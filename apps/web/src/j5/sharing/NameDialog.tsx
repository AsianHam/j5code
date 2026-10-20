import type { EnvironmentId } from "@t3tools/contracts";
import { isPersonName } from "@t3tools/contracts/j5";
import { ArrowRightIcon } from "lucide-react";
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
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PersonAvatar } from "./PersonAvatar";
import { offeredLevel } from "./nameDialog.logic";
import { levelLabel } from "./people.logic";
import { NAME_NOT_USABLE } from "./shareLink.logic";
import { nameIsInUse, refreshSharing, refusalMessage, sharingManage } from "./sharingManage";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

const SOMEONE_NEW = "new";

/**
 * "What should people and agents on <server> call you?", asked before a device uses the server
 * (People and access AC5, AC6). The first owner gives a name. A device the server cannot place
 * picks who it belongs to from everyone on the server, or names someone new. There is no way to
 * put it off: until it is answered the device reaches nothing there.
 */
export function NameDialog({
  environmentId,
  kind,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: "claim" | "first-owner";
}) {
  const serverName = useEnvironment(environmentId)?.label ?? "this server";
  const claimable = useEnvironmentQuery(
    kind === "claim" ? sharingManage.claimablePeople({ environmentId, input: {} }) : null,
  );
  const claimDevice = useAtomCommand(sharingManage.claimDevice, { reportFailure: false });
  const setFirstOwnerName = useAtomCommand(sharingManage.setFirstOwnerName, {
    reportFailure: false,
  });
  const people = claimable.data?.people ?? [];
  const [choice, setChoice] = useState<string>(SOMEONE_NEW);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const naming = kind === "first-owner" || choice === SOMEONE_NEW;

  const save = async () => {
    const typed = name.trim();
    if (naming && !isPersonName(typed)) {
      setError(NAME_NOT_USABLE);
      return;
    }
    setBusy(true);
    setError(null);
    const result =
      kind === "first-owner"
        ? await setFirstOwnerName({ environmentId, input: { name: typed } })
        : await claimDevice({
            environmentId,
            input:
              choice === SOMEONE_NEW
                ? { kind: "new", name: typed }
                : { kind: "person", personId: choice },
          });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        nameIsInUse(squashAtomCommandFailure(result))
          ? `Someone on ${serverName} already has that name.`
          : refusalMessage(result),
      );
      return;
    }
    // A claimed device's session is ended for renewal; the renewal watcher reconnects it. The
    // first owner's own access is read again, which closes this dialog.
    refreshSharing(environmentId);
  };

  return (
    <Dialog open>
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>What should people and agents on {serverName} call you?</DialogTitle>
            {kind === "claim" ? (
              <DialogDescription>
                This device is paired but the server does not know who it belongs to.
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogPanel>
            {kind === "claim" && people.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-input">
                <RadioGroup
                  value={choice}
                  disabled={busy}
                  onValueChange={(value) => {
                    setChoice(value as string);
                    setError(null);
                  }}
                >
                  {people.map((person) => {
                    const level = offeredLevel(person.levels);
                    return (
                      <label
                        key={person.personId}
                        className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-sm"
                      >
                        <Radio value={person.personId} />
                        <PersonAvatar name={person.name} size="xs" />
                        <span className="min-w-0 truncate">{person.name}</span>
                        {level === null ? null : (
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {levelLabel(level)}
                          </span>
                        )}
                      </label>
                    );
                  })}
                  <label className="flex items-center gap-2.5 px-3 py-2">
                    <Radio value={SOMEONE_NEW} />
                    <Input
                      aria-label="Someone new"
                      placeholder="Someone new"
                      value={name}
                      disabled={busy}
                      maxLength={80}
                      onFocus={() => setChoice(SOMEONE_NEW)}
                      onChange={(event) => {
                        setName(event.target.value);
                        setChoice(SOMEONE_NEW);
                        setError(null);
                      }}
                    />
                  </label>
                </RadioGroup>
              </div>
            ) : (
              <Input
                aria-label="Your name"
                placeholder="Your name"
                autoFocus
                value={name}
                disabled={busy}
                maxLength={80}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
              />
            )}
            {claimable.error === null ? null : (
              <p className="text-xs text-muted-foreground">
                The people on this server could not be listed: {claimable.error}
              </p>
            )}
            {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="submit" disabled={busy || (naming && name.trim() === "")}>
              {busy ? "Saving…" : "Continue"}
              {busy ? null : <ArrowRightIcon className="size-3.5" />}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
