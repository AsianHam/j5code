/**
 * Records `j5.thread.created` for every thread, saying what kind of thread it is, and
 * `j5.turn.started` for every run the orchestrator creates, saying who asked for it.
 *
 * Upstream's `client.thread.started` fires only for a thread a person starts from the composer;
 * agents, delegated tasks and provider subagents create the rest. `thread.created` is written
 * once for each of them.
 *
 * Upstream's `client.turn.requested` fires only for a message a person sends over a client
 * socket. A turn started by an agent's message, an Inbox reply, a spawn brief, a Crew notice, a
 * playbook step or a scheduled task never passes through that handler, and
 * `provider.turn.completed` does not say who asked. This reads the committed `run.created`
 * event instead, which every path writes exactly once, so retried commands are not counted twice.
 *
 * @module ThreadAnalytics
 */
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import { readEventStoreHighWater } from "../a2a/eventStoreHighWater.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";

const TurnOrigin = Schema.Struct({
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  scheduled: Schema.Number,
  threadCreatedBy: OrchestrationV2Actor,
  threadCreationSource: OrchestrationV2CreationSource,
  persona: Schema.Number,
});
const decodeTurnOrigin = Schema.decodeUnknownEffect(TurnOrigin);

/** What made a thread: a person, a fork, or one of the three ways an agent starts another. */
const threadKind = (thread: OrchestrationV2AppThread) => {
  if (thread.lineage.relationshipToParent === "fork") return "fork";
  if (thread.lineage.relationshipToParent === "subagent")
    return thread.creationSource === "provider" ? "provider_subagent" : "delegated";
  if (thread.createdBy === "agent") return "peer_agent";
  return thread.createdBy === "user" ? "person" : "system";
};

export class ThreadAnalytics extends Context.Service<
  ThreadAnalytics,
  {
    /** Records a `thread.created` or `run.created` event; every other event is ignored. */
    readonly handleStoredEvent: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void>;
  }
>()("t3/j5/analytics/ThreadAnalytics") {}

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    ThreadAnalytics,
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      const crews = yield* AgentCrewInstanceService;
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ThreadManagement.ThreadManagementService;

      const recordThread = (thread: OrchestrationV2AppThread) =>
        analytics.record("j5.thread.created", {
          kind: threadKind(thread),
          createdBy: thread.createdBy,
          creationSource: thread.creationSource,
          persona: thread.agentPersonaAssignment !== undefined,
        });

      const recordTurn = Effect.fn("j5.analytics.turnStarted")(function* (run: OrchestrationV2Run) {
        // The message and its run are written by one command, so the row is committed by now.
        // Only the markers are read: the payload also holds the message text.
        const rows = yield* sql`
          SELECT
            json_extract(message.payload_json, '$.createdBy') AS "createdBy",
            json_extract(message.payload_json, '$.creationSource') AS "creationSource",
            json_extract(message.payload_json, '$.scheduledTaskId') IS NOT NULL AS "scheduled",
            json_extract(thread.payload_json, '$.createdBy') AS "threadCreatedBy",
            json_extract(thread.payload_json, '$.creationSource') AS "threadCreationSource",
            json_extract(thread.payload_json, '$.agentPersonaAssignment') IS NOT NULL AS "persona"
          FROM orchestration_v2_projection_messages AS message
          JOIN orchestration_v2_projection_threads AS thread
            ON thread.thread_id = message.thread_id
          WHERE message.message_id = ${run.userMessageId}
        `;
        if (rows[0] === undefined) return;
        const origin = yield* decodeTurnOrigin(rows[0]);
        // Every seat is a platform-spawned thread, so nothing else needs the Crew store.
        const crewSeat =
          origin.threadCreatedBy === "agent" && origin.threadCreationSource === "mcp"
            ? (yield* crews.findMembership(participantIdForThread(run.threadId))) !== null
            : false;
        yield* analytics.record("j5.turn.started", {
          createdBy: origin.createdBy,
          creationSource: origin.creationSource,
          scheduled: origin.scheduled === 1,
          threadCreatedBy: origin.threadCreatedBy,
          threadCreationSource: origin.threadCreationSource,
          crewSeat,
          firstTurn: run.ordinal === 1,
          turnNumber: run.ordinal,
          persona: origin.persona === 1,
          // Background notifications, delegated task results and restart continuations.
          wake: run.workStartedAt !== undefined,
        });
      });

      const handleStoredEvent: ThreadAnalytics["Service"]["handleStoredEvent"] = (stored) => {
        const recorded =
          stored.event.type === "thread.created"
            ? recordThread(stored.event.payload)
            : stored.event.type === "run.created"
              ? recordTurn(stored.event.payload)
              : Effect.void;
        return recorded.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 thread analytics skipped an event", { cause }),
          ),
        );
      };

      if (daemon) {
        // Tailed from the current high-water mark: threads and turns that started while the server
        // was down go uncounted, and a restart never counts old ones again.
        const runDaemon = Effect.gen(function* () {
          let afterSequence = yield* readEventStoreHighWater("J5 thread analytics");
          return yield* Effect.forever(
            Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
              Stream.runForEach((event) =>
                handleStoredEvent(event).pipe(
                  Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 thread analytics stream failed; resuming", { cause }).pipe(
                  Effect.andThen(Effect.sleep(Duration.seconds(1))),
                ),
              ),
            ),
          );
        });
        yield* Effect.forkScoped(runDaemon);
      }

      return ThreadAnalytics.of({ handleStoredEvent });
    }),
  );

/** For tests, which feed `handleStoredEvent` themselves. */
export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
