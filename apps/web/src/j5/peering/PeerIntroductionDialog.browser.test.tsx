import { EnvironmentId } from "@t3tools/contracts";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

// A modal dialog's backdrop sits over everything outside it, including the selects' popups,
// so the dialog renders inline here; the selects and buttons are the real ones.
vi.mock(import("../../components/ui/dialog"), async (importOriginal) => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    ...(await importOriginal()),
    Dialog: Part as never,
    DialogDescription: Part as never,
    DialogFooter: Part as never,
    DialogHeader: Part as never,
    DialogPanel: Part as never,
    DialogPopup: Part as never,
    DialogTitle: Part as never,
  };
});

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const state = vi.hoisted(() => ({
  remotePhase: "connected",
  canManage: true,
  peers: {} as Record<string, ReadonlyArray<{ environmentId: string }>>,
  unreadable: {} as Record<string, string>,
}));
const environmentOf = (environmentId: string) => ({
  environmentId,
  label: environmentId === "env-local" ? "Local" : "Remote",
  connection: { phase: environmentId === "env-local" ? "connected" : state.remotePhase },
  serverConfig: {},
});
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironments: (() => ({
    environments: [environmentOf("env-local"), environmentOf("env-remote")],
  })) as never,
  useEnvironment: ((id: string) => environmentOf(id)) as never,
  useEnvironmentHttpBaseUrl: (() => "http://client.example") as never,
}));
// The dialog's only atom is the add-peer command's permission on the chosen environment.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: ((permission: { readonly environmentId: string | null }) =>
    permission.environmentId !== null && state.canManage) as never,
}));
vi.mock(import("../state"), async (importOriginal) => ({
  ...(await importOriginal()),
  peersQueryAtom: ((id: string) => id) as never,
  j5Environment: {
    addPeer: { permissionAtom: (environmentId: string | null) => ({ environmentId }) },
  } as never,
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((key: string | null) =>
    key !== null && state.unreadable[key] !== undefined
      ? { data: null, error: state.unreadable[key] }
      : { data: key === null ? null : (state.peers[key] ?? []), error: null }) as never,
}));
vi.mock(import("./peeringCheck"), async (importOriginal) => ({
  ...(await importOriginal()),
  peeringServerOf: ((environment: ReturnType<typeof environmentOf>) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverVersion: "1.0.0",
    supportsPoll: true,
    runMode: "service",
  })) as never,
  // Each server reaches the other, so the recommendation is to send directly both ways.
  runPeeringCheck: (() =>
    Promise.resolve({
      localToRemote: { kind: "reached", origin: "https://remote.example:3773" },
      remoteToLocal: { kind: "reached", origin: "https://local.example:3773" },
    })) as never,
  noRouteMessage: (() => "") as never,
}));
vi.mock(import("./peeringClient"), async (importOriginal) => ({
  ...(await importOriginal()),
  addPeer: vi.fn(),
  issuePeerCredential: vi.fn(),
  removePeer: vi.fn(),
}));

import { render } from "../../../test/render";
import { PeerIntroductionDialog } from "./PeerIntroductionDialog";
import { addPeer, issuePeerCredential, removePeer } from "./peeringClient";

function resetState() {
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
}

const dialog = () => (
  <PeerIntroductionDialog
    open
    onOpenChange={() => {}}
    servers={[LOCAL, REMOTE]}
    defaultServerId={LOCAL}
    onPeered={() => {}}
  />
);
const peerButton = () => page.getByRole("button", { name: "Peer", exact: true });

const choose = async (select: "Server to peer" | "Server to peer with", option: string) => {
  await page.getByRole("combobox", { name: select, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};
const renderWithRemote = async () => {
  const screen = await render(dialog());
  await choose("Server to peer with", "Remote");
  return screen;
};
/** Keeps the recommended setup as a manual one, which then outlives any change in the servers. */
const renderWithManualSetup = async () => {
  const screen = await renderWithRemote();
  await page.getByRole("button", { name: "Set up differently" }).click();
  await expect.element(peerButton()).toBeEnabled();
  return screen;
};
const nothingWritten = () => {
  expect(removePeer).not.toHaveBeenCalled();
  expect(issuePeerCredential).not.toHaveBeenCalled();
  expect(addPeer).not.toHaveBeenCalled();
};

describe("peering over a leftover record", () => {
  it("clears the other server's old record of this one before issuing anything", async () => {
    resetState();
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    await using _screen = await renderWithRemote();
    await peerButton().click();

    await expect.poll(() => vi.mocked(addPeer).mock.calls.length).toBe(2);
    expect(removePeer).toHaveBeenCalledWith(REMOTE, LOCAL);
    const cleared = vi.mocked(removePeer).mock.invocationCallOrder[0]!;
    expect(vi.mocked(issuePeerCredential).mock.invocationCallOrder[0]).toBeGreaterThan(cleared);
  });

  it("stops before issuing anything when clearing that record fails", async () => {
    resetState();
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    vi.mocked(removePeer).mockRejectedValue(new Error("removal refused"));
    await using _screen = await renderWithRemote();
    await peerButton().click();

    await expect.element(page.getByText("removal refused")).toBeVisible();
    expect(removePeer).toHaveBeenCalledTimes(1);
    expect(issuePeerCredential).not.toHaveBeenCalled();
    expect(addPeer).not.toHaveBeenCalled();
  });

  it("names where to clear it, and clears nothing, when the remote cannot be managed", async () => {
    resetState();
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    state.canManage = false;
    await using _screen = await renderWithRemote();

    await expect
      .element(page.getByText("Remove Local under Peer servers on Remote first.", { exact: false }))
      .toBeVisible();
    await expect.element(peerButton()).toBeDisabled();
    nothingWritten();
  });
});

describe("peering from a server that is not this client's own", () => {
  it("clears the old record the other server holds of the chosen one", async () => {
    resetState();
    state.peers = { [LOCAL]: [{ environmentId: REMOTE }] };
    await using _screen = await render(dialog());
    await choose("Server to peer", "Remote");
    await choose("Server to peer with", "Local");
    await peerButton().click();

    await expect.poll(() => vi.mocked(addPeer).mock.calls.length).toBe(2);
    expect(removePeer).toHaveBeenCalledWith(LOCAL, REMOTE);
  });
});

describe("peering when a peer list cannot be read", () => {
  it("decides nothing from it and says why", async () => {
    resetState();
    // This server does record the remote, but its list fails to load.
    state.peers = { [LOCAL]: [{ environmentId: REMOTE }], [REMOTE]: [{ environmentId: LOCAL }] };
    state.unreadable = { [LOCAL]: "could not list peers" };
    await using _screen = await renderWithRemote();

    await expect
      .element(page.getByText("Could not read Local's peers: could not list peers"))
      .toBeVisible();
    await expect.element(page.getByText(/old record/)).not.toBeInTheDocument();
    await expect.element(peerButton()).toBeDisabled();
    nothingWritten();
  });
});

describe("peering with a saved manual setup", () => {
  it("stops offering Peer once the remote disconnects", async () => {
    resetState();
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    await using screen = await renderWithManualSetup();
    state.remotePhase = "disconnected";
    await screen.rerender(dialog());

    await expect.element(peerButton()).toBeDisabled();
    nothingWritten();
  });

  it("stops offering Peer once this client can no longer manage the remote", async () => {
    resetState();
    state.peers = { [REMOTE]: [{ environmentId: LOCAL }] };
    await using screen = await renderWithManualSetup();
    state.canManage = false;
    await screen.rerender(dialog());

    await expect.element(peerButton()).toBeDisabled();
    nothingWritten();
  });

  it("stops offering Peer once this server turns out to record the remote", async () => {
    resetState();
    await using screen = await renderWithManualSetup();
    state.peers = { [LOCAL]: [{ environmentId: REMOTE }] };
    await screen.rerender(dialog());

    await expect.element(peerButton()).toBeDisabled();
    nothingWritten();
  });
});
