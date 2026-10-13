import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SharingOpenLink, SharingPerson } from "@t3tools/contracts/j5";
import { useEffect, useState } from "react";

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
import { requestConfirmDialog } from "../../confirmDialog";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { LinkLifetimeRow } from "./LinkLifetimeRow";
import {
  activeOpenLinkFor,
  DEFAULT_LINK_LIFETIME,
  initialsOf,
  joinLinkMeta,
  type LinkLifetime,
} from "./shareLink.logic";
import { ShareLinkPanel } from "./ShareLinkPanel";
import {
  linkSecretMadeHere,
  openLinksQuery,
  peopleQuery,
  refreshSharing,
  refusalMessage,
  rememberLinkSecret,
  sharingManage,
} from "./sharingManage";

/**
 * A thread's join link: one view-only link several people can open (Shared server AC26 to AC28).
 * With no link yet it makes one; with one in force it shows the link, who joined through it, and
 * the way to revoke it.
 */
export function JoinLinkDialog({
  environmentId,
  threadId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const canManage = useAtomValue(sharingManage.createOpenLink.permissionAtom(environmentId));
  const links = useEnvironmentQuery(canManage ? openLinksQuery(environmentId) : null);
  const people = useEnvironmentQuery(canManage ? peopleQuery(environmentId) : null);
  // People join through the link without this client doing anything, so each opening reads again.
  useEffect(() => refreshSharing(environmentId), [environmentId]);
  const createOpenLink = useAtomCommand(sharingManage.createOpenLink, { reportFailure: false });
  const revokeOpenLink = useAtomCommand(sharingManage.revokeOpenLink, { reportFailure: false });

  const [lifetime, setLifetime] = useState<LinkLifetime>(DEFAULT_LINK_LIFETIME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const active = links.data === null ? null : activeOpenLinkFor(links.data.links, threadId, nowMs);
  const title = thread?.title ?? "this thread";

  const make = async () => {
    setBusy(true);
    setError(null);
    const created = await createOpenLink({ environmentId, input: { threadId, lifetime } });
    if (created._tag === "Failure") {
      setError(`The link could not be made. ${refusalMessage(created)}`);
    } else {
      rememberLinkSecret(created.value.linkId, created.value.token);
      setNowMs(Date.now());
    }
    refreshSharing(environmentId);
    setBusy(false);
  };

  const revoke = async (link: SharingOpenLink) => {
    const confirmed = await requestConfirmDialog(
      `Revoke the join link for ${title}? Nobody new can join with it. People who already joined keep their access until you remove them.`,
      { variant: "destructive" },
      { confirmLabel: "Revoke link" },
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    const revoked = await revokeOpenLink({ environmentId, input: { linkId: link.linkId } });
    if (revoked._tag === "Failure") {
      setError(`The link could not be revoked. ${refusalMessage(revoked)}`);
    }
    refreshSharing(environmentId);
    setBusy(false);
    if (revoked._tag === "Success") onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Join link</DialogTitle>
          <DialogDescription>
            {active === null
              ? "One link several people can open. Each person types a name and gets View on the thread."
              : `${title} · View`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              This connection cannot manage access on this server.
            </p>
          ) : links.data === null ? (
            <p className="text-xs text-muted-foreground">
              {links.error ?? "Reading this thread's join link…"}
            </p>
          ) : active === null ? (
            <>
              <div>
                <p className="mb-1.5 text-xs font-medium text-foreground">Thread</p>
                <p className="truncate text-sm text-foreground">{title}</p>
              </div>
              <LinkLifetimeRow
                value={lifetime}
                onChange={setLifetime}
                helper="Nobody new can join after that. People who joined stay."
                disabled={busy}
              />
              <Alert>
                <AlertDescription>
                  Anyone with the link can read the whole thread, including any agents it spawned.
                  Their names are unconfirmed until you confirm them; promoting someone to
                  Collaborate confirms their name.
                </AlertDescription>
              </Alert>
            </>
          ) : (
            <ActiveJoinLink
              environmentId={environmentId}
              link={active}
              people={people.data?.people ?? []}
              nowMs={nowMs}
              busy={busy}
              onMakeAnother={() => void make()}
            />
          )}
          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          {active === null ? (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={busy || !canManage || links.data === null}
                onClick={() => void make()}
              >
                {busy ? "Making link…" : "Make link"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void revoke(active)}
              >
                {busy ? "Revoking…" : "Revoke link"}
              </Button>
              <Button onClick={onClose}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ActiveJoinLink({
  environmentId,
  link,
  people,
  nowMs,
  busy,
  onMakeAnother,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: SharingOpenLink;
  readonly people: ReadonlyArray<SharingPerson>;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly onMakeAnother: () => void;
}) {
  const token = linkSecretMadeHere(link.linkId);
  const joined = link.joined.flatMap(
    (personId) => people.find((person) => person.personId === personId) ?? [],
  );
  const meta = joinLinkMeta({
    expiresAtMs: link.expiresAt.epochMilliseconds,
    nowMs,
    joined: link.joined.length,
  });
  return (
    <>
      {token === null ? (
        <>
          <p className="text-xs text-muted-foreground">{meta}</p>
          <p className="text-xs text-muted-foreground">
            A link's address is shown only on the page that made it, until that page is closed or
            reloaded. To copy one from here, make a new link; the earlier one keeps working until it
            expires or is revoked.
          </p>
          <div>
            <Button size="xs" variant="outline" disabled={busy} onClick={onMakeAnother}>
              Make a new link
            </Button>
          </div>
        </>
      ) : (
        <ShareLinkPanel
          environmentId={environmentId}
          secret={token}
          whoCannotOpen="People"
          meta={meta}
        />
      )}
      {joined.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {joined.map((person) => {
            const name = person.displayName ?? "Unnamed";
            return (
              <li key={person.personId} className="flex min-h-7 items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-semibold text-muted-foreground"
                >
                  {initialsOf(name)}
                </span>
                <span className="min-w-0 truncate">{name}</span>
                {person.nameSelfGiven ? (
                  <Badge variant="warning" size="sm">
                    name they gave
                  </Badge>
                ) : null}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  joined {formatRelativeTimeLabel(person.createdAt)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
