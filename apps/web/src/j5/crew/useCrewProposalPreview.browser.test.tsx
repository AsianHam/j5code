import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { CrewProposalPreviewResponse, type CrewProposalSeat } from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { previewCrewProposal } = vi.hoisted(() => ({ previewCrewProposal: vi.fn() }));
vi.mock(import("./crewProposalsClient"), async (importOriginal) => ({
  ...(await importOriginal()),
  previewCrewProposal,
}));

import { act, render } from "../../../test/render";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

const environmentId = EnvironmentId.make("crew-preview");
const decodePreviewResponse = Schema.decodeUnknownSync(CrewProposalPreviewResponse);
const seats: ReadonlyArray<CrewProposalSeat> = [
  { seat: "reviewer", agentId: null, reason: "Review", instructions: "Review the patch" },
];
const response: CrewProposalPreviewResponse = {
  proposalId: "proposal:1",
  workspaceOptions: {
    currentBranch: "main",
    cwd: "/repo",
    worktrees: [],
  },
  approvalToken: "preview:1",
  seats: [
    {
      seat: "reviewer",
      workspace: { type: "shared" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      runtimeMode: "full-access",
      provider: "OpenAI",
      harness: "Codex",
      model: "GPT-6-Astra",
      reasoning: "High",
      access: "Full access",
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let result: ReturnType<typeof useCrewProposalPreview>;
function Surface(props: {
  seats: ReadonlyArray<CrewProposalSeat>;
  environmentId: EnvironmentId | null;
  busy?: boolean;
  proposalId?: string;
}) {
  const preview = useCrewProposalPreview(
    props.environmentId,
    props.proposalId ?? "proposal:1",
    props.seats,
    props.busy ?? false,
  );
  useEffect(() => {
    result = preview;
  }, [preview]);
  return null;
}
function surface(
  nextSeats = seats,
  nextEnvironment: EnvironmentId | null = environmentId,
  busy = false,
) {
  return <Surface seats={nextSeats} environmentId={nextEnvironment} busy={busy} />;
}
function setup() {
  previewCrewProposal.mockReset();
}

describe("crew runtime preview lifecycle", () => {
  it("withholds approval while loading and ignores a response for a previous roster", async () => {
    setup();
    const first = deferred<CrewProposalPreviewResponse>();
    const second = deferred<CrewProposalPreviewResponse>();
    previewCrewProposal.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await using screen = await render(surface(), { router: false });
    expect(result.loading).toBe(true);
    expect(result.data).toBeNull();
    const changed = [{ ...seats[0]!, instructions: "Review only authentication" }];
    await screen.rerender(surface(changed));
    await act(async () => first.resolve(response));
    expect(result.data).toBeNull();
    await act(async () => second.resolve({ ...response, approvalToken: "preview:2" }));
    expect(result.data?.approvalToken).toBe("preview:2");
    expect(previewCrewProposal).toHaveBeenLastCalledWith(environmentId, {
      proposalId: "proposal:1",
      seats: changed,
    });
  });

  it.each([
    [
      "harness",
      {
        modelSelection: {
          ...response.seats[0]!.modelSelection,
          instanceId: ProviderInstanceId.make("codex-other"),
        },
      },
    ],
    ["model", { modelSelection: { ...response.seats[0]!.modelSelection, model: "other-model" } }],
    [
      "reasoning",
      {
        modelSelection: {
          ...response.seats[0]!.modelSelection,
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      },
    ],
    ["access", { runtimeMode: "approval-required" as const }],
  ])("invalidates approval when the custom %s changes", async (_field, change) => {
    setup();
    const next = deferred<CrewProposalPreviewResponse>();
    previewCrewProposal.mockResolvedValueOnce(response).mockReturnValueOnce(next.promise);
    await using screen = await render(surface(), { router: false });
    expect(result.data).toEqual(response);
    const edited = [{ ...seats[0]!, ...change }];
    await screen.rerender(surface(edited));
    expect(result.data).toBeNull();
    expect(result.runtimeSeats).toBeNull();
    expect(result.loading).toBe(true);
    expect(previewCrewProposal).toHaveBeenLastCalledWith(environmentId, {
      proposalId: "proposal:1",
      seats: edited,
    });
    await act(async () => next.resolve({ ...response, approvalToken: "updated-runtime" }));
    expect(result.data?.approvalToken).toBe("updated-runtime");
  });

  it("invalidates displayed runtime on environment changes and failed previews can retry", async () => {
    setup();
    previewCrewProposal
      .mockResolvedValueOnce(response)
      .mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValueOnce(response);
    await using screen = await render(surface(), { router: false });
    expect(result.data).toEqual(response);
    await screen.rerender(surface(seats, EnvironmentId.make("another-environment")));
    expect(result.data).toBeNull();
    expect(result.error).toBe("Provider unavailable");
    await act(async () => result.refresh());
    expect(result.data).toEqual(response);
  });

  it("retains runtime disclosure while approving but requires a fresh token afterward", async () => {
    setup();
    const next = deferred<CrewProposalPreviewResponse>();
    previewCrewProposal.mockResolvedValueOnce(response).mockReturnValueOnce(next.promise);
    await using screen = await render(surface(), { router: false });
    // Match the card: invalidate the approval token, then enter busy in the same event.
    await act(async () => {
      result.refresh();
      await screen.rerender(<Surface seats={seats} environmentId={environmentId} busy />);
    });
    expect(result.data).toBeNull();
    expect(result.runtimeSeats).toEqual(response.seats);
    expect(result.loading).toBe(false);
    expect(previewCrewProposal).toHaveBeenCalledTimes(1);
    await screen.rerender(surface(seats, environmentId, false));
    expect(previewCrewProposal).toHaveBeenCalledTimes(2);
    expect(result.data).toBeNull();
    expect(result.runtimeSeats).toBeNull();
    expect(result.loading).toBe(true);
    await act(async () => next.resolve({ ...response, approvalToken: "preview:2" }));
    expect(result.data?.approvalToken).toBe("preview:2");
    expect(result.runtimeSeats).toEqual(response.seats);
  });

  it("never retains busy runtime disclosure for a changed roster, environment, or proposal", async () => {
    setup();
    previewCrewProposal.mockResolvedValueOnce(response);
    await using screen = await render(surface(), { router: false });
    await screen.rerender(
      surface([{ ...seats[0]!, instructions: "Changed instructions" }], environmentId, true),
    );
    expect(result.runtimeSeats).toBeNull();
    expect(result.data).toBeNull();
    await screen.rerender(surface(seats, EnvironmentId.make("another-environment"), true));
    expect(result.runtimeSeats).toBeNull();
    await screen.rerender(
      <Surface seats={seats} environmentId={environmentId} proposalId="proposal:2" busy />,
    );
    expect(result.runtimeSeats).toBeNull();
    expect(previewCrewProposal).toHaveBeenCalledTimes(1);
  });

  it("accepts a preview from a server that predates seat workspaces", async () => {
    setup();
    // An older server sends neither the card's workspace options nor a seat's workspace.
    const { workspaceOptions: _options, ...withoutOptions } = response;
    const older = decodePreviewResponse({
      ...withoutOptions,
      seats: response.seats.map(({ workspace: _workspace, ...row }) => row),
    });
    previewCrewProposal.mockResolvedValue(older);
    await using _screen = await render(surface(), { router: false });
    expect(result.error).toBeNull();
    expect(result.data?.seats.map((row) => row.seat)).toEqual(["reviewer"]);
    expect(result.data?.seats[0]?.workspace).toBeUndefined();
    // With no options, the card has no workspace to offer, so the control stays hidden.
    expect(result.data?.workspaceOptions).toBeUndefined();
  });

  it("never accepts incomplete runtime rows or an unavailable environment", async () => {
    setup();
    previewCrewProposal.mockResolvedValue({ ...response, seats: [] });
    await using screen = await render(surface(), { router: false });
    expect(result.data).toBeNull();
    expect(result.error).toContain("incomplete");
    await screen.rerender(surface(seats, null));
    expect(result.data).toBeNull();
    expect(result.loading).toBe(false);
    expect(result.error).toContain("Connect");
    expect(previewCrewProposal).toHaveBeenCalledTimes(1);
  });
});
