import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  VcsProcessTimeoutError,
  VcsProcessSpawnError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CheckpointCapture from "../../orchestration-v2/CheckpointCaptureService.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import { QueuedRunCandidates } from "./QueuedRunCandidates.ts";
import { layer, QueuedRunWatchdog } from "./QueuedRunWatchdog.ts";

const isCaptureError = Schema.is(CheckpointCapture.CheckpointCaptureExecutionError);
const isRefreshError = Schema.is(RunFinalization.RunFinalizationRefreshError);

const input = {
  threadId: ThreadId.make("observation-thread"),
  runId: RunId.make("observation-run"),
  scopeId: CheckpointScopeId.make("observation-scope"),
};
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
function fixture() {
  const turnItems: Array<OrchestrationV2TurnItem> = [];
  const projection = {
    thread: { projectId: ProjectId.make("observation-project") },
    runs: [
      {
        id: input.runId,
        threadId: input.threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make("observation-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    checkpointScopes: [{ id: input.scopeId, cwd: "/repo" }],
    plans: [],
    turnItems,
  } as unknown as OrchestrationV2ThreadProjection;
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadProjection: () => Effect.succeed(projection),
    getCheckpointContext: () => Effect.succeed(projection as never),
  });
  const events = Layer.mock(EventSink.EventSinkV2)({
    write: (write) =>
      Effect.sync(() => {
        for (const event of write.events) {
          if (event.type === "turn-item.updated") turnItems.push(event.payload);
        }
        return [] as never;
      }),
  });
  return { turnItems, projections, events };
}

it.effect.each([
  { phase: "checkpoint", reportFails: false },
  { phase: "checkpoint", reportFails: true },
  { phase: "refresh", reportFails: false },
  { phase: "refresh", reportFails: true },
] as const)(
  "handles a $phase VCS failure through real finalization and observer (reportFails=$reportFails)",
  ({ phase, reportFails }) => {
    const { turnItems, projections, events } = fixture();
    const vcs =
      phase === "checkpoint"
        ? new VcsProcessTimeoutError({
            operation: "capture",
            command: "git",
            cwd: "/repo",
            timeoutMs: 5000,
          })
        : new VcsProcessSpawnError({
            operation: "refresh",
            command: "git",
            cwd: "/repo",
            cause: new Error("spawn failed"),
          });
    const wrapped =
      phase === "checkpoint"
        ? new CheckpointCapture.CheckpointCaptureExecutionError({ ...input, cause: vcs })
        : new RunFinalization.RunFinalizationRefreshError({ cwd: "/repo", cause: vcs });
    const observation = layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          projections,
          IdAllocator.layer,
          Layer.mock(QueuedRunCandidates)({}),
          reportFails
            ? Layer.mock(EventSink.EventSinkV2)({
                write: () => Effect.die("observation write failed"),
              })
            : events,
        ),
      ),
    );
    const serviceLayer = RunFinalization.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          observation,
          projections,
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
            execute: () => (isCaptureError(wrapped) ? Effect.fail(wrapped) : Effect.void),
          }),
          Layer.succeed(RunFinalization.RunFinalizationObserver, {
            refreshAfterTurn: () => Effect.void,
            refresh: () => (isRefreshError(wrapped) ? Effect.fail(wrapped) : Effect.void),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      if (phase === "refresh") {
        // Upstream logs a failed display refresh once the checkpoint is durable, so
        // finalization succeeds and there is no delay to observe.
        yield* service.finalize(input);
        assert.equal(turnItems.length, 0);
        return;
      }
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const error = yield* service.finalize(input).pipe(Effect.flip);
        assert.instanceOf(error, RunFinalization.RunFinalizationError);
        assert.strictEqual(error.cause, wrapped);
      }
      assert.equal(turnItems.length, reportFails ? 0 : 1);
      if (!reportFails) {
        assert.match(turnItems[0]?.title ?? "", /Run finalization delayed/);
        const item = turnItems[0];
        assert.isTrue(item?.type === "error" && item.failure.code === "vcs_finalization_failure");
      }
    }).pipe(Effect.provide(serviceLayer));
  },
);

it.effect("ignores ordinary and cyclic causes before reading projection state", () => {
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  let reads = 0;
  const observation = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.sync(() => {
              reads += 1;
              throw new Error("unexpected read");
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(QueuedRunCandidates)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* QueuedRunWatchdog;
    for (const cause of [new Error("ordinary failure"), cyclic, null, "not VCS"]) {
      yield* observer.recordVcsFailure({ ...input, phase: "start", cause });
    }
    assert.equal(reads, 0);
  }).pipe(Effect.provide(observation));
});
