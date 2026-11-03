import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
  CrewProposalResolveRequest,
  CrewProposalsResponse,
} from "../j5.ts";

const decodeList = Schema.decodeUnknownSync(CrewProposalsResponse);
const decodePreviewResponse = Schema.decodeUnknownSync(CrewProposalPreviewResponse);
const decodePreviewRequest = Schema.decodeUnknownSync(CrewProposalPreviewRequest);
const decodeResolve = Schema.decodeUnknownSync(CrewProposalResolveRequest);

it("requires a runtime preview token for approval, while a decline needs no preview", () => {
  const decode = Schema.decodeUnknownSync(CrewProposalResolveRequest);
  expect(() => decode({ proposalId: "proposal", decision: "approve" })).toThrow();
  expect(
    decode({ proposalId: "proposal", decision: "approve", approvalToken: "token" }),
  ).toMatchObject({ approvalToken: "token" });
  expect(decode({ proposalId: "proposal", decision: "decline" })).toEqual({
    proposalId: "proposal",
    decision: "decline",
  });
});

it("reads a seat workspace it can't decode as absent, keeping the rest of the list", () => {
  const seat = { seat: "reviewer", agentId: null, reason: "Review" };
  const proposal = {
    id: "proposal",
    projectId: "project",
    captainParticipantId: "captain",
    captainThreadId: "thread",
    crewInstanceId: null,
    kind: "roster",
    status: "open",
    brief: "Brief",
    displayName: "Crew",
    approvedSeats: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    resolvedAt: null,
  };
  const decoded = decodeList({
    proposals: [
      {
        ...proposal,
        requestedSeats: [
          { ...seat, workspace: { type: "sandbox" } },
          { ...seat, seat: "builder", workspace: { type: "worktree" } },
          { ...seat, seat: "scout", workspace: { type: "shared" } },
        ],
      },
    ],
  });
  expect(decoded.proposals[0]!.requestedSeats).toEqual([
    seat,
    { ...seat, seat: "builder" },
    { ...seat, seat: "scout", workspace: { type: "shared" } },
  ]);
});

it("reads a preview's workspace options it can't decode as absent, keeping the preview", () => {
  const decoded = decodePreviewResponse({
    proposalId: "proposal",
    approvalToken: "token",
    seats: [],
    workspaceOptions: { currentBranch: "main", worktrees: [{ path: "/repo-worktrees/a" }] },
  });
  expect(decoded).toEqual({ proposalId: "proposal", approvalToken: "token", seats: [] });
});

it("still refuses a seat workspace it can't decode in a preview or an approval", () => {
  const seats = [
    { seat: "reviewer", agentId: null, reason: "Review", workspace: { type: "worktree" } },
  ];
  expect(() => decodePreviewRequest({ proposalId: "proposal", seats })).toThrow();
  expect(() =>
    decodeResolve({
      proposalId: "proposal",
      decision: "approve",
      approvalToken: "token",
      seats: [{ ...seats[0], workspace: { type: "sandbox" } }],
    }),
  ).toThrow();
});

it("carries the person's replacement persona text through a preview and an approval", () => {
  const seat = {
    seat: "reviewer",
    agentId: "sentry",
    reason: "Review",
    personaInstructions: "Only read the README.",
    workspace: { type: "shared" },
  };
  expect(decodePreviewRequest({ proposalId: "proposal", seats: [seat] }).seats?.[0]).toMatchObject({
    personaInstructions: "Only read the README.",
  });
  expect(
    decodeResolve({
      proposalId: "proposal",
      decision: "approve",
      approvalToken: "token",
      seats: [seat],
    }),
  ).toMatchObject({ seats: [{ personaInstructions: "Only read the README." }] });
});

it("carries a new worktree's saved commit through a preview request and a preview's runtime", () => {
  const baseCommit = "3f9c2ab1".repeat(5);
  const workspace = { type: "worktree", baseRef: "main", baseCommit } as const;
  const seat = { seat: "builder", agentId: null, reason: "Build", workspace };
  expect(
    decodePreviewRequest({ proposalId: "proposal", seats: [seat] }).seats?.[0]?.workspace,
  ).toEqual(workspace);
  const runtime = {
    seat: "builder",
    provider: "Codex",
    harness: "Codex",
    model: "gpt",
    reasoning: "High",
    access: "Full access",
    modelSelection: { instanceId: "codex", model: "gpt" },
    runtimeMode: "full-access",
    workspace,
  };
  expect(
    decodePreviewResponse({ proposalId: "proposal", approvalToken: "token", seats: [runtime] })
      .seats[0]?.workspace,
  ).toEqual(workspace);
});
