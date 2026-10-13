import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { j5Environment, peersQueryAtom } from "../state";
import { PeerIntroductionDialog } from "./PeerIntroductionDialog";
import { refreshPeers, removePeer, type PeerRecord } from "./peeringClient";
import {
  isPeerCredentialRejected,
  peerPollState,
  peerPollStoppedReason,
} from "@t3tools/contracts/j5";
import { removalConfirmation } from "@t3tools/client-runtime/j5/peering";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useVisibleRefresh } from "../useVisibleRefresh";
import { formatRelativeTimeLabel } from "../../timestampFormat";

/**
 * The servers this environment exchanges agent messages with. A peer is also
 * an authorized session in the list above; this section is where the pairing
 * is made and where it is taken apart. Removal is mutual when this client can
 * manage the other server too, as the introduction was; removing one side only
 * is a choice the person is warned about, never an accident.
 */
export function PeerServersSettings({
  primaryEnvironmentId,
  canManage,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly canManage: boolean;
}) {
  const peers = useEnvironmentQuery(
    primaryEnvironmentId === null ? null : peersQueryAtom(primaryEnvironmentId),
  );
  // A peer's session revoked or expired elsewhere moves no revision, and a server too old to
  // have the change stream moves none at all; reading again on focus covers both.
  const refreshOnFocus = useCallback(() => {
    if (primaryEnvironmentId !== null) refreshPeers(primaryEnvironmentId);
  }, [primaryEnvironmentId]);
  useVisibleRefresh(refreshOnFocus, primaryEnvironmentId !== null);
  const { environments } = useEnvironments();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Each opening mounts a fresh dialog, so a previous introduction's fields and steps never carry over.
  const [dialogGeneration, setDialogGeneration] = useState(0);
  const openDialog = () => {
    setDialogGeneration((generation) => generation + 1);
    setDialogOpen(true);
  };

  // Peering is an administrative act on this server, like pairing links and sessions.
  if (primaryEnvironmentId === null || !canManage) return null;

  return (
    <SettingsSection
      title="Peer servers"
      headerAction={
        <Button size="xs" variant="ghost-muted" aria-label="Add peer" onClick={openDialog}>
          <PlusIcon className="size-3" />
          <span>Add peer</span>
        </Button>
      }
    >
      {(peers.data ?? []).map((peer) => (
        <PeerRow
          key={peer.environmentId}
          peer={peer}
          primaryEnvironmentId={primaryEnvironmentId}
          otherEnvironmentId={
            environments.find(
              (environment) =>
                environment.environmentId === peer.environmentId &&
                environment.connection.phase === "connected",
            )?.environmentId ?? null
          }
        />
      ))}
      {peers.data !== null && peers.data.length === 0 ? (
        <SettingsRow
          title="No peers yet"
          description="Peer this server with another environment you are connected to so their agents can exchange messages. Agents address each other by participant id and see which server each one lives on."
        />
      ) : null}
      {peers.error !== null ? (
        <SettingsRow title="Couldn't read peers" description={peers.error} />
      ) : null}
      <PeerIntroductionDialog
        key={dialogGeneration}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        primaryEnvironmentId={primaryEnvironmentId}
        onPeered={(otherEnvironmentId) => {
          refreshPeers(primaryEnvironmentId);
          refreshPeers(otherEnvironmentId);
        }}
      />
    </SettingsSection>
  );
}

function PeerRow({
  peer,
  primaryEnvironmentId,
  otherEnvironmentId,
}: {
  readonly peer: PeerRecord;
  readonly primaryEnvironmentId: EnvironmentId;
  /** The peer as one of this client's connected environments, when it is one. */
  readonly otherEnvironmentId: EnvironmentId | null;
}) {
  const otherManageable = useAtomValue(j5Environment.removePeer.permissionAtom(otherEnvironmentId));
  const [removing, setRemoving] = useState(false);

  const confirmation = removalConfirmation({
    otherManageable,
    ended: isPeerCredentialRejected(peer),
  });

  const remove = async () => {
    const confirmed = await ((confirmation === "both"
      ? requestConfirmDialog(
          `Remove ${peer.label} as a peer? Both servers drop their record of the other and revoke the credential they issued. Agents on the two servers will no longer be able to message each other; messages still waiting are cancelled and open Exchanges between them are dropped, and each agent involved is told.`,
          { variant: "destructive" },
          { confirmLabel: "Remove peer" },
        )
      : confirmation === "ended"
        ? requestConfirmDialog(
            `Remove ${peer.label} as a peer? ${peer.label} already ended this peering. This server drops its record of ${peer.label}; messages still waiting for it are cancelled and open Exchanges with its agents are dropped, and each agent here that was involved is told.`,
            { variant: "destructive" },
            { confirmLabel: "Remove peer" },
          )
        : requestConfirmDialog(
            `Remove ${peer.label} here only?`,
            { variant: "destructive" },
            {
              confirmLabel: "Remove here only",
              content: (
                <span className="flex flex-col gap-2">
                  <span className="font-medium text-foreground">
                    {peer.label} will keep its side of this peering.
                  </span>
                  <span>
                    This client can't reach {peer.label} to remove it there. Until you remove it on{" "}
                    {peer.label} too, {peer.label} will keep trying to reach this server, and its
                    messages to this server's agents will fail.
                  </span>
                </span>
              ),
            },
          )) ?? Promise.resolve(false));
    if (!confirmed) return;
    setRemoving(true);
    try {
      await removePeer(primaryEnvironmentId, peer.environmentId);
      refreshPeers(primaryEnvironmentId);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not remove the peer",
        description: cause instanceof Error ? cause.message : String(cause),
      });
      setRemoving(false);
      return;
    }
    if (confirmation === "both" && otherEnvironmentId !== null) {
      try {
        await removePeer(otherEnvironmentId, primaryEnvironmentId);
        refreshPeers(otherEnvironmentId);
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: `Removed here, but not on ${peer.label}`,
          description: `${peer.label} still lists this server as a peer. Remove it there. ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    setRemoving(false);
  };

  return (
    <SettingsRow
      title={peer.label}
      description={<PeerStatus peer={peer} />}
      control={
        <Button size="sm" variant="ghost" disabled={removing} onClick={() => void remove()}>
          {removing ? "Removing…" : "Remove"}
        </Button>
      }
    />
  );
}

/** The real time, read when the minute clock ticks. */
const timeAtMinute = (_minute: string) => Date.now();

/** How messages travel, in the dialog's words, and the health that matters for that way. */
function PeerStatus({ peer }: { readonly peer: PeerRecord }) {
  // Re-rendered each minute, so "online" turns to "offline since" with no read: a peer that
  // stopped polling sends nothing to re-read for. The minute is up to 59 s behind, so the online
  // window is measured against the real time, as the CLI measures it; the minute is passed in
  // so the compiler's memoization recomputes the state on each tick.
  const state = peerPollState(peer, timeAtMinute(useNowMinute()));
  const travel =
    peer.linkMode === "store"
      ? "Polls this server for its A2A messages"
      : peer.linkMode === "poll"
        ? `${peer.origin ?? ""} · this server polls it for A2A messages`
        : `${peer.origin ?? ""} · sends directly both ways`;
  // The other server removed this one: nothing else on the row matters now.
  const ended = isPeerCredentialRejected(peer);
  // Once polling stopped, the last poll that worked says nothing about the peer.
  const stoppedReason = peerPollStoppedReason(peer);
  const stopped = ended || stoppedReason !== null;
  const health = ended
    ? `${peer.label} ended this peering`
    : stoppedReason !== null
      ? "Polling stopped"
      : state === null
        ? peer.inboundSession === "active"
          ? "Session active"
          : "No live session here: its deliveries are refused"
        : state.kind === "never"
          ? peer.linkMode === "store"
            ? "Has not polled yet"
            : "Not polled yet"
          : state.kind === "online"
            ? `Online · last polled ${formatRelativeTimeLabel(state.lastPolledAt)}`
            : `Offline since ${formatRelativeTimeLabel(state.since)}`;
  return (
    <span className="flex flex-col gap-0.5">
      <span>{travel}</span>
      <span className={stopped ? "text-destructive" : undefined}>
        {health}
        {peer.waitingCount > 0 && peer.oldestWaitingAt !== null
          ? ` · ${String(peer.waitingCount)} waiting · oldest ${formatRelativeTimeLabel(peer.oldestWaitingAt)}`
          : peer.linkMode === "store"
            ? " · 0 waiting"
            : ""}
      </span>
      {ended ? (
        <span>Remove it here. To peer again, use Add peer.</span>
      ) : peer.lastError !== null ? (
        <span className="text-destructive">{stoppedReason ?? peer.lastError}</span>
      ) : null}
    </span>
  );
}
