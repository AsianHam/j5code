import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessageContext } from "~/lib/composerContextRecords";
import type { ChatMessage } from "~/types";
import {
  resolvedSpawnBriefContext,
  isSpawnBriefMessage,
  participantIdsForSpawnBrief,
  presentSpawnBrief,
  presentSpawnerIdentity,
} from "./SpawnBrief";

const CREATED_AT = "2026-09-17T12:00:00.000Z";
const SPAWN_BRIEF_ID = MessageId.make(
  "message:j5:a2a:mcp:session-1:spawn-brief:spawn-arch-review-20260917",
);

function message(input: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: SPAWN_BRIEF_ID,
    role: "user",
    text: "",
    runId: null,
    streaming: false,
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

const brief = [
  "IDENTITY: You are the ARCHITECTURE REVIEWER.",
  "",
  "TASK: Review both repos: agent-ops and obs-sentinel.",
  "",
  'REPLY: j5_send_message(to="agent:director") when done.',
].join("\n");

const currentRaw = [
  "<j5_spawn_context>",
  "Platform-provided identity facts:",
  "participant_id: agent:reviewer",
  "project_id: project-prod",
  "project_title: Production Monitoring",
  "spawned_by: agent:director",
  "spawner_thread_id: thread-director",
  "</j5_spawn_context>",
  "",
  "<spawner_brief>",
  brief,
  "</spawner_brief>",
].join("\n");

// Stored history keeps the identity lines briefs carried before Squadrons were retired.
const preFoldRaw = currentRaw
  .replace("project_id: project-prod", "squadron_id: squadron:prod")
  .replace("project_title: ", "squadron_name: ");

const legacyRaw = [
  "<j5_spawn_context>",
  "Platform-provided identity facts:",
  "participant_id: agent:reviewer",
  "squadron_id: squadron:prod",
  "squadron_name: Production Monitoring",
  "</j5_spawn_context>",
  "",
  "<spawner_brief>",
  brief,
  "</spawner_brief>",
].join("\n");

describe("presentSpawnBrief", () => {
  it("still reads a brief stored before Squadrons were retired", () => {
    expect(preFoldRaw).toContain(
      "squadron_id: squadron:prod\nsquadron_name: Production Monitoring",
    );
    expect(presentSpawnBrief(message({ text: preFoldRaw }))).toEqual({
      brief,
      participantId: "agent:reviewer",
      spawnedBy: "agent:director",
      spawnerThreadId: "thread-director",
    });
  });

  it("separates the brief from the platform facts and names the spawner", () => {
    expect(presentSpawnBrief(message({ text: currentRaw }))).toEqual({
      brief,
      participantId: "agent:reviewer",
      spawnedBy: "agent:director",
      spawnerThreadId: "thread-director",
    });
    expect(participantIdsForSpawnBrief(message({ text: currentRaw }))).toEqual(["agent:director"]);
  });

  it("keeps briefs written before the spawner facts existed, without a spawner", () => {
    expect(presentSpawnBrief(message({ text: legacyRaw }))).toMatchObject({
      brief,
      spawnedBy: null,
      spawnerThreadId: null,
    });
    expect(participantIdsForSpawnBrief(message({ text: legacyRaw }))).toEqual([]);
  });

  it("gates on the spawn-brief message id, never on envelope-looking text", () => {
    const delivery = message({
      id: MessageId.make("message:j5:a2a:delivery:abc"),
      text: currentRaw,
    });
    expect(isSpawnBriefMessage(delivery)).toBe(false);
    expect(presentSpawnBrief(delivery)).toBeNull();
    expect(
      presentSpawnBrief(message({ id: MessageId.make("message-1"), text: currentRaw })),
    ).toBeNull();
    expect(presentSpawnBrief(message({ role: "assistant", text: currentRaw }))).toBeNull();
  });

  it("keeps a crew seat's crew facts and instructions verbatim, attributed to the captain", () => {
    const crewRemainder = [
      "<j5_crew_context>",
      "Platform-provided crew facts:",
      "crew: Change review",
      "your_seat: reviewer",
      "captain_participant_id: agent:director",
      "</j5_crew_context>",
      "",
      "<seat_instructions>",
      "Review correctness: report concrete risks.",
      "</seat_instructions>",
      "",
      "<spawner_brief>",
      brief,
      "</spawner_brief>",
    ].join("\n");
    const crewRaw = currentRaw.replace(
      `<spawner_brief>\n${brief}\n</spawner_brief>`,
      crewRemainder,
    );

    expect(presentSpawnBrief(message({ text: crewRaw }))).toMatchObject({
      brief: crewRemainder,
      spawnedBy: "agent:director",
      spawnerThreadId: "thread-director",
    });
  });

  it("returns null for an unrecognized template so the raw text stays visible", () => {
    expect(presentSpawnBrief(message({ text: "Just a brief with no wrapper." }))).toBeNull();
    expect(
      presentSpawnBrief(message({ text: currentRaw.replace("project_title: ", "name: ") })),
    ).toBeNull();
    expect(presentSpawnBrief(message({ text: currentRaw.slice(0, -5) }))).toBeNull();
    // A mangled opening tag with an intact closing tag must not hide the identity block.
    expect(
      presentSpawnBrief(message({ text: currentRaw.replace("<spawner_brief>\n", "<brief>\n") })),
    ).toBeNull();
    expect(
      presentSpawnBrief(
        message({ text: currentRaw.replace("<spawner_brief>\n", "Some prose first.\n\n") }),
      ),
    ).toBeNull();
  });
});

describe("resolvedSpawnBriefContext", () => {
  it("shows a brief that quotes composer context tags verbatim", () => {
    const quoting = [
      "Review the terminal capture format. A user message ends like this:",
      "",
      "<terminal_context>",
      "- Build line 7:",
      "  npm test",
      "</terminal_context>",
    ].join("\n");

    // The generic user-row derivation upgrades the quoted block into a context record.
    expect(resolveUserMessageContext({ text: quoting }).text).not.toBe(quoting);

    const state = resolvedSpawnBriefContext(quoting);
    expect(state.text).toBe(quoting);
    expect(state.records).toEqual([]);
    expect(state.recordsById.size).toBe(0);
  });
});

describe("a brief from an outside agent", () => {
  // The identity block `spawnFirstTurnText` writes when the spawner is an outside agent.
  const outsideRaw = [
    "<j5_spawn_context>",
    "Platform-provided identity facts:",
    "participant_id: agent:reviewer",
    "project_id: project-prod",
    "project_title: Production Monitoring",
    "spawned_by: outside:session-1",
    "spawned_by_outside_agent: Claude Desktop",
    "spawner_reply: You were started by an outside agent: one that runs outside this app. You cannot reply to it with j5_send_message.",
    "</j5_spawn_context>",
    "",
    "<spawner_brief>",
    brief,
    "</spawner_brief>",
  ].join("\n");

  it("names the outside agent as the spawner, with no spawner thread to open", () => {
    const outsideMessage = message({ text: outsideRaw });
    expect(presentSpawnBrief(outsideMessage)).toEqual({
      brief,
      participantId: "agent:reviewer",
      spawnedBy: "outside:session-1",
      spawnerThreadId: null,
    });
    expect(participantIdsForSpawnBrief(outsideMessage)).toEqual(["outside:session-1"]);
  });

  it("marks the spawner as an outside agent, named or not", () => {
    expect(
      presentSpawnerIdentity({
        spawnedBy: "outside:session-1",
        participantLabels: new Map([["outside:session-1", "Claude Desktop"]]),
      }),
    ).toEqual({ label: "Claude Desktop (outside agent)", tooltipParticipantId: null });
    expect(
      presentSpawnerIdentity({ spawnedBy: "outside:session-1", participantLabels: new Map() }),
    ).toEqual({ label: "an outside agent", tooltipParticipantId: "outside:session-1" });
  });
});

describe("presentSpawnerIdentity", () => {
  it("names a known spawner without a tooltip", () => {
    expect(
      presentSpawnerIdentity({
        spawnedBy: "agent:director",
        participantLabels: new Map([["agent:director", "Director"]]),
      }),
    ).toEqual({ label: "Director", tooltipParticipantId: null });
  });

  it("stays honest about unknown and missing spawners", () => {
    expect(
      presentSpawnerIdentity({ spawnedBy: "agent:director", participantLabels: new Map() }),
    ).toEqual({ label: "Unnamed participant", tooltipParticipantId: "agent:director" });
    expect(presentSpawnerIdentity({ spawnedBy: null, participantLabels: new Map() })).toEqual({
      label: "another agent",
      tooltipParticipantId: null,
    });
  });
});
