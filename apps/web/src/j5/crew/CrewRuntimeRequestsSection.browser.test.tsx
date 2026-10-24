import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { ScopedCrewRuntimeRequest } from "./crewRuntimeRequests.logic";

const OPERABLE = EnvironmentId.make("env-operate");
const READ_ONLY = EnvironmentId.make("env-read-only");
const client = vi.hoisted(() => ({
  respondCrewRuntimeRequest: vi.fn(() => Promise.resolve({})),
  refreshCrewRuntimeRequests: vi.fn(() => Promise.resolve()),
}));

// A permission atom is its environment id; only the operable environment's session may answer.
vi.mock(import("@effect/atom-react"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useAtomValue: ((atom: Parameters<typeof original.useAtomValue>[0]) =>
      typeof atom === "string" ? atom === "env-operate" : original.useAtomValue(atom)) as never,
  };
});
vi.mock(import("../state"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    j5Environment: {
      ...original.j5Environment,
      respondCrewRuntimeRequest: {
        permissionAtom: (environmentId: string) => environmentId,
      } as never,
    },
  };
});
vi.mock(import("./crewRuntimeRequestsClient"), async (importOriginal) => ({
  ...(await importOriginal()),
  respondCrewRuntimeRequest: client.respondCrewRuntimeRequest as never,
  refreshCrewRuntimeRequests: client.refreshCrewRuntimeRequests as never,
}));
vi.mock(import("../a2a/humanInboxRefresh"), async (importOriginal) => ({
  ...(await importOriginal()),
  notifyHumanInboxChanged: vi.fn(),
}));
vi.mock(import("../../components/chat/ComposerPendingApprovalPanel"), async (importOriginal) => ({
  ...(await importOriginal()),
  ComposerPendingApprovalPanel: (() => null) as never,
}));
vi.mock(import("../../components/chat/ComposerPendingApprovalActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  ComposerPendingApprovalActions: ((props: {
    readonly requestId: string;
    readonly canRespond: boolean;
    readonly onRespondToApproval: (requestId: string, decision: "accept") => void;
  }) => (
    <button
      type="button"
      data-request={props.requestId}
      disabled={!props.canRespond}
      onClick={() => props.onRespondToApproval(props.requestId, "accept")}
    >
      Approve
    </button>
  )) as never,
}));

import { act, render } from "../../../test/render";
import { CrewRuntimeRequestsSection } from "./CrewRuntimeRequestsSection";

const request = (environmentId: EnvironmentId, id: string): ScopedCrewRuntimeRequest => ({
  environmentId,
  threadId: ThreadId.make(`thread:${id}`),
  requestId: RuntimeRequestId.make(id),
  crewInstanceId: "crew:1",
  crewName: "Release Crew",
  projectId: "project:1",
  seat: "builder",
  threadTitle: "builder",
  createdAt: "2026-09-24T12:00:00.000Z",
  requestKind: "command",
});

it("lets each seat's approval be answered only where this session may operate", async () => {
  await using screen = await render(
    <CrewRuntimeRequestsSection
      requests={[request(OPERABLE, "req:operable"), request(READ_ONLY, "req:read-only")]}
      onOpenThread={() => undefined}
    />,
  );
  const approve = (id: string) =>
    screen.container.querySelector<HTMLButtonElement>(`[data-request="${id}"]`)!;
  expect(approve("req:read-only").disabled).toBe(true);
  expect(approve("req:operable").disabled).toBe(false);

  await act(() => approve("req:operable").click());
  // The answer goes to the environment that holds the seat's thread, never another one.
  expect(client.respondCrewRuntimeRequest).toHaveBeenCalledExactlyOnceWith(OPERABLE, {
    threadId: ThreadId.make("thread:req:operable"),
    requestId: RuntimeRequestId.make("req:operable"),
    decision: "accept",
  });
});
