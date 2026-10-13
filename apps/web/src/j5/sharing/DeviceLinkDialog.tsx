import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SharingLink } from "@t3tools/contracts/j5";
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
import { useAtomCommand } from "../../state/use-atom-command";
import { LinkLifetimeRow } from "./LinkLifetimeRow";
import { DEFAULT_LINK_LIFETIME, namedLinkMeta, type LinkLifetime } from "./shareLink.logic";
import { ShareLinkPanel } from "./ShareLinkPanel";
import { refreshSharing, refusalMessage, rememberLinkSecret, sharingManage } from "./sharingManage";

/**
 * A link for a further device of someone already on the server (Shared server AC19). It asks how
 * long the link lasts, then shows it; the person's access is what it already was.
 */
export function DeviceLinkDialog({
  environmentId,
  person,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: { readonly personId: string; readonly name: string };
  readonly onClose: () => void;
}) {
  const canManage = useAtomValue(sharingManage.createLink.permissionAtom(environmentId));
  const createLink = useAtomCommand(sharingManage.createLink, { reportFailure: false });
  const [lifetime, setLifetime] = useState<LinkLifetime>(DEFAULT_LINK_LIFETIME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<SharingLink | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const make = async () => {
    setBusy(true);
    setError(null);
    const created = await createLink({
      environmentId,
      input: { personId: person.personId, lifetime },
    });
    if (created._tag === "Failure") {
      setError(`The link could not be made. ${refusalMessage(created)}`);
    } else {
      rememberLinkSecret(created.value.linkId, created.value.credential);
      setNowMs(Date.now());
      setLink(created.value);
    }
    refreshSharing(environmentId);
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {link === null ? `New device link for ${person.name}` : `Link for ${person.name}`}
          </DialogTitle>
          <DialogDescription>
            {link === null
              ? `One more device for ${person.name}, who reaches what they already reach.`
              : `Send this to ${person.name} over a channel you trust. Whoever opens it becomes ${person.name} on this server, on that one device.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {link === null ? (
            <LinkLifetimeRow
              value={lifetime}
              onChange={setLifetime}
              helper="It works once, on one device."
              disabled={busy}
            />
          ) : (
            <ShareLinkPanel
              environmentId={environmentId}
              secret={link.credential}
              whoCannotOpen={person.name}
              meta={namedLinkMeta({
                expiresAtMs: link.expiresAt.epochMilliseconds,
                nowMs,
                level: null,
                targetTitle: null,
              })}
            />
          )}
          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          {link === null ? (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={busy || !canManage} onClick={() => void make()}>
                {busy ? "Making link…" : "Make link"}
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
