import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { makeCrewMembershipsRead, projectCrewMemberships } from "./crewMembershipsRead.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const criticThread = ThreadId.make("thread:critic");
const instance = (id: string, archivedAt: string | null): AgentCrewInstance => ({
  id,
  projectId: LedgerProjectId.make("project:crew-reads"),
  captainParticipantId: participantIdForThread(captainThread),
  captainThreadId: captainThread,
  brief: "Implement and review the login fix.",
  version: 1,
  displayName: "Review Pair",
  createdAt: "2026-09-09T16:00:00.000Z",
  archivedAt,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: participantIdForThread(builderThread),
      threadId: builderThread,
      addedVersion: 1,
      reason: null,
    },
    {
      seatName: "critic",
      agentId: "critic",
      participantId: participantIdForThread(criticThread),
      threadId: criticThread,
      addedVersion: 1,
      reason: null,
    },
  ],
});

it("projects one membership per involved thread, live members before captains, nothing for outsiders", () => {
  const outsider = ThreadId.make("thread:outsider");
  const projected = projectCrewMemberships(
    [captainThread, builderThread, outsider, builderThread],
    // The retired Crew is listed first: a retired seat must never win over the live one.
    [instance("crew:old", "2026-09-09T17:00:00.000Z"), instance("crew:live", null)],
  );
  assert.deepStrictEqual(projected.entries, [
    {
      threadId: captainThread,
      membership: {
        kind: "captain",
        crews: [{ crewInstanceId: "crew:live", crewName: "Review Pair" }],
      },
    },
    {
      threadId: builderThread,
      membership: {
        kind: "member",
        seat: "builder",
        crew: { crewInstanceId: "crew:live", crewName: "Review Pair" },
      },
    },
  ]);
});

it("shows a former seat that now commands its own Crew as a captain", () => {
  const promoted: AgentCrewInstance = {
    ...instance("crew:by-builder", null),
    captainParticipantId: participantIdForThread(builderThread),
    captainThreadId: builderThread,
    members: [],
  };
  const projected = projectCrewMemberships(
    [builderThread],
    [instance("crew:old", "2026-09-09T17:00:00.000Z"), promoted],
  );
  assert.deepStrictEqual(projected.entries, [
    {
      threadId: builderThread,
      membership: {
        kind: "captain",
        crews: [{ crewInstanceId: "crew:by-builder", crewName: "Review Pair" }],
      },
    },
  ]);
});

it.effect("reads the Crews of the visible threads, as seats and as the Captains they may be", () =>
  Effect.gen(function* () {
    const received: Array<{
      threadIds: ReadonlyArray<ThreadId>;
      participantIds: ReadonlyArray<ParticipantId>;
    }> = [];
    const read = yield* makeCrewMembershipsRead.pipe(
      Effect.provide(
        Layer.mock(AgentCrewInstanceService)({
          listInvolving: (input) => {
            received.push(input);
            return Effect.succeed([instance("crew:live", null)]);
          },
        }),
      ),
    );
    const { entries } = yield* read([criticThread, captainThread]);
    assert.deepStrictEqual(
      entries.map((entry) => [entry.threadId, entry.membership.kind]),
      [
        [criticThread, "member"],
        [captainThread, "captain"],
      ],
    );
    // Each thread is looked up both as a seat and as the Captain its participant id may be.
    assert.deepStrictEqual(received, [
      {
        threadIds: [criticThread, captainThread],
        participantIds: [
          participantIdForThread(criticThread),
          participantIdForThread(captainThread),
        ],
      },
    ]);
  }),
);

it("drops a retired Captain and its seats from the membership response", () => {
  assert.deepStrictEqual(
    projectCrewMemberships(
      [captainThread, builderThread, criticThread],
      [instance("crew:retired", "2026-09-21T12:00:00.000Z")],
    ),
    { entries: [] },
  );
});
