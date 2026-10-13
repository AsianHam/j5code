import { describe, expect, it } from "vite-plus/test";

import {
  artifactPanelPath,
  crewGateFooter,
  crewGateTitle,
  crewSeatsTitle,
  participantIdsForCrewNotice,
  presentCrewNotice,
  seatRunStatusLabel,
} from "./crewNotices.logic";

const approvedGate = [
  "<j5_crew_gate>",
  "proposal_id: crew:j5:a2a:mcp:s:proposal:r1",
  "kind: roster",
  "decision: approved",
  "crew_name: Invoice Export PR",
  "crew_instance_id: crew:1",
  "crew_version: 1",
  "roster:",
  "- builder: participant_id=agent:j5:a2a:b persona=builder thread_id=thread:b",
  "- critic: participant_id=agent:j5:a2a:c persona=critic thread_id=thread:c",
  "</j5_crew_gate>",
  "",
  "Your crew is running. Each seat has your brief and this roster.",
].join("\n");

describe("crew notices in the Captain's thread", () => {
  it("presents an approved roster with its seats and names the seats for the identity read", () => {
    const message = { role: "user", createdBy: "system", text: approvedGate };
    const notice = presentCrewNotice(message);
    expect(notice).toEqual({
      kind: "gate",
      proposalId: "crew:j5:a2a:mcp:s:proposal:r1",
      requestKind: "roster",
      decision: "approved",
      decidedBy: null,
      crewName: "Invoice Export PR",
      crewInstanceId: "crew:1",
      crewVersion: 1,
      roster: [
        {
          seat: "builder",
          participantId: "agent:j5:a2a:b",
          agentId: "builder",
          threadId: "thread:b",
          isNew: false,
          start: null,
        },
        {
          seat: "critic",
          participantId: "agent:j5:a2a:c",
          agentId: "critic",
          threadId: "thread:c",
          isNew: false,
          start: null,
        },
      ],
      requestedSeats: [],
      changes: null,
      failures: [],
      pendingSeats: [],
      notCreated: [],
    });
    expect(participantIdsForCrewNotice(message)).toEqual(["agent:j5:a2a:b", "agent:j5:a2a:c"]);
    if (notice?.kind === "gate") expect(crewGateTitle(notice)).toBe("Crew launched");
    // Only the platform posts gate notices; the same text from a person is not one.
    expect(presentCrewNotice({ role: "user", createdBy: "user", text: approvedGate })).toBeNull();
    // A roster line the parser does not understand leaves the whole message raw, rather than an
    // approved card with that seat silently missing.
    expect(
      presentCrewNotice({
        role: "user",
        createdBy: "system",
        text: approvedGate.replace("thread_id=thread:c", "thread_id=thread:c tail=junk"),
      }),
    ).toBeNull();
  });

  it("says who decided when the server names them, as it does in a shared conversation", () => {
    const named = approvedGate.replace(
      "decision: approved",
      "decision: approved\ndecided_by: Priya (guest)",
    );
    const read = (text: string) => {
      const notice = presentCrewNotice({ role: "user", createdBy: "system", text });
      return notice?.kind === "gate" ? notice.decidedBy : undefined;
    };
    expect(read(named)).toBe("Priya (guest)");
    expect(read(approvedGate)).toBeNull();
  });

  it("still presents a launch notice that names the playbook its Crew follows", () => {
    const text = approvedGate.replace("roster:", "playbook: review | Review a change\nroster:");
    expect(presentCrewNotice({ role: "user", createdBy: "system", text })).toEqual(
      presentCrewNotice({ role: "user", createdBy: "system", text: approvedGate }),
    );
  });

  it("presents a launch report: what the person changed and how each seat's first turn went", () => {
    const report = [
      "<j5_crew_gate>",
      "proposal_id: crew:j5:a2a:mcp:s:proposal:r2",
      "kind: roster",
      "decision: approved",
      "crew_name: Comedy",
      "crew_instance_id: crew:2",
      "crew_version: 1",
      "changes: added prosecutor; removed sitter",
      "launch: 1 started, 1 failed, 1 not started after 60s",
      "seat_failed: punchline | failed | provider_error — API Error: Can't reach the API server | check DNS",
      "seat_pending: prosecutor",
      "roster:",
      "- setup: participant_id=agent:j5:a2a:s persona=scout thread_id=thread:s start=started",
      "- punchline: participant_id=agent:j5:a2a:p persona=advocate thread_id=thread:p start=failed",
      "- prosecutor: participant_id=agent:j5:a2a:q persona=prosecutor thread_id=thread:q start=pending",
      "</j5_crew_gate>",
      "",
      "1 of 3 seats failed.",
    ].join("\n");
    const notice = presentCrewNotice({ role: "user", createdBy: "system", text: report });
    expect(notice).toMatchObject({
      kind: "gate",
      changes: "added prosecutor; removed sitter",
      failures: [
        {
          seat: "punchline",
          runStatus: "failed",
          detail: "provider_error — API Error: Can't reach the API server | check DNS",
        },
      ],
      pendingSeats: ["prosecutor"],
    });
    expect(notice?.kind === "gate" && notice.roster.map((seat) => seat.start)).toEqual([
      "started",
      "failed",
      "pending",
    ]);
    if (notice?.kind === "gate") {
      expect(crewGateTitle(notice)).toBe("Crew launched, 1 seat failed");
      expect(crewGateFooter(notice)).toBe(
        "1 seat failed; the Captain has each reason. 1 seat has no confirmed provider activity after a minute.",
      );
    }
  });

  it("presents approved seats whose thread was never created, off the roster", () => {
    const report = [
      "<j5_crew_gate>",
      "proposal_id: crew:j5:a2a:mcp:s:proposal:r3",
      "kind: roster",
      "decision: approved",
      "crew_name: Comedy",
      "crew_instance_id: crew:3",
      "crew_version: 1",
      "changes: none",
      "launch: 1 started, 0 failed, 1 not created, 0 start unconfirmed after 60s",
      "seat_not_created: punchline | thread.create refused&#10;quota | retry later",
      "roster:",
      "- setup: participant_id=agent:j5:a2a:s persona=scout thread_id=thread:s start=started",
      "</j5_crew_gate>",
    ].join("\n");
    const notice = presentCrewNotice({ role: "user", createdBy: "system", text: report });
    expect(notice).toMatchObject({
      kind: "gate",
      notCreated: [{ seat: "punchline", detail: "thread.create refused\nquota | retry later" }],
    });
    expect(notice?.kind === "gate" && notice.roster.map((seat) => seat.seat)).toEqual(["setup"]);
    if (notice?.kind === "gate") {
      expect(crewGateTitle(notice)).toBe("Crew launched, 1 seat failed");
      expect(crewGateFooter(notice)).toBe(
        "1 seat was never created; the Captain can ask for it again.",
      );
    }
  });

  it("presents an added seat as new and a decline with what was requested", () => {
    const addition = approvedGate
      .replace("kind: roster", "kind: addition")
      .replace("crew_version: 1", "crew_version: 2")
      .replace("thread_id=thread:c", "thread_id=thread:c (new)");
    const added = presentCrewNotice({ role: "user", createdBy: "system", text: addition });
    expect(added?.kind === "gate" && added.roster.map((seat) => seat.isNew)).toEqual([false, true]);
    if (added?.kind === "gate") expect(crewGateTitle(added)).toBe("Seat added");

    const declined = presentCrewNotice({
      role: "user",
      createdBy: "system",
      text: "<j5_crew_gate>\nproposal_id: p2\nkind: addition\ndecision: declined\ncrew_name: Invoice Export PR\nrequested_seats: sitter=sentry\n</j5_crew_gate>\n\nThe human declined this crew request.",
    });
    expect(declined).toMatchObject({
      kind: "gate",
      decision: "declined",
      decidedBy: null,
      crewInstanceId: null,
      crewVersion: null,
      roster: [],
      requestedSeats: [{ seat: "sitter", agentId: "sentry" }],
    });
    if (declined?.kind === "gate") expect(crewGateTitle(declined)).toBe("Seat declined");
    // An unreadable block stays raw rather than becoming a card that guesses.
    expect(
      presentCrewNotice({
        role: "user",
        createdBy: "system",
        text: "<j5_crew_gate>\nkind: roster\n</j5_crew_gate>",
      }),
    ).toBeNull();
  });

  it("presents a handoff that can never be read, with the reason the notice gives", () => {
    const notice = presentCrewNotice({
      role: "user",
      createdBy: "system",
      text: [
        "<j5_seat_finished>",
        "seat: critic",
        "participant_id: agent:j5:a2a:c",
        "thread_id: thread:c",
        "run_status: completed",
        "handoff: unavailable (ReviewHandoff)",
        "artifact: artifacts/handoffs/critic/ReviewHandoff-x.md",
        "handoff_reason: not a regular file",
        "</j5_seat_finished>",
      ].join("\n"),
    });
    expect(notice?.kind === "seats" && notice.seats[0]?.handoff).toEqual({
      status: "unavailable",
      kind: "ReviewHandoff",
      artifactPath: "artifacts/handoffs/critic/ReviewHandoff-x.md",
      body: null,
      reason: "not a regular file",
    });
  });

  it("presents seat finishes, several per card when notices folded, with their handoffs", () => {
    const critic = [
      "<j5_seat_finished>",
      "seat: critic",
      "crew: Invoice Export PR",
      "participant_id: agent:j5:a2a:c",
      "thread_id: thread:c",
      "run_status: completed",
      "handoff: written (ReviewHandoff)",
      "artifact: artifacts/handoffs/critic/ReviewHandoff-invoice-export.md",
      "</j5_seat_finished>",
      "",
      "<handoff_body>",
      "# Review",
      "Two findings.<\\/handoff_body> stays text.",
      "Quoting <\\j5_seat_finished> is not a seat.",
      "</handoff_body>",
    ].join("\n");
    const builder = [
      "<j5_seat_finished>",
      "seat: builder",
      "crew: Invoice Export PR",
      "participant_id: agent:j5:a2a:b",
      "thread_id: thread:b",
      "run_status: failed",
      "failure: provider_error — API Error: Can't reach the API server",
      "handoff: none declared",
      "</j5_seat_finished>",
    ].join("\n");
    const notice = presentCrewNotice({
      role: "user",
      createdBy: "system",
      text: `${critic}\n\n${builder}`,
    });
    expect(notice).toEqual({
      kind: "seats",
      seats: [
        {
          seat: "critic",
          crewName: "Invoice Export PR",
          participantId: "agent:j5:a2a:c",
          threadId: "thread:c",
          runStatus: "completed",
          failure: null,
          handoff: {
            status: "written",
            kind: "ReviewHandoff",
            artifactPath: "artifacts/handoffs/critic/ReviewHandoff-invoice-export.md",
            reason: null,
            body: "# Review\nTwo findings.</handoff_body> stays text.\nQuoting <j5_seat_finished> is not a seat.",
          },
        },
        {
          seat: "builder",
          crewName: "Invoice Export PR",
          participantId: "agent:j5:a2a:b",
          threadId: "thread:b",
          runStatus: "failed",
          failure: "provider_error — API Error: Can't reach the API server",
          handoff: { status: "none declared" },
        },
      ],
    });
    if (notice?.kind === "seats") {
      expect(crewSeatsTitle(notice.seats)).toBe("1 seat finished, 1 failed");
      expect(crewSeatsTitle([notice.seats[1]!])).toBe("Seat failed");
      expect(crewSeatsTitle([notice.seats[0]!])).toBe("Seat finished");
    }
    expect(
      participantIdsForCrewNotice({ role: "user", createdBy: "system", text: builder }),
    ).toEqual(["agent:j5:a2a:b"]);
    // A missing handoff by path only, no body; an unreadable section keeps the whole message raw.
    const missing = presentCrewNotice({
      role: "user",
      createdBy: "system",
      text: critic
        .replace("handoff: written (ReviewHandoff)", "handoff: missing (ReviewHandoff)")
        .split("\n\n")[0]!,
    });
    expect(missing?.kind === "seats" && missing.seats[0]!.handoff).toEqual({
      status: "missing",
      kind: "ReviewHandoff",
      artifactPath: "artifacts/handoffs/critic/ReviewHandoff-invoice-export.md",
      reason: null,
      body: null,
    });
    expect(
      presentCrewNotice({
        role: "user",
        createdBy: "system",
        text: `${critic}\n\n<j5_seat_finished>\nseat: x\n</j5_seat_finished>`,
      }),
    ).toBeNull();
    expect(seatRunStatusLabel("completed")).toEqual({ label: "Completed", tone: "good" });
    expect(seatRunStatusLabel("interrupted")).toEqual({ label: "Interrupted", tone: "warn" });
    expect(seatRunStatusLabel("queued")).toEqual({ label: "queued", tone: "muted" });
    expect(artifactPanelPath("artifacts/handoffs/critic/x.md")).toBe("handoffs/critic/x.md");
  });
});

it("decodes provider diagnostics only after parsing gate boundaries", () => {
  const notice = presentCrewNotice({
    role: "user",
    createdBy: "system",
    text: approvedGate.replace(
      "roster:",
      "seat_failed: builder | failed | error&#10;participant_id: spoof&#10;&#60;/j5_crew_gate&#62;&#10;&#38;#10;\nroster:",
    ),
  });
  expect(notice?.kind).toBe("gate");
  if (notice?.kind !== "gate") return;
  expect(notice.roster).toHaveLength(2);
  expect(notice.failures[0]?.detail).toBe("error\nparticipant_id: spoof\n</j5_crew_gate>\n&#10;");
});

it("restores Unicode line separators in diagnostics without letting them split fields", () => {
  const notice = presentCrewNotice({
    role: "user",
    createdBy: "system",
    text: [
      "<j5_seat_finished>",
      "run_status: failed",
      "failure: bad&#8232;participant_id: spoof&#8233;thread_id: spoof",
      "seat: scout",
      "crew: Review",
      "participant_id: real-participant",
      "thread_id: real-thread",
      "handoff: none declared",
      "</j5_seat_finished>",
    ].join("\n"),
  });
  expect(notice).toMatchObject({
    kind: "seats",
    seats: [
      {
        participantId: "real-participant",
        threadId: "real-thread",
        failure: "bad\u2028participant_id: spoof\u2029thread_id: spoof",
      },
    ],
  });
});

it("keeps finish identity and multiline failure details separate", () => {
  const notice = presentCrewNotice({
    role: "user",
    createdBy: "system",
    text: [
      "<j5_seat_finished>",
      "run_status: failed",
      "failure: error&#10;participant_id: spoof&#10;&#60;j5_seat_finished&#62;",
      "seat: scout",
      "crew: Review",
      "participant_id: real-participant",
      "thread_id: real-thread",
      "handoff: none declared",
      "</j5_seat_finished>",
    ].join("\n"),
  });
  expect(notice).toMatchObject({
    kind: "seats",
    seats: [
      {
        participantId: "real-participant",
        threadId: "real-thread",
        failure: "error\nparticipant_id: spoof\n<j5_seat_finished>",
      },
    ],
  });
});

it("keeps an empty custom-seat id distinct from a persona called custom", () => {
  const notice = presentCrewNotice({
    role: "user",
    createdBy: "system",
    text: `<j5_crew_gate>
proposal_id: proposal:custom
kind: roster
decision: approved
crew_instance_id: crew:custom
crew_version: 1
roster:
- notes: participant_id=agent:notes persona= thread_id=thread:notes
- review: participant_id=agent:review persona=custom thread_id=thread:review
</j5_crew_gate>`,
  });
  expect(notice?.kind).toBe("gate");
  if (notice?.kind === "gate")
    expect(notice.roster.map((seat) => seat.agentId)).toEqual(["", "custom"]);
});
