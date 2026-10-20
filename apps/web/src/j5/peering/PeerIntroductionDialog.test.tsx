import { EnvironmentId } from "@t3tools/contracts";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/dialog", () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: Part,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogPanel: Part,
    DialogPopup: Part,
    DialogTitle: Part,
  };
});
vi.mock("../../components/ui/alert", () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return { Alert: Part, AlertDescription: Part, AlertTitle: Part };
});
vi.mock("../../components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../../components/ui/input", () => ({ Input: () => null }));
vi.mock("../../components/ui/radio-group", () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return { Radio: Part, RadioGroup: Part };
});
vi.mock("../../components/ui/toggle-group", () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return { Toggle: Part, ToggleGroup: Part };
});
vi.mock("../../components/ui/select", () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Select: ({ children }: PropsWithChildren<{ onValueChange: (value: string) => void }>) => (
      <div>{children}</div>
    ),
    SelectItem: Part,
    SelectPopup: Part,
    SelectTrigger: Part,
    SelectValue: Part,
  };
});

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const state = {
  remotePhase: "connected",
  canManage: true,
  peers: {} as Record<string, ReadonlyArray<{ environmentId: string }>>,
  unreadable: {} as Record<string, string>,
};
const environmentOf = (environmentId: EnvironmentId) => ({
  environmentId,
  label: environmentId === LOCAL ? "Local" : "Remote",
  connection: { phase: environmentId === LOCAL ? "connected" : state.remotePhase },
  serverConfig: {},
});
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [environmentOf(LOCAL), environmentOf(REMOTE)] }),
  useEnvironment: (id: EnvironmentId) => environmentOf(id),
  useEnvironmentHttpBaseUrl: () => "http://client.example",
}));
// The dialog's only atom is the add-peer command's permission on the chosen environment.
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (permission: { readonly environmentId: string | null }) =>
    permission.environmentId !== null && state.canManage,
}));
vi.mock("../state", () => ({
  peersQueryAtom: (id: string) => id,
  j5Environment: {
    addPeer: { permissionAtom: (environmentId: string | null) => ({ environmentId }) },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key !== null && state.unreadable[key] !== undefined
      ? { data: null, error: state.unreadable[key] }
      : { data: key === null ? null : (state.peers[key] ?? []), error: null },
}));
vi.mock("./peeringCheck", () => ({
  peeringServerOf: (environment: ReturnType<typeof environmentOf>) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverVersion: "1.0.0",
    supportsPoll: true,
    runMode: "service",
  }),
  // Each server reaches the other, so the recommendation is to send directly both ways.
  runPeeringCheck: () =>
    Promise.resolve({
      localToRemote: { kind: "reached", origin: "https://remote.example:3773" },
      remoteToLocal: { kind: "reached", origin: "https://local.example:3773" },
    }),
  noRouteMessage: () => "",
}));
vi.mock("./peeringClient", () => ({
  addPeer: vi.fn(),
  issuePeerCredential: vi.fn(),
  removePeer: vi.fn(),
}));

import { PeerIntroductionDialog } from "./PeerIntroductionDialog";
import { Select } from "../../components/ui/select";
import { addPeer, issuePeerCredential, removePeer } from "./peeringClient";

let renderer: ReactTestRenderer | null;
beforeEach(() => {
  renderer = null;
  state.remotePhase = "connected";
  state.canManage = true;
  state.peers = {};
  state.unreadable = {};
  vi.mocked(removePeer)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.mocked(issuePeerCredential)
    .mockReset()
    .mockResolvedValue({ credential: "credential" } as never);
  vi.mocked(addPeer)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

const dialog = () => (
  <PeerIntroductionDialog
    open
    onOpenChange={() => {}}
    servers={[LOCAL, REMOTE]}
    defaultServerId={LOCAL}
    onPeered={() => {}}
  />
);
const button = (label: string): ReactTestInstance =>
  renderer!.root.findAllByType("button").find((found) => found.props.children === label)!;
const rerender = async () => {
  await act(async () => renderer!.update(dialog()));
};

const text = () =>
  renderer!.root
    .findAllByType("p")
    .map((found) => found.children.join(""))
    .join("\n");
const chooseRemote = async () => {
  await act(async () => {
    renderer = create(dialog());
  });
  await act(async () => renderer!.root.findAllByType(Select)[1]!.props.onValueChange(REMOTE));
};
const clickPeer = async () => {
  await act(async () => button("Peer").props.onClick());
};
/** Keeps the recommended setup as a manual one, which then outlives any change in the servers. */
const chooseManualSetup = async () => {
  await chooseRemote();
  await act(async () => button("Set up differently").props.onClick());
  expect(button("Peer").props.disabled).toBe(false);
};
const nothingWritten = () => {
  expect(removePeer).not.toHaveBeenCalled();
  expect(issuePeerCredential).not.toHaveBeenCalled();
  expect(addPeer).not.toHaveBeenCalled();
};

describe("peering over a leftover record", () => {
  it("clears the other server's old record of this one before issuing anything", async () => {
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    await chooseRemote();
    await clickPeer();

    expect(removePeer).toHaveBeenCalledWith(REMOTE, LOCAL);
    const cleared = vi.mocked(removePeer).mock.invocationCallOrder[0]!;
    expect(vi.mocked(issuePeerCredential).mock.invocationCallOrder[0]).toBeGreaterThan(cleared);
    expect(addPeer).toHaveBeenCalledTimes(2);
  });

  it("stops before issuing anything when clearing that record fails", async () => {
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    vi.mocked(removePeer).mockRejectedValue(new Error("removal refused"));
    await chooseRemote();
    await clickPeer();

    expect(removePeer).toHaveBeenCalledTimes(1);
    expect(issuePeerCredential).not.toHaveBeenCalled();
    expect(addPeer).not.toHaveBeenCalled();
  });

  it("names where to clear it, and clears nothing, when the remote cannot be managed", async () => {
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    state.canManage = false;
    await chooseRemote();

    expect(text()).toContain("Remove Local under Peer servers on Remote first.");
    expect(button("Peer").props.disabled).toBe(true);
    await clickPeer();
    nothingWritten();
  });
});

describe("peering from a server that is not this client's own", () => {
  it("clears the old record the other server holds of the chosen one", async () => {
    state.peers = { [LOCAL]: [{ environmentId: REMOTE }] };
    await act(async () => {
      renderer = create(dialog());
    });
    await act(async () => renderer!.root.findAllByType(Select)[0]!.props.onValueChange(REMOTE));
    await act(async () => renderer!.root.findAllByType(Select)[1]!.props.onValueChange(LOCAL));
    await clickPeer();

    expect(removePeer).toHaveBeenCalledWith(LOCAL, REMOTE);
    expect(addPeer).toHaveBeenCalledTimes(2);
  });
});

describe("peering when a peer list cannot be read", () => {
  it("decides nothing from it and says why", async () => {
    // This server does record the remote, but its list fails to load.
    state.peers = { [LOCAL]: [{ environmentId: REMOTE }], [REMOTE]: [{ environmentId: LOCAL }] };
    state.unreadable = { [LOCAL]: "could not list peers" };
    await chooseRemote();

    expect(text()).toContain("Could not read Local's peers: could not list peers");
    expect(text()).not.toContain("old record");
    expect(button("Peer").props.disabled).toBe(true);
    await clickPeer();
    nothingWritten();
  });
});

describe("peering with a saved manual setup", () => {
  it("stops offering Peer once the remote disconnects", async () => {
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    await chooseManualSetup();
    state.remotePhase = "disconnected";
    await rerender();

    expect(button("Peer").props.disabled).toBe(true);
    await clickPeer();
    nothingWritten();
  });

  it("stops offering Peer once this client can no longer manage the remote", async () => {
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    await chooseManualSetup();
    state.canManage = false;
    await rerender();

    expect(button("Peer").props.disabled).toBe(true);
    await clickPeer();
    nothingWritten();
  });

  it("stops offering Peer once this server turns out to record the remote", async () => {
    await chooseManualSetup();
    state.peers = { [LOCAL]: [{ environmentId: REMOTE }] };
    await rerender();

    expect(button("Peer").props.disabled).toBe(true);
    await clickPeer();
    nothingWritten();
  });
});
