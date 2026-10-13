import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { type ReactNode, useSyncExternalStore } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { j5Sharing } from "./guestAccess";
import { DeviceLinkDialog } from "./DeviceLinkDialog";
import { GuestRevokedThreadRedirect } from "./GuestRevokedThreadRedirect";
import { RenameDialog } from "./RenameDialog";
import { LeaveDialog } from "./LeaveDialog";
import { JoinLinkDialog } from "./JoinLinkDialog";
import {
  askForOwnerNameLater,
  useOwnerName,
  useOwnerNameAskedLater,
  useOwnerNameNow,
} from "./ownerName";
import { ownerNameCheck, serverToAskOwnerNameFor } from "./ownerName.logic";
import { OwnerNameDialog } from "./OwnerNameDialog";
import { PromoteDialog } from "./PromoteDialog";
import { ShareDialog } from "./ShareDialog";
import { closeSharingDialog, sharingDialogStore } from "./sharingDialogs";
import { sharingManage } from "./sharingManage";

/**
 * Draws whichever of sharing's dialogs was asked for. Mounted once, at the root, so it also holds
 * the one thing sharing does on every page: taking a guest off a thread that is no longer theirs.
 */
export function SharingDialogHost() {
  return (
    <>
      <GuestRevokedThreadRedirect />
      <SharingDialogs />
    </>
  );
}

function SharingDialogs() {
  const { request, opening } = useSyncExternalStore(
    sharingDialogStore.subscribe,
    sharingDialogStore.read,
    sharingDialogStore.read,
  );
  // With nothing asked for, the one question a server's owner is put at startup may be shown.
  if (request === null) return <OwnerNameAtStartup />;
  switch (request.kind) {
    case "share":
      return (
        <OwnerNameFirst key={opening} environmentId={request.environmentId}>
          <ShareDialog
            environmentId={request.environmentId}
            target={request.target}
            person={request.person}
            onClose={closeSharingDialog}
          />
        </OwnerNameFirst>
      );
    case "join-link":
      return (
        <OwnerNameFirst key={opening} environmentId={request.environmentId}>
          <JoinLinkDialog
            environmentId={request.environmentId}
            threadId={request.threadId}
            onClose={closeSharingDialog}
          />
        </OwnerNameFirst>
      );
    case "device-link":
      return (
        <DeviceLinkDialog
          key={opening}
          environmentId={request.environmentId}
          person={request.person}
          onClose={closeSharingDialog}
        />
      );
    case "promote":
      return (
        <PromoteDialog
          key={opening}
          environmentId={request.environmentId}
          person={request.person}
          target={request.target}
          onClose={closeSharingDialog}
        />
      );
    case "rename":
      return (
        <RenameDialog
          key={opening}
          environmentId={request.environmentId}
          person={request.person}
          onClose={closeSharingDialog}
        />
      );
    case "leave":
      return (
        <LeaveDialog
          key={opening}
          environmentId={request.environmentId}
          threadId={request.threadId}
          onClose={closeSharingDialog}
        />
      );
    case "owner-name":
      return <ChangeOwnerName key={opening} environmentId={request.environmentId} />;
  }
}

/**
 * Sharing starts by asking the server's owner their name while they have none: a guest would
 * otherwise read a thread shared by a nameless member, and the server refuses to bring anyone in
 * until it is set. Once saved, the dialog that was asked for follows.
 */
function OwnerNameFirst({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const canManage = useAtomValue(sharingManage.setOwnerName.permissionAtom(environmentId));
  // Another client may have named the owner since this connection was told there was no name.
  const told = useOwnerName(environmentId);
  const now = useOwnerNameNow(environmentId, canManage && told === null);
  const check = canManage ? ownerNameCheck(now) : "proceed";
  // "proceed" on the list's word alone lasts one render: the name is then this client's own.
  if (check === "wait" || (canManage && now.known === null && check === "proceed")) return null;
  if (check === "proceed") return children;
  return (
    <OwnerNameDialog
      environmentId={environmentId}
      current={null}
      dismissLabel="Cancel"
      onDismiss={closeSharingDialog}
      onSaved={() => undefined}
    />
  );
}

function ChangeOwnerName({ environmentId }: { readonly environmentId: EnvironmentId }) {
  // The name is shown to be changed, so it is the server's now, not what the connection was told.
  const now = useOwnerNameNow(environmentId, true);
  if (now.listed === undefined && !now.listFailed) return null;
  return (
    <OwnerNameDialog
      environmentId={environmentId}
      current={now.listed ?? now.known ?? null}
      dismissLabel="Cancel"
      onDismiss={closeSharingDialog}
      onSaved={closeSharingDialog}
    />
  );
}

// Every connected server with what its connection was told of its owner's name, and whether this
// connection may set one. It reads the one answer each connection already asks for when it
// connects, so it costs no request and holds nothing up.
const ownerNameCandidatesAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].map((id) => ({
    id,
    ownerName: get(j5Sharing.ownerName(id)),
    canManage: get(sharingManage.setOwnerName.permissionAtom(id)),
  })),
);

/** The one-time question, for one server at a time, when its answer says the owner has no name. */
function OwnerNameAtStartup() {
  const candidates = useAtomValue(ownerNameCandidatesAtom);
  const askedLater = useOwnerNameAskedLater();
  const environmentId = serverToAskOwnerNameFor(candidates, askedLater);
  return environmentId === null ? null : <AskOwnerName environmentId={environmentId} />;
}

function AskOwnerName({ environmentId }: { readonly environmentId: EnvironmentId }) {
  // A name set from this client since the connection was told `null` settles the question.
  const ownerName = useOwnerName(environmentId);
  if (ownerName !== null) return null;
  return (
    <OwnerNameDialog
      key={environmentId}
      environmentId={environmentId}
      current={null}
      dismissLabel="Not now"
      onDismiss={() => askForOwnerNameLater(environmentId)}
      onSaved={() => undefined}
    />
  );
}
