import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { A2AArchiveFacts, A2AArchiveFactsError } from "./ArchiveFactsService.ts";
import { makePreArchiveFactsRead } from "./preArchiveFactsRead.ts";

it.effect("returns the pre-archive facts without turning a failed read into a clean archive", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:pre-archive-http");
    let failRead = false;
    const archiveFacts = Layer.mock(A2AArchiveFacts)({
      readForThread: (receivedThreadId) =>
        failRead
          ? Effect.fail(
              new A2AArchiveFactsError({
                operation: "read pre-archive facts",
                cause: new Error("placement unavailable"),
              }),
            )
          : Effect.succeed({
              state: "registered" as const,
              threadId: receivedThreadId,
              projectId: "project:pre-archive-http" as never,
              participantId: "agent:pre-archive-http" as never,
              retired: false,
              archived: false,
              openExchanges: [],
              placementSubtree: {
                state: "unknown" as const,
                reason: "placement-query-failed" as const,
              },
            }),
    });
    const archiveCrews = Layer.mock(ArchiveCrewService)({
      readCaptainFacts: (input) =>
        Effect.succeed([
          {
            instance: {
              id: "crew:pre-archive-http",
              projectId: input.projectId,
              captainParticipantId: input.captainParticipantId,
              captainThreadId: threadId,
              displayName: "Review Pair",
              brief: "Review the release.",
              version: 1,
              createdAt: "2026-09-14T10:00:00.000Z",
              archivedAt: null,
              members: [],
            },
            facts: {
              members: [
                {
                  seatName: "critic",
                  participantId: "agent:critic" as never,
                  threadId: ThreadId.make("thread:critic"),
                  alreadyArchived: false,
                  neverCreated: false,
                  facts: {
                    openExchanges: [],
                    runningTurn: { runId: "run:critic" as never, status: "running" },
                  },
                },
              ],
            },
          },
        ]),
    });
    const crewInstances = Layer.mock(AgentCrewInstanceService)({
      findMembership: () => Effect.succeed(null),
    });
    const read = yield* makePreArchiveFactsRead.pipe(
      Effect.provide(Layer.mergeAll(archiveFacts, archiveCrews, crewInstances)),
    );

    assert.deepStrictEqual(yield* read(threadId), {
      state: "registered",
      threadId,
      projectId: "project:pre-archive-http",
      participantId: "agent:pre-archive-http",
      retired: false,
      openExchanges: [],
      placementSubtree: { state: "unknown", reason: "placement-query-failed" },
      // A Captain's live Crews ride along seat by seat: the Captain is never archived alone.
      liveCrews: [
        {
          crewInstanceId: "crew:pre-archive-http",
          crewName: "Review Pair",
          seats: [
            { seat: "critic", participantId: "agent:critic", runningTurn: true, openAsks: 0 },
          ],
        },
      ],
      crewSeat: null,
    });

    failRead = true;
    const failure = yield* read(threadId).pipe(Effect.flip);
    assert.equal(failure._tag, "A2AArchiveFactsError");
  }),
);
