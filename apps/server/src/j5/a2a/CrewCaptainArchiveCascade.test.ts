import {
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService, type ArchiveCrewInput } from "./ArchiveCrewService.ts";
import { CrewCaptainArchiveCascade, layer as cascadeLayer } from "./CrewCaptainArchiveCascade.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const projectId = LedgerProjectId.make("project:j5:cascade");
const captainThread = ThreadId.make("thread:captain");
const seatThread = ThreadId.make("thread:seat");
const crew = (id: string, archivedAt: string | null): AgentCrewInstance => ({
  id,
  projectId,
  captainParticipantId: participantIdForThread(captainThread),
  captainThreadId: captainThread,
  displayName: id,
  brief: "Land it.",
  version: 1,
  createdAt: "2026-09-15T10:00:00.000Z",
  archivedAt,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: ParticipantId.make("agent:j5:a2a:thread:seat"),
      threadId: seatThread,
      addedVersion: 1,
      reason: null,
    },
  ],
});
const archivedEvent = (
  threadId: ThreadId,
  type = "thread.archived",
  id = "event:archive",
): OrchestrationV2StoredEvent =>
  ({ sequence: 1, commandId: null, event: { id, type, threadId } }) as never;
const captainProjection = (archivedAt: string | null, deletedAt: string | null = null) =>
  ({
    thread: {
      id: captainThread,
      archivedAt: archivedAt === null ? null : DateTime.makeUnsafe(archivedAt),
      deletedAt: deletedAt === null ? null : DateTime.makeUnsafe(deletedAt),
    },
  }) as unknown as OrchestrationV2ThreadProjection;
const noThreads = Layer.mock(ThreadManagementService)({});

it.effect("retires the live Crews a Captain commanded when the person archives its thread", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ArchiveCrewInput>>([]);
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            listInvolving: (input) =>
              Effect.succeed(
                input.threadIds.includes(captainThread)
                  ? [crew("crew:live", null), crew("crew:old", "2026-09-14T00:00:00.000Z")]
                  : [],
              ),
          }),
          Layer.mock(ArchiveCrewService)({
            archive: (input) =>
              Ref.update(calls, (items) => [...items, input]).pipe(
                Effect.as({ status: "archived" as const, members: [] }),
              ),
          }),
          noThreads,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      // A seat's own archive commands nothing; unrelated events are ignored.
      assert.isNull(yield* cascade.handleStoredEvent(archivedEvent(seatThread)));
      assert.isNull(yield* cascade.handleStoredEvent(archivedEvent(captainThread, "run.updated")));
      assert.deepStrictEqual(yield* cascade.handleStoredEvent(archivedEvent(captainThread)), [
        "crew:live",
      ]);
      const [call] = yield* Ref.get(calls);
      assert.isNull(call?.callerParticipantId);
      assert.isTrue(call?.confirmationSatisfied);
      // Recorded as retired with its Captain, so the Captain's unarchive brings it back.
      assert.isTrue(call?.withCaptain);
      assert.equal(call?.crewInstanceId, "crew:live");
      // Same event, same command ids: a replayed event converges.
      const again = yield* cascade.handleStoredEvent(archivedEvent(captainThread));
      assert.deepStrictEqual(again, ["crew:live"]);
      const [first, second] = yield* Ref.get(calls);
      assert.equal(
        first?.commandIds("builder").archiveCommandId,
        second?.commandIds("builder").archiveCommandId,
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "the boot sweep retires live Crews whose Captain is archived or gone, and no others",
  () =>
    Effect.gen(function* () {
      const goneCaptain = ThreadId.make("thread:gone-captain");
      const liveCaptain = ThreadId.make("thread:live-captain");
      const unreadable = ThreadId.make("thread:unreadable-captain");
      const commanded = (id: string, captain: ThreadId): AgentCrewInstance => ({
        ...crew(id, null),
        captainThreadId: captain,
        captainParticipantId: participantIdForThread(captain),
      });
      const calls = yield* Ref.make<ReadonlyArray<ArchiveCrewInput>>([]);
      const layer = cascadeLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentCrewInstanceService)({
              listLive: () =>
                Effect.succeed([
                  crew("crew:archived-captain", null),
                  commanded("crew:gone-captain", goneCaptain),
                  commanded("crew:live-captain", liveCaptain),
                  commanded("crew:unreadable", unreadable),
                ]),
            }),
            Layer.mock(ArchiveCrewService)({
              // The first orphaned Crew will not retire; the sweep must still reach the second.
              archive: (input) =>
                Ref.update(calls, (items) => [...items, input]).pipe(
                  Effect.flatMap(() =>
                    input.crewInstanceId === "crew:archived-captain"
                      ? Effect.die(new Error("a seat refused to archive"))
                      : Effect.succeed({ status: "archived" as const, members: [] }),
                  ),
                ),
            }),
            Layer.mock(ThreadManagementService)({
              getThreadProjection: (threadId) =>
                threadId === captainThread
                  ? Effect.succeed(captainProjection("2026-09-17T08:00:00.000Z"))
                  : threadId === liveCaptain
                    ? Effect.succeed(captainProjection(null))
                    : threadId === goneCaptain
                      ? Effect.succeed(captainProjection(null, "2026-09-17T08:30:00.000Z"))
                      : Effect.die(new Error("projection store unavailable")),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const cascade = yield* CrewCaptainArchiveCascade;
        const retired = yield* cascade.reconcile;
        // Both orphaned Crews were attempted once; the one whose archive failed is left for the
        // next boot rather than aborting the sweep before the second.
        assert.deepStrictEqual(retired, ["crew:gone-captain"]);
        assert.deepStrictEqual(
          (yield* Ref.get(calls)).map((call) => call.crewInstanceId),
          ["crew:archived-captain", "crew:gone-captain"],
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("a Crew whose retirement fails is tried once, and the next Crew still retires", () =>
  Effect.gen(function* () {
    const calls: Array<ArchiveCrewInput> = [];
    const testLayer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            listInvolving: () => Effect.succeed([crew("crew:broken", null), crew("crew:ok", null)]),
          }),
          Layer.mock(ArchiveCrewService)({
            archive: (input) =>
              Effect.suspend(() => {
                calls.push(input);
                return input.crewInstanceId === "crew:broken"
                  ? Effect.die("archive failure")
                  : Effect.succeed({ status: "archived" as const, members: [] });
              }),
          }),
          noThreads,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      assert.deepStrictEqual(yield* cascade.handleStoredEvent(archivedEvent(captainThread)), [
        "crew:ok",
      ]);
      assert.deepStrictEqual(
        calls.map((call) => call.crewInstanceId),
        ["crew:broken", "crew:ok"],
      );
    }).pipe(Effect.provide(testLayer));
  }),
);

const criticThread = ThreadId.make("thread:critic");
const pair = (id: string, archivedAt: string | null): AgentCrewInstance => {
  const base = crew(id, archivedAt);
  return {
    ...base,
    members: [
      ...base.members,
      {
        seatName: "critic",
        agentId: "critic",
        participantId: ParticipantId.make("agent:j5:a2a:thread:critic"),
        threadId: criticThread,
        addedVersion: 1,
        reason: null,
      },
    ],
  };
};
const seatAt = "2026-09-17T09:00:00.000Z";
const seatProjection = (
  threadId: ThreadId,
  facts: {
    settledOverride?: "settled" | "active" | null;
    archivedAt?: string | null;
    pendingRequest?: boolean;
    running?: boolean;
    pinnedAt?: string;
    snoozedUntil?: string;
    autoSettleDisabledAt?: string;
    userMessageAt?: string;
  } = {},
) =>
  ({
    thread: {
      id: threadId,
      archivedAt: facts.archivedAt ?? null,
      deletedAt: null,
      settledOverride: facts.settledOverride ?? null,
      settledAt: facts.settledOverride === "settled" ? DateTime.makeUnsafe(seatAt) : null,
      pinnedAt: facts.pinnedAt === undefined ? null : DateTime.makeUnsafe(facts.pinnedAt),
      snoozedUntil:
        facts.snoozedUntil === undefined ? null : DateTime.makeUnsafe(facts.snoozedUntil),
      snoozedAt: facts.snoozedUntil === undefined ? null : DateTime.makeUnsafe(seatAt),
      autoSettleDisabledAt:
        facts.autoSettleDisabledAt === undefined
          ? null
          : DateTime.makeUnsafe(facts.autoSettleDisabledAt),
    },
    runs: facts.running
      ? [
          {
            id: "run:seat",
            ordinal: 1,
            status: "running",
            requestedAt: DateTime.makeUnsafe(seatAt),
            startedAt: DateTime.makeUnsafe(seatAt),
            completedAt: null,
          },
        ]
      : [],
    runtimeRequests: facts.pendingRequest
      ? [
          {
            id: "request:seat",
            kind: "user_input",
            status: "pending",
            createdAt: DateTime.makeUnsafe(seatAt),
            responseCapability: { type: "live", providerSessionId: "session:seat" },
          },
        ]
      : [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    messages:
      facts.userMessageAt === undefined
        ? []
        : [
            {
              id: "message:seat",
              role: "user",
              text: "Next step",
              createdBy: "user",
              updatedAt: DateTime.makeUnsafe(facts.userMessageAt),
            },
          ],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: DateTime.makeUnsafe(seatAt),
  }) as unknown as OrchestrationV2ThreadProjection;
const lifecycleEvent = (id: string, type: string, threadId = captainThread) =>
  ({ sequence: 1, commandId: null, event: { id, type, threadId } }) as never;

it.effect("settling a Captain settles its Crew's seats, and unsettling it unsettles them", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            listInvolving: () =>
              Effect.succeed([
                pair("crew:live", null),
                pair("crew:old", "2026-09-14T00:00:00.000Z"),
              ]),
          }),
          Layer.mock(ArchiveCrewService)({}),
          Layer.mock(ThreadManagementService)({
            // The builder has not settled; the critic already has.
            getThreadProjection: (threadId) =>
              Effect.succeed(
                seatProjection(threadId, {
                  settledOverride: threadId === criticThread ? "settled" : null,
                }),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (items) => [...items, command]).pipe(
                Effect.as({ sequence: 1 } as never),
              ),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      // A seat's own settle commands nothing.
      assert.isNull(
        yield* cascade.handleStoredEvent(
          lifecycleEvent("event:seat", "thread.settled", seatThread),
        ),
      );
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:settle", "thread.settled")),
        ["crew:live"],
      );
      // A replayed event converges on the same command.
      yield* cascade.handleStoredEvent(lifecycleEvent("event:settle", "thread.settled"));
      const settles = yield* Ref.get(dispatched);
      assert.deepStrictEqual(
        settles.map((command) => [command.type, "threadId" in command ? command.threadId : null]),
        [
          ["thread.settle", seatThread],
          ["thread.settle", seatThread],
        ],
      );
      assert.equal(settles[0]?.commandId, settles[1]?.commandId);
      yield* Ref.set(dispatched, []);
      // Unsettle reaches only a seat that is settled; one that never settled keeps auto-settle.
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:unsettle", "thread.unsettled")),
        ["crew:live"],
      );
      const unsettles = yield* Ref.get(dispatched);
      assert.deepStrictEqual(
        unsettles.map((command) => [command.type, "threadId" in command ? command.threadId : null]),
        [["thread.unsettle", criticThread]],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("unarchiving a Captain brings back the Crews that retired with it", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const restored = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            // The store lists only Crews that retired with this Captain, never one retired alone.
            listRetiredWithCaptain: (threadId) =>
              Effect.succeed(
                threadId === captainThread
                  ? [pair("crew:with-captain", "2026-09-17T08:00:00.000Z")]
                  : [],
              ),
            restoreWithCaptain: (id) =>
              Ref.update(restored, (items) => [...items, id]).pipe(Effect.as(true)),
            serialize: (_id, effect) => effect,
          }),
          Layer.mock(ArchiveCrewService)({}),
          Layer.mock(ThreadManagementService)({
            // The builder's thread was archived with the Crew; the critic's was never created.
            getThreadProjection: (threadId) =>
              threadId === criticThread
                ? Effect.fail(
                    new OrchestratorProjectionError({
                      threadId,
                      cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                    }),
                  )
                : Effect.succeed(
                    seatProjection(threadId, { archivedAt: "2026-09-17T08:00:00.000Z" }),
                  ),
            dispatch: (command) =>
              Ref.update(dispatched, (items) => [...items, command]).pipe(
                Effect.as({ sequence: 1 } as never),
              ),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      assert.isNull(
        yield* cascade.handleStoredEvent(
          lifecycleEvent("event:other", "thread.unarchived", seatThread),
        ),
      );
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:unarchive", "thread.unarchived")),
        ["crew:with-captain"],
      );
      assert.deepStrictEqual(
        (yield* Ref.get(dispatched)).map((command) => [
          command.type,
          "threadId" in command ? command.threadId : null,
        ]),
        [["thread.unarchive", seatThread]],
      );
      assert.deepStrictEqual(yield* Ref.get(restored), ["crew:with-captain"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a Captain archived again after an unarchive retires its Crew again", () =>
  Effect.gen(function* () {
    // The Crew record, its seat thread, and the command ids the orchestrator has already seen.
    const retiredAt = yield* Ref.make<string | null>(null);
    const seatArchived = yield* Ref.make(false);
    const seen = new Set<string>();
    const archiveIds: Array<string> = [];
    const current = Effect.map(Ref.get(retiredAt), (archivedAt) => crew("crew:live", archivedAt));
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            listInvolving: () => Effect.map(current, (instance) => [instance]),
            listRetiredWithCaptain: () =>
              Effect.map(current, (instance) => (instance.archivedAt === null ? [] : [instance])),
            restoreWithCaptain: () => Ref.set(retiredAt, null).pipe(Effect.as(true)),
            serialize: (_id, effect) => effect,
          }),
          Layer.mock(ArchiveCrewService)({
            // Mirrors the orchestrator: a command id it has seen replays its old receipt and
            // changes nothing, which leaves the seat live and fails the seat's archive.
            archive: (input) =>
              Effect.gen(function* () {
                const commandId = String(input.commandIds("builder").archiveCommandId);
                archiveIds.push(commandId);
                if (seen.has(commandId)) return yield* Effect.die("seat still live after replay");
                seen.add(commandId);
                yield* Ref.set(seatArchived, true);
                yield* Ref.set(retiredAt, input.archivedAt);
                return { status: "archived" as const, members: [] };
              }),
          }),
          Layer.mock(ThreadManagementService)({
            getThreadProjection: (threadId) =>
              Effect.map(Ref.get(seatArchived), (archived) =>
                seatProjection(threadId, {
                  archivedAt: archived ? "2026-09-17T08:00:00.000Z" : null,
                }),
              ),
            dispatch: (command) =>
              (command.type === "thread.unarchive"
                ? Ref.set(seatArchived, false)
                : Effect.void
              ).pipe(Effect.as({ sequence: 1 } as never)),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:archive-1", "thread.archived")),
        ["crew:live"],
      );
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:unarchive", "thread.unarchived")),
        ["crew:live"],
      );
      assert.isFalse(yield* Ref.get(seatArchived));
      assert.isNull(yield* Ref.get(retiredAt));
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:archive-2", "thread.archived")),
        ["crew:live"],
      );
      assert.isTrue(yield* Ref.get(seatArchived));
      assert.isNotNull(yield* Ref.get(retiredAt));
      assert.lengthOf(archiveIds, 2);
      assert.notEqual(archiveIds[0], archiveIds[1]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("settling a Captain leaves a seat that is waiting on the person or still running", () =>
  Effect.gen(function* () {
    const waitingThread = ThreadId.make("thread:waiting");
    const runningThread = ThreadId.make("thread:running");
    const trio: AgentCrewInstance = {
      ...crew("crew:busy", null),
      members: [
        ...crew("crew:busy", null).members,
        { ...crew("x", null).members[0]!, seatName: "waiting", threadId: waitingThread },
        { ...crew("x", null).members[0]!, seatName: "running", threadId: runningThread },
      ],
    };
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({ listInvolving: () => Effect.succeed([trio]) }),
          Layer.mock(ArchiveCrewService)({}),
          Layer.mock(ThreadManagementService)({
            getThreadProjection: (threadId) =>
              Effect.succeed(
                seatProjection(threadId, {
                  pendingRequest: threadId === waitingThread,
                  running: threadId === runningThread,
                }),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (items) => [...items, command]).pipe(
                Effect.as({ sequence: 1 } as never),
              ),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:settle", "thread.settled")),
        ["crew:busy"],
      );
      // Only the idle seat settles, as upstream's auto-settle would have it.
      assert.deepStrictEqual(
        (yield* Ref.get(dispatched)).map((command) => [
          command.type,
          "threadId" in command ? command.threadId : null,
        ]),
        [["thread.settle", seatThread]],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "settling a Captain leaves the seats upstream's auto-settle would, except ones only held off automatic settling",
  () =>
    Effect.gen(function* () {
      const seats = {
        pinned: ThreadId.make("thread:pinned"),
        snoozed: ThreadId.make("thread:snoozed"),
        queued: ThreadId.make("thread:queued"),
        optedOut: ThreadId.make("thread:opted-out"),
        unsettled: ThreadId.make("thread:unsettled"),
      };
      const member = crew("x", null).members[0]!;
      const instance: AgentCrewInstance = {
        ...crew("crew:mixed", null),
        members: Object.entries(seats).map(([seatName, threadId]) => ({
          ...member,
          seatName,
          threadId,
        })),
      };
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
      const layer = cascadeLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentCrewInstanceService)({
              listInvolving: () => Effect.succeed([instance]),
            }),
            Layer.mock(ArchiveCrewService)({}),
            Layer.mock(ThreadManagementService)({
              getThreadProjection: (threadId) =>
                Effect.succeed(
                  seatProjection(
                    threadId,
                    threadId === seats.pinned
                      ? { pinnedAt: seatAt }
                      : threadId === seats.snoozed
                        ? { snoozedUntil: "2026-09-18T09:00:00.000Z" }
                        : threadId === seats.queued
                          ? // Sent a minute ago; no run has picked it up yet.
                            { userMessageAt: "2026-09-17T09:59:00.000Z" }
                          : threadId === seats.unsettled
                            ? // What the cascade's own unsettle leaves on a seat.
                              { settledOverride: "active" }
                            : { autoSettleDisabledAt: seatAt },
                  ),
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (items) => [...items, command]).pipe(
                  Effect.as({ sequence: 1 } as never),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-09-17T10:00:00.000Z"));
        const cascade = yield* CrewCaptainArchiveCascade;
        yield* cascade.handleStoredEvent(lifecycleEvent("event:settle", "thread.settled"));
        // No settle reaches the pinned seat, so it keeps its pin; the snoozed and about-to-start
        // seats are left alone too. The opt-out and an earlier unsettle do not hold a seat back.
        assert.deepStrictEqual(
          (yield* Ref.get(dispatched)).map((command) => [
            command.type,
            "threadId" in command ? command.threadId : null,
          ]),
          [
            ["thread.settle", seats.optedOut],
            ["thread.settle", seats.unsettled],
          ],
        );
      }).pipe(Effect.provide(layer));
    }),
);
