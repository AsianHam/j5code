import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pairTitle, peerPairs, type ManagedPeerList } from "./peerPairs";
import type { PeerRecord } from "./peeringClient";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");
const VM = EnvironmentId.make("environment-vm");

const record = (environmentId: string, label: string): PeerRecord =>
  ({ environmentId, label, linkMode: "push" }) as PeerRecord;

describe("peerPairs", () => {
  it("shows a pairing both managed servers record once, with each side's record", () => {
    const lists: ReadonlyArray<ManagedPeerList> = [
      { environmentId: REMOTE, label: "Remote", peers: [record(LOCAL, "Local")] },
      { environmentId: LOCAL, label: "Local", peers: [record(REMOTE, "Remote")] },
    ];

    const pairs = peerPairs(lists);
    expect(pairs.map(pairTitle)).toEqual(["Local ↔ Remote"]);
    expect(pairs[0]!.sides.map((side) => side.record?.environmentId)).toEqual([REMOTE, LOCAL]);
  });

  it("keeps a pair between two servers that are not this client's own, beside its own pairs", () => {
    const lists: ReadonlyArray<ManagedPeerList> = [
      { environmentId: LOCAL, label: "Local", peers: [] },
      { environmentId: REMOTE, label: "Remote", peers: [record(VM, "Work VM")] },
      { environmentId: VM, label: "Work VM", peers: [record(REMOTE, "Remote")] },
    ];

    expect(peerPairs(lists).map(pairTitle)).toEqual(["Remote ↔ Work VM"]);
  });

  it("tells a managed server holding no record apart from one this client cannot read", () => {
    const lists: ReadonlyArray<ManagedPeerList> = [
      { environmentId: LOCAL, label: "Local", peers: [record(REMOTE, "Remote"), record(VM, "VM")] },
      { environmentId: REMOTE, label: "Remote", peers: [] },
      { environmentId: VM, label: "Work VM", peers: null },
    ];

    const [withRemote, withVm] = peerPairs(lists);
    expect(withRemote!.sides[1]).toMatchObject({ label: "Remote", record: null, read: true });
    expect(withVm!.sides[1]).toMatchObject({
      label: "Work VM",
      managed: true,
      record: null,
      read: false,
    });
  });
});
