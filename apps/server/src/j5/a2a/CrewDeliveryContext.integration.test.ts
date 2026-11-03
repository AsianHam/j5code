import * as CrewTurnContext from "./CrewTurnContext.ts";
import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as Preparation from "./CrewSeatPreparation.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { LedgerProjectId } from "./contracts.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { spawnFirstTurnText } from "./spawnIds.ts";

it.effect(
  "direct chat activates a waiting seat, prepares its worktree, and queues follow-up work",
  () =>
    Effect.gen(function* () {
      const checkoutStarted = yield* Deferred.make<void>();
      const finishCheckout = yield* Deferred.make<void>();
      const harness = makeHarness({
        crewDeliveryContext: true,
        createWorktree: (input) =>
          Deferred.succeed(checkoutStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishCheckout)),
            Effect.as({
              worktree: {
                path: "/repo-worktrees/crew-reviewer",
                refName: input.newRefName,
                headSha: "abc",
              },
            } as never),
          ),
      });
      const services = Layer.mergeAll(
        harness.layer,
        Crews.layer.pipe(Layer.provide(harness.layer)),
        ledgerLayer.pipe(Layer.provide(harness.layer)),
        CrewTurnContext.layer.pipe(Layer.provide(Layer.merge(harness.layer, harness.orchestrator))),
      );
      const layer = Preparation.layer.pipe(
        Layer.provideMerge(services),
        Layer.provideMerge(harness.orchestrator),
      );
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const crews = yield* Crews.AgentCrewInstanceService;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:crew-reviewer");
        const captainThreadId = ThreadId.make("thread:captain");
        const ledgerProjectId = LedgerProjectId.make(projectId);
        yield* (yield* A2ALedger).ensureProject({
          projectId: ledgerProjectId,
          createdAt: "2026-10-27T12:00:00Z",
        });
        yield* crews.record({
          id: "crew:integration",
          projectId: ledgerProjectId,
          captainThreadId,
          captainParticipantId: participantIdForThread(captainThreadId),
          displayName: "Review",
          brief: "Shared goal",
          createdAt: "2026-10-27T12:00:00Z",
          members: [
            {
              seatName: "reviewer",
              agentId: null,
              threadId,
              participantId: participantIdForThread(threadId),
              reason: "Review the fix",
            },
          ],
        });
        const text = spawnFirstTurnText({
          brief: "Shared goal",
          participantId: participantIdForThread(threadId),
          projectId,
          projectTitle: "Project",
          spawnedByParticipantId: participantIdForThread(captainThreadId),
          crew: {
            displayName: "Review",
            instanceId: "crew:integration",
            seatName: "reviewer",
            captainParticipantId: participantIdForThread(captainThreadId),
            roster: [],
          },
        });
        yield* sql`INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace)
        VALUES (${threadId}, ${text}, '{"type":"worktree","baseRef":"main"}')`;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:create-reviewer"),
          threadId,
          projectId,
          title: "Reviewer",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
          branch: null,
          worktreePath: null,
        });
        assert.lengthOf((yield* threads.getThreadProjection(threadId)).runs, 0);
        assert.isTrue((yield* crews.read("crew:integration"))!.members[0]!.notStarted);
        yield* threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make("command:first-assignment"),
          messageId: MessageId.make("message:first-assignment"),
          text: "Review the code now.",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        yield* Deferred.await(checkoutStarted);
        const preparing = yield* threads.getThreadProjection(threadId);
        assert.equal(preparing.runs[0]!.status, "preparing");
        assert.notInclude(preparing.messages[0]!.text, "Shared goal");
        assert.isTrue(preparing.messages[0]!.text.endsWith("Review the code now."));
        assert.isTrue((yield* crews.read("crew:integration"))!.members[0]!.notStarted);
        yield* threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make("command:follow-up"),
          messageId: MessageId.make("message:follow-up"),
          text: "Check the failure path too.",
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const queued = yield* threads.getThreadProjection(threadId);
        assert.equal(
          queued.messages.find((message) => message.id === "message:follow-up")!.text,
          "Check the failure path too.",
        );
        assert.isTrue(queued.runs.some((run) => run.status === "queued"));
        const released = yield* threads.streamStoredEventsFrom({ afterSequence: 0 }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.threadId === threadId &&
              stored.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.succeed(finishCheckout, undefined);
        yield* Fiber.join(released);
        const ready = yield* threads.getThreadProjection(threadId);
        assert.equal(ready.thread.worktreePath, "/repo-worktrees/crew-reviewer");
        assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.baseRefName, "main");
        assert.lengthOf(harness.createWorktree.mock.calls, 1);
        const crewContext = yield* CrewTurnContext.CrewTurnContext;
        const promptFor = (text: string) =>
          Effect.gen(function* () {
            let prompt = "";
            yield* crewContext.deliver(
              {
                threadId,
                runId: ready.runs[0]!.id,
                providerThread: {
                  id: "provider-thread:crew-reviewer",
                  nativeThreadRef: null,
                } as never,
                text,
              },
              (sent) =>
                Effect.sync(() => {
                  prompt = sent;
                  return true;
                }),
            );
            return prompt;
          });
        assert.include(yield* promptFor(ready.messages[0]!.text), "Shared goal");
        // The member's thread keeps what it was told, once, and the record starts no run.
        const introduced = yield* threads.getThreadProjection(threadId);
        const kept = introduced.messages.filter((message) => message.createdBy === "system");
        assert.lengthOf(kept, 1);
        assert.include(kept[0]!.text, "<spawner_brief>\nShared goal\n</spawner_brief>");
        assert.notInclude(kept[0]!.text, "Review the code now.");
        assert.lengthOf(introduced.runs, ready.runs.length);
        yield* crews.addMembers("crew:integration", [
          {
            seatName: "tester",
            agentId: null,
            threadId: ThreadId.make("thread:tester"),
            participantId: participantIdForThread(ThreadId.make("thread:tester")),
            reason: "Test the fix",
          },
        ]);
        const reordered = yield* threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make("command:queued-second"),
          messageId: MessageId.make("message:queued-second"),
          text: "Original second assignment",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        const canceled = yield* threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make("command:queued-cancel"),
          messageId: MessageId.make("message:queued-cancel"),
          text: "Cancel this assignment",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* threads.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("command:edit-second"),
          threadId,
          runId: reordered.run.id,
          text: "Edited second assignment",
        });
        const firstQueued = ready.runs.find((run) => run.status === "queued")!;
        yield* threads.dispatch({
          type: "queued-run.reorder",
          commandId: CommandId.make("command:reorder-second"),
          threadId,
          runId: reordered.run.id,
          beforeRunId: firstQueued.id,
        });
        yield* threads.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("command:cancel-third"),
          threadId,
          runId: canceled.run.id,
        });
        const queuedAfterEdits = yield* threads.getThreadProjection(threadId);
        assert.equal(
          queuedAfterEdits.runs.find((run) => run.id === canceled.run.id)?.status,
          "cancelled",
        );
        assert.equal(
          queuedAfterEdits.messages.find((message) => message.id === reordered.message.id)?.text,
          "Edited second assignment",
        );
        const now = yield* DateTime.now;
        yield* (yield* EventSinkV2).write({
          events: ready.runs
            .filter((run) => run.status !== "queued")
            .map((run) => ({
              id: EventId.make(`event:finish-active:${run.id}`),
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: {
                ...run,
                status: "completed" as const,
                completedAt: now,
                queuePosition: null,
              },
            })),
        });
        yield* threads.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("command:resume-reordered"),
          threadId,
        });
        const selected = yield* threads.getThreadProjection(threadId);
        assert.equal(selected.runs.find((run) => run.id === reordered.run.id)?.status, "starting");
        const nextText = selected.messages.find(
          (message) => message.id === reordered.message.id,
        )!.text;
        const prompt = yield* promptFor(nextText);
        assert.include(prompt, "joined: tester:");
        assert.isTrue(prompt.endsWith("Edited second assignment"));
        assert.equal(yield* promptFor("Next assignment"), "Next assignment");
        yield* (yield* EventSinkV2).write({
          events: ready.runs.map((run) => ({
            id: EventId.make(`event:finished:${run.id}`),
            type: "run.updated" as const,
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...run,
              status: "completed" as const,
              completedAt: now,
              queuePosition: null,
            },
          })),
        });
        const reused = yield* threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make("command:reuse-finished-seat"),
          messageId: MessageId.make("message:reuse-finished-seat"),
          text: "Review the revision.",
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "mcp",
        });
        assert.equal(reused.message.text, "Review the revision.");
        assert.equal(reused.run.threadId, threadId);
        assert.equal(reused.projection.thread.worktreePath, ready.thread.worktreePath);
        assert.lengthOf((yield* crews.read("crew:integration"))!.members, 2);
        assert.lengthOf(harness.createWorktree.mock.calls, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a preparing Crew seat resumes worktree preparation after restart", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:preparing-at-restart");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:create-at-restart"),
      threadId,
      projectId,
      title: "Reviewer",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      branch: null,
      worktreePath: null,
    });
    yield* sql`INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace, delivered_roster)
      VALUES (${threadId}, 'approved context', '{"type":"worktree","baseRef":"main"}', '[]')`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:accepted-before-restart"),
      threadId,
      messageId: MessageId.make("message:accepted-before-restart"),
      text: "Existing assignment",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: {
        type: "defer_start",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      },
    });
    assert.equal((yield* threads.getThreadProjection(threadId)).runs[0]!.status, "preparing");
    const context = yield* Effect.context<
      | ThreadManagementService
      | import("../../orchestration-v2/ThreadLaunchService.ts").ThreadLaunchService
      | SqlClient.SqlClient
      | EventSinkV2
    >();
    yield* threads.streamStoredEventsFrom({ afterSequence: 0 }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.threadId === threadId &&
          stored.event.payload.status === "starting",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.provide(Preparation.layer.pipe(Layer.provide(Layer.succeedContext(context)))),
    );
    assert.equal(
      (yield* threads.getThreadProjection(threadId)).thread.worktreePath,
      "/repo-worktrees/feature",
    );
    assert.lengthOf(harness.createWorktree.mock.calls, 1);
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, harness.orchestrator)));
});
