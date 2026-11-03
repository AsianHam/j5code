import { describe, expect, it } from "vite-plus/test";

import {
  CUSTOM_AGENT,
  crewMemberInstructions,
  crewProposalRows,
  crewProposalRoster,
  crewProposalRowChange,
  newCrewProposalRow,
  addSeat,
  describeSeatAgent,
  removeSeat,
  saveSeat,
} from "./crewProposalDraft";

describe("crew proposal roster edits", () => {
  const seats = [
    { seat: "builder", agentId: "builder", reason: "Implements" },
    { seat: "critic", agentId: "critic", reason: "Reviews" },
  ];

  it("removes a seat by name and adds a normalized seat with the user's instructions", () => {
    expect(removeSeat(seats, "critic").map((seat) => seat.seat)).toEqual(["builder"]);
    const added = addSeat(seats, { seat: "Security Pass", agentId: "sentry", instructions: "  " });
    expect(added.error).toBeNull();
    expect(added.seats.at(-1)).toEqual({
      seat: "security-pass",
      agentId: "sentry",
      reason: "Added by the user",
      workspace: { type: "shared" },
    });
    const briefed = addSeat(seats, {
      seat: "eyes",
      agentId: "sentry",
      instructions: " Review only the auth module. ",
    });
    expect(briefed.seats.at(-1)?.instructions).toBe("Review only the auth module.");
  });

  it("names saved and custom seats without inferring runtime or access", () => {
    const rows = [
      { personaId: "critic", displayName: "Critic", authority: "Review only" },
      { personaId: "builder", displayName: "Builder", authority: "Workspace write" },
    ];
    expect(describeSeatAgent(rows, "builder")).toBe("Builder");
    expect(describeSeatAgent(rows, "ghost")).toBe("ghost");
    expect(describeSeatAgent(rows, null)).toBe("Custom crew member");
  });

  it("adds a custom seat with no persona behind it once it has instructions", () => {
    expect(
      addSeat(seats, { seat: "scribe", agentId: CUSTOM_AGENT, instructions: " " }).error,
    ).toContain("Give the custom crew member");
    const custom = addSeat(seats, {
      seat: "scribe",
      agentId: CUSTOM_AGENT,
      instructions: "Keep the running notes.",
    });
    expect(custom.error).toBeNull();
    expect(custom.seats.at(-1)).toEqual({
      seat: "scribe",
      agentId: null,
      reason: "Added by the user",
      instructions: "Keep the running notes.",
      workspace: { type: "shared" },
    });
  });

  it("rejects duplicate or malformed seat names and a missing persona", () => {
    expect(addSeat(seats, { seat: "builder", agentId: "scout", instructions: "" }).error).toContain(
      "already exists",
    );
    expect(addSeat(seats, { seat: "9lives", agentId: "scout", instructions: "" }).error).toContain(
      "lowercase",
    );
    expect(addSeat(seats, { seat: "eyes", agentId: "", instructions: "" }).error).toContain(
      "Pick a persona",
    );
  });
});

describe("crew member edits", () => {
  const original = {
    seat: "reviewer",
    agentId: null,
    reason: "Independent review requested by the Captain",
    instructions: "Review the patch",
  };
  const seats = [original, { seat: "builder", agentId: "builder", reason: "Implement" }];

  it("validates custom instructions without changing the existing roster", () => {
    const result = saveSeat(seats, "reviewer", {
      seat: "reviewer",
      agentId: CUSTOM_AGENT,
      instructions: "  ",
    });
    expect(result.error).toContain("instructions");
    expect(result.seats).toBe(seats);
    expect(original.instructions).toBe("Review the patch");
  });

  it("rejects a persona member whose replacement text was cleared", () => {
    const result = saveSeat(seats, "builder", {
      seat: "builder",
      agentId: "builder",
      instructions: "",
      personaInstructions: "  ",
    });
    expect(result.error).toContain("can't be empty");
    expect(result.seats).toBe(seats);
  });

  it("saves a validated edit in place and preserves the Captain's reason when renaming", () => {
    const result = saveSeat(seats, "reviewer", {
      seat: "renamed",
      agentId: CUSTOM_AGENT,
      instructions: "  Review authentication only  ",
      runtimeMode: "approval-required",
    });
    expect(result.error).toBeNull();
    expect(result.seats).toEqual([
      {
        ...original,
        seat: "renamed",
        instructions: "Review authentication only",
        runtimeMode: "approval-required",
      },
      seats[1],
    ]);
    expect(result.seats[1]).toBe(seats[1]);
    expect(original.instructions).toBe("Review the patch");
  });

  it("keeps the steps a seat owns when the person edits it", () => {
    const owning = [
      { seat: "lead", agentId: null, reason: "Plans", instructions: "Plan.", steps: ["plan"] },
    ];
    const edited = saveSeat(owning, "lead", {
      seat: "lead",
      agentId: CUSTOM_AGENT,
      instructions: "Plan carefully.",
    });
    expect(edited.error).toBeNull();
    expect(edited.seats[0]).toEqual({
      seat: "lead",
      agentId: null,
      reason: "Plans",
      instructions: "Plan carefully.",
      steps: ["plan"],
    });
  });
});

describe("inline roster drafts", () => {
  const original = {
    seat: "builder",
    agentId: null,
    reason: "Build",
    instructions: "Implement",
    steps: ["build"],
  };
  it("marks actual edits and clears the tag when the original values return", () => {
    const row = crewProposalRows([original])[0]!;
    expect(crewProposalRowChange(row)).toBeNull();
    const edited = { ...row, value: { ...row.value, instructions: "Implement carefully" } };
    expect(crewProposalRowChange(edited)).toBe("Edited");
    expect(crewProposalRowChange({ ...edited, value: row.value })).toBeNull();
    expect(crewProposalRoster([edited]).seats[0]).toEqual({
      ...original,
      instructions: "Implement carefully",
    });
  });
  it("retains an unfinished custom addition, validates it, and restores the roster when removed", () => {
    const rows = crewProposalRows([original]);
    const added = newCrewProposalRow("added:0");
    expect(crewProposalRowChange(added)).toBe("Added");
    expect(crewProposalRoster([...rows, added]).errors.has(added.id)).toBe(true);
    const named = { ...added, value: { ...added.value, seat: "Reviewer" } };
    expect(crewProposalRoster([...rows, named]).errors.get(added.id)).toContain("instructions");
    const complete = { ...named, value: { ...named.value, instructions: "Review" } };
    expect(crewProposalRoster([...rows, complete]).errors.size).toBe(0);
    expect(crewProposalRoster([...rows, complete]).seats[1]).toEqual({
      seat: "reviewer",
      agentId: null,
      reason: "Added by the user",
      instructions: "Review",
      workspace: { type: "shared" },
    });
    expect(
      crewProposalRoster([...rows, complete].filter((row) => row.id !== added.id)).seats,
    ).toEqual([original]);
  });
  it("flags duplicate normalized names on both rows", () => {
    const added = newCrewProposalRow("added:0");
    const duplicate = {
      ...added,
      value: { ...added.value, seat: "Builder", instructions: "Help" },
    };
    const roster = crewProposalRoster([...crewProposalRows([original]), duplicate]);
    expect([...roster.errors.keys()]).toEqual(["builder", "added:0"]);
  });
});

it("keeps useful validation for multiple unnamed additions", () => {
  const result = crewProposalRoster([newCrewProposalRow("new:1"), newCrewProposalRow("new:2")]);
  expect([...result.errors.values()]).toEqual([
    "Seat names are lowercase words joined by hyphens.",
    "Seat names are lowercase words joined by hyphens.",
  ]);
});

it("saves a persona member's box as a replacement only when it was edited", () => {
  const persona = "Review independently.";
  const seeded = { text: `${persona}\n\nCheck auth.`, instructions: "Check auth." };
  // Left as seeded, the seat keeps exactly what it had.
  expect(crewMemberInstructions(seeded.text, persona, seeded)).toEqual({
    instructions: "Check auth.",
  });
  // Back at the persona's own text, nothing is sent.
  expect(crewMemberInstructions(persona, persona, seeded)).toEqual({ instructions: "" });
  // Any other text replaces the persona's instructions; the extra ones it held are not sent twice.
  expect(crewMemberInstructions(`${persona} Also test.`, persona, seeded)).toEqual({
    instructions: "",
    personaInstructions: `${persona} Also test.`,
  });
  expect(crewMemberInstructions("Only read the docs.", persona, seeded)).toEqual({
    instructions: "",
    personaInstructions: "Only read the docs.",
  });
  expect(crewMemberInstructions("Custom instructions", null, null)).toEqual({
    instructions: "Custom instructions",
  });
});
