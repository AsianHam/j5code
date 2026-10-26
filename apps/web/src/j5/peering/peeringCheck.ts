import type { EnvironmentId } from "@t3tools/contracts";
import type { PeerProbeResponse } from "@t3tools/contracts/j5";
import {
  peeringCandidates,
  peeringReachFrom,
  peeringRunMode,
  type PeeringReach,
  type PeeringServer,
} from "@t3tools/client-runtime/j5/peering";

import type { EnvironmentPresentation } from "../../state/environments";
import { listPeerAddresses, probePeer } from "./peeringClient";

/** A server's facts for the check, from the descriptor this client already holds for it. */
export const peeringServerOf = (environment: EnvironmentPresentation): PeeringServer => {
  const descriptor = environment.serverConfig?.environment;
  return {
    environmentId: environment.environmentId,
    label: descriptor?.label ?? environment.label,
    serverVersion: descriptor?.serverVersion ?? "an unknown version",
    supportsPoll: descriptor?.capabilities.j5PeerPoll === true,
    runMode: peeringRunMode(descriptor?.capabilities.serverSelfUpdate),
  };
};

export interface PeeringCheckSide {
  readonly server: Pick<PeeringServer, "environmentId" | "label">;
  /** The address this client uses for the server: a hint, tried first. */
  readonly clientUrl: string | null;
}

export interface PeeringCheck {
  readonly localToRemote: PeeringReach;
  readonly remoteToLocal: PeeringReach;
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The origins a server offers for itself, or why it could not say; a failure is reported, never guessed at. */
interface OfferedAddresses {
  readonly addresses: ReadonlyArray<string>;
  readonly error: string | null;
}

const offeredAddresses = (environmentId: EnvironmentId): Promise<OfferedAddresses> =>
  listPeerAddresses(environmentId).then(
    (addresses) => ({ addresses, error: null }),
    (cause: unknown) => ({ addresses: [], error: errorText(cause) }),
  );

/** One direction: `from` fetches `to`'s public identity at each address `to` might be reached at. */
const reach = async (
  from: EnvironmentId,
  to: PeeringCheckSide,
  offered: OfferedAddresses,
  current?: string,
): Promise<PeeringReach> => {
  const offeredCandidates = peeringCandidates({
    addresses: offered.addresses,
    clientUrl: to.clientUrl,
  });
  const candidates =
    current === undefined ? offeredCandidates : [...new Set([current, ...offeredCandidates])];
  const probes = await Promise.all(
    candidates.map((origin) =>
      probePeer(from, origin).catch((cause: unknown): PeerProbeResponse => ({
        outcome: "failed",
        origin,
        error: errorText(cause),
      })),
    ),
  );
  return peeringReachFrom({
    expected: to.server,
    candidates,
    probes,
    addressesError: offered.error,
  });
};

/**
 * One direction, for a peer `from` already records: the address it uses now is tried first, so
 * one that still works is kept, then the addresses the introduction would try.
 */
export async function runReachCheck(
  from: EnvironmentId,
  to: PeeringCheckSide,
  current: string,
): Promise<PeeringReach> {
  return reach(from, to, await offeredAddresses(to.server.environmentId), current);
}

/** Both directions in parallel. Nothing is recorded; the check only informs the setup. */
export async function runPeeringCheck(
  local: PeeringCheckSide,
  remote: PeeringCheckSide,
): Promise<PeeringCheck> {
  const [localAddresses, remoteAddresses] = await Promise.all([
    offeredAddresses(local.server.environmentId),
    offeredAddresses(remote.server.environmentId),
  ]);
  const [localToRemote, remoteToLocal] = await Promise.all([
    reach(local.server.environmentId, remote, remoteAddresses),
    reach(remote.server.environmentId, local, localAddresses),
  ]);
  return { localToRemote, remoteToLocal };
}

/**
 * What the dialog says when the check found no way to connect. Only a
 * direction that was tried and failed counts as unreachable; one the check
 * could not test is said to be untested.
 */
export const noRouteMessage = (check: PeeringCheck) =>
  check.localToRemote.kind === "failed" && check.remoteToLocal.kind === "failed"
    ? "Neither server could reach the other at the addresses it tried. Set up differently to enter an address the check could not find."
    : "The check couldn't test every direction, so it can't recommend a setup. Set up differently to enter the address each server reaches the other at.";
