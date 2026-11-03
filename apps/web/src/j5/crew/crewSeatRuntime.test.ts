import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { CUSTOM_AGENT, addSeat, saveSeat } from "./crewProposalDraft";
import {
  applyCrewSeatDraft,
  chooseCrewSeatPersona,
  chooseCrewSeatWorkspace,
  chooseCrewHarness,
  describeCrewSeatWorkspace,
  setCrewSeatBaseRef,
  setCrewSeatStartFromOrigin,
  setCrewSeatWorktree,
  crewModelSelection,
  crewReasoningDescriptor,
  crewSeatDraft,
  crewSeatStopsForApprovals,
  resolvedCrewSeatDraft,
  setCrewReasoning,
} from "./crewSeatRuntime";

const runtime: CrewProposalSeatRuntime = {
  workspace: { type: "shared" },
  seat: "reviewer",
  provider: "OpenAI",
  harness: "Codex",
  model: "GPT-6-Astra",
  reasoning: "High",
  access: "Full access",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex-work"),
    model: "gpt-6-astra",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ],
  },
  runtimeMode: "full-access",
};
const seat = {
  seat: "reviewer",
  agentId: null,
  reason: "Review the patch",
  instructions: "Focus on tests",
};
const model: ServerProviderModel = {
  slug: "other-model",
  name: "Other model",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "medium", label: "Medium" },
        ],
      },
    ],
  },
};

describe("crew member edits", () => {
  it("initializes edits from the resolved runtime and preserves unrelated settings", () => {
    const initialized = resolvedCrewSeatDraft(crewSeatDraft(seat), runtime);
    const edited = applyCrewSeatDraft(seat, {
      ...initialized,
      runtimeMode: "approval-required",
      instructions: "Review authentication",
    });
    expect(edited).toEqual({
      ...seat,
      instructions: "Review authentication",
      modelSelection: runtime.modelSelection,
      runtimeMode: "approval-required",
    });
    const refreshed = resolvedCrewSeatDraft(crewSeatDraft(edited), runtime);
    expect(refreshed.runtimeMode).toBe("approval-required");
  });

  it("keeps the saved persona and unrelated settings when editing its runtime", () => {
    const saved = { ...seat, agentId: "sentry" };
    const draft = resolvedCrewSeatDraft(crewSeatDraft(saved), runtime);
    expect(draft.runtimeMode).toBeUndefined();
    expect(applyCrewSeatDraft(saved, draft)).not.toHaveProperty("runtimeMode");
    expect(applyCrewSeatDraft(saved, { ...draft, runtimeMode: "approval-required" })).toEqual({
      ...saved,
      modelSelection: runtime.modelSelection,
      runtimeMode: "approval-required",
    });
  });

  it("clears custom overrides when selecting a saved persona or returning to custom", () => {
    const initialized = resolvedCrewSeatDraft(crewSeatDraft(seat), runtime);
    const persona = chooseCrewSeatPersona(initialized, "sentry");
    expect(applyCrewSeatDraft(seat, persona)).toEqual({ ...seat, agentId: "sentry" });
    expect(chooseCrewSeatPersona(persona, CUSTOM_AGENT)).toEqual(crewSeatDraft(seat));
  });

  it("resets model options to the newly chosen model's advertised defaults", () => {
    const selected = crewModelSelection(
      { instanceId: ProviderInstanceId.make("claude-work") },
      model,
    );
    expect(selected).toEqual({
      instanceId: "claude-work",
      model: "other-model",
      options: [{ id: "effort", value: "low" }],
    });
    const noOptions = crewModelSelection(
      { instanceId: ProviderInstanceId.make("codex-work") },
      { ...model, capabilities: null },
    );
    expect(noOptions).not.toHaveProperty("options");
  });

  it.each(["auto", "auto-accept-edits"] as const)(
    "switches unsupported ACP %s access to explicit Supervised",
    (runtimeMode) => {
      const draft = { ...crewSeatDraft(seat), runtimeMode };
      const acp = {
        instanceId: ProviderInstanceId.make("acp-work"),
        driver: ProviderDriverKind.make("acpRegistry"),
      };
      const next = chooseCrewHarness(draft, acp, model);
      expect(next.runtimeMode).toBe("approval-required");
      expect(next.modelSelection).toEqual(crewModelSelection(acp, model));
      expect(next.instructions).toBe(seat.instructions);
      expect(
        chooseCrewHarness(draft, { ...acp, driver: ProviderDriverKind.make("codex") }, model)
          .runtimeMode,
      ).toBe(runtimeMode);
    },
  );

  it("retains supported explicit access when switching to ACP", () => {
    const acp = {
      instanceId: ProviderInstanceId.make("acp-work"),
      driver: ProviderDriverKind.make("acpRegistry"),
    };
    expect(
      chooseCrewHarness({ ...crewSeatDraft(seat), runtimeMode: "full-access" }, acp, model)
        .runtimeMode,
    ).toBe("full-access");
    expect(
      chooseCrewHarness({ ...crewSeatDraft(seat), runtimeMode: "approval-required" }, acp, model)
        .runtimeMode,
    ).toBe("approval-required");
  });

  it("changes reasoning without discarding other model options", () => {
    const descriptor = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [{ id: "medium", label: "Medium" }],
    };
    expect(setCrewReasoning(runtime.modelSelection, descriptor, "medium").options).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "medium" },
    ]);
    expect(crewReasoningDescriptor(model)?.id).toBe("effort");
    expect(
      crewReasoningDescriptor({
        ...model,
        capabilities: {
          optionDescriptors: [
            { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
          ],
        },
      })?.id,
    ).toBe("thinking");
  });

  it("manual additions preserve the chosen runtime for custom and saved-persona members", () => {
    const draft = {
      ...resolvedCrewSeatDraft(crewSeatDraft(seat), runtime),
      seat: "Second Reviewer",
    };
    const added = addSeat([seat], draft);
    expect(added.error).toBeNull();
    expect(added.seats[1]).toEqual({
      ...seat,
      seat: "second-reviewer",
      reason: "Added by the user",
      modelSelection: runtime.modelSelection,
      runtimeMode: "full-access",
      workspace: { type: "shared" },
    });
    const saved = addSeat([seat], { ...draft, agentId: "sentry" });
    expect(saved.seats[1]?.modelSelection).toEqual(runtime.modelSelection);
    expect(saved.seats[1]?.runtimeMode).toBe("full-access");
  });
});

describe("crewSeatStopsForApprovals", () => {
  const custom = { agentId: null } as const;
  const persona = { agentId: "critic" } as const;
  it("flags custom seats and overridden personas whose access is short of Full access", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(crewSeatStopsForApprovals(custom, { runtimeMode })).toBe(true);
      expect(crewSeatStopsForApprovals({ ...persona, runtimeMode }, { runtimeMode })).toBe(true);
    }
    expect(crewSeatStopsForApprovals(custom, { runtimeMode: "full-access" })).toBe(false);
    expect(
      crewSeatStopsForApprovals(
        { ...persona, runtimeMode: "full-access" },
        { runtimeMode: "full-access" },
      ),
    ).toBe(false);
  });

  it("leaves persona defaults and unresolved runtimes quiet", () => {
    // A read-only persona resolves to approval-required with approvals disabled: it never asks.
    expect(crewSeatStopsForApprovals(persona, { runtimeMode: "approval-required" })).toBe(false);
    expect(crewSeatStopsForApprovals(custom, undefined)).toBe(false);
  });
});

describe("crew seat workspace", () => {
  const options = {
    currentBranch: "j5/main",
    cwd: "/repo",
    worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/login" }],
  };

  it("keeps a seat's workspace through a persona change and the save", () => {
    const proposed = {
      ...seat,
      workspace: { type: "worktree" as const, baseRef: "release", branch: "fix/login" },
    };
    const draft = chooseCrewSeatPersona(crewSeatDraft(proposed), "critic");
    expect(draft.workspace).toEqual(proposed.workspace);
    const saved = saveSeat([proposed], proposed.seat, draft);
    expect(saved.error).toBeNull();
    expect(saved.seats[0]?.workspace).toEqual(proposed.workspace);
    expect(applyCrewSeatDraft(proposed, draft).workspace).toEqual(proposed.workspace);
  });

  it("starts each choice from the Captain's repository and edits its details", () => {
    const draft = crewSeatDraft({ ...seat, workspace: { type: "shared" } });
    const worktree = chooseCrewSeatWorkspace(draft, "worktree", options);
    // A new worktree starts from the Captain's current branch, and its base can change.
    expect(worktree.workspace).toEqual({ type: "worktree", baseRef: "j5/main" });
    expect(setCrewSeatBaseRef(worktree, "release").workspace).toEqual({
      type: "worktree",
      baseRef: "release",
    });
    // Starting from origin is a separate choice that keeps the base.
    expect(setCrewSeatStartFromOrigin(worktree, true).workspace).toEqual({
      type: "worktree",
      baseRef: "j5/main",
      startFromOrigin: true,
    });
    expect(setCrewSeatStartFromOrigin(draft, true)).toBe(draft);
    const existing = chooseCrewSeatWorkspace(draft, "existing_worktree", options);
    expect(existing.workspace).toEqual({
      type: "existing_worktree",
      worktreePath: "/repo-worktrees/builder",
    });
    expect(setCrewSeatWorktree(existing, "/repo-worktrees/other").workspace).toEqual({
      type: "existing_worktree",
      worktreePath: "/repo-worktrees/other",
    });
    expect(chooseCrewSeatWorkspace(existing, "shared", options).workspace).toEqual({
      type: "shared",
    });
    const saved = saveSeat([seat], seat.seat, worktree);
    expect(saved.seats[0]?.workspace).toEqual({ type: "worktree", baseRef: "j5/main" });
  });

  it("starts a seat the person adds in the Captain's checkout", () => {
    const added = addSeat([], { seat: "reviewer", agentId: CUSTOM_AGENT, instructions: "Review" });
    expect(added.seats[0]?.workspace).toEqual({ type: "shared" });
  });

  it("drops a saved commit when the base or its origin choice is edited", () => {
    const baseCommit = "3f9c2ab1".repeat(5);
    const pinned = {
      seat: "builder",
      agentId: CUSTOM_AGENT,
      instructions: "Build",
      workspace: { type: "worktree" as const, baseRef: "main", baseCommit },
    };
    expect(setCrewSeatBaseRef(pinned, "release").workspace).toEqual({
      type: "worktree",
      baseRef: "release",
    });
    expect(setCrewSeatStartFromOrigin(pinned, true).workspace).toEqual({
      type: "worktree",
      baseRef: "main",
      startFromOrigin: true,
    });
  });

  it("describes each choice on the seat row", () => {
    expect(
      describeCrewSeatWorkspace({
        type: "worktree",
        baseRef: "main",
        baseCommit: "3f9c2ab1".repeat(5),
      }),
    ).toBe("New worktree from main @ 3f9c2ab1");
    expect(describeCrewSeatWorkspace({ type: "shared" })).toBe("Captain's checkout");
    expect(describeCrewSeatWorkspace({ type: "worktree", baseRef: "release" })).toBe(
      "New worktree from release",
    );
    expect(
      describeCrewSeatWorkspace({
        type: "existing_worktree",
        worktreePath: "/repo-worktrees/builder",
        branch: "fix/login",
      }),
    ).toBe("Existing worktree on fix/login");
  });
});
