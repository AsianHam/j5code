import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  isPeerCredentialRejected,
  peerPollState,
  peerPollStoppedReason,
} from "@t3tools/contracts/j5";
import { removalConfirmation } from "@t3tools/client-runtime/j5/peering";
import { Atom } from "effect/reactivity";
import { EllipsisIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { j5Environment, peersQueryAtom } from "../state";
import { useVisibleRefresh } from "../useVisibleRefresh";
import { editableSides, PeerEditDialog } from "./PeerEditDialog";
import { PeerIntroductionDialog } from "./PeerIntroductionDialog";
import { pairTitle, peerPairs, type PeerPair, type PeerPairSide } from "./peerPairs";
import { refreshPeers, removePeer, type PeerRecord } from "./peeringClient";

/**
 * Each connected server this client can peer from, with its peer list; the key
 * is the connected servers' ids, joined with commas.
 */
const managedPeerListsAtom = Atom.family((ids: string) =>
  Atom.make((get) =>
    ids
      .split(",")
      .filter(
        (id): id is EnvironmentId =>
          id !== "" && get(j5Environment.addPeer.permissionAtom(id as EnvironmentId)),
      )
      .map((environmentId) => ({ environmentId, result: get(peersQueryAtom(environmentId)) })),
  ),
);

const refreshPeerLists = (serversKey: string) => {
  for (const id of serversKey.split(",")) if (id !== "") refreshPeers(id as EnvironmentId);
};

/**
 * Every pairing among the servers this client manages, one row per pair,
 * including pairs between two servers that are neither of them this client's
 * own. A peer is also an authorized session in the list above; this section is
 * where the pairing is made and where it is taken apart. Removal takes down
 * every side this client manages, as the introduction made them; leaving a
 * side it cannot reach is a choice the person is warned about, never an accident.
 */
export function PeerServersSettings({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const connected = environments
    .filter((environment) => environment.connection.phase === "connected")
    .toSorted((left, right) => left.label.localeCompare(right.label));
  // Peering is an administrative act on a server, like pairing links and sessions.
  const managed = useAtomValue(
    managedPeerListsAtom(connected.map((environment) => environment.environmentId).join(",")),
  );
  const servers = managed.map(({ environmentId }) => environmentId);
  // A peer's session revoked or expired elsewhere moves no revision, and a server too old to
  // have the change stream moves none at all; reading again on focus covers both.
  const serversKey = servers.join(",");
  const refreshOnFocus = () => refreshPeerLists(serversKey);
  useVisibleRefresh(refreshOnFocus, servers.length > 0);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Each opening mounts a fresh dialog, so a previous introduction's fields and steps never carry over.
  const [dialogGeneration, setDialogGeneration] = useState(0);
  const openDialog = () => {
    setDialogGeneration((generation) => generation + 1);
    setDialogOpen(true);
  };

  const defaultServerId =
    primaryEnvironmentId !== null && servers.includes(primaryEnvironmentId)
      ? primaryEnvironmentId
      : (servers[0] ?? null);
  if (defaultServerId === null) return null;

  const labelOf = (id: EnvironmentId) =>
    connected.find((environment) => environment.environmentId === id)?.label ?? id;
  const lists = managed.map(({ environmentId, result }) => ({
    environmentId,
    label: labelOf(environmentId),
    peers: result._tag === "Success" ? result.value : null,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
  }));
  const pairs = peerPairs(lists);

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
      {pairs.map((pair) => (
        <PeerPairRow key={pair.key} pair={pair} />
      ))}
      {pairs.length === 0 && lists.some((list) => list.peers !== null) ? (
        <SettingsRow
          title="No peers yet"
          description="Peer two servers you are connected to so their agents can exchange messages. Agents address each other by participant id and see which server each one lives on."
        />
      ) : null}
      {lists.map((list) =>
        list.error === null ? null : (
          <SettingsRow
            key={list.environmentId}
            title={`Couldn't read ${list.label}'s peers`}
            description={list.error}
          />
        ),
      )}
      <PeerIntroductionDialog
        key={dialogGeneration}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        servers={servers}
        defaultServerId={defaultServerId}
        onPeered={(first, second) => {
          refreshPeers(first);
          refreshPeers(second);
        }}
      />
    </SettingsSection>
  );
}

const otherSide = (pair: PeerPair, side: PeerPairSide) =>
  pair.sides[0] === side ? pair.sides[1] : pair.sides[0];

function PeerPairRow({ pair }: { readonly pair: PeerPair }) {
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  // A side this client read and found a record on; the pair exists because there is one.
  const holder = pair.sides.find(
    (side): side is PeerPairSide & { readonly record: PeerRecord } => side.record !== null,
  )!;
  // A managed server whose peers could not be read may still hold its side, so removal tries it too.
  const removable = pair.sides.filter(
    (side) => side.record !== null || (side.managed && !side.read),
  );
  const other = otherSide(pair, holder);
  const confirmation = removalConfirmation({
    otherManageable: removable.includes(other),
    ended: other.read || isPeerCredentialRejected(holder.record),
  });

  const remove = async () => {
    const confirmed = await ((confirmation === "both"
      ? requestConfirmDialog(
          `Remove the peering between ${pair.sides[0].label} and ${pair.sides[1].label}? Both servers drop their record of the other and revoke the credential they issued. Agents on the two servers will no longer be able to message each other; messages still waiting are cancelled and open Exchanges between them are dropped, and each agent involved is told.`,
          { variant: "destructive" },
          { confirmLabel: "Remove peer" },
        )
      : confirmation === "ended"
        ? requestConfirmDialog(
            `Remove ${other.label} from ${holder.label}? ${other.label} no longer holds its side of this peering. ${holder.label} drops its record of ${other.label}; messages still waiting there for ${other.label} are cancelled and open Exchanges with its agents are dropped, and each agent on ${holder.label} that was involved is told.`,
            { variant: "destructive" },
            { confirmLabel: "Remove peer" },
          )
        : requestConfirmDialog(
            `Remove ${other.label} on ${holder.label} only?`,
            { variant: "destructive" },
            {
              confirmLabel: "Remove here only",
              content: (
                <span className="flex flex-col gap-2">
                  <span className="font-medium text-foreground">
                    {other.label} will keep its side of this peering.
                  </span>
                  <span>
                    This client can't manage {other.label} to remove it there. Until you remove it
                    on {other.label} too, {other.label} will keep trying to reach {holder.label},
                    and its messages to {holder.label}'s agents will fail.
                  </span>
                </span>
              ),
            },
          )) ?? Promise.resolve(false));
    if (!confirmed) return;
    setRemoving(true);
    // Each side is tried, so one that fails never keeps the other from being removed.
    for (const side of removable) {
      try {
        await removePeer(side.environmentId, otherSide(pair, side).environmentId);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        toastManager.add({
          type: "error",
          title: `Could not remove the peering on ${side.label}`,
          description: `${side.label} may still list ${otherSide(pair, side).label} as a peer. ${reason}`,
        });
      }
    }
    for (const side of removable) refreshPeers(side.environmentId);
    setRemoving(false);
  };

  return (
    <SettingsRow
      title={pairTitle(pair)}
      description={
        <span className="flex flex-col gap-0.5">
          <span>{travelLine(holder.record, holder.label, other.label)}</span>
          {pair.sides.map((side) =>
            side.record !== null ? (
              <SideStatus
                key={side.environmentId}
                peer={side.record}
                holder={side.label}
                other={otherSide(pair, side).label}
              />
            ) : side.read ? (
              <span key={side.environmentId} className="text-destructive">
                {side.label}: holds no record of {otherSide(pair, side).label}
              </span>
            ) : null,
          )}
        </span>
      }
      control={
        <>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  disabled={removing}
                  aria-label={`More actions for ${pairTitle(pair)}`}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {editableSides(pair).length > 0 ? (
                <>
                  <MenuItem onClick={() => setEditing(true)}>
                    <PencilIcon />
                    Edit
                  </MenuItem>
                  <MenuSeparator />
                </>
              ) : null}
              <MenuItem variant="destructive" onClick={() => void remove()}>
                {removing ? "Removing…" : "Remove…"}
              </MenuItem>
            </MenuPopup>
          </Menu>
          {editing ? <PeerEditDialog pair={pair} onClose={() => setEditing(false)} /> : null}
        </>
      }
    />
  );
}

/** How messages travel between the pair, in the dialog's words. */
const travelLine = (peer: PeerRecord, holder: string, other: string) =>
  peer.linkMode === "store"
    ? `${other} polls ${holder} for A2A messages`
    : peer.linkMode === "poll"
      ? `${holder} polls ${other} for A2A messages`
      : "Sends directly both ways";

/** The real time, read when the minute clock ticks. */
const timeAtMinute = (_minute: string) => Date.now();

/** One server's record of the other, with the health that matters for the way messages travel. */
function SideStatus({
  peer,
  holder,
  other,
}: {
  readonly peer: PeerRecord;
  readonly holder: string;
  readonly other: string;
}) {
  // Re-rendered each minute, so "online" turns to "offline since" with no read: a peer that
  // stopped polling sends nothing to re-read for. The minute is up to 59 s behind, so the online
  // window is measured against the real time, as the CLI measures it; the minute is passed in
  // so the compiler's memoization recomputes the state on each tick.
  const state = peerPollState(peer, timeAtMinute(useNowMinute()));
  const reaches =
    peer.linkMode !== "store" && peer.origin !== null
      ? `reaches ${other} at ${peer.origin} · `
      : "";
  // The other server removed this one: nothing else on the line matters now.
  const ended = isPeerCredentialRejected(peer);
  // Once polling stopped, the last poll that worked says nothing about the peer.
  const stoppedReason = peerPollStoppedReason(peer);
  const stopped = ended || stoppedReason !== null;
  const health = ended
    ? `${other} ended this peering`
    : stoppedReason !== null
      ? "Polling stopped"
      : state === null
        ? peer.inboundSession === "active"
          ? "Session active"
          : `No live session for ${other}: its deliveries are refused`
        : state.kind === "never"
          ? peer.linkMode === "store"
            ? `${other} has not polled yet`
            : "Not polled yet"
          : state.kind === "online"
            ? `Online · last polled ${formatRelativeTimeLabel(state.lastPolledAt)}`
            : `Offline since ${formatRelativeTimeLabel(state.since)}`;
  return (
    <>
      <span className={stopped ? "text-destructive" : undefined}>
        {holder}: {reaches}
        {health}
        {peer.waitingCount > 0 && peer.oldestWaitingAt !== null
          ? ` · ${String(peer.waitingCount)} waiting · oldest ${formatRelativeTimeLabel(peer.oldestWaitingAt)}`
          : peer.linkMode === "store"
            ? " · 0 waiting"
            : ""}
      </span>
      {ended ? (
        <span>Remove the peering. To peer again, use Add peer.</span>
      ) : peer.lastError !== null ? (
        <span className="text-destructive">{stoppedReason ?? peer.lastError}</span>
      ) : null}
    </>
  );
}
