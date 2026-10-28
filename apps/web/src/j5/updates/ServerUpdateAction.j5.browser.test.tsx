// J5 (case 40): every install kind updates in place with `j5 update`, and the
// success toast names the `j5` version. Moved here when upstream replaced
// `components/ServerUpdateAction.test.tsx` with its browser test.
import { RegistryContext } from "@effect/atom-react";
import { AuthSessionState, type EnvironmentId, type ServerInstallation } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  clipboard: vi.fn(),
  sessionAtom: null as unknown,
}));

vi.mock(import("~/hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  useCopyToClipboard: ((options: { onCopy: (context: { command: string }) => void }) => ({
    copyToClipboard: (command: string, context: { command: string }) => {
      testState.clipboard(command);
      options.onCopy(context);
    },
    isCopied: false,
  })) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) => selector({ continueThreadsAfterServerUpdate: false })) as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => testState.sessionAtom) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import { resetConfirmDialogForTests } from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { ServerUpdateAction } from "~/components/ServerUpdateAction";

const session = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

function setup(): Disposable {
  testState.updateServer.mockReset();
  testState.toast.mockReset();
  testState.clipboard.mockReset();
  testState.sessionAtom = Atom.make<SessionResult>(AsyncResult.success(session));
  resetConfirmDialogForTests();
  return { [Symbol.dispose]: resetConfirmDialogForTests };
}

function renderAction(props: Partial<Parameters<typeof ServerUpdateAction>[0]>) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ServerUpdateAction
        environmentId={"env-test" as EnvironmentId}
        serverLabel="Test server"
        selfUpdate="boot-service"
        targetVersion="0.0.31"
        {...props}
      />
    </RegistryContext.Provider>,
  );
}

describe("J5 server update commands", () => {
  it.each([
    [{ kind: "npm-global", prefix: "/opt/node" }],
    [{ kind: "npx" }],
    [undefined],
  ] satisfies ReadonlyArray<readonly [ServerInstallation | undefined]>)(
    "copies `j5 update` for %j without invoking remote update",
    async (installation) => {
      using _state = setup();
      await using screen = await renderAction({
        selfUpdate: null,
        installation,
        targetVersion: "0.0.45",
      });
      await act(async () => screen.container.querySelector("button")!.click());

      expect(testState.clipboard).toHaveBeenCalledWith("j5 update 0.0.45");
      expect(testState.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Update command copied",
          description: expect.stringContaining("to update it"),
        }),
      );
      expect(testState.updateServer).not.toHaveBeenCalled();
    },
  );

  it("reports the reconnected `j5` version", async () => {
    using _state = setup();
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    await using screen = await renderAction({});
    await act(async () => screen.container.querySelector("button")!.click());

    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Reconnected on j5 0.0.31.",
    });
  });
});
