import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  A2AHomeRegistrar,
  participantIdForThread,
  threadIdForParticipant,
  layer as homeRegistrarLayer,
} from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { CommCommandId, ParticipantId, LedgerProjectId } from "./contracts.ts";

const createdAt = "2026-08-19T15:30:00.000Z";

it("reads an agent's thread back out of its participant id, and nothing else's", () => {
  const threadId = ThreadId.make("thread:j5:a2a:mcp:session:spawn:1");
  assert.equal(threadIdForParticipant(participantIdForThread(threadId)), threadId);
  for (const other of ["human:local", "machine:watchdog", "outside:session-1", "agent:j5:a2a:"])
    assert.isNull(threadIdForParticipant(other));
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const ledger = ledgerLayer.pipe(Layer.provide(database));
const registrar = homeRegistrarLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const testLayer = Layer.mergeAll(database, ledger, registrar);

const createProjectLedger = Effect.fn("test.j5.a2a.createProjectLedger")(function* (
  projectId: LedgerProjectId,
) {
  const ledgerService = yield* A2ALedger;
  yield* ledgerService.ensureProject({ projectId: projectId, createdAt });
});

const countJoined = Effect.fn("test.j5.a2a.countJoined")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_comm_event
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.threadId') = ${threadId}
  `;
  return rows[0]?.count ?? 0;
});

it.effect("registers one immutable home with the authoritative creation inputs", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:registrar:initial");
    const threadId = ThreadId.make("thread:registrar:initial");
    const commandId = CommCommandId.make("command:registrar:initial");
    yield* createProjectLedger(projectId);

    const home = yield* service.registerAtCreation({
      projectId,
      threadId,
      createdAt,
      commandId,
    });

    assert.deepStrictEqual(home, {
      projectId,
      participantId: participantIdForThread(threadId),
    });
    const events = yield* sql<{
      readonly command_id: string;
      readonly created_at: string;
      readonly receiver: string;
      readonly project_id: string;
    }>`
      SELECT command_id, created_at, receiver, project_id
      FROM j5_a2a_comm_event
      WHERE kind = 'participant.joined'
    `;
    assert.deepStrictEqual(events, [
      {
        command_id: commandId,
        created_at: createdAt,
        receiver: home.participantId,
        project_id: projectId,
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replays the exact creation key without appending a second join", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const projectId = LedgerProjectId.make("project:registrar:replay");
    const threadId = ThreadId.make("thread:registrar:replay");
    const input = {
      projectId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:replay"),
    };
    yield* createProjectLedger(projectId);

    const initial = yield* service.registerAtCreation(input);
    const replay = yield* service.registerAtCreation(input);

    assert.deepStrictEqual(replay, initial);
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("returns the same durable home when a fresh command id repeats its creation", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const projectId = LedgerProjectId.make("project:registrar:fresh-command-replay");
    const threadId = ThreadId.make("thread:registrar:fresh-command-replay");
    yield* createProjectLedger(projectId);

    const initial = yield* service.registerAtCreation({
      projectId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:fresh-command-replay:initial"),
    });
    const replay = yield* service.registerAtCreation({
      projectId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:fresh-command-replay:retry"),
    });

    assert.deepStrictEqual(replay, initial);
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "retains an encoded historical participant id when creation retries after the format change",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const service = yield* A2AHomeRegistrar;
      const ledgerService = yield* A2ALedger;
      const projectId = LedgerProjectId.make("project:registrar:historical-id");
      const threadId = ThreadId.make("thread:registrar:historical-id");
      const historicalId = ParticipantId.make("agent:j5:a2a:thread%3Aregistrar%3Ahistorical-id");
      yield* createProjectLedger(projectId);
      yield* ledgerService.append({
        commandId: CommCommandId.make("command:registrar:historical-id:original"),
        projectId,
        acceptedAt: createdAt,
        event: {
          kind: "participant.joined",
          sender: null,
          receiver: historicalId,
          exchangeId: null,
          correlationId: null,
          payload: { participant: { kind: "agent", id: historicalId, threadId } },
          createdAt,
        },
      });

      const replay = yield* service.registerAtCreation({
        projectId,
        threadId,
        createdAt,
        commandId: CommCommandId.make("command:registrar:historical-id:retry"),
      });

      assert.equal(participantIdForThread(threadId), "agent:j5:a2a:thread:registrar:historical-id");
      assert.deepStrictEqual(replay, { projectId, participantId: historicalId });
      assert.equal(yield* countJoined(threadId), 1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "returns the existing home for a replay and rejects the command id on another thread",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const service = yield* A2AHomeRegistrar;
      const projectId = LedgerProjectId.make("project:registrar:command-conflict");
      const threadId = ThreadId.make("thread:registrar:command-conflict");
      const otherThreadId = ThreadId.make("thread:registrar:command-conflict:other");
      const commandId = CommCommandId.make("command:registrar:command-conflict");
      yield* createProjectLedger(projectId);
      const home = yield* service.registerAtCreation({
        projectId,
        threadId,
        createdAt,
        commandId,
      });

      // A thread that already has a home keeps it: later creation inputs are not compared.
      const replay = yield* service.registerAtCreation({
        projectId,
        threadId,
        createdAt: "2026-08-19T15:30:01.000Z",
        commandId,
      });
      assert.deepStrictEqual(replay, home);
      assert.equal(yield* countJoined(threadId), 1);

      const error = yield* Effect.flip(
        service.registerAtCreation({ projectId, threadId: otherThreadId, createdAt, commandId }),
      );

      assert.equal(error._tag, "A2AHomeCommandConflictError");
      assert.equal(yield* countJoined(threadId), 1);
      assert.equal(yield* countJoined(otherThreadId), 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a conflicting home without appending into the requested project", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const existingProjectId = LedgerProjectId.make("project:registrar:existing");
    const requestedProjectId = LedgerProjectId.make("project:registrar:requested");
    const threadId = ThreadId.make("thread:registrar:conflict");
    yield* createProjectLedger(existingProjectId);
    yield* createProjectLedger(requestedProjectId);
    yield* service.registerAtCreation({
      projectId: existingProjectId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:existing"),
    });

    const error = yield* Effect.flip(
      service.registerAtCreation({
        projectId: requestedProjectId,
        threadId,
        createdAt,
        commandId: CommCommandId.make("command:registrar:requested"),
      }),
    );

    assert.equal(error._tag, "A2AHomeConflictError");
    if (error._tag === "A2AHomeConflictError") {
      assert.equal(error.existingProjectId, existingProjectId);
      assert.equal(error.requestedProjectId, requestedProjectId);
    }
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects an existing home before validating a different requested project", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const existingProjectId = LedgerProjectId.make("project:registrar:precheck-existing");
    const requestedProjectId = LedgerProjectId.make("project:registrar:precheck-missing");
    const threadId = ThreadId.make("thread:registrar:precheck-conflict");
    yield* createProjectLedger(existingProjectId);
    yield* service.registerAtCreation({
      projectId: existingProjectId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:precheck-existing"),
    });

    const error = yield* Effect.flip(
      service.registerAtCreation({
        projectId: requestedProjectId,
        threadId,
        createdAt,
        commandId: CommCommandId.make("command:registrar:precheck-requested"),
      }),
    );

    assert.equal(error._tag, "A2AHomeConflictError");
    if (error._tag === "A2AHomeConflictError") {
      assert.equal(error.existingProjectId, existingProjectId);
      assert.equal(error.requestedProjectId, requestedProjectId);
    }
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("distinguishes no home and exact replay does not reactivate ended membership", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const ledgerService = yield* A2ALedger;
    const projectId = LedgerProjectId.make("project:registrar:lookup");
    const threadId = ThreadId.make("thread:registrar:lookup");
    yield* createProjectLedger(projectId);

    const missing = yield* Effect.flip(service.getHomeForThread(threadId));
    assert.equal(missing._tag, "A2AHomeNotFoundError");
    const registration = {
      projectId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:lookup"),
    };
    const home = yield* service.registerAtCreation(registration);
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:registrar:lookup:left"),
      projectId,
      acceptedAt: createdAt,
      event: {
        kind: "participant.left",
        sender: home.participantId,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: {
          participant: { kind: "agent", id: home.participantId, threadId },
        },
        createdAt,
      },
    });

    assert.deepStrictEqual(yield* service.getHomeForThread(threadId), home);
    assert.deepStrictEqual(yield* service.registerAtCreation(registration), home);
    assert.deepStrictEqual(yield* ledgerService.listMembership(projectId), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("recovers a conflicting home committed between precheck and append", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      const sql = Context.get(databaseContext, SqlClient.SqlClient);
      const databaseLayer = Layer.succeed(SqlClient.SqlClient, sql);
      yield* runJ5A2AMigrations().pipe(Effect.provide(databaseLayer));
      const ledgerContext = yield* Layer.build(ledgerLayer.pipe(Layer.provide(databaseLayer)));
      const realLedger = Context.get(ledgerContext, A2ALedger);
      const appendEntered = yield* Deferred.make<void>();
      const releaseAppend = yield* Deferred.make<void>();
      const requestedProjectId = LedgerProjectId.make("project:registrar:race:requested");
      const winningProjectId = LedgerProjectId.make("project:registrar:race:winner");
      const threadId = ThreadId.make("thread:registrar:race");
      yield* realLedger.ensureProject({ projectId: requestedProjectId, createdAt });
      yield* realLedger.ensureProject({ projectId: winningProjectId, createdAt });

      const blockedLedger = A2ALedger.of({
        ...realLedger,
        appendEvents: (command) =>
          Deferred.succeed(appendEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseAppend)),
            Effect.andThen(realLedger.appendEvents(command)),
          ),
      });
      const registrarContext = yield* Layer.build(
        homeRegistrarLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(A2ALedger, blockedLedger),
              Layer.succeed(SqlClient.SqlClient, sql),
            ),
          ),
        ),
      );
      const blockedRegistrar = Context.get(registrarContext, A2AHomeRegistrar);
      const registrationFiber = yield* blockedRegistrar
        .registerAtCreation({
          projectId: requestedProjectId,
          threadId,
          createdAt,
          commandId: CommCommandId.make("command:registrar:race:requested"),
        })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(appendEntered);
      yield* realLedger.append({
        commandId: CommCommandId.make("command:registrar:race:winner"),
        projectId: winningProjectId,
        acceptedAt: createdAt,
        event: {
          kind: "participant.joined",
          sender: null,
          receiver: participantIdForThread(threadId),
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: {
              kind: "agent",
              id: participantIdForThread(threadId),
              threadId,
            },
          },
          createdAt,
        },
      });
      yield* Deferred.succeed(releaseAppend, undefined);

      const outcome = yield* Fiber.join(registrationFiber);
      assert.equal(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.equal(outcome.failure._tag, "A2AHomeConflictError");
        if (outcome.failure._tag === "A2AHomeConflictError") {
          assert.equal(outcome.failure.existingProjectId, winningProjectId);
          assert.equal(outcome.failure.requestedProjectId, requestedProjectId);
        }
      }
      const joined = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM j5_a2a_comm_event
        WHERE kind = 'participant.joined'
          AND json_extract(payload, '$.participant.threadId') = ${threadId}
      `;
      assert.equal(joined[0]?.count, 1);
    }),
  ),
);

it.effect("enforces one historical agent home at the database boundary", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledgerService = yield* A2ALedger;
    const firstProjectId = LedgerProjectId.make("project:registrar:index:first");
    const secondProjectId = LedgerProjectId.make("project:registrar:index:second");
    const threadId = ThreadId.make("thread:registrar:index");
    yield* createProjectLedger(firstProjectId);
    yield* createProjectLedger(secondProjectId);

    yield* ledgerService.append({
      commandId: CommCommandId.make("command:registrar:index:first"),
      projectId: firstProjectId,
      acceptedAt: createdAt,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: ParticipantId.make("agent:registrar:index:first"),
        exchangeId: null,
        correlationId: null,
        payload: {
          participant: {
            kind: "agent",
            id: ParticipantId.make("agent:registrar:index:first"),
            threadId,
          },
        },
        createdAt,
      },
    });
    const error = yield* Effect.flip(
      ledgerService.append({
        commandId: CommCommandId.make("command:registrar:index:second"),
        projectId: secondProjectId,
        acceptedAt: createdAt,
        event: {
          kind: "participant.joined",
          sender: null,
          receiver: ParticipantId.make("agent:registrar:index:second"),
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: {
              kind: "agent",
              id: ParticipantId.make("agent:registrar:index:second"),
              threadId,
            },
          },
          createdAt,
        },
      }),
    );

    assert.equal(error._tag, "A2AStorageError");
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("opens the project ledger for a project's first participant", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:registrar:missing");
    const threadId = ThreadId.make("thread:registrar:missing-project");

    const home = yield* service.registerAtCreation({
      projectId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:missing-project"),
    });

    assert.deepStrictEqual(home, { projectId, participantId: participantIdForThread(threadId) });
    assert.deepStrictEqual(yield* sql`SELECT project_id, created_at FROM j5_a2a_project_ledger`, [
      { project_id: projectId, created_at: createdAt },
    ]);
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);
