import { assert, it } from "@effect/vitest";
import { CommandId, ProviderSessionId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import {
  ArchiveAgentOperationError,
  ArchiveAgentService,
  type ArchiveAgentInput,
  type ArchiveAgentTargetFacts,
} from "./ArchiveAgentService.ts";
import {
  ArchiveCrewConfirmationRequiredError,
  ArchiveCrewConfirmationStaleError,
  ArchiveCrewNotCaptainError,
  ArchiveCrewPartialFailureError,
  ArchiveCrewService,
  layer as archiveCrewLayer,
  type ArchiveCrewInput,
} from "./ArchiveCrewService.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { ExchangeId, ParticipantId, LedgerProjectId } from "./contracts.ts";
import { CrewWorktrees } from "./CrewWorktrees.ts";
import type { CrewArchiveWorktree } from "@t3tools/contracts/j5";

const projectId = LedgerProjectId.make("project:j5:archive-crew");
const captain = ParticipantId.make("agent:j5:a2a:captain");
const builder = ParticipantId.make("agent:j5:a2a:thread:builder");
const critic = ParticipantId.make("agent:j5:a2a:thread:critic");
const instance: AgentCrewInstance = {
  id: "crew:j5:test",
  projectId,
  captainParticipantId: captain,
  captainThreadId: ThreadId.make("t:captain"),
  brief: "Implement and review the login fix.",
  version: 1,
  displayName: "Review Pair",
  createdAt: "2026-09-09T16:00:00.000Z",
  archivedAt: null,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: builder,
      threadId: ThreadId.make("t:b"),
      addedVersion: 1,
      reason: null,
    },
    {
      seatName: "critic",
      agentId: "critic",
      participantId: critic,
      threadId: ThreadId.make("t:c"),
      addedVersion: 1,
      reason: null,
    },
  ],
};
const openExchange = {
  exchangeId: ExchangeId.make("exchange:j5:archive-crew"),
  direction: "inbound" as const,
  replyObligation: "participant-owes-reply" as const,
  counterpartyId: captain,
  intent: "Review the fix",
  urgency: null,
  openedAt: "2026-09-09T16:05:00.000Z",
};

const fixture = Effect.gen(function* () {
  // A null entry is a seat whose thread never came to exist.
  const facts = yield* Ref.make<Record<string, ArchiveAgentTargetFacts | null>>({
    [builder]: {
      facts: { openExchanges: [openExchange], runningTurn: null },
      threadArchived: false,
      retired: false,
    },
    [critic]: {
      facts: { openExchanges: [], runningTurn: { runId: RunId.make("run:c"), status: "running" } },
      threadArchived: false,
      retired: false,
    },
  });
  const archived = yield* Ref.make<ReadonlyArray<ArchiveAgentInput>>([]);
  const failSeat = yield* Ref.make<ParticipantId | null>(null);
  // A seat whose facts the store cannot read at all.
  const unreadableSeat = yield* Ref.make<ParticipantId | null>(null);
  const marked = yield* Ref.make<ReadonlyArray<string>>([]);
  const crewArchivedAt = yield* Ref.make<string | null>(null);
  // The order of cancels and retired stamps, so a test can see the run ends before the stamp.
  const lifecycle = yield* Ref.make<ReadonlyArray<string>>([]);
  // What cleanup was asked about, and what it reports back.
  const cleanedSeats = yield* Ref.make<ReadonlyArray<ReadonlyArray<ThreadId>>>([]);
  const cleanupResult = yield* Ref.make<ReadonlyArray<CrewArchiveWorktree>>([]);
  const approvalStamps = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  // The retired stamps and playbook cancels that had already happened when cleanup was asked.
  const lifecycleAtCleanup = yield* Ref.make<ReadonlyArray<string>>([]);
  // The order of session reads, seat archives, session closes and cleanup passes.
  const sessionSteps = yield* Ref.make<ReadonlyArray<string>>([]);
  const openSessions = new Map<ThreadId, ProviderSessionId>([
    [ThreadId.make("t:b"), ProviderSessionId.make("session:b")],
  ]);
  const step = (name: string) => Ref.update(sessionSteps, (items) => [...items, name]);
  const layer = archiveCrewLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CrewWorktrees)({
          liveSessions: (seats) =>
            Effect.forEach(seats, (seat) => step(`read:${seat.threadId}`)).pipe(
              Effect.as(
                seats.flatMap((seat) => {
                  const providerSessionId = openSessions.get(seat.threadId);
                  return providerSessionId === undefined
                    ? []
                    : [{ threadId: seat.threadId, providerSessionId }];
                }),
              ),
            ),
          closeSessions: (sessions) =>
            Effect.forEach(sessions, (session) => step(`close:${session.providerSessionId}`)),
          cleanup: ({ seats, crew }) =>
            Effect.all([
              step("cleanup"),
              Ref.update(approvalStamps, (items) => [...items, crew?.archivedAt]),
              Ref.update(cleanedSeats, (items) => [...items, seats.map((seat) => seat.threadId)]),
              Ref.get(lifecycle).pipe(Effect.flatMap((seen) => Ref.set(lifecycleAtCleanup, seen))),
            ]).pipe(Effect.andThen(Ref.get(cleanupResult))),
        }),
        Layer.mock(ArchiveAgentService)({
          readFacts: (target) =>
            Effect.gen(function* () {
              if ((yield* Ref.get(unreadableSeat)) === target.participantId)
                return yield* new ArchiveAgentOperationError({
                  phase: "reading the target thread projection",
                  cause: new Error("database is locked"),
                });
              const current = (yield* Ref.get(facts))[target.participantId];
              return current === undefined ? yield* Effect.die("unknown seat") : current;
            }),
          archive: (input) =>
            Effect.gen(function* () {
              yield* step(`archive:${input.target.threadId}`);
              // Mirrors the real service: a retired member replays as already archived.
              if ((yield* Ref.get(facts))[input.target.participantId]?.retired)
                return "already_archived" as const;
              if ((yield* Ref.get(failSeat)) === input.target.participantId)
                return yield* new ArchiveAgentOperationError({
                  phase: "committing the target thread archive",
                  cause: new Error("injected"),
                });
              yield* Ref.update(archived, (items) => [...items, input]);
              yield* Ref.update(facts, (current) => ({
                ...current,
                [input.target.participantId]: {
                  facts: { openExchanges: [], runningTurn: null },
                  threadArchived: true,
                  retired: true,
                },
              }));
              return "archived" as const;
            }),
        }),
        Layer.mock(AgentCrewInstanceService)({
          serialize: (_id, effect) => effect,
          read: (id) =>
            Ref.get(crewArchivedAt).pipe(
              Effect.map((archivedAt) => (id === instance.id ? { ...instance, archivedAt } : null)),
            ),
          markArchived: (id, archivedAt) =>
            Effect.all(
              [
                Ref.update(marked, (items) => [...items, id]),
                Ref.update(lifecycle, (items) => [...items, `marked:${id}`]),
                Ref.set(crewArchivedAt, archivedAt),
              ],
              { discard: true },
            ),
          listForCaptain: (query) =>
            Ref.get(crewArchivedAt).pipe(
              Effect.map((archivedAt) =>
                query.captainParticipantId === captain ? [{ ...instance, archivedAt }] : [],
              ),
            ),
        }),
        Layer.mock(PlaybookStore)({
          cancelForCrew: (id) =>
            Ref.update(lifecycle, (items) => [...items, `cancelled:${id}`]).pipe(Effect.as([])),
        }),
        Layer.mock(ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
        }),
      ),
    ),
  );
  const input = (overrides: Partial<ArchiveCrewInput> = {}): ArchiveCrewInput => ({
    providerSessionId: "session",
    callerParticipantId: captain,
    projectId,
    crewInstanceId: instance.id,
    clientRequestKey: "archive-1",
    archivedAt: "2026-09-09T17:00:00.000Z",
    commandIds: (seat) => ({
      interruptCommandId: CommandId.make(`interrupt:${seat}`),
      archiveCommandId: CommandId.make(`archive:${seat}`),
    }),
    ...overrides,
  });
  return {
    layer,
    input,
    archived,
    failSeat,
    unreadableSeat,
    marked,
    facts,
    lifecycle,
    crewArchivedAt,
    cleanedSeats,
    cleanupResult,
    approvalStamps,
    lifecycleAtCleanup,
    sessionSteps,
  };
});

it.effect("refuses until the captain confirms every member's facts, then retires the unit", () =>
  Effect.gen(function* () {
    const { layer, input, archived, marked } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const refusal = yield* service.archive(input()).pipe(Effect.flip);
      assert.instanceOf(refusal, ArchiveCrewConfirmationRequiredError);
      if (!(refusal instanceof ArchiveCrewConfirmationRequiredError)) return;
      assert.deepStrictEqual(
        refusal.facts.members.map((member) => [
          member.seatName,
          member.facts.openExchanges.length,
          member.facts.runningTurn?.runId ?? null,
        ]),
        [
          ["builder", 1, null],
          ["critic", 0, "run:c"],
        ],
      );
      assert.include(refusal.message, "1 open exchange(s) and 1 running turn(s)");
      assert.include(refusal.message, "check with the user");
      assert.lengthOf(yield* Ref.get(archived), 0);

      const notCaptain = yield* service
        .archive(input({ callerParticipantId: builder }))
        .pipe(Effect.flip);
      assert.instanceOf(notCaptain, ArchiveCrewNotCaptainError);

      const garbage = yield* service
        .archive(input({ confirmationToken: "nope" }))
        .pipe(Effect.flip);
      assert.equal(garbage._tag, "ArchiveCrewConfirmationTokenError");

      const outcome = yield* service.archive(
        input({ confirmationToken: refusal.confirmationToken }),
      );
      assert.deepStrictEqual(outcome, {
        status: "archived",
        members: [
          { seatName: "builder", participantId: builder, result: "archived" },
          { seatName: "critic", participantId: critic, result: "archived" },
        ],
        worktrees: [],
      });
      const calls = yield* Ref.get(archived);
      assert.deepStrictEqual(
        calls.map((call) => [
          call.target.participantId,
          call.confirmationSatisfied,
          call.archiveCommandId,
        ]),
        [
          [builder, true, CommandId.make("archive:builder")],
          [critic, true, CommandId.make("archive:critic")],
        ],
      );
      assert.deepStrictEqual(yield* Ref.get(marked), [instance.id]);

      const replay = yield* service.archive(
        input({ confirmationToken: refusal.confirmationToken }),
      );
      assert.equal(replay.status, "already_archived");
      assert.lengthOf(yield* Ref.get(archived), 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("cancels the Crew's playbook run before the retired stamp, and again on a retry", () =>
  Effect.gen(function* () {
    const { layer, input, lifecycle } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      yield* service.archive(input({ confirmationSatisfied: true }));
      assert.deepStrictEqual(yield* Ref.get(lifecycle), [
        `cancelled:${instance.id}`,
        `marked:${instance.id}`,
      ]);
      // A crash after the stamp but before a cancel landed is repaired by the retry.
      const replay = yield* service.archive(input({ confirmationSatisfied: true }));
      assert.equal(replay.status, "already_archived");
      assert.deepStrictEqual(yield* Ref.get(lifecycle), [
        `cancelled:${instance.id}`,
        `marked:${instance.id}`,
        `cancelled:${instance.id}`,
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("the Captain cascade's archive cancels the Crew's playbook run too", () =>
  Effect.gen(function* () {
    const { layer, input, lifecycle } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      // CrewCaptainArchiveCascade.retire archives each Crew through this door with withCaptain.
      yield* service.archive(input({ confirmationSatisfied: true, withCaptain: true }));
      assert.deepStrictEqual(yield* Ref.get(lifecycle), [
        `cancelled:${instance.id}`,
        `marked:${instance.id}`,
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reports a partial failure by seat and finishes on retry with the same token", () =>
  Effect.gen(function* () {
    const { layer, input, archived, failSeat, marked } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const refusal = yield* service.archive(input()).pipe(Effect.flip);
      if (!(refusal instanceof ArchiveCrewConfirmationRequiredError)) return assert.fail();
      yield* Ref.set(failSeat, critic);
      const partial = yield* service
        .archive(input({ confirmationToken: refusal.confirmationToken }))
        .pipe(Effect.flip);
      assert.instanceOf(partial, ArchiveCrewPartialFailureError);
      if (partial instanceof ArchiveCrewPartialFailureError) {
        assert.deepStrictEqual(partial.archivedSeats, ["builder"]);
        assert.equal(partial.failedSeat, "critic");
        assert.include(partial.message, "same client_request_id and confirmation_token");
      }
      assert.deepStrictEqual(yield* Ref.get(marked), []);

      // Builder is retired now, so the current facts are a strict subset of the confirmed ones.
      yield* Ref.set(failSeat, null);
      const finished = yield* service.archive(
        input({ confirmationToken: refusal.confirmationToken }),
      );
      assert.equal(finished.status, "archived");
      assert.deepStrictEqual(
        (yield* Ref.get(archived)).map((call) => call.target.participantId),
        [builder, critic],
      );
      assert.deepStrictEqual(yield* Ref.get(marked), [instance.id]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("treats a token as stale when a member gains new work after confirmation", () =>
  Effect.gen(function* () {
    const { layer, input, facts, archived } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const refusal = yield* service.archive(input()).pipe(Effect.flip);
      if (!(refusal instanceof ArchiveCrewConfirmationRequiredError)) return assert.fail();
      yield* Ref.update(facts, (current) => ({
        ...current,
        [critic]: {
          ...current[critic]!,
          facts: {
            openExchanges: [{ ...openExchange, exchangeId: ExchangeId.make("exchange:new") }],
            runningTurn: null,
          },
        },
      }));
      const stale = yield* service
        .archive(input({ confirmationToken: refusal.confirmationToken }))
        .pipe(Effect.flip);
      assert.instanceOf(stale, ArchiveCrewConfirmationStaleError);
      if (stale instanceof ArchiveCrewConfirmationStaleError) {
        assert.isNotNull(stale.confirmationToken);
        assert.notEqual(stale.confirmationToken, refusal.confirmationToken);
      }
      assert.lengthOf(yield* Ref.get(archived), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retires the unit for a person whose dialog already listed every seat's facts", () =>
  Effect.gen(function* () {
    const { layer, input, archived, marked } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      // The person's archive dialog reads the same seat facts the Captain's refusal would carry.
      const before = yield* service.readCaptainFacts({ projectId, captainParticipantId: captain });
      assert.deepStrictEqual(
        before.map((entry) => [
          entry.instance.id,
          entry.facts.members.map((member) => [
            member.seatName,
            member.facts.openExchanges.length,
            member.facts.runningTurn !== null,
          ]),
        ]),
        [
          [
            instance.id,
            [
              ["builder", 1, false],
              ["critic", 0, true],
            ],
          ],
        ],
      );
      assert.deepStrictEqual(
        yield* service.readCaptainFacts({ projectId, captainParticipantId: builder }),
        [],
      );

      // No token is minted or checked: the person is not a participant and confirmed already.
      const outcome = yield* service.archive(
        input({ callerParticipantId: null, projectId: null, confirmationSatisfied: true }),
      );
      assert.equal(outcome.status, "archived");
      assert.deepStrictEqual(
        (yield* Ref.get(archived)).map((call) => [
          call.target.participantId,
          call.callerParticipantId,
          call.confirmationSatisfied,
        ]),
        [
          [builder, captain, true],
          [critic, captain, true],
        ],
      );
      assert.deepStrictEqual(yield* Ref.get(marked), [instance.id]);
      // Once retired, the Captain commands no live Crew and may be archived on its own.
      assert.deepStrictEqual(
        yield* service.readCaptainFacts({ projectId, captainParticipantId: captain }),
        [],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retires the unit past a seat whose thread was never created, and says so", () =>
  Effect.gen(function* () {
    const { layer, input, archived, marked, facts } = yield* fixture;
    yield* Ref.update(facts, (current) => ({ ...current, [critic]: null }));
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const outcome = yield* service.archive(
        input({ callerParticipantId: null, confirmationSatisfied: true }),
      );
      assert.deepStrictEqual(outcome, {
        status: "archived",
        members: [
          { seatName: "builder", participantId: builder, result: "archived" },
          { seatName: "critic", participantId: critic, result: "never_created" },
        ],
        worktrees: [],
      });
      assert.deepStrictEqual(
        (yield* Ref.get(archived)).map((call) => call.target.participantId),
        [builder],
      );
      assert.deepStrictEqual(yield* Ref.get(marked), [instance.id]);

      const replay = yield* service.archive(
        input({ callerParticipantId: null, confirmationSatisfied: true }),
      );
      assert.equal(replay.status, "already_archived");
      assert.deepStrictEqual(
        replay.members.map((member) => [member.seatName, member.result]),
        [
          ["builder", "already_archived"],
          ["critic", "never_created"],
        ],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "a seat whose facts cannot be read fails the unit instead of passing as never created",
  () =>
    Effect.gen(function* () {
      const { layer, input, archived, marked, unreadableSeat } = yield* fixture;
      yield* Ref.set(unreadableSeat, critic);
      yield* Effect.gen(function* () {
        const service = yield* ArchiveCrewService;
        const failure = yield* service
          .archive(input({ callerParticipantId: null, confirmationSatisfied: true }))
          .pipe(Effect.flip);
        assert.instanceOf(failure, ArchiveCrewPartialFailureError);
        if (!(failure instanceof ArchiveCrewPartialFailureError)) return;
        assert.equal(failure.failedSeat, "critic");
        assert.lengthOf(yield* Ref.get(archived), 0);
        assert.lengthOf(yield* Ref.get(marked), 0);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "cleans up worktrees once every seat is archived and the Crew is stamped, and reports the result",
  () =>
    Effect.gen(function* () {
      const { layer, input, lifecycleAtCleanup, cleanedSeats, cleanupResult } = yield* fixture;
      const reported: ReadonlyArray<CrewArchiveWorktree> = [
        { path: "/wt/builder", branch: "j5/builder", outcome: "removed", reason: null },
        { path: "/wt/critic", branch: "j5/critic", outcome: "kept", reason: "unmerged_commits" },
      ];
      yield* Ref.set(cleanupResult, reported);
      yield* Effect.gen(function* () {
        const service = yield* ArchiveCrewService;
        const outcome = yield* service.archive(
          input({ callerParticipantId: null, confirmationSatisfied: true }),
        );
        assert.deepStrictEqual(outcome.worktrees, reported);
        assert.deepStrictEqual(yield* Ref.get(cleanedSeats), [
          [ThreadId.make("t:b"), ThreadId.make("t:c")],
        ]);
        // The archive is committed, and the Crew stamped, before anything is removed.
        assert.include(yield* Ref.get(lifecycleAtCleanup), `marked:${instance.id}`);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("closes each seat's session after its archive and before the worktree cleanup", () =>
  Effect.gen(function* () {
    const { layer, input, sessionSteps } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      yield* service.archive(input({ callerParticipantId: null, confirmationSatisfied: true }));
      // The session is read before the seat's archive removes its binding, closed once every
      // seat is archived, and the cleanup comes last.
      assert.deepStrictEqual(yield* Ref.get(sessionSteps), [
        "read:t:b",
        "archive:t:b",
        "read:t:c",
        "archive:t:c",
        "close:session:b",
        "cleanup",
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a replay of an archived Crew checks its worktrees again", () =>
  Effect.gen(function* () {
    const { layer, input, cleanedSeats, cleanupResult, approvalStamps } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      yield* service.archive(input({ callerParticipantId: null, confirmationSatisfied: true }));
      yield* Ref.set(cleanupResult, [
        { path: "/wt/critic", branch: "j5/critic", outcome: "removed", reason: null },
      ]);
      const replay = yield* service.archive(
        input({
          callerParticipantId: null,
          confirmationSatisfied: true,
          archivedAt: "2026-09-10T08:00:00.000Z",
        }),
      );
      assert.equal(replay.status, "already_archived");
      // The replay is the same archive, so an approval it would file carries the original stamp.
      assert.deepStrictEqual(yield* Ref.get(approvalStamps), [
        "2026-09-09T17:00:00.000Z",
        "2026-09-09T17:00:00.000Z",
      ]);
      assert.deepStrictEqual(
        replay.worktrees.map((entry) => entry.outcome),
        ["removed"],
      );
      assert.lengthOf(yield* Ref.get(cleanedSeats), 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a seat that never came to exist is not looked at for a worktree", () =>
  Effect.gen(function* () {
    const { layer, input, facts, cleanedSeats } = yield* fixture;
    yield* Ref.update(facts, (current) => ({ ...current, [critic]: null }));
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      yield* service.archive(input({ callerParticipantId: null, confirmationSatisfied: true }));
      assert.deepStrictEqual(yield* Ref.get(cleanedSeats), [[ThreadId.make("t:b")]]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a failed archive removes nothing", () =>
  Effect.gen(function* () {
    const { layer, input, failSeat, cleanedSeats } = yield* fixture;
    yield* Ref.set(failSeat, critic);
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const failure = yield* service
        .archive(input({ callerParticipantId: null, confirmationSatisfied: true }))
        .pipe(Effect.flip);
      assert.instanceOf(failure, ArchiveCrewPartialFailureError);
      assert.lengthOf(yield* Ref.get(cleanedSeats), 0);
    }).pipe(Effect.provide(layer));
  }),
);
