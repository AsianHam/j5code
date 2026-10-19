import { EnvironmentId } from "@t3tools/contracts";

import type { PeerRecord } from "./peeringClient";

/** One server this client manages, and its peer records when they were read. */
export interface ManagedPeerList {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly peers: ReadonlyArray<PeerRecord> | null;
}

/** One server of a peered pair, as this client sees it. */
export interface PeerPairSide {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** This client manages this server, whether or not its peers could be read. */
  readonly managed: boolean;
  /** This server's record of the other one; null when it holds none, or when `read` is false. */
  readonly record: PeerRecord | null;
  /** This client read this server's peers, so a null record means it holds none. */
  readonly read: boolean;
}

export interface PeerPair {
  readonly key: string;
  readonly sides: readonly [PeerPairSide, PeerPairSide];
}

/**
 * Every pairing the managed servers record, one per pair however many sides
 * this client can read. A server outside the managed set appears only as the
 * other side of a pair, under the name its peer records for it.
 */
export function peerPairs(lists: ReadonlyArray<ManagedPeerList>): ReadonlyArray<PeerPair> {
  const listOf = new Map(lists.map((list) => [list.environmentId, list]));
  const pairs = new Map<string, PeerPair>();
  for (const list of lists) {
    for (const record of list.peers ?? []) {
      const otherId = EnvironmentId.make(record.environmentId);
      const key = [list.environmentId, otherId].toSorted().join("|");
      if (pairs.has(key)) continue;
      const side = (environmentId: EnvironmentId, other: EnvironmentId): PeerPairSide => {
        const managed = listOf.get(environmentId);
        return {
          environmentId,
          label: managed?.label ?? record.label,
          managed: managed !== undefined,
          record: managed?.peers?.find((peer) => peer.environmentId === other) ?? null,
          read: (managed?.peers ?? null) !== null,
        };
      };
      const sides = [side(list.environmentId, otherId), side(otherId, list.environmentId)].toSorted(
        (left, right) => left.label.localeCompare(right.label),
      );
      pairs.set(key, { key, sides: [sides[0]!, sides[1]!] });
    }
  }
  return [...pairs.values()].toSorted((left, right) =>
    pairTitle(left).localeCompare(pairTitle(right)),
  );
}

export const pairTitle = (pair: PeerPair) => `${pair.sides[0].label} ↔ ${pair.sides[1].label}`;
