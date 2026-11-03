import type { CrewProposalSeat } from "@t3tools/contracts/j5";
import { applyCrewSeatDraft, crewSeatDraft, type CrewSeatDraft } from "./crewSeatRuntime";

/** The persona choice for a seat that runs without a persona: named and briefed on the card. */
export const CUSTOM_AGENT = "__custom__";

/** Pure roster edits so the card's behavior is testable without rendering. */
export const removeSeat = (seats: ReadonlyArray<CrewProposalSeat>, seatName: string) =>
  seats.filter((seat) => seat.seat !== seatName);

export const addSeat = (
  seats: ReadonlyArray<CrewProposalSeat>,
  draft: CrewSeatDraft,
): { readonly seats: ReadonlyArray<CrewProposalSeat>; readonly error: string | null } => {
  const seatName = draft.seat.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(seatName))
    return { seats, error: "Seat names are lowercase words joined by hyphens." };
  if (seats.some((seat) => seat.seat === seatName))
    return { seats, error: `Seat ${seatName} already exists.` };
  if (draft.agentId.length === 0)
    return { seats, error: "Pick a persona for the seat, or Custom crew member." };
  const custom = draft.agentId === CUSTOM_AGENT;
  const instructions = draft.instructions.trim();
  const personaInstructions = draft.personaInstructions?.trim();
  // A custom seat has no persona; its instructions are all it will know beyond the brief.
  if (custom && instructions.length === 0)
    return { seats, error: "Give the custom crew member its instructions." };
  // A replacement is stored as non-empty text, so a cleared box would silently fall back to the persona's own.
  if (!custom && personaInstructions === "")
    return {
      seats,
      error:
        "Member instructions can't be empty. Use Reset to persona text to go back to the persona's own.",
    };
  return {
    seats: [
      ...seats,
      {
        seat: seatName,
        agentId: custom ? null : draft.agentId,
        reason: "Added by the user",
        ...(instructions ? { instructions } : {}),
        ...(!custom && personaInstructions ? { personaInstructions } : {}),
        ...(draft.modelSelection ? { modelSelection: draft.modelSelection } : {}),
        ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
        // A seat the person adds starts in the Captain's checkout until they choose otherwise.
        workspace: draft.workspace ?? { type: "shared" },
      },
    ],
    error: null,
  };
};

/** Validate an edit without mutating the current roster or the Captain's reason. */
export const saveSeat = (
  seats: ReadonlyArray<CrewProposalSeat>,
  seatName: string,
  draft: CrewSeatDraft,
): { readonly seats: ReadonlyArray<CrewProposalSeat>; readonly error: string | null } => {
  const current = seats.find((seat) => seat.seat === seatName);
  if (!current) return { seats, error: "This seat is no longer in the roster." };
  const validated = addSeat(removeSeat(seats, seatName), draft);
  if (validated.error !== null) return { seats, error: validated.error };
  // The card cannot reassign playbook steps, so an edited seat keeps the ones it owns.
  // An edit keeps the seat's own workspace, or its lack of one; only a new seat defaults.
  const { workspace: _defaulted, ...edited } = validated.seats[validated.seats.length - 1]!;
  const updated = {
    ...edited,
    ...(draft.workspace === undefined ? {} : { workspace: draft.workspace }),
    reason: current.reason,
    ...(current.personaSwaps === undefined ? {} : { personaSwaps: current.personaSwaps }),
    ...(current.steps === undefined ? {} : { steps: current.steps }),
  };
  return {
    seats: seats.map((seat) => (seat.seat === seatName ? updated : seat)),
    error: null,
  };
};

/** Names are catalog metadata; runtime and access are disclosed only by the server preview. */
export const describeSeatAgent = (
  rows: ReadonlyArray<{
    readonly personaId: string;
    readonly displayName: string;
  }>,
  agentId: string | null,
): string => {
  if (agentId === null) return "Custom crew member";
  const row = rows.find((candidate) => candidate.personaId === agentId);
  return row?.displayName ?? agentId;
};

export interface CrewProposalRow {
  readonly id: string;
  readonly original: CrewProposalSeat | null;
  readonly value: CrewSeatDraft;
}

export const crewProposalRows = (
  seats: ReadonlyArray<CrewProposalSeat>,
): ReadonlyArray<CrewProposalRow> =>
  seats.map((seat) => ({ id: seat.seat, original: seat, value: crewSeatDraft(seat) }));

export const newCrewProposalRow = (id: string): CrewProposalRow => ({
  id,
  original: null,
  value: { seat: "", agentId: CUSTOM_AGENT, instructions: "", workspace: { type: "shared" } },
});

/** Incomplete rows stay in the draft, but never authorize a preview or a launch. */
export const crewProposalRoster = (rows: ReadonlyArray<CrewProposalRow>) => {
  const errors = new Map<string, string>();
  const seats = rows.map((row) => {
    const result =
      row.original === null
        ? addSeat([], row.value)
        : saveSeat([row.original], row.original.seat, row.value);
    if (result.error !== null) errors.set(row.id, result.error);
    return result.error === null
      ? result.seats[0]!
      : applyCrewSeatDraft(
          row.original ?? { seat: row.value.seat, agentId: null, reason: "Added by the user" },
          row.value,
        );
  });
  for (let i = 0; i < seats.length; i++) {
    if (
      !errors.has(rows[i]!.id) &&
      seats[i]!.seat.length > 0 &&
      seats.some((seat, j) => i !== j && seat.seat === seats[i]!.seat)
    )
      errors.set(rows[i]!.id, `Seat ${seats[i]!.seat} already exists.`);
  }
  return { seats, errors };
};

const comparableDraft = (draft: CrewSeatDraft) =>
  JSON.stringify([
    draft.seat,
    draft.agentId,
    draft.instructions.trim(),
    draft.personaInstructions?.trim() ?? null,
    draft.modelSelection === undefined
      ? null
      : [
          draft.modelSelection.instanceId,
          draft.modelSelection.model,
          [...(draft.modelSelection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
        ],
    draft.runtimeMode ?? null,
    draft.workspace === undefined
      ? null
      : draft.workspace.type === "shared"
        ? ["shared"]
        : draft.workspace.type === "worktree"
          ? [
              "worktree",
              draft.workspace.baseRef,
              draft.workspace.baseCommit ?? null,
              draft.workspace.startFromOrigin ?? false,
            ]
          : ["existing_worktree", draft.workspace.worktreePath],
  ]);

export const crewProposalRowChange = (row: CrewProposalRow): "Added" | "Edited" | null =>
  row.original === null
    ? "Added"
    : comparableDraft(row.value) === comparableDraft(crewSeatDraft(row.original))
      ? null
      : "Edited";

/**
 * What the instructions box saves as. A persona member's box holds the persona's whole text, so an
 * edit replaces the persona's instructions and drops the extra ones the box already contained;
 * a box left as seeded keeps exactly what the seat had, and a box reset to the persona's text
 * sends nothing.
 */
export const crewMemberInstructions = (
  box: string,
  persona: string | null,
  seed: {
    readonly text: string;
    readonly instructions: string;
    readonly personaInstructions?: string | undefined;
  } | null,
): { readonly instructions: string; readonly personaInstructions?: string } => {
  if (persona === null) return { instructions: box };
  const text = box.trim();
  if (text === persona.trim()) return { instructions: "" };
  if (seed !== null && text === seed.text.trim())
    return {
      instructions: seed.instructions,
      ...(seed.personaInstructions === undefined
        ? {}
        : { personaInstructions: seed.personaInstructions }),
    };
  return { instructions: "", personaInstructions: text };
};
