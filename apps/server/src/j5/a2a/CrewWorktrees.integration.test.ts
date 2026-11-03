import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { GitManager } from "../../git/GitManager.ts";
import { layer as projectionStoreLayer } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as Preparation from "./CrewSeatPreparation.ts";
import { CrewWorktrees, manualLayer } from "./CrewWorktrees.ts";
import { LedgerProjectId } from "./contracts.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ReadChanges } from "./ReadChanges.ts";

it.effect(
  "records the worktree upstream's launch creates for a seat's first assignment, from the event it commits",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        crewDeliveryContext: true,
        createWorktree: (input) =>
          Effect.succeed({
            worktree: {
              path: "/repo-worktrees/crew-builder",
              refName: input.newRefName,
              headSha: "abc",
            },
          } as never),
      });
      const services = Layer.mergeAll(
        harness.layer,
        Crews.layer.pipe(Layer.provide(harness.layer)),
        ledgerLayer.pipe(Layer.provide(harness.layer)),
      );
      const base = Preparation.layer.pipe(
        Layer.provideMerge(services),
        Layer.provideMerge(harness.orchestrator),
      );
      const layer = manualLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.services,
            projectionStoreLayer.pipe(Layer.provide(harness.layer)),
            Layer.mock(ProviderSessionManagerV2)({}),
            Layer.mock(GitVcsDriver)({}),
            Layer.mock(GitManager)({}),
            Layer.mock(ReadChanges)({}),
            NodeServices.layer,
          ),
        ),
        Layer.provideMerge(base),
      );
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const crews = yield* Crews.AgentCrewInstanceService;
        const worktrees = yield* CrewWorktrees;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:crew-builder");
        const captainThreadId = ThreadId.make("thread:captain");
        const ledgerProjectId = LedgerProjectId.make(projectId);
        yield* (yield* A2ALedger).ensureProject({
          projectId: ledgerProjectId,
          createdAt: "2026-10-27T12:00:00Z",
        });
        yield* crews.record({
          id: "crew:worktrees",
          projectId: ledgerProjectId,
          captainThreadId,
          captainParticipantId: participantIdForThread(captainThreadId),
          displayName: "Build",
          brief: "Shared goal",
          createdAt: "2026-10-27T12:00:00Z",
          members: [
            {
              seatName: "builder",
              agentId: null,
              threadId,
              participantId: participantIdForThread(threadId),
              reason: "Build the fix",
            },
          ],
        });
        yield* sql`INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace)
          VALUES (${threadId}, '', '{"type":"worktree","baseRef":"main"}')`;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:create-builder"),
          threadId,
          projectId,
          title: "Builder",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
          branch: null,
          worktreePath: null,
        });
        // Created unbound: nothing is recorded until a worktree exists.
        assert.lengthOf(yield* sql`SELECT * FROM j5_crew_worktree`, 0);
        yield* threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make("command:first-assignment"),
          messageId: MessageId.make("message:first-assignment"),
          text: "Build it now.",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        // The event upstream's launch commits when it binds the new worktree is the record's input.
        const bound = yield* threads.streamStoredEventsFrom({ afterSequence: 0 }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "thread.metadata-updated" &&
              stored.event.threadId === threadId &&
              stored.event.payload.worktreePath !== null,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        assert.deepStrictEqual(
          yield* Effect.forEach(bound, (stored) => worktrees.handleStoredEvent(stored)),
          [true],
        );
        const [row] = yield* sql<{
          readonly thread_id: string;
          readonly project_id: string;
          readonly path: string;
          readonly branch: string | null;
        }>`SELECT thread_id, project_id, path, branch FROM j5_crew_worktree`;
        assert.equal(row?.thread_id, threadId);
        assert.equal(row?.project_id, projectId);
        assert.equal(row?.path, "/repo-worktrees/crew-builder");
        assert.isString(row?.branch);
        // Later metadata updates for the same thread (the branch rename) leave the record alone.
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.worktreePath, "/repo-worktrees/crew-builder");
        const [again] = bound;
        assert.isFalse(yield* worktrees.handleStoredEvent(again!));
      }).pipe(Effect.provide(layer));
    }),
);
