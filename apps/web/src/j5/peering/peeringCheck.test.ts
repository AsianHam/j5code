import { EnvironmentId } from "@t3tools/contracts";
import type { PeerProbeResponse } from "@t3tools/contracts/j5";
import { describe, expect, it, vi } from "vite-plus/test";

const { listPeerAddresses, probePeer } = vi.hoisted(() => ({
  listPeerAddresses: vi.fn<(environmentId: string) => Promise<ReadonlyArray<string>>>(),
  probePeer: vi.fn<(from: string, origin: string) => Promise<PeerProbeResponse>>(),
}));
vi.mock("./peeringClient", () => ({ listPeerAddresses, probePeer }));
import { noRouteMessage, runPeeringCheck, type PeeringCheckSide } from "./peeringCheck";

const side = (id: string, label: string, clientUrl: string | null): PeeringCheckSide => ({
  server: { environmentId: EnvironmentId.make(id), label },
  clientUrl,
});

describe("runPeeringCheck", () => {
  it("reports a server's failed address list as its error, never as a guess about its network", async () => {
    // This browser reaches both servers over loopback, so only their own lists could offer an address.
    const vm = side("environment-vm", "Work VM", "http://localhost:3773");
    const laptop = side("environment-laptop", "JM-LT-04213", "http://127.0.0.1:3774");
    listPeerAddresses.mockImplementation((environmentId) =>
      environmentId === "environment-vm"
        ? Promise.reject(new Error("access expired"))
        : Promise.resolve([]),
    );
    probePeer.mockRejectedValue(new Error("no probe should run"));

    const check = await runPeeringCheck(vm, laptop);
    expect(check.remoteToLocal).toEqual({ kind: "untested", error: "access expired" });
    expect(check.localToRemote).toEqual({ kind: "untested", error: null });
    expect(probePeer).not.toHaveBeenCalled();
  });
});

describe("noRouteMessage", () => {
  it("says the check couldn't test a direction, never that neither server could reach the other", () => {
    const untested = { kind: "untested", error: null } as const;
    const failed = {
      kind: "failed",
      errors: ["10.0.0.2:3773: connection timed out after 4 s"],
    } as const;

    for (const check of [
      { localToRemote: untested, remoteToLocal: untested },
      { localToRemote: failed, remoteToLocal: untested },
    ]) {
      expect(noRouteMessage(check)).not.toContain("Neither server could reach");
      expect(noRouteMessage(check)).toContain("couldn't test");
    }
    expect(noRouteMessage({ localToRemote: failed, remoteToLocal: failed })).toContain(
      "Neither server could reach the other at the addresses it tried.",
    );
  });
});
