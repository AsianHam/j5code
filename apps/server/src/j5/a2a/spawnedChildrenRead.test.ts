import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { projectSpawnedChildren, threadIdForParticipant } from "./spawnedChildrenRead.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const helperThread = ThreadId.make("thread:helper");
const captain = participantIdForThread(captainThread);
const builder = participantIdForThread(builderThread);
const helper = participantIdForThread(helperThread);

const crew: AgentCrewInstance = {
  id: "crew:1",
  projectId: LedgerProjectId.make("project:children"),
  captainParticipantId: captain,
  captainThreadId: captainThread,
  brief: "Implement and review the login fix.",
  version: 1,
  displayName: "Review Pair",
  createdAt: "2026-09-09T16:00:00.000Z",
  archivedAt: null,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: builder,
      threadId: builderThread,
      addedVersion: 1,
      reason: null,
    },
  ],
};

it("maps participant ids back to thread ids only for agent participants", () => {
  assert.equal(threadIdForParticipant(builder), builderThread);
  assert.isNull(threadIdForParticipant(ParticipantId.make("human:bryant")));
});

it("groups placed children under each visible thread and marks live crew seats", () => {
  const projected = projectSpawnedChildren(
    [captainThread, helperThread, captainThread],
    [
      { participant_id: builder, placement_parent_id: captain },
      { participant_id: helper, placement_parent_id: captain },
      { participant_id: "human:bryant", placement_parent_id: captain },
      {
        participant_id: participantIdForThread(ThreadId.make("thread:grandchild")),
        placement_parent_id: helper,
      },
    ],
    [crew, { ...crew, id: "crew:old", archivedAt: "2026-09-09T18:00:00.000Z" }],
  );
  assert.deepStrictEqual(projected.entries, [
    {
      threadId: captainThread,
      children: [
        {
          threadId: builderThread,
          participantId: builder,
          seat: { crewInstanceId: "crew:1", crewName: "Review Pair", seat: "builder" },
        },
        { threadId: helperThread, participantId: helper, seat: null },
      ],
    },
    {
      threadId: helperThread,
      children: [
        {
          threadId: ThreadId.make("thread:grandchild"),
          participantId: participantIdForThread(ThreadId.make("thread:grandchild")),
          seat: null,
        },
      ],
    },
  ]);
});

it("a Captain's row carries every live roster seat, placed or not, and no retired one", () => {
  const seat = (seatName: string) => {
    const threadId = ThreadId.make(`thread:${seatName}`);
    return {
      seatName,
      agentId: null,
      participantId: participantIdForThread(threadId),
      threadId,
      addedVersion: 1,
      reason: null,
    };
  };
  const reserved = seat("reserved");
  const unplaced = seat("unplaced");
  const archived = seat("archived");
  const elsewhere = seat("elsewhere");
  const projected = projectSpawnedChildren(
    [captainThread],
    [{ participant_id: builder, placement_parent_id: captain }],
    [{ ...crew, members: [...crew.members, reserved, unplaced, archived, elsewhere] }],
    new Map([
      [unplaced.participantId, { archived: false, placementParentId: null }],
      [archived.participantId, { archived: true, placementParentId: captain }],
      [elsewhere.participantId, { archived: false, placementParentId: helper }],
    ]),
  );
  assert.deepStrictEqual(
    projected.entries[0]?.children.map((child) => [child.threadId, child.seat?.seat ?? null]),
    [
      [builderThread, "builder"],
      [reserved.threadId, "reserved"],
      [unplaced.threadId, "unplaced"],
    ],
  );
});

it("a Crew whose launch placed no seat still gives its Captain a row per seat", () => {
  const projected = projectSpawnedChildren([captainThread], [], [crew]);
  assert.deepStrictEqual(projected.entries, [
    {
      threadId: captainThread,
      children: [
        {
          threadId: builderThread,
          participantId: builder,
          seat: { crewInstanceId: "crew:1", crewName: "Review Pair", seat: "builder" },
        },
      ],
    },
  ]);
  // A retired Crew gives nothing.
  assert.deepStrictEqual(
    projectSpawnedChildren([captainThread], [], [{ ...crew, archivedAt: "2026-09-09T18:00Z" }])
      .entries,
    [],
  );
});
