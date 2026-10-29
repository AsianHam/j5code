import {
  VcsError,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { FLEET_DISPATCH_THRESHOLD_MS } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import {
  type CandidateCursor,
  QueuedRunCandidates,
  layer as candidateLayer,
} from "./QueuedRunCandidates.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { forkParked } from "../../serverActivation.ts";

export const QUEUED_RUN_WATCHDOG_DELAY_MS = FLEET_DISPATCH_THRESHOLD_MS;
export const QUEUED_RUN_WATCHDOG_POLL_MS = 60 * 1000;
export const QUEUED_RUN_WATCHDOG_MAX_CANDIDATES = 100;

export class QueuedRunWatchdogError extends Schema.TaggedError<QueuedRunWatchdogError>()(
  "QueuedRunWatchdogError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export class QueuedRunWatchdog extends Context.Reference<{
  readonly scan: () => Effect.Effect<void, QueuedRunWatchdogError>;
  readonly recordVcsFailure: (input: {
    readonly threadId: OrchestrationV2Run["threadId"];
    readonly runId: OrchestrationV2Run["id"];
    readonly phase: "start" | "finalization";
    readonly cause: unknown;
  }) => Effect.Effect<void>;
}>("j5/queued-run-watchdog/QueuedRunWatchdog", {
  defaultValue: () => ({ scan: () => Effect.void, recordVcsFailure: () => Effect.void }),
}) {}

function waitingMinutes(run: OrchestrationV2Run, now: DateTime.Utc): number {
  return Math.max(
    1,
    Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(run.requestedAt)) / 60_000),
  );
}

function hasFact(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
  signal: string,
) {
  const id = `turn-item:run:${encodeURIComponent(run.id)}:signal:${encodeURIComponent(signal)}`;
  return projection.turnItems.some((item) => item.id === id);
}

const isVcsError = Schema.is(VcsError);
function findVcsError(cause: unknown) {
  const seen = new Set<unknown>();
  let current = cause;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (isVcsError(current)) return current;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export const layer = Layer.effect(
  QueuedRunWatchdog,
  Effect.gen(function* () {
    const events = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const candidatesStore = yield* QueuedRunCandidates;
    const startingRunCursor = yield* Ref.make<CandidateCursor | undefined>(undefined);

    const writeFact = Effect.fn("QueuedRunWatchdog.writeFact")(function* (input: {
      readonly projection: OrchestrationV2ThreadProjection;
      readonly run: OrchestrationV2Run;
      readonly signal: string;
      readonly title: string;
      readonly message: string;
      readonly code: string;
      readonly expectedStatus?: "starting";
    }) {
      if (hasFact(input.projection, input.run, input.signal)) return;
      const now = yield* DateTime.now;
      const event = {
        id: yield* ids.allocate.event({ threadId: input.run.threadId }),
        type: "turn-item.updated" as const,
        threadId: input.run.threadId,
        runId: input.run.id,
        ...(input.run.rootNodeId === null ? {} : { nodeId: input.run.rootNodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: now,
        payload: {
          id: ids.derive.runSignalTurnItem({ runId: input.run.id, signal: input.signal }),
          threadId: input.run.threadId,
          runId: input.run.id,
          nodeId: input.run.rootNodeId,
          providerThreadId: input.run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: input.run.ordinal * 100 + 99,
          status: "completed" as const,
          title: input.title,
          startedAt: input.run.requestedAt,
          completedAt: now,
          updatedAt: now,
          type: "error" as const,
          failure: makeProviderFailure({
            message: input.message,
            code: input.code,
            class: "unknown",
          }),
        },
      };
      if (input.expectedStatus === undefined || input.run.activeAttemptId === null) {
        yield* events.write({ events: [event] });
        return;
      }
      yield* events.writeIfRunCurrent({
        threadId: input.run.threadId,
        runId: input.run.id,
        activeAttemptId: input.run.activeAttemptId,
        expectedStatus: input.expectedStatus,
        events: [event],
      });
    });

    const scanEffect = Effect.fn("QueuedRunWatchdog.scan")(function* () {
      const now = yield* DateTime.now;
      const after = yield* Ref.get(startingRunCursor);
      const candidates = yield* candidatesStore.list({
        status: "starting",
        requestedBefore: DateTime.makeUnsafe(
          DateTime.toEpochMillis(now) - QUEUED_RUN_WATCHDOG_DELAY_MS,
        ),
        ...(after === undefined ? {} : { after }),
        limit: QUEUED_RUN_WATCHDOG_MAX_CANDIDATES,
      });
      const lastCandidate = candidates.at(-1);
      yield* Ref.set(
        startingRunCursor,
        candidates.length === QUEUED_RUN_WATCHDOG_MAX_CANDIDATES && lastCandidate !== undefined
          ? { requestedAt: lastCandidate.requestedAt, runId: lastCandidate.id }
          : undefined,
      );
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            // A full projection is only needed for a bounded candidate, where
            // it provides deduplication and rechecks current run state.
            const projection = yield* projections.getThreadProjection(candidate.threadId);
            const run = projection.runs.find((current) => current.id === candidate.id);
            if (
              run === undefined ||
              run.status !== "starting" ||
              run.startedAt !== null ||
              DateTime.toEpochMillis(now) - DateTime.toEpochMillis(run.requestedAt) <
                QUEUED_RUN_WATCHDOG_DELAY_MS
            ) {
              return;
            }
            yield* writeFact({
              projection,
              run,
              signal: "queued-run-watchdog",
              title: "Run waiting",
              message: `Run waiting ${waitingMinutes(run, now)}m, not yet dispatched.`,
              code: "queued_run_waiting",
              expectedStatus: "starting",
            });
          }),
        { discard: true },
      );
    });
    const scan = () =>
      scanEffect().pipe(Effect.mapError((cause) => new QueuedRunWatchdogError({ cause })));

    const recordVcsFailureEffect = Effect.fn("QueuedRunWatchdog.recordVcsFailure")(
      function* (input: {
        readonly threadId: OrchestrationV2Run["threadId"];
        readonly runId: OrchestrationV2Run["id"];
        readonly phase: "start" | "finalization";
        readonly cause: unknown;
      }) {
        const vcsError = findVcsError(input.cause);
        if (vcsError === undefined) return;
        const projection = yield* projections.getThreadProjection(input.threadId);
        const run = projection.runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined) return;
        // Upstream no longer copies arbitrary cause text; VCS errors format their own redacted message.
        const failure = makeProviderFailure({
          cause: vcsError,
          message: vcsError.message,
          class: "unknown",
        });
        yield* writeFact({
          projection,
          run,
          signal: `vcs-${input.phase}-failure`,
          title: input.phase === "start" ? "Run start delayed" : "Run finalization delayed",
          message:
            input.phase === "start"
              ? `A VCS operation failed while this run was starting: ${failure.message}`
              : `A VCS operation failed while this run was finalizing: ${failure.message}`,
          code: `vcs_${input.phase}_failure`,
        });
      },
    );
    const recordVcsFailure = (input: {
      readonly threadId: OrchestrationV2Run["threadId"];
      readonly runId: OrchestrationV2Run["id"];
      readonly phase: "start" | "finalization";
      readonly cause: unknown;
    }) => recordVcsFailureEffect(input).pipe(Effect.catchCause(() => Effect.void));

    return { scan, recordVcsFailure };
  }),
);

export const live = layer.pipe(Layer.provide(candidateLayer));

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const watchdog = yield* QueuedRunWatchdog;
    yield* Effect.forever(
      Effect.sleep(`${QUEUED_RUN_WATCHDOG_POLL_MS} millis`).pipe(
        Effect.andThen(watchdog.scan()),
        Effect.catchCause((cause) =>
          Effect.logWarning("Queued run watchdog scan failed", { cause }),
        ),
      ),
    ).pipe(forkParked);
  }),
);
