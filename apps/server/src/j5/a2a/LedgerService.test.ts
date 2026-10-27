import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  A2ALedger,
  A2AStorageError,
  LedgerGapError,
  layer as ledgerLayer,
} from "./LedgerService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  CommCommandId,
  CorrelationId,
  MessageSentPayload,
  ProjectLedger,
  LedgerProjectId,
  LedgerMessageId,
  ParticipantId,
  type AppendCommEventCommand,
  type CommEvent,
  type LedgerCursor,
} from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";
const isProject = Schema.is(ProjectLedger);
const decodeMessageSentPayload = Schema.decodeUnknownSync(MessageSentPayload);
const isLedgerGapError = Schema.is(LedgerGapError);
const isA2AStorageError = Schema.is(A2AStorageError);

const memoryLedgerLayer = () =>
  ledgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));

const fileLedgerLayer = (filename: string) =>
  ledgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));

const messageEvent = (index: number): CommEvent => ({
  kind: "silence.notice",
  sender: ParticipantId.make("agent:sender"),
  receiver: ParticipantId.make("agent:receiver"),
  exchangeId: null,
  correlationId: null,
  payload: { index },
  createdAt: timestamp,
});

it.effect("routes single-event append through command ids and A2 projections", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:single-append-projection");
    const commandId = CommCommandId.make("command:single-append-projection");
    const messageId = LedgerMessageId.make("message:single-append-projection");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    yield* ledger.append({
      commandId,
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "message.sent",
        sender: ParticipantId.make("agent:single:sender"),
        receiver: ParticipantId.make("agent:single:receiver"),
        exchangeId: null,
        correlationId: CorrelationId.make("correlation:single-append-projection"),
        payload: {
          messageId,
          text: "Single append remains deliverable.",
          originProjectId: projectId,
          receiverProjectId: projectId,
          exchangeRole: "none",
          envelopeChannel: "peer",
        },
        createdAt: timestamp,
      },
    });

    const rows = yield* sql<{
      readonly command_id: string;
      readonly message_id: string;
      readonly status: string;
    }>`
      SELECT command_id, message_id, status
      FROM j5_a2a_delivery
      WHERE message_id = ${messageId}
    `;
    assert.deepStrictEqual(rows, [
      { command_id: commandId, message_id: messageId, status: "pending" },
    ]);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

const appendCommand = (
  projectId: LedgerProjectId,
  index: number,
  event: CommEvent = messageEvent(index),
): AppendCommEventCommand => ({
  commandId: CommCommandId.make(`command:${projectId}:${index}`),
  projectId,
  acceptedAt: timestamp,
  event,
});

it.effect("ensures, lists, and reads project ledgers under their project titles", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const first = {
      id: LedgerProjectId.make("project:first"),
      name: "First project",
      createdAt: timestamp,
    };
    // No upstream project row: the read falls back to the project id.
    const second = {
      id: LedgerProjectId.make("project:second"),
      name: "project:second",
      createdAt: "2026-08-16T12:00:01.000Z",
    };
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (${first.id}, ${first.name}, '/tmp/first', '[]', ${timestamp}, ${timestamp}, NULL)
    `;

    yield* ledger.ensureProject({ projectId: second.id, createdAt: second.createdAt });
    yield* ledger.ensureProject({ projectId: first.id, createdAt: first.createdAt });
    // Ensuring an existing ledger keeps its original row.
    yield* ledger.ensureProject({ projectId: first.id, createdAt: "2026-08-16T12:00:02.000Z" });

    assert.deepStrictEqual(yield* ledger.readProjectLedger(first.id), first);
    assert.deepStrictEqual(yield* ledger.readProjectLedger(second.id), second);
    assert.deepStrictEqual(yield* ledger.listProjectLedgers(), [first, second]);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it("rejects a whitespace-only project name during contract validation", () => {
  assert.isFalse(
    isProject({
      id: LedgerProjectId.make("project:blank-name"),
      name: "   ",
      createdAt: timestamp,
    }),
  );
});

it("requires an explicit envelope channel on every sent-message payload", () => {
  assert.throws(() =>
    decodeMessageSentPayload({
      messageId: LedgerMessageId.make("message:missing-envelope-channel"),
      text: "An implicit peer channel is not valid.",
      originProjectId: LedgerProjectId.make("project:origin"),
      receiverProjectId: LedgerProjectId.make("project:receiver"),
      exchangeRole: "none",
    }),
  );
});

it.effect("replays an append command from its durable receipt without adding a row", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const projectId = LedgerProjectId.make("project:idempotency");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    const command = appendCommand(projectId, 1);

    const first = yield* ledger.append(command);
    const replay = yield* ledger.append(command);
    const page = yield* ledger.readEvents({
      projectId,
      cursor: { afterSeq: 0 },
      limit: 10,
    });

    assert.isTrue(first.committed);
    assert.isFalse(replay.committed);
    assert.deepStrictEqual(replay.receipt, first.receipt);
    assert.deepStrictEqual(replay.event, first.event);
    assert.lengthOf(page.events, 1);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("publishes committed events in their per-project sequence order", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const projectId = LedgerProjectId.make("project:published-order");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    const committed = yield* ledger.subscribeCommitted;
    const observedFiber = yield* committed.pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );

    yield* Effect.forEach([1, 2, 3], (index) => ledger.append(appendCommand(projectId, index)), {
      concurrency: "unbounded",
    });
    const observed = yield* Fiber.join(observedFiber);

    assert.deepStrictEqual(
      Array.from(observed, (event) => event.seq),
      [1, 2, 3],
    );
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect.prop(
  "reads generated ledgers strictly once and gap-free across cursor pages",
  {
    eventCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
    pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  },
  ({ eventCount, pageSize }) =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledger = yield* A2ALedger;
      const projectId = LedgerProjectId.make("project:property");
      yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
      for (let index = 1; index <= eventCount; index += 1) {
        yield* ledger.append(appendCommand(projectId, index));
      }

      const sequences: Array<number> = [];
      let cursor: LedgerCursor = { afterSeq: 0 };
      let complete = false;
      while (!complete) {
        const page = yield* ledger.readEvents({ projectId, cursor, limit: pageSize });
        sequences.push(...page.events.map((event) => event.seq));
        cursor = page.nextCursor;
        complete = page.complete;
      }

      assert.deepStrictEqual(
        sequences,
        Array.from({ length: eventCount }, (_, index) => index + 1),
      );
      assert.equal(new Set(sequences).size, eventCount);
    }).pipe(Effect.provide(memoryLedgerLayer())),
  { arbitrary: { runs: 24 } },
);

it.effect("negative control: a deleted ledger row fails the gap-free read", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:gap-negative-control");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    for (let index = 1; index <= 3; index += 1) {
      yield* ledger.append(appendCommand(projectId, index));
    }

    yield* sql`DELETE FROM j5_a2a_comm_event WHERE project_id = ${projectId} AND seq = 2`;
    const error = yield* Effect.flip(
      ledger.readEvents({ projectId, cursor: { afterSeq: 0 }, limit: 10 }),
    );

    assert.isTrue(isLedgerGapError(error));
    if (isLedgerGapError(error)) {
      assert.equal(error.expectedSeq, 2);
      assert.equal(error.actualSeq, 3);
    }
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("rebuilds the active membership projection byte-equivalently from the ledger", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:membership");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    const firstAgent = {
      kind: "agent" as const,
      id: ParticipantId.make("agent:first"),
      threadId: ThreadId.make("thread:first"),
    };
    const secondAgent = {
      kind: "agent" as const,
      id: ParticipantId.make("agent:second"),
      threadId: ThreadId.make("thread:second"),
    };
    const person = {
      kind: "human" as const,
      id: ParticipantId.make("human:ledger-person"),
    };
    const membershipEvents: ReadonlyArray<CommEvent> = [
      {
        kind: "participant.joined",
        sender: null,
        receiver: firstAgent.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: firstAgent },
        createdAt: timestamp,
      },
      {
        kind: "participant.joined",
        sender: null,
        receiver: secondAgent.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: secondAgent },
        createdAt: timestamp,
      },
      {
        kind: "participant.left",
        sender: firstAgent.id,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: firstAgent },
        createdAt: timestamp,
      },
    ];
    for (const [index, event] of membershipEvents.entries()) {
      yield* ledger.append(appendCommand(projectId, index + 1, event));
    }
    // Upgraded databases retain readable human membership history, but rebuilds
    // never project it into the now agent-only membership table.
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        project_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        4,
        ${projectId},
        'participant.joined',
        NULL,
        ${person.id},
        NULL,
        NULL,
        json_object('participant', json_object('kind', 'human', 'id', ${person.id})),
        ${timestamp},
        'command:historical-human-membership'
      )
    `;

    const expected = [
      {
        projectId,
        participant: secondAgent,
        joinedSeq: 2,
        updatedSeq: 2,
      },
    ];
    const before = yield* ledger.listMembership(projectId);
    assert.deepStrictEqual(before, expected);
    assert.equal(
      yield* ledger.findHistoricalAgentParticipantId({
        projectId,
        threadId: firstAgent.threadId,
      }),
      firstAgent.id,
    );
    assert.equal(
      yield* ledger.findHistoricalAgentParticipantId({
        projectId,
        threadId: ThreadId.make("thread:never-joined"),
      }),
      null,
    );

    yield* sql`DELETE FROM j5_a2a_membership WHERE project_id = ${projectId}`;
    const corrupted = yield* ledger.listMembership(projectId);
    assert.deepStrictEqual(corrupted, []);
    assert.notEqual(corrupted.length, expected.length);

    const rebuilt = yield* ledger.rebuildMembership(projectId);
    assert.deepStrictEqual(rebuilt, expected);
    const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
    assert.equal(yield* encode(rebuilt), yield* encode(before));
    const history = yield* ledger.readEvents({
      projectId,
      cursor: { afterSeq: 3 },
      limit: 1,
    });
    assert.deepStrictEqual(history.events[0]?.payload, { participant: person });

    const forbidden = yield* Effect.flip(
      ledger.append(
        appendCommand(projectId, 5, {
          kind: "participant.joined",
          sender: null,
          receiver: person.id,
          exchangeId: null,
          correlationId: null,
          payload: { participant: person },
          createdAt: timestamp,
        }),
      ),
    );
    assert.equal(forbidden._tag, "A2AStorageError");
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("rejects a malformed stored historical participant id", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:malformed-historical-participant");
    const threadId = ThreadId.make("thread:malformed-historical-participant");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        project_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        1,
        ${projectId},
        'participant.joined',
        NULL,
        NULL,
        NULL,
        NULL,
        json_object(
          'participant',
          json_object('kind', 'agent', 'id', '', 'threadId', ${threadId})
        ),
        ${timestamp},
        'command:malformed-historical-participant'
      )
    `;

    const error = yield* Effect.flip(
      ledger.findHistoricalAgentParticipantId({ projectId, threadId }),
    );
    assert.isTrue(isA2AStorageError(error));
    if (isA2AStorageError(error)) {
      assert.equal(error.operation, "find historical agent participant");
    }
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("persists project ledgers, events, and receipts across a database restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-a2a-ledger-" });
      const filename = path.join(directory, "state.sqlite");
      const projectId = LedgerProjectId.make("project:restart");
      const command = appendCommand(projectId, 1);
      const firstProcess = Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          ) VALUES (${projectId}, 'Restart', '/tmp/restart', '[]', ${timestamp}, ${timestamp}, NULL)
        `;
        yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
        const result = yield* ledger.append(command);
        assert.isTrue(result.committed);
      }).pipe(Effect.provide(fileLedgerLayer(filename)));
      const secondProcess = Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        assert.equal((yield* ledger.readProjectLedger(projectId)).name, "Restart");
        const replay = yield* ledger.append(command);
        assert.isFalse(replay.committed);
        const page = yield* ledger.readEvents({
          projectId,
          cursor: { afterSeq: 0 },
          limit: 10,
        });
        assert.deepStrictEqual(
          page.events.map((event) => event.seq),
          [1],
        );
      }).pipe(Effect.provide(fileLedgerLayer(filename)));
      yield* firstProcess;
      yield* secondProcess;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("enforces one message.received correlation per receiver project", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:receiver");
    const correlationId = CorrelationId.make("correlation:shared");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    const receivedEvent: CommEvent = {
      kind: "message.received",
      sender: ParticipantId.make("agent:external"),
      receiver: ParticipantId.make("agent:local"),
      exchangeId: null,
      correlationId,
      payload: {
        originProjectId: LedgerProjectId.make("project:origin"),
        message: "hello",
      },
      createdAt: timestamp,
    };
    yield* ledger.append(appendCommand(projectId, 1, receivedEvent));
    const failedCommand = CommCommandId.make(`command:${projectId}:2`);
    const error = yield* Effect.flip(
      ledger.appendEvents({
        commandId: failedCommand,
        projectId,
        acceptedAt: timestamp,
        events: [receivedEvent],
      }),
    );
    assert.isTrue(isA2AStorageError(error));
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE project_id = ${projectId} AND kind = 'message.received'
    `;
    assert.equal(rows[0]?.count, 1);

    const receipts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_command_receipt
      WHERE command_id = ${failedCommand}
    `;
    assert.equal(receipts[0]?.count, 0, "the failed event insert rolls back its receipt");

    const retried = yield* ledger.appendEvents({
      commandId: failedCommand,
      projectId,
      acceptedAt: timestamp,
      events: [
        {
          ...receivedEvent,
          correlationId: CorrelationId.make("correlation:retry-after-rollback"),
        },
      ],
    });
    assert.isTrue(retried.committed, "the rolled-back command id remains reusable");
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("rejects delivery transitions without a projected message row", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const projectId = LedgerProjectId.make("project:missing-delivery-projection");
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    const transitions: ReadonlyArray<{ readonly name: string; readonly event: CommEvent }> = [
      {
        name: "delivered",
        event: {
          kind: "message.delivered",
          sender: ParticipantId.make("agent:delivery:sender"),
          receiver: ParticipantId.make("agent:delivery:receiver"),
          exchangeId: null,
          correlationId: CorrelationId.make("correlation:missing-delivered"),
          payload: {
            messageId: LedgerMessageId.make("message:missing-delivered"),
            attempt: 1,
            channel: "agent",
          },
          createdAt: timestamp,
        },
      },
      {
        name: "delivery-failed",
        event: {
          kind: "message.delivery_failed",
          sender: ParticipantId.make("agent:delivery:sender"),
          receiver: ParticipantId.make("agent:delivery:receiver"),
          exchangeId: null,
          correlationId: CorrelationId.make("correlation:missing-delivery-failed"),
          payload: {
            messageId: LedgerMessageId.make("message:missing-delivery-failed"),
            attempt: 1,
            error: "forced missing projection",
            nextAttemptAt: timestamp,
            alarmed: false,
          },
          createdAt: timestamp,
        },
      },
    ];

    for (const [index, transition] of transitions.entries()) {
      const commandId = CommCommandId.make(`command:missing-delivery:${transition.name}`);
      const error = yield* Effect.flip(
        ledger.appendEvents({
          commandId,
          projectId,
          acceptedAt: timestamp,
          events: [transition.event],
        }),
      );
      assert.isTrue(isA2AStorageError(error));

      const retried = yield* ledger.appendEvents({
        commandId,
        projectId,
        acceptedAt: timestamp,
        events: [messageEvent(index + 100)],
      });
      assert.isTrue(retried.committed, "the failed projection rolls back its command receipt");
    }

    const transitionRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE project_id = ${projectId}
        AND kind IN ('message.delivered', 'message.delivery_failed')
    `;
    assert.equal(transitionRows[0]?.count, 0);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);
