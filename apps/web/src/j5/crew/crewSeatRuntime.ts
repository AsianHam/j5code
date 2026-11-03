import type {
  ModelSelection,
  ProviderOptionDescriptor,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { isAgentPersonaReasoningOptionId } from "@t3tools/contracts";
import type {
  CrewProposalSeat,
  CrewProposalSeatRuntime,
  CrewSeatWorkspace,
  CrewWorkspaceOptions,
} from "@t3tools/contracts/j5";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";

import { CUSTOM_AGENT } from "./crewProposalDraft";

export interface CrewSeatDraft {
  readonly seat: string;
  readonly agentId: string;
  readonly instructions: string;
  /** The persona's whole text as edited on the card, run instead of the persona's own. */
  readonly personaInstructions?: string;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly workspace?: CrewSeatWorkspace;
}

export const CREW_ACCESS_OPTIONS = [
  {
    value: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
] as const;

/**
 * Whether a seat will pause for the person's approval in its own thread: any resolved access short
 * of Full access. A saved persona on its own default policy is the exception; its sandbox refuses
 * what it may not do instead of asking. A seat whose runtime has not resolved yet is not counted.
 */
export const crewSeatStopsForApprovals = (
  seat: Pick<CrewProposalSeat, "agentId" | "runtimeMode">,
  runtime: Pick<CrewProposalSeatRuntime, "runtimeMode"> | undefined,
): boolean =>
  runtime !== undefined &&
  runtime.runtimeMode !== "full-access" &&
  (seat.agentId === null || seat.runtimeMode !== undefined);

export const crewSeatDraft = (seat: CrewProposalSeat): CrewSeatDraft => ({
  seat: seat.seat,
  agentId: seat.agentId ?? CUSTOM_AGENT,
  instructions: seat.instructions ?? "",
  ...(seat.personaInstructions === undefined
    ? {}
    : { personaInstructions: seat.personaInstructions }),
  ...(seat.modelSelection === undefined ? {} : { modelSelection: seat.modelSelection }),
  ...(seat.runtimeMode === undefined ? {} : { runtimeMode: seat.runtimeMode }),
  ...(seat.workspace === undefined ? {} : { workspace: seat.workspace }),
});

/** Freeze the resolved runtime before changing one field, so unrelated settings stay put. */
export const resolvedCrewSeatDraft = (
  draft: CrewSeatDraft,
  runtime?: CrewProposalSeatRuntime,
): CrewSeatDraft => {
  const modelSelection = draft.modelSelection ?? runtime?.modelSelection;
  const runtimeMode =
    draft.runtimeMode ?? (draft.agentId === CUSTOM_AGENT ? runtime?.runtimeMode : undefined);
  return {
    ...draft,
    ...(modelSelection ? { modelSelection } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
  };
};

/**
 * A newly selected persona starts from its own runtime defaults; those overrides belong to the
 * previous member. Where the seat works is about the seat, so it stays.
 */
export const chooseCrewSeatPersona = (draft: CrewSeatDraft, agentId: string): CrewSeatDraft => ({
  seat: draft.seat,
  instructions: draft.instructions,
  agentId,
  ...(draft.workspace === undefined ? {} : { workspace: draft.workspace }),
});

export const CREW_WORKSPACE_OPTIONS = [
  { value: "shared", label: "Captain's checkout" },
  { value: "worktree", label: "New worktree" },
  { value: "existing_worktree", label: "Existing worktree" },
] as const;

/**
 * A new type starts from what the Captain's repository offers: a new worktree from the Captain's
 * current branch, an existing worktree at the first one listed. The server checks both again.
 */
export const chooseCrewSeatWorkspace = (
  draft: CrewSeatDraft,
  type: CrewSeatWorkspace["type"],
  options: CrewWorkspaceOptions | undefined,
): CrewSeatDraft => ({
  ...draft,
  workspace:
    type === "shared"
      ? { type }
      : type === "worktree"
        ? { type, baseRef: options?.currentBranch ?? "" }
        : { type, worktreePath: options?.worktrees[0]?.path ?? "" },
});

/**
 * A new worktree's base branch; other fields of the choice stay as they were. The saved commit is
 * dropped: an edited base is resolved again, and the new commit shown, before it can be approved.
 */
export const setCrewSeatBaseRef = (draft: CrewSeatDraft, baseRef: string): CrewSeatDraft => {
  const { baseCommit: _pin, ...kept } = draft.workspace?.type === "worktree" ? draft.workspace : {};
  return { ...draft, workspace: { ...kept, type: "worktree", baseRef } };
};

/** Whether a new worktree starts from the fetched origin copy of its base branch. */
export const setCrewSeatStartFromOrigin = (
  draft: CrewSeatDraft,
  startFromOrigin: boolean,
): CrewSeatDraft => {
  if (draft.workspace?.type !== "worktree") return draft;
  const { baseCommit: _pin, ...kept } = draft.workspace;
  return { ...draft, workspace: { ...kept, startFromOrigin } };
};

export const setCrewSeatWorktree = (draft: CrewSeatDraft, worktreePath: string): CrewSeatDraft => ({
  ...draft,
  workspace: { type: "existing_worktree", worktreePath },
});

export const describeCrewSeatWorkspace = (workspace: CrewSeatWorkspace): string =>
  workspace.type === "shared"
    ? "Captain's checkout"
    : workspace.type === "worktree"
      ? `New worktree from ${workspace.baseRef}${workspace.baseCommit === undefined ? "" : ` @ ${workspace.baseCommit.slice(0, 8)}`}`
      : `Existing worktree on ${workspace.branch ?? workspace.worktreePath}`;

/** A different model starts with its own advertised defaults, never options from another model. */
export const crewModelSelection = (
  provider: Pick<ServerProvider, "instanceId">,
  model: ServerProviderModel,
): ModelSelection => {
  const options = buildProviderOptionSelectionsFromDescriptors(
    model.capabilities?.optionDescriptors,
  );
  return { instanceId: provider.instanceId, model: model.slug, ...(options ? { options } : {}) };
};

/** ACP cannot enforce Auto or Auto-accept edits; a harness switch visibly chooses its supervised mode. */
export const chooseCrewHarness = (
  draft: CrewSeatDraft,
  provider: Pick<ServerProvider, "instanceId" | "driver">,
  model: ServerProviderModel,
): CrewSeatDraft => ({
  ...draft,
  modelSelection: crewModelSelection(provider, model),
  ...(provider.driver === "acpRegistry" &&
  (draft.runtimeMode === "auto" || draft.runtimeMode === "auto-accept-edits")
    ? { runtimeMode: "approval-required" }
    : {}),
});

export const crewReasoningDescriptor = (
  model: ServerProviderModel | undefined,
): ProviderOptionDescriptor | undefined =>
  model?.capabilities?.optionDescriptors?.find(({ id }) => isAgentPersonaReasoningOptionId(id));

export const setCrewReasoning = (
  selection: ModelSelection,
  descriptor: ProviderOptionDescriptor,
  value: string | boolean,
): ModelSelection => ({
  ...selection,
  options: [
    ...(selection.options ?? []).filter(({ id }) => id !== descriptor.id),
    { id: descriptor.id, value },
  ],
});

export const applyCrewSeatDraft = (
  seat: CrewProposalSeat,
  draft: CrewSeatDraft,
): CrewProposalSeat => ({
  seat: seat.seat,
  reason: seat.reason,
  agentId: draft.agentId === CUSTOM_AGENT ? null : draft.agentId,
  ...(draft.instructions ? { instructions: draft.instructions } : {}),
  ...(draft.personaInstructions ? { personaInstructions: draft.personaInstructions } : {}),
  ...(draft.modelSelection ? { modelSelection: draft.modelSelection } : {}),
  ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
  ...(draft.workspace ? { workspace: draft.workspace } : {}),
  ...(seat.steps === undefined ? {} : { steps: seat.steps }),
});
