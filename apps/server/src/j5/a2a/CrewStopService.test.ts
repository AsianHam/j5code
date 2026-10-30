import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";
import { CrewStopService, layer as crewStopLayer } from "./CrewStopService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { LedgerProjectId } from "./contracts.ts";

const projectId = LedgerProjectId.make("ledger:crew-stop");
const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const criticThread = ThreadId.make("thread:critic");
const retiredThread = ThreadId.make("thread:retired");
const createdAt = DateTime.makeUnsafe("2026-09-14T20:00:00.000Z");

const projection = (threadId: ThreadId): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:crew-stop"),
      archivedAt: threadId === retiredThread ? "2026-09-14T19:00:00.000Z" : null,
    },
    // Only the builder has a turn to stop.
    runs: threadId === builderThread ? [{ id: "run:builder", ordinal: 1, status: "running" }] : [],
  }) as unknown as OrchestrationV2ThreadProjection;

it.effect("stops every live seat, for the Captain or a person, and nobody else", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    );
    yield* runJ5A2AMigrations().pipe(Effect.provide(context));
    yield* Context.get(context, A2ALedger).ensureProject({
      projectId: projectId,
      createdAt: DateTime.formatIso(createdAt),
    });
    const captain = participantIdForThread(captainThread);
    yield* Context.get(context, AgentCrewInstanceService).record({
      id: "crew:stop",
      projectId,
      captainParticipantId: captain,
      captainThreadId: captainThread,
      displayName: "Stop Crew",
      brief: "Work.",
      createdAt: DateTime.formatIso(createdAt),
      members: [
        {
          seatName: "builder",
          agentId: "builder",
          participantId: participantIdForThread(builderThread),
          threadId: builderThread,
          reason: null,
        },
        {
          seatName: "critic",
          agentId: "critic",
          participantId: participantIdForThread(criticThread),
          threadId: criticThread,
          reason: null,
        },
        {
          seatName: "retired",
          agentId: "scout",
          participantId: participantIdForThread(retiredThread),
          threadId: retiredThread,
          reason: null,
        },
      ],
    });
    const interrupts = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = crewStopLayer.pipe(
      Layer.provideMerge(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
          dispatch: (command) =>
            Ref.update(interrupts, (items) => [
              ...items,
              command.type === "thread.stop"
                ? `${command.type}:${command.threadId}:${command.commandId}:${command.reason ?? "no reason"}`
                : command.type,
            ]).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          stopDelegatedTasks: () => Effect.void,
        }),
      ),
      // Every seat here has a thread, so no home is read.
      Layer.provideMerge(Layer.mock(A2AArchiveFacts)({})),
      Layer.provideMerge(Layer.succeedContext(context)),
    );
    yield* Effect.gen(function* () {
      const service = yield* CrewStopService;
      const commandIds = (seatName: string) => ({
        interruptCommandId: CommandId.make(`stop:${seatName}`),
      });

      const stopped = yield* service.stop({
        callerParticipantId: captain,
        projectId,
        crewInstanceId: "crew:stop",
        commandIds,
      });
      assert.deepStrictEqual(
        stopped.members.map(({ seatName, result }) => [seatName, result]),
        [
          ["builder", "interrupt_requested"],
          ["critic", "already_idle"],
          ["retired", "archived"],
        ],
      );
      // The archived seat is never stopped; live seats get upstream's Stop under the caller's
      // deterministic ids, idle or not, so a held queue and delegated tasks stop too.
      // The Captain's Stop reads as an agent's; without a reason the timeline says "Stopped by user".
      assert.deepStrictEqual(yield* Ref.get(interrupts), [
        `thread.stop:${builderThread}:stop:builder:Stopped by an agent`,
        `thread.stop:${criticThread}:stop:critic:Stopped by an agent`,
      ]);

      // A person stops the same Crew without a participant id, and the Stop stays theirs.
      const byHuman = yield* service.stop({
        callerParticipantId: null,
        projectId: null,
        crewInstanceId: "crew:stop",
        commandIds,
      });
      assert.lengthOf(byHuman.members, 3);
      assert.deepStrictEqual((yield* Ref.get(interrupts)).slice(2), [
        `thread.stop:${builderThread}:stop:builder:no reason`,
        `thread.stop:${criticThread}:stop:critic:no reason`,
      ]);

      // A member, or any other agent, is refused and pointed at the Captain.
      const refused = yield* service
        .stop({
          callerParticipantId: participantIdForThread(builderThread),
          projectId,
          crewInstanceId: "crew:stop",
          commandIds,
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewStopRequestError");
      assert.include(refused.message, "only its Captain or the human");
      const wrongProject = yield* service
        .stop({
          callerParticipantId: captain,
          projectId: LedgerProjectId.make("project:other"),
          crewInstanceId: "crew:stop",
          commandIds,
        })
        .pipe(Effect.flip);
      assert.include(wrongProject.message, "lives in project");
      const missing = yield* service
        .stop({
          callerParticipantId: null,
          projectId: null,
          crewInstanceId: "crew:nope",
          commandIds,
        })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "CrewStopNotFoundError");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

/**
 * A Crew whose first seat's row was recorded but whose thread never came to exist, ahead of a
 * seat with a running turn. `ghost` reads as the test says: missing (not-found with no home),
 * unreadable (the store fails), or homed (a home with no thread behind it).
 */
const ghostFixture = (ghost: "missing" | "unreadable" | "homed") =>
  Effect.gen(function* () {
    const ghostThread = ThreadId.make("thread:ghost");
    const context = yield* Layer.build(
      Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    );
    yield* runJ5A2AMigrations().pipe(Effect.provide(context));
    yield* Context.get(context, A2ALedger).ensureProject({
      projectId: projectId,
      createdAt: DateTime.formatIso(createdAt),
    });
    yield* Context.get(context, AgentCrewInstanceService).record({
      id: "crew:ghost",
      projectId,
      captainParticipantId: participantIdForThread(captainThread),
      captainThreadId: captainThread,
      displayName: "Ghost Crew",
      brief: "Work.",
      createdAt: DateTime.formatIso(createdAt),
      members: [ghostThread, builderThread].map((threadId) => ({
        seatName: threadId === ghostThread ? "ghost" : "builder",
        agentId: "builder",
        participantId: participantIdForThread(threadId),
        threadId,
        reason: null,
      })),
    });
    const interrupts = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = crewStopLayer.pipe(
      Layer.provideMerge(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            threadId !== ghostThread
              ? Effect.succeed(projection(threadId))
              : Effect.fail(
                  new OrchestratorProjectionError({
                    threadId,
                    cause:
                      ghost === "unreadable"
                        ? new ProjectionStoreReadError({ threadId })
                        : new ProjectionStoreThreadNotFoundError({ threadId }),
                  }),
                ),
          dispatch: (command) =>
            Ref.update(interrupts, (items) =>
              command.type === "thread.stop" ? [...items, command.threadId] : items,
            ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          stopDelegatedTasks: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.mock(A2AArchiveFacts)({
          readForThread: (threadId) =>
            Effect.succeed(
              ghost === "homed"
                ? {
                    state: "registered",
                    threadId,
                    projectId,
                    participantId: participantIdForThread(threadId),
                    retired: false,
                    archived: false,
                    openExchanges: [],
                    placementSubtree: { state: "none" },
                  }
                : {
                    state: "not-an-a2a-participant",
                    threadId,
                    openExchanges: [],
                    placementSubtree: { state: "not-applicable" },
                  },
            ),
        }),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
    );
    const stop = CrewStopService.pipe(
      Effect.flatMap((service) =>
        service.stop({
          callerParticipantId: null,
          projectId: null,
          crewInstanceId: "crew:ghost",
          commandIds: (seatName) => ({ interruptCommandId: CommandId.make(`stop:${seatName}`) }),
        }),
      ),
      Effect.provide(layer),
    );
    return { stop, interrupts };
  });

it.effect(
  "a seat that was never created ahead of a running seat still lets the stop reach it",
  () =>
    Effect.gen(function* () {
      const { stop, interrupts } = yield* ghostFixture("missing");
      const stopped = yield* stop;
      assert.deepStrictEqual(
        stopped.members.map(({ seatName, result }) => [seatName, result]),
        [
          ["ghost", "never_created"],
          ["builder", "interrupt_requested"],
        ],
      );
      assert.deepStrictEqual(yield* Ref.get(interrupts), [builderThread]);
    }).pipe(Effect.scoped),
);

it.effect("a seat the store cannot read, or a home with no thread, fails the stop loudly", () =>
  Effect.gen(function* () {
    for (const ghost of ["unreadable", "homed"] as const) {
      const { stop, interrupts } = yield* ghostFixture(ghost);
      const failure = yield* stop.pipe(Effect.flip);
      assert.equal(failure._tag, "CrewStopOperationError", ghost);
      assert.include(failure.message, "seat ghost", ghost);
      assert.lengthOf(yield* Ref.get(interrupts), 0, ghost);
    }
  }).pipe(Effect.scoped),
);
