import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { j5Sharing } from "./access";
import { LeftOnNothingRedirect } from "./LeftOnNothingRedirect";
import { LeaveDialog } from "./LeaveDialog";
import { NameDialog } from "./NameDialog";
import { serverToAskNameFor } from "./nameDialog.logic";
import { RenameDialog } from "./RenameDialog";
import { RetiredLinksNotice } from "./RetiredLinksNotice";
import { SessionRenewalWatcher } from "./SessionRenewalWatcher";
import { ShareDialog } from "./ShareDialog";
import { closeSharingDialog, sharingDialogStore } from "./sharingDialogs";

/**
 * Draws whichever of sharing's dialogs was asked for. Mounted once, at the root, so it also holds
 * what People and access does on every page: the name question a server puts before a device
 * uses it, renewing a session ended for a change of level, the one-time notice about links that
 * stopped working, and taking someone off a thread that is no longer theirs.
 */
export function SharingDialogHost() {
  return (
    <>
      <LeftOnNothingRedirect />
      <SessionRenewalWatcher />
      <RetiredLinksNotice />
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
  // The name question comes before anything else asked of that server.
  const asking = useAtomValue(nameToAskAtom);
  if (asking !== null)
    return <NameDialog key={asking.id} environmentId={asking.id} kind={asking.kind} />;
  if (request === null) return null;
  switch (request.kind) {
    case "share":
      return (
        <ShareDialog
          key={opening}
          environmentId={request.environmentId}
          scope={request.scope}
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
          scope={request.scope}
          onClose={closeSharingDialog}
        />
      );
  }
}

// Every connected server's answer, which each connection asks for when it connects, so this
// costs no request and holds nothing up.
const nameToAskAtom = Atom.make((get) =>
  serverToAskNameFor(
    [...get(environmentCatalog.catalogValueAtom).entries.keys()].map((id) => ({
      id,
      access: get(j5Sharing.connectionAccess(id)),
    })),
  ),
);
