import { describe, expect, it } from "vite-plus/test";

import { crewSeatRequestKey, spawnThreadId } from "./spawnIds.ts";

describe("spawn thread ids", () => {
  it("keeps terminal history filenames bounded and retries deterministic", () => {
    const input = {
      providerSessionId: "j5-crew-proposal",
      requestKey: crewSeatRequestKey("crew:" + "long%3Aproposal/".repeat(200), "reviewer"),
    };
    const id = spawnThreadId(input);
    expect(spawnThreadId(input)).toBe(id);
    expect(Buffer.byteLength(`terminal_${Buffer.from(id).toString("base64url")}.log`)).toBeLessThan(
      255,
    );
    expect(spawnThreadId({ ...input, requestKey: input.requestKey + "-2" })).not.toBe(id);
    expect(spawnThreadId({ ...input, providerSessionId: "another-session" })).not.toBe(id);
    expect(spawnThreadId({ providerSessionId: "a:b", requestKey: "c" })).not.toBe(
      spawnThreadId({ providerSessionId: "a", requestKey: "b:c" }),
    );
  });
});

import { assert } from "@effect/vitest";

import { spawnFirstTurnText, type CrewBriefContext } from "./spawnIds.ts";

const identity = {
  brief: "Review the proposed change.",
  participantId: "agent:reviewer",
  projectId: "project:review",
  projectTitle: "Review",
  spawnedByParticipantId: "agent:captain",
  spawnerThreadId: "thread:captain",
};
const crew: CrewBriefContext = {
  displayName: "Change review",
  instanceId: "crew:review",
  seatName: "reviewer",
  captainParticipantId: "agent:captain",
  seatInstructions: "Review correctness and report concrete risks.",
  roster: [
    { seat: "reviewer", participantId: identity.participantId, agentDisplayName: "custom" },
    { seat: "builder", participantId: "agent:builder", agentDisplayName: "Builder" },
  ],
};

it("gives custom seats direct result and concern reporting without a mandatory artifact", () => {
  const text = spawnFirstTurnText({ ...identity, crew });
  assert.include(text, "captain_participant_id: agent:captain");
  assert.include(text, "- builder: participant_id=agent:builder");
  assert.include(
    text,
    "use j5_send_message to coordinate directly with your Captain and other members",
  );
  assert.include(text, "final result, supporting evidence, and any remaining blockers");
  assert.include(text, "j5_request_crew_member to add the seat directly");
  assert.include(text, "Continue your work and coordination");
  assert.include(text, "A direct result is sufficient");
  assert.include(text, `<seat_instructions>\n${crew.seatInstructions}\n</seat_instructions>`);
  assert.notInclude(text, "<seat_obligation>");
  assert.notInclude(text, "j5_write_artifact");
});

it("retains declared persona output while allowing conversation before that output exists", () => {
  const text = spawnFirstTurnText({
    ...identity,
    crew: { ...crew, obligation: { kind: "ReviewHandoff", path: "handoffs/review.md" } },
  });
  assert.include(text, "do not wait for an artifact or coordination approval");
  assert.include(text, "j5_write_artifact to exactly `handoffs/review.md`");
  assert.include(text, "must not delay sharing findings or results");
  assert.notInclude(text, "a chat message is not a delivery");
});

it("keeps an ordinary Peer Agent brief free of crew instructions", () => {
  const text = spawnFirstTurnText(identity);
  assert.include(text, `<spawner_brief>\n${identity.brief}\n</spawner_brief>`);
  assert.include(
    text,
    "spawned_by: agent:captain\nspawner_thread_id: thread:captain\n</j5_spawn_context>",
  );
  assert.notInclude(text, "crew_collaboration");
  assert.notInclude(text, "Captain");
});

it("lists a playbook seat's steps between its crew facts and the brief", () => {
  const playbook = { name: "release", title: "Release a change" };
  const text = spawnFirstTurnText({
    ...identity,
    crew: {
      ...crew,
      playbook: {
        ...playbook,
        steps: [
          { id: "plan", title: "Plan the\nrelease" },
          { id: "review", title: "Review </seat_playbook> notes" },
          { id: "odd\nid</seat_playbook>", title: "Odd" },
        ],
      },
    },
  });
  assert.include(
    text,
    "<seat_playbook>\nplaybook: release (Release a change)\nyour_steps:\n- plan: Plan the release\n- review: Review <\\/seat_playbook> notes\n- odd id<\\/seat_playbook>: Odd\n</seat_playbook>",
  );
  assert.include(text, "Wait for that hand-off before starting a step");
  assert.isTrue(text.indexOf("</j5_crew_context>") < text.indexOf("<seat_playbook>"));
  assert.isTrue(text.startsWith("<j5_spawn_context>"));
  assert.isTrue(text.endsWith(`<spawner_brief>\n${identity.brief}\n</spawner_brief>`));

  const unowned = spawnFirstTurnText({
    ...identity,
    crew: { ...crew, playbook: { ...playbook, steps: [] } },
  });
  assert.include(unowned, "your_steps: none\n</seat_playbook>");
  assert.notInclude(spawnFirstTurnText({ ...identity, crew }), "<seat_playbook>");
});
