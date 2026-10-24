import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const editorState = vi.hoisted(() => ({ props: null as unknown }));

vi.mock(import("./crewProposalsClient"), async (importOriginal) => ({
  ...(await importOriginal()),
  previewCrewProposal: vi.fn(),
}));
// The dialog owns the draft; the editor only reports changes, so tests drive it through its props.
vi.mock(import("./CrewSeatEditor"), async (importOriginal) => ({
  ...(await importOriginal()),
  CrewSeatEditor: ((props: unknown) => {
    editorState.props = props;
    return null;
  }) as never,
}));

import { act, render } from "../../../test/render";
import { CrewSeatDialog } from "./CrewSeatDialog";
import type { CrewSeatEditor } from "./CrewSeatEditor";
import { previewCrewProposal } from "./crewProposalsClient";
import { chooseCrewSeatPersona, resolvedCrewSeatDraft } from "./crewSeatRuntime";
import { addSeat, saveSeat } from "./crewProposalDraft";

const seat = {
  seat: "reviewer",
  agentId: null,
  reason: "Review",
  instructions: "Review the patch",
};
const runtime: CrewProposalSeatRuntime = {
  workspace: { type: "shared" },
  seat: "reviewer",
  provider: "OpenAI",
  harness: "Codex",
  model: "GPT-6-Astra",
  reasoning: "High",
  access: "Full access",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access",
};
function setup() {
  editorState.props = null;
  vi.mocked(previewCrewProposal).mockReset();
}

const editor = () => editorState.props as ComponentProps<typeof CrewSeatEditor>;
const change = (value: ComponentProps<typeof CrewSeatEditor>["value"]) =>
  act(() => editor().onChange(value));
// Dispatched directly: Playwright's click waits for the popup's open animation to settle.
const click = (name: string) =>
  act(() => (page.getByRole("button", { name, exact: true }).element() as HTMLElement).click());
const submit = (name: "Save changes" | "Add member" = "Save changes") => click(name);

describe("crew member dialog draft lifecycle", () => {
  it("keeps runtime changes local and discards them when cancelled", async () => {
    setup();
    const onSave = vi.fn();
    const onClose = vi.fn();
    await using _screen = await render(
      <CrewSeatDialog
        proposalId="proposal:1"
        previewSeatName="reviewer"
        seat={seat}
        runtime={runtime}
        environmentId={null}
        agents={[]}
        disabled={false}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    expect(editor().value.modelSelection).toEqual(runtime.modelSelection);
    await change({
      ...editor().value,
      runtimeMode: "approval-required",
      instructions: "Unsaved edits",
    });
    expect(editor().value.instructions).toBe("Unsaved edits");
    expect(onSave).not.toHaveBeenCalled();
    expect(seat.instructions).toBe("Review the patch");
    await click("Cancel");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("leaves invalid edits open, then publishes one validated roster update on Save", async () => {
    setup();
    const onClose = vi.fn();
    const onSave = vi.fn((draft) => saveSeat([seat], seat.seat, draft).error);
    await using _screen = await render(
      <CrewSeatDialog
        proposalId="proposal:1"
        previewSeatName="reviewer"
        seat={seat}
        runtime={runtime}
        environmentId={null}
        agents={[]}
        disabled={false}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await change({ ...editor().value, instructions: "" });
    await submit();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("instructions");
    await change({
      ...editor().value,
      instructions: "Check authentication",
      runtimeMode: "approval-required",
    });
    await submit();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instructions: "Check authentication",
        modelSelection: runtime.modelSelection,
        runtimeMode: "approval-required",
      }),
    );
  });

  it("prefills a proposed saved persona and saves its edited runtime without changing its identity", async () => {
    setup();
    const saved = { ...seat, agentId: "sentry" };
    let roster = [saved];
    await using _screen = await render(
      <CrewSeatDialog
        proposalId="proposal:1"
        previewSeatName="reviewer"
        seat={saved}
        runtime={runtime}
        environmentId={null}
        agents={[]}
        disabled={false}
        onClose={() => {}}
        onSave={(draft) => {
          const result = saveSeat(roster, saved.seat, draft);
          roster = result.seats as typeof roster;
          return result.error;
        }}
      />,
    );
    await change({
      ...resolvedCrewSeatDraft(editor().value, editor().runtime),
      runtimeMode: "approval-required",
    });
    expect(roster[0]).toEqual(saved);
    await submit();
    expect(roster[0]).toEqual({
      ...saved,
      modelSelection: runtime.modelSelection,
      runtimeMode: "approval-required",
    });
  });

  it("keeps persona defaults when saving only instructions", async () => {
    setup();
    const onSave = vi.fn(
      (_draft: Parameters<React.ComponentProps<typeof CrewSeatDialog>["onSave"]>[0]) => null,
    );
    await using _screen = await render(
      <CrewSeatDialog
        proposalId="proposal:1"
        previewSeatName="reviewer"
        seat={{ ...seat, agentId: "sentry" }}
        runtime={runtime}
        environmentId={null}
        agents={[]}
        disabled={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    await change({ ...editor().value, instructions: "Check auth" });
    await submit();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelSelection");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("runtimeMode");
  });

  it("loads a manually selected persona's defaults and ignores an older response", async () => {
    setup();
    const pending: Array<(value: Awaited<ReturnType<typeof previewCrewProposal>>) => void> = [];
    vi.mocked(previewCrewProposal).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const onSave = vi.fn((draft) => addSeat([], draft).error);
    await using _screen = await render(
      <CrewSeatDialog
        proposalId="proposal:1"
        previewSeatName="reviewer"
        seat={null}
        environmentId={EnvironmentId.make("test")}
        agents={[]}
        disabled={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    await change(chooseCrewSeatPersona({ ...editor().value, seat: "manual" }, "sentry"));
    await act(async () =>
      pending[0]!({
        workspaceOptions: {
          currentBranch: "main",
          cwd: "/repo",
          worktrees: [],
        },
        proposalId: "proposal:1",
        approvalToken: "old",
        seats: [{ ...runtime, model: "Wrong custom default" }],
      }),
    );
    expect(editor().runtime).toBeUndefined();
    await act(async () =>
      pending[1]!({
        workspaceOptions: {
          currentBranch: "main",
          cwd: "/repo",
          worktrees: [],
        },
        proposalId: "proposal:1",
        approvalToken: "new",
        seats: [runtime],
      }),
    );
    expect(editor().runtime).toEqual(runtime);
    await change({
      ...resolvedCrewSeatDraft(editor().value, editor().runtime),
      runtimeMode: "approval-required",
    });
    await submit("Add member");
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sentry",
        modelSelection: runtime.modelSelection,
        runtimeMode: "approval-required",
      }),
    );
  });

  it("starts additions as custom and requires a valid name before publishing", async () => {
    setup();
    const onClose = vi.fn();
    const onSave = vi.fn((draft) => addSeat([seat], draft).error);
    await using _screen = await render(
      <CrewSeatDialog
        proposalId="proposal:1"
        previewSeatName="reviewer"
        seat={null}
        environmentId={null}
        agents={[]}
        disabled={false}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await change({
      ...editor().value,
      instructions: "Review security",
      modelSelection: runtime.modelSelection,
      runtimeMode: "approval-required",
    });
    await submit("Add member");
    expect(onClose).not.toHaveBeenCalled();
    await change({ ...editor().value, seat: "security" });
    await submit("Add member");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        seat: "security",
        modelSelection: runtime.modelSelection,
        runtimeMode: "approval-required",
      }),
    );
  });
});
