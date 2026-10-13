import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import type { CrewProposal } from "./AgentCrewProposalService.ts";
import { crewLaunchReportText, crewRosterChanges } from "./crewGateNotice.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const seat = (name: string, agentId: string, reason = `${name} does its part`) => ({
  workspace: { type: "shared" as const },
  seat: name,
  agentId,
  reason,
});

describe("crew roster changes", () => {
  it("names what the person added, removed, and renamed against the proposal", () => {
    const changes = crewRosterChanges(
      [seat("builder", "builder"), seat("critic", "critic", "Reviews"), seat("sitter", "sentry")],
      [
        seat("builder", "builder"),
        seat("reviewer", "critic", "Reviews"),
        seat("sentry", "sentry", "Security"),
      ],
    );
    assert.deepStrictEqual(changes, {
      added: ["sentry"],
      removed: ["sitter"],
      renamed: [{ from: "critic", to: "reviewer" }],
      runtimeChanged: [],
      instructionsChanged: [],
    });
    assert.deepStrictEqual(
      crewRosterChanges(
        [seat("reviewer", "scout", "Reviews")],
        [seat("reviewer", "critic", "Reviews")],
      ).runtimeChanged,
      ["reviewer"],
    );
    assert.deepStrictEqual(crewRosterChanges([seat("a", "x")], [seat("a", "x")]), {
      added: [],
      removed: [],
      renamed: [],
      runtimeChanged: [],
      instructionsChanged: [],
    });
  });

  it("compares runtime options semantically and reports saved instruction edits across renames", () => {
    const requested = {
      ...seat("reviewer", "custom"),
      instructions: "Review",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-astra",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
      runtimeMode: "approval-required" as const,
    };
    const reordered = {
      ...requested,
      modelSelection: {
        ...requested.modelSelection,
        options: requested.modelSelection.options.toReversed(),
      },
    };
    assert.deepStrictEqual(crewRosterChanges([requested], [reordered]).runtimeChanged, []);
    const renamed = crewRosterChanges(
      [requested],
      [{ ...reordered, seat: "critic", instructions: "Review tests" }],
    );
    assert.deepStrictEqual(renamed.runtimeChanged, []);
    assert.deepStrictEqual(renamed.instructionsChanged, ["critic"]);
    assert.deepStrictEqual(renamed.renamed, [{ from: "reviewer", to: "critic" }]);
    assert.deepStrictEqual(
      crewRosterChanges([requested], [{ ...requested, runtimeMode: "full-access" }]).runtimeChanged,
      ["reviewer"],
    );
  });
});

describe("crew launch report", () => {
  const proposal: CrewProposal = {
    id: "proposal:1",
    projectId: LedgerProjectId.make("project:1"),
    captainParticipantId: ParticipantId.make("agent:captain"),
    captainThreadId: ThreadId.make("thread:captain"),
    crewInstanceId: "crew:1",
    kind: "roster",
    status: "approved",
    brief: "Tell two jokes.",
    displayName: "Comedy",
    requestedSeats: [seat("setup", "scout"), seat("punchline", "advocate")],
    approvedSeats: [
      seat("setup", "scout"),
      seat("punchline", "advocate"),
      seat("prosecutor", "prosecutor"),
    ],
    createdAt: "2026-09-17T20:00:00.000Z",
    resolvedAt: "2026-09-17T20:01:00.000Z",
    reportedAt: null,
  };
  const member = (name: string, agentId: string) => ({
    workspace: { type: "shared" as const },
    seatName: name,
    agentId,
    participantId: ParticipantId.make(`agent:${name}`),
    threadId: ThreadId.make(`thread:${name}`),
    addedVersion: 1,
    reason: null,
  });
  const instance = {
    id: "crew:1",
    projectId: LedgerProjectId.make("project:1"),
    captainParticipantId: ParticipantId.make("agent:captain"),
    captainThreadId: ThreadId.make("thread:captain"),
    displayName: "Comedy",
    brief: "Tell two jokes.",
    version: 1,
    createdAt: "2026-09-17T20:01:00.000Z",
    archivedAt: null,
    members: [
      member("setup", "scout"),
      member("punchline", "advocate"),
      member("prosecutor", "prosecutor"),
    ],
  } as unknown as AgentCrewInstance;

  it("names the playbook before the roster and tells the Captain how to start it", () => {
    const text = crewLaunchReportText({
      proposal,
      instance,
      verdicts: new Map(),
      windowMs: 60_000,
      playbook: { name: "review", title: "Review <a> change" },
    });
    assert.include(text, "playbook: review | Review &#60;a&#62; change\nroster:\n");
    assert.include(
      text,
      `Start it with j5_playbook_start(name: "review", client_request_id, crew_instance_id: "${instance.id}").`,
    );
    const plain = crewLaunchReportText({
      proposal,
      instance,
      verdicts: new Map(),
      windowMs: 60_000,
    });
    assert.notInclude(plain, "playbook");
  });

  it("distinguishes a custom seat from a saved agent named custom", () => {
    const text = crewLaunchReportText({
      proposal,
      instance: {
        ...instance,
        members: [
          { ...instance.members[0]!, agentId: null },
          { ...instance.members[1]!, agentId: "custom" },
        ],
      },
      verdicts: new Map(),
      windowMs: 60_000,
    });
    assert.include(text, "persona= thread_id=thread:setup");
    assert.include(text, "persona=custom thread_id=thread:punchline");
  });

  it("says per seat what became of its first turn, and what the person changed", () => {
    const text = crewLaunchReportText({
      proposal,
      instance,
      verdicts: new Map([
        ["setup", { kind: "started" }],
        [
          "punchline",
          {
            kind: "failed",
            runStatus: "failed",
            runId: "run:failed",
            failure: {
              class: "provider_error",
              message: "API Error: Can't reach the API server",
              code: "sdk_result_error",
              retryable: null,
            },
          },
        ],
        ["prosecutor", { kind: "pending" }],
      ]),
      windowMs: 60_000,
    });
    assert.include(text, "decision: approved");
    assert.include(text, "changes: added prosecutor");
    assert.include(
      text,
      "launch: 1 started, 1 failed, 0 not created, 1 start unconfirmed after 60s",
    );
    assert.include(
      text,
      "seat_failed: punchline | failed | provider_error — API Error: Can't reach the API server",
    );
    assert.include(text, "seat_pending: prosecutor");
    assert.include(
      text,
      "- setup: participant_id=agent:setup persona=scout thread_id=thread:setup start=started",
    );
    assert.include(text, "thread_id=thread:punchline start=failed");
    assert.include(text, "thread_id=thread:prosecutor start=pending");
    assert.include(text, "1 of 3 seats failed");
    assert.include(text, "1 seat has no confirmed provider activity after 60s");
    assert.notInclude(text, "Your crew is running");
  });

  it("names seats that never got a thread or never got their brief", () => {
    const text = crewLaunchReportText({
      proposal,
      instance: { ...instance, members: instance.members.slice(0, 2) } as AgentCrewInstance,
      verdicts: new Map([
        ["setup", { kind: "started" }],
        ["punchline", { kind: "not_started", detail: "brief failed\nretry later" }],
        ["prosecutor", { kind: "not_created", detail: "its thread was never created" }],
      ]),
      windowMs: 60_000,
    });
    assert.include(
      text,
      "launch: 1 started, 1 failed, 1 not created, 0 start unconfirmed after 60s",
    );
    assert.include(text, "seat_failed: punchline | not_started | brief failed&#10;retry later");
    assert.include(text, "thread_id=thread:punchline start=failed");
    assert.include(text, "seat_not_created: prosecutor | its thread was never created");
    assert.notInclude(text, "thread_id=thread:prosecutor");
    assert.include(text, "j5_request_crew_member");
    assert.notInclude(text, "Your crew is running");
  });

  it("tells the Captain when the human pins a custom seat to a different runtime", () => {
    const requested = {
      workspace: { type: "shared" as const },
      seat: "reviewer",
      agentId: null,
      reason: "Reviews",
      instructions: "Review changes",
    };
    const approved = {
      ...requested,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet",
        options: [{ id: "effort", value: "high" }],
      },
      runtimeMode: "approval-required" as const,
      instructions: "Review tests first",
    };
    const text = crewLaunchReportText({
      proposal: { ...proposal, requestedSeats: [requested], approvedSeats: [approved] },
      instance: { ...instance, members: [{ ...member("reviewer", "custom"), agentId: null }] },
      verdicts: new Map([["reviewer", { kind: "started" }]]),
      windowMs: 60_000,
    });
    assert.include(text, "changes: runtime changed: reviewer; instructions changed: reviewer");
    assert.notInclude(text, "changes: none");
    assert.deepStrictEqual(crewRosterChanges([requested], [requested]).runtimeChanged, []);
  });

  it("reads as a running crew when every seat started, with no change against the proposal", () => {
    const text = crewLaunchReportText({
      proposal: { ...proposal, approvedSeats: proposal.requestedSeats },
      instance: { ...instance, members: instance.members.slice(0, 2) } as AgentCrewInstance,
      verdicts: new Map([
        ["setup", { kind: "started" }],
        ["punchline", { kind: "started" }],
      ]),
      windowMs: 60_000,
    });
    assert.include(text, "changes: none");
    assert.include(
      text,
      "launch: 2 started, 0 failed, 0 not created, 0 start unconfirmed after 60s",
    );
    assert.include(text, "Your crew is running.");
    assert.notInclude(text, "seat_failed");
  });

  it("tells every Captain the crew is running, and says nothing of where to ask a person", () => {
    const text = crewLaunchReportText({
      proposal: { ...proposal, approvedSeats: proposal.requestedSeats },
      instance: { ...instance, members: instance.members.slice(0, 2) } as AgentCrewInstance,
      verdicts: new Map([
        ["setup", { kind: "started" }],
        ["punchline", { kind: "started" }],
      ]),
      windowMs: 60_000,
    });
    assert.include(
      text,
      "Your crew is running. Each seat has your brief and this roster; coordinate with j5_send_message.",
    );
    assert.notInclude(text, "j5_send_message, and ask");
    assert.notInclude(text, "through the inbox");
    assert.notInclude(text, "ask in this thread");
  });
});
