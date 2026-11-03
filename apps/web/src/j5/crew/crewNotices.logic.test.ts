import { describe, expect, it } from "vite-plus/test";

import {
  crewApprovalSummary,
  crewDeclinedSummary,
  crewNoticeLines,
  presentCrewNotice,
} from "@t3tools/client-runtime/j5/crew-notices";

import { isHiddenCrewNotice, withoutHiddenCrewNotices } from "./crewNotices.logic";

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
  it("presents an approved roster with its compact approval summary", () => {
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
    expect(notice !== null && crewApprovalSummary(notice)).toBe("Crew approved · 2 members");
    expect(isHiddenCrewNotice(message)).toBe(false);
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
      "decision: approved\ndecided_by: Priya",
    );
    const read = (text: string) => {
      const notice = presentCrewNotice({ role: "user", createdBy: "system", text });
      return notice?.kind === "gate" ? notice.decidedBy : undefined;
    };
    expect(read(named)).toBe("Priya");
    expect(read(approvedGate)).toBeNull();
  });

  it("names the approver in the approval summary only when the notice carries one", () => {
    const summary = (text: string) => {
      const notice = presentCrewNotice({ role: "user", createdBy: "system", text });
      return notice === null ? null : crewApprovalSummary(notice);
    };
    expect(
      summary(approvedGate.replace("decision: approved", "decision: approved\ndecided_by: Priya")),
    ).toBe("Crew approved · 2 members · by Priya");
    expect(summary(approvedGate)).toBe("Crew approved · 2 members");
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
    // The started seat has no line; the failed one opens its thread, the unconfirmed one warns.
    expect(notice !== null && crewNoticeLines(notice)).toEqual([
      {
        seat: "punchline",
        crewName: null,
        threadId: "thread:p",
        reason: "couldn't start",
        detail: "provider_error — API Error: Can't reach the API server | check DNS",
        tone: "bad",
      },
      {
        seat: "prosecutor",
        crewName: null,
        threadId: "thread:q",
        reason: "hasn't confirmed it started",
        detail: null,
        tone: "warn",
      },
    ]);
    expect(isHiddenCrewNotice({ role: "user", createdBy: "system", text: report })).toBe(false);
    // A first turn that was interrupted is a launch outcome, told the same way as a failure.
    const interrupted = presentCrewNotice({
      role: "user",
      createdBy: "system",
      text: report.replace("punchline | failed |", "punchline | interrupted |"),
    });
    expect(interrupted !== null && crewNoticeLines(interrupted)[0]).toMatchObject({
      seat: "punchline",
      tone: "bad",
    });
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
    // A seat that was never created has no thread to open.
    expect(notice !== null && crewNoticeLines(notice)).toEqual([
      {
        seat: "punchline",
        crewName: null,
        threadId: null,
        reason: "was never created",
        detail: "thread.create refused\nquota | retry later",
        tone: "bad",
      },
    ]);
  });

  it("draws one line per seat that needs the person, for a mixed launch and a batch of failures", () => {
    const launch = [
      "<j5_crew_gate>",
      "proposal_id: crew:j5:a2a:mcp:s:proposal:r4",
      "kind: roster",
      "decision: approved",
      "crew_name: Comedy",
      "seat_failed: punchline | failed | provider_error",
      "seat_not_created: heckler | thread.create refused",
      "roster:",
      "- setup: participant_id=agent:j5:a2a:s persona=scout thread_id=thread:s start=started",
      "- punchline: participant_id=agent:j5:a2a:p persona=advocate thread_id=thread:p start=failed",
      "</j5_crew_gate>",
    ].join("\n");
    const launched = presentCrewNotice({ role: "user", createdBy: "system", text: launch });
    expect(
      launched !== null &&
        crewNoticeLines(launched).map(({ seat, threadId, tone }) => ({ seat, threadId, tone })),
    ).toEqual([
      { seat: "punchline", threadId: "thread:p", tone: "bad" },
      { seat: "heckler", threadId: null, tone: "bad" },
    ]);

    const finish = (seat: string, runStatus: string) =>
      [
        "<j5_seat_finished>",
        `seat: ${seat}`,
        `participant_id: agent:j5:a2a:${seat}`,
        `thread_id: thread:${seat}`,
        `run_status: ${runStatus}`,
        "failure: provider_error",
        "handoff: none declared",
        "</j5_seat_finished>",
      ].join("\n");
    const batch = presentCrewNotice({
      role: "user",
      createdBy: "system",
      text: [
        finish("builder", "failed"),
        finish("critic", "completed"),
        finish("sitter", "failed"),
      ].join("\n\n"),
    });
    expect(batch !== null && crewNoticeLines(batch).map((line) => line.threadId)).toEqual([
      "thread:builder",
      "thread:sitter",
    ]);
  });

  it("names the Crew only when one notice speaks for several", () => {
    const finish = (seat: string, crew: string) =>
      [
        "<j5_seat_finished>",
        `seat: ${seat}`,
        `crew: ${crew}`,
        `participant_id: agent:j5:a2a:${seat}-${crew}`,
        `thread_id: thread:${seat}-${crew}`,
        "run_status: failed",
        "failure: provider_error",
        "handoff: none declared",
        "</j5_seat_finished>",
      ].join("\n");
    const notice = (text: string) => presentCrewNotice({ role: "user", createdBy: "system", text });
    const oneCrew = notice(`${finish("builder", "Web")}\n\n${finish("critic", "Web")}`);
    expect(oneCrew !== null && crewNoticeLines(oneCrew).map((line) => line.crewName)).toEqual([
      null,
      null,
    ]);
    const twoCrews = notice(`${finish("builder", "Web")}\n\n${finish("builder", "Api")}`);
    expect(twoCrews !== null && crewNoticeLines(twoCrews).map((line) => line.crewName)).toEqual([
      "Web",
      "Api",
    ]);
  });

  it("keeps the rows a hidden notice bounded, dropping only that notice's row", () => {
    const row = (id: string, message: { role: string; createdBy: string; text: string }) => ({
      kind: "message",
      id,
      message,
    });
    const visible = [
      row("ask", { role: "user", createdBy: "user", text: "Ship it" }),
      { kind: "work", id: "w1" },
    ];
    // Nothing hidden: the same array comes back, so the list's identity check holds.
    expect(withoutHiddenCrewNotices(visible)).toBe(visible);
    const rows = [
      ...visible,
      row("launch", {
        role: "user",
        createdBy: "system",
        text: "<j5_seat_finished>\nseat: builder\nparticipant_id: agent:b\nthread_id: thread:b\nrun_status: completed\nhandoff: none declared\n</j5_seat_finished>",
      }),
      row("reply", { role: "assistant", createdBy: "agent", text: "Crew is running." }),
    ];
    const shown = withoutHiddenCrewNotices(rows);
    expect(shown.map((entry) => entry.id)).toEqual(["ask", "w1", "reply"]);
    // The same input gives the same output array.
    expect(withoutHiddenCrewNotices(rows)).toBe(shown);
  });

  it("presents an added seat as new and a decline with what was requested", () => {
    const addition = approvedGate
      .replace("kind: roster", "kind: addition")
      .replace("crew_version: 1", "crew_version: 2")
      .replace("thread_id=thread:c", "thread_id=thread:c (new)");
    const added = presentCrewNotice({ role: "user", createdBy: "system", text: addition });
    expect(added?.kind === "gate" && added.roster.map((seat) => seat.isNew)).toEqual([false, true]);
    expect(isHiddenCrewNotice({ role: "user", createdBy: "system", text: addition })).toBe(true);

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
    // A decline keeps its line: it has no seat lines, and is not hidden.
    if (declined?.kind === "gate") {
      expect(crewDeclinedSummary(declined)).toBe("Crew Invoice Export PR · seat declined");
      expect(crewNoticeLines(declined)).toEqual([]);
    }
    expect(
      isHiddenCrewNotice({
        role: "user",
        createdBy: "system",
        text: "<j5_crew_gate>\nproposal_id: p3\nkind: roster\ndecision: declined\n</j5_crew_gate>",
      }),
    ).toBe(false);
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
    expect(notice !== null && crewNoticeLines(notice)).toEqual([
      {
        seat: "critic",
        crewName: null,
        threadId: "thread:c",
        reason: "finished · ReviewHandoff can't be read",
        detail: "not a regular file",
        tone: "warn",
      },
    ]);
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
    // Folded finishes: the clean one has no line, the failed one carries its error.
    expect(notice !== null && crewNoticeLines(notice)).toEqual([
      {
        seat: "builder",
        crewName: null,
        threadId: "thread:b",
        reason: "run failed",
        detail: "provider_error — API Error: Can't reach the API server",
        tone: "bad",
      },
    ]);
    expect(isHiddenCrewNotice({ role: "user", createdBy: "system", text: critic })).toBe(true);
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
    expect(missing !== null && crewNoticeLines(missing)).toEqual([
      {
        seat: "critic",
        crewName: null,
        threadId: "thread:c",
        reason: "finished · ReviewHandoff missing",
        detail: null,
        tone: "warn",
      },
    ]);
    expect(
      presentCrewNotice({
        role: "user",
        createdBy: "system",
        text: `${critic}\n\n<j5_seat_finished>\nseat: x\n</j5_seat_finished>`,
      }),
    ).toBeNull();
    // A message that is not a Crew notice is never hidden.
    expect(isHiddenCrewNotice({ role: "user", createdBy: "user", text: critic })).toBe(false);
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

it("counts all approved members from old gate notices while retaining launch failures", () => {
  const message = {
    role: "user",
    createdBy: "system",
    text: approvedGate.replace(
      "roster:",
      "seat_not_created: tester | could not create thread\nseat_failed: builder | failed | signed out\nroster:",
    ),
  };
  const notice = presentCrewNotice(message);
  expect(notice).not.toBeNull();
  expect(crewApprovalSummary(notice!)).toBe("Crew approved · 3 members");
  expect(crewNoticeLines(notice!).map((line) => line.seat)).toEqual(["builder", "tester"]);
  expect(isHiddenCrewNotice(message)).toBe(false);
});

it("presents created waiting seats without claiming they started", () => {
  const text = approvedGate
    .replace("thread_id=thread:b", "thread_id=thread:b start=waiting")
    .replace("thread_id=thread:c", "thread_id=thread:c start=waiting");
  const notice = presentCrewNotice({ role: "user", createdBy: "system", text });
  expect(notice?.kind).toBe("gate");
  if (notice?.kind !== "gate") return;
  expect(notice.roster.map((seat) => seat.start)).toEqual(["waiting", "waiting"]);
  expect(crewApprovalSummary(notice)).toBe("Crew approved · 2 members");
  expect(crewNoticeLines(notice)).toEqual([]);
});
