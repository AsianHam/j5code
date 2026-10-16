import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2AppThread,
  type OrchestrationV2CreationSource,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "../a2a/AgentCrewInstanceService.ts";
import { LedgerProjectId } from "../a2a/contracts.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { manualLayer, ThreadAnalytics } from "./ThreadAnalytics.ts";

const at = DateTime.makeUnsafe("2026-10-10T12:00:00Z");
const providerInstanceId = ProviderInstanceId.make("codex");

type Origin = {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
};

const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

/** Stores a thread and returns its id with the `thread.created` event it comes with. */
const thread = Effect.fn(function* (
  name: string,
  origin: Origin,
  options: {
    readonly parent?: { readonly threadId: ThreadId; readonly relationship: "fork" | "subagent" };
    readonly persona?: boolean;
  } = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:turn-analytics:${name}`);
  const created = {
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: {
      ...origin,
      id: threadId,
      projectId: ProjectId.make("project:turn-analytics"),
      title: name,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: options.parent?.threadId ?? null,
        relationshipToParent: options.parent?.relationship ?? null,
        rootThreadId: options.parent?.threadId ?? threadId,
      },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      ...(options.persona
        ? {
            agentPersonaAssignment: {
              personaId: "critic",
              definitionVersion: 1,
              authorityPolicy: "critic-review",
              resolvedRoute: "primary",
              resolvedDriver: ProviderDriverKind.make("codex"),
              resolvedModelSelection: modelSelection,
            },
          }
        : {}),
    } satisfies OrchestrationV2AppThread,
  } as const;
  yield* store.apply(created);
  return {
    threadId,
    created: {
      sequence: 0,
      commandId: null,
      event: created,
    } as unknown as OrchestrationV2StoredEvent,
  };
});

/** Stores the message that asks for a turn and returns the `run.created` event it comes with. */
const turn = Effect.fn(function* (
  threadId: ThreadId,
  ordinal: number,
  origin: Origin & { readonly scheduledTaskId?: ScheduledTaskId },
  run: { readonly workStartedAt?: DateTime.Utc } = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const messageId = MessageId.make(`message:${threadId}:${ordinal}`);
  yield* store.apply({
    id: EventId.make(`event:${messageId}`),
    type: "message.updated",
    threadId,
    occurredAt: at,
    payload: {
      ...origin,
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: "the text never leaves the machine",
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });
  return {
    sequence: ordinal,
    commandId: null,
    event: {
      type: "run.created",
      threadId,
      payload: {
        id: RunId.make(`run:${threadId}:${ordinal}`),
        threadId,
        ordinal,
        userMessageId: messageId,
        ...run,
      },
    },
  } as unknown as OrchestrationV2StoredEvent;
});

const testLayer = (recorded: Ref.Ref<ReadonlyArray<Readonly<Record<string, unknown>>>>) =>
  manualLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(ledgerLayer, crewInstanceLayer, ProjectionStore.layer)),
    Layer.provide(
      Layer.succeed(
        AnalyticsService,
        AnalyticsService.of({
          record: (event, properties = {}) =>
            Ref.update(recorded, (events) => [...events, { event, ...properties }]),
          flush: Effect.void,
        }),
      ),
    ),
    // The manual layer never tails the stream.
    Layer.provide(Layer.succeed(ThreadManagementService, {} as ThreadManagementService["Service"])),
    Layer.provide(Layer.succeed(EventSinkV2, {} as EventSinkV2["Service"])),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

it.effect("says who asked for each turn, and nothing about what was asked", () =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<Readonly<Record<string, unknown>>>>([]);
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const turns = yield* ThreadAnalytics;

      const { threadId: composer } = yield* thread("composer", {
        createdBy: "user",
        creationSource: "web",
      });
      const { threadId: seat } = yield* thread("seat", {
        createdBy: "agent",
        creationSource: "mcp",
      });
      const { threadId: spawned } = yield* thread(
        "spawned",
        { createdBy: "agent", creationSource: "mcp" },
        { persona: true },
      );
      const projectId = LedgerProjectId.make("ledger:turn-analytics");
      yield* (yield* A2ALedger).ensureProject({ projectId, createdAt: DateTime.formatIso(at) });
      yield* (yield* AgentCrewInstanceService).record({
        id: "crew:turn-analytics",
        projectId,
        captainParticipantId: participantIdForThread(composer),
        captainThreadId: composer,
        displayName: "Crew",
        brief: "Brief.",
        createdAt: DateTime.formatIso(at),
        members: [
          {
            seatName: "builder",
            agentId: "builder",
            participantId: participantIdForThread(seat),
            threadId: seat,
            reason: null,
          },
        ],
      });

      const events = [
        // A person typing in the composer.
        yield* turn(composer, 1, { createdBy: "user", creationSource: "web" }),
        // A Crew seat's brief, then a platform notice to the same seat.
        yield* turn(seat, 1, { createdBy: "agent", creationSource: "mcp" }),
        yield* turn(seat, 2, { createdBy: "system", creationSource: "server" }),
        // An agent's message, then the person's Inbox reply, to a spawned agent outside a Crew.
        yield* turn(spawned, 2, { createdBy: "agent", creationSource: "mcp" }),
        yield* turn(spawned, 3, { createdBy: "user", creationSource: "mcp" }),
        // A scheduled task waking the person's own thread.
        yield* turn(
          composer,
          2,
          {
            createdBy: "system",
            creationSource: "server",
            scheduledTaskId: ScheduledTaskId.make("task:nightly"),
          },
          { workStartedAt: at },
        ),
      ];
      for (const event of events) yield* turns.handleStoredEvent(event);
      // Only a new run is a turn.
      yield* turns.handleStoredEvent({
        ...events[0]!,
        event: { ...events[0]!.event, type: "run.updated" },
      } as OrchestrationV2StoredEvent);
    }).pipe(Effect.provide(testLayer(recorded)));

    const expected = (asked: string, properties: Readonly<Record<string, unknown>>) => {
      const [createdBy, creationSource] = asked.split("/");
      return { event: "j5.turn.started", createdBy, creationSource, ...properties };
    };
    const person = {
      threadCreatedBy: "user",
      threadCreationSource: "web",
      crewSeat: false,
      persona: false,
    };
    const seatThread = { threadCreatedBy: "agent", threadCreationSource: "mcp", crewSeat: true };
    const spawnedThread = {
      threadCreatedBy: "agent",
      threadCreationSource: "mcp",
      crewSeat: false,
      persona: true,
    };
    const plain = { scheduled: false, wake: false };
    const first = { firstTurn: true, turnNumber: 1 };
    const nth = (turnNumber: number) => ({ firstTurn: false, turnNumber });
    assert.deepStrictEqual(yield* Ref.get(recorded), [
      expected("user/web", { ...plain, ...person, ...first }),
      expected("agent/mcp", { ...plain, ...seatThread, persona: false, ...first }),
      expected("system/server", { ...plain, ...seatThread, persona: false, ...nth(2) }),
      expected("agent/mcp", { ...plain, ...spawnedThread, ...nth(2) }),
      expected("user/mcp", { ...plain, ...spawnedThread, ...nth(3) }),
      expected("system/server", { ...person, ...nth(2), scheduled: true, wake: true }),
    ]);
  }),
);

it.effect("says what made each thread, and nothing about the thread", () =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<Readonly<Record<string, unknown>>>>([]);
    yield* Effect.gen(function* () {
      const threads = yield* ThreadAnalytics;
      const agent = { createdBy: "agent", creationSource: "mcp" } as const;

      const composer = yield* thread("composer", { createdBy: "user", creationSource: "web" });
      const parent = { threadId: composer.threadId };
      const created = [
        composer,
        yield* thread(
          "fork",
          { createdBy: "user", creationSource: "web" },
          { parent: { ...parent, relationship: "fork" } },
        ),
        // `j5_spawn_agent` with a persona: a Peer Agent, which has no parent in the lineage.
        yield* thread("peer", agent, { persona: true }),
        yield* thread("delegated", agent, { parent: { ...parent, relationship: "subagent" } }),
        yield* thread(
          "provider-subagent",
          { createdBy: "agent", creationSource: "provider" },
          { parent: { ...parent, relationship: "subagent" } },
        ),
        yield* thread("system", { createdBy: "system", creationSource: "server" }),
      ];
      for (const { created: event } of created) yield* threads.handleStoredEvent(event);
    }).pipe(Effect.provide(testLayer(recorded)));

    const expected = (kind: string, asked: string, persona = false) => {
      const [createdBy, creationSource] = asked.split("/");
      return { event: "j5.thread.created", kind, createdBy, creationSource, persona };
    };
    assert.deepStrictEqual(yield* Ref.get(recorded), [
      expected("person", "user/web"),
      expected("fork", "user/web"),
      expected("peer_agent", "agent/mcp", true),
      expected("delegated", "agent/mcp"),
      expected("provider_subagent", "agent/provider"),
      expected("system", "system/server"),
    ]);
  }),
);
