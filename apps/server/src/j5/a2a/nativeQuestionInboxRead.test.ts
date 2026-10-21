import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as Homes from "./HomeRegistrar.ts";
import * as Ledger from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import * as Placements from "./PlacementService.ts";
import { CommCommandId, LedgerProjectId } from "./contracts.ts";
import { makeNativeQuestionInboxRead } from "./nativeQuestionInboxRead.ts";
import { PlacementCommandId, type ParticipantProvenance } from "./placementContracts.ts";

const timestamp = "2026-10-19T12:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const projectId = LedgerProjectId.make("project:native-question-inbox");
const parentId = ThreadId.make("thread:inbox-spawner");

const projection = (id: ThreadId): OrchestrationV2ThreadProjection => ({
  thread: {
    id,
    projectId: ProjectId.make(projectId),
    title: `Agent ${id}`,
    createdBy: "agent",
    creationSource: "mcp",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
});

const question = (
  id: string,
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make(`node:${id}`),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session:inbox") },
  createdAt: now,
  resolvedAt: null,
  ...overrides,
});

const shell = (record: OrchestrationV2ThreadProjection): OrchestrationV2ThreadShell => ({
  ...record.thread,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest:
    record.runtimeRequests.find((request) => request.status === "pending") ?? null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
});

const setup = Effect.gen(function* () {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const storage = Layer.mergeAll(Ledger.layer, Placements.layer, Crews.layer).pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(Homes.layer.pipe(Layer.provide(Ledger.layer), Layer.provide(database))),
  );
  const context = yield* Layer.build(storage);
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  const records = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const reads: Array<ThreadId> = [];
  const external = Layer.mock(ThreadManagement.ThreadManagementService)({
    getShellSnapshot: () =>
      Effect.sync(() => ({
        schemaVersion: 1,
        snapshotSequence: 1,
        projects: [],
        threads: [...shells.values()],
        archivedThreads: [],
      })),
    getThreadRecords: (id) =>
      Effect.sync(() => {
        reads.push(id);
        return records.get(id)!;
      }),
  });
  const read = yield* makeNativeQuestionInboxRead.pipe(
    Effect.provide(external),
    Effect.provide(context),
  );
  const homes = Context.get(context, Homes.A2AHomeRegistrar);
  const placements = Context.get(context, Placements.ParticipantPlacementService);
  const add = (
    id: ThreadId,
    requests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [],
    provenance?: ParticipantProvenance,
  ) =>
    Effect.gen(function* () {
      yield* homes.registerAtCreation({
        projectId,
        threadId: id,
        createdAt: timestamp,
        commandId: CommCommandId.make(`home:${id}`),
      });
      yield* placements.recordCreation({
        projectId,
        participantId: Homes.participantIdForThread(id),
        commandId: PlacementCommandId.make(`placement:${id}`),
        actor: "platform",
        createdAt: timestamp,
        provenance: provenance ?? {
          kind: "spawned-by",
          spawnedByParticipantId: Homes.participantIdForThread(parentId),
          source: "j5_spawn",
        },
      });
      const value = { ...projection(id), runtimeRequests: requests };
      records.set(id, value);
      shells.set(id, shell(value));
    });
  yield* add(parentId, [], { kind: "unknown", source: "native_or_unobserved" });
  const crew = (id: string, memberId: ThreadId, captainId = parentId) =>
    Context.get(context, Crews.AgentCrewInstanceService).record({
      id,
      projectId,
      captainParticipantId: Homes.participantIdForThread(captainId),
      captainThreadId: captainId,
      displayName: `Crew ${id}`,
      brief: "Complete the task",
      createdAt: timestamp,
      members: [
        {
          seatName: "reviewer",
          agentId: null,
          participantId: Homes.participantIdForThread(memberId),
          threadId: memberId,
          reason: null,
        },
      ],
    });
  return { context, read, add, crew, records, shells, reads };
});

it.effect.each(["live", "message"] as const)(
  "lists a solo Peer and a live Crew seat once for %s questions",
  (capability) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const peer = ThreadId.make("thread:inbox-peer");
      const seat = ThreadId.make("thread:inbox-seat");
      const responseCapability =
        capability === "live"
          ? { type: "live" as const, providerSessionId: ProviderSessionId.make("session:inbox") }
          : { type: "message" as const };
      yield* fixture.add(peer, [question("peer-question", { responseCapability })]);
      yield* fixture.add(seat, [question("seat-question", { responseCapability })]);
      yield* fixture.crew("crew:one", seat);
      yield* fixture.crew("crew:one", seat);
      const listed = yield* fixture.read;
      assert.deepEqual(
        listed.map((item) => [item.threadId, item.requestId]),
        [
          [peer, "peer-question"],
          [seat, "seat-question"],
        ],
      );
      assert.equal(listed[0]?.threadTitle, `Agent ${peer}`);
      assert.equal(listed[0]?.responseCapability, capability);
      assert.equal(listed[1]?.responseCapability, capability);
      assert.isUndefined(listed[0]?.crew);
      assert.equal(listed[1]?.crew?.seat, "reviewer");
      assert.equal(fixture.reads.filter((id) => id === seat).length, 1);
    }),
);

it.effect("loads actual pending questions when the shell summary names an approval", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const peer = ThreadId.make("thread:mixed-requests");
    const approval = question("approval", { kind: "command" });
    yield* fixture.add(peer, [approval, question("actual-question")]);
    assert.equal(fixture.shells.get(peer)?.pendingRuntimeRequest?.kind, "command");
    assert.deepEqual(
      (yield* fixture.read).map((item) => item.requestId),
      ["actual-question"],
    );
  }),
);

it.effect.each(["resolved", "expired", "cancelled", "not_resumable", "approval"] as const)(
  "omits %s requests even when a stale shell says a question is pending",
  (kind) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const peer = ThreadId.make("thread:no-answerable-question");
      const pending = question("question");
      yield* fixture.add(peer, [pending]);
      const request =
        kind === "not_resumable"
          ? {
              ...pending,
              responseCapability: { type: "not_resumable" as const, reason: "Session ended" },
            }
          : kind === "approval"
            ? { ...pending, kind: "command" as const }
            : { ...pending, status: kind, resolvedAt: now };
      fixture.records.set(peer, { ...fixture.records.get(peer)!, runtimeRequests: [request] });
      assert.deepEqual(yield* fixture.read, []);
    }),
);

it.effect("removes a question after another actor resolves it despite a stale shell summary", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const peer = ThreadId.make("thread:answered-elsewhere");
    const request = question("question");
    yield* fixture.add(peer, [request]);
    assert.equal((yield* fixture.read).length, 1);
    fixture.records.set(peer, {
      ...fixture.records.get(peer)!,
      runtimeRequests: [{ ...request, status: "resolved", resolvedAt: now }],
    });
    assert.deepEqual(yield* fixture.read, []);
  }),
);

it.effect.each(["idle", "root", "native-delegated", "unregistered"] as const)(
  "does not load records for an %s thread",
  (kind) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const id = ThreadId.make("thread:excluded-before-record-read");
      const requests = kind === "idle" ? [] : [question("question")];
      if (kind === "unregistered") {
        fixture.shells.set(id, shell({ ...projection(id), runtimeRequests: requests }));
      } else {
        yield* fixture.add(
          id,
          requests,
          kind === "root"
            ? { kind: "unknown", source: "native_or_unobserved" }
            : kind === "native-delegated"
              ? {
                  kind: "spawned-by",
                  spawnedByParticipantId: Homes.participantIdForThread(parentId),
                  source: "upstream_lineage",
                }
              : undefined,
        );
        if (kind === "native-delegated") {
          const value = fixture.shells.get(id)!;
          fixture.shells.set(id, {
            ...value,
            lineage: {
              parentThreadId: parentId,
              relationshipToParent: "subagent",
              rootThreadId: parentId,
            },
          });
        }
      }
      assert.deepEqual(yield* fixture.read, []);
      assert.deepEqual(fixture.reads, []);
    }),
);

it.effect("omits a fork that inherits a spawned Peer's placement parent", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const peer = ThreadId.make("thread:fork-source");
    const fork = ThreadId.make("thread:fork");
    yield* fixture.add(peer);
    yield* fixture.add(fork, [question("fork-question")], {
      kind: "forked-from",
      sourceParticipantId: Homes.participantIdForThread(peer),
      source: "upstream_lineage",
    });
    const placement = yield* Context.get(
      fixture.context,
      Placements.ParticipantPlacementService,
    ).readPlacement({ projectId, participantId: Homes.participantIdForThread(fork) });
    assert.equal(placement?.placementParentId, Homes.participantIdForThread(parentId));
    assert.deepEqual(yield* fixture.read, []);
    assert.deepEqual(fixture.reads, []);
  }),
);

it.effect("placing an ordinary thread under an agent does not add its question to the Inbox", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const id = ThreadId.make("thread:manually-placed");
    yield* fixture.add(id, [question("ordinary-question")], {
      kind: "unknown",
      source: "native_or_unobserved",
    });
    const sql = Context.get(fixture.context, SqlClient.SqlClient);
    // Reparenting has no public producer yet; placement alone must not change eligibility.
    yield* sql`
      UPDATE j5_a2a_participant_placement
      SET placement_parent_id = ${Homes.participantIdForThread(parentId)}
      WHERE project_id = ${projectId} AND participant_id = ${Homes.participantIdForThread(id)}
    `;
    assert.deepEqual(yield* fixture.read, []);
    assert.deepEqual(fixture.reads, []);
  }),
);

it.effect.each(["archived-shell", "deleted-shell", "archived-records", "deleted-records"] as const)(
  "omits an %s thread",
  (state) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const id = ThreadId.make("thread:no-longer-visible");
      yield* fixture.add(id, [question("question")]);
      const changes = state.startsWith("archived") ? { archivedAt: now } : { deletedAt: now };
      if (state.endsWith("shell"))
        fixture.shells.set(id, { ...fixture.shells.get(id)!, ...changes });
      else {
        const value = fixture.records.get(id)!;
        fixture.records.set(id, { ...value, thread: { ...value.thread, ...changes } });
      }
      assert.deepEqual(yield* fixture.read, []);
    }),
);

it.effect("omits a retired-only Crew seat but keeps another live Crew's seat", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const retiredSeat = ThreadId.make("thread:retired-seat");
    const sharedSeat = ThreadId.make("thread:shared-seat");
    yield* fixture.add(retiredSeat, [question("retired-question")]);
    yield* fixture.add(sharedSeat, [question("live-question")]);
    yield* fixture.crew("crew:retired", retiredSeat);
    yield* fixture.crew("crew:shared-live", sharedSeat);
    const crews = Context.get(fixture.context, Crews.AgentCrewInstanceService);
    yield* crews.markArchived("crew:retired", timestamp);
    assert.deepEqual(
      (yield* fixture.read).map((item) => item.requestId),
      ["live-question"],
    );
    assert.isFalse(fixture.reads.includes(retiredSeat));
  }),
);

it.effect("does not turn a secret-only shell summary into a native question Inbox row", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const peer = ThreadId.make("thread:secret-only");
    yield* fixture.add(peer);
    fixture.shells.set(peer, {
      ...fixture.shells.get(peer)!,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("secret-only"),
        kind: "user_input",
        createdAt: now,
      },
    });
    assert.deepEqual(yield* fixture.read, []);
    assert.deepEqual(fixture.reads, [peer]);
  }),
);

it.effect("leaves a placed live Captain's question inline in its own thread", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const captain = ThreadId.make("thread:placed-captain");
    const seat = ThreadId.make("thread:captains-seat");
    yield* fixture.add(captain, [question("captain-question")]);
    yield* fixture.add(seat);
    yield* fixture.crew("crew:captains", seat, captain);
    assert.deepEqual(yield* fixture.read, []);
    assert.deepEqual(fixture.reads, []);
  }),
);

it.effect("bounds placement query results to threads with a pending request", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const pending = ThreadId.make("thread:only-pending-peer");
    yield* fixture.add(pending, [question("pending-question")]);
    for (const id of ["idle-one", "idle-two", "idle-three"])
      yield* fixture.add(ThreadId.make(`thread:${id}`));
    const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const listed = yield* fixture.read.pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          const compiled = statement.compile();
          if (compiled[0].includes("JOIN j5_a2a_participant_placement")) queries.push(compiled);
          return statement;
        }),
      ),
    );
    assert.deepEqual(
      listed.map((item) => item.threadId),
      [pending],
    );
    assert.equal(queries.length, 1);
    const [query, parameters] = queries[0]!;
    const sql = Context.get(fixture.context, SqlClient.SqlClient);
    // Inspect the executed query's result size, before any in-memory filtering.
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (${query})`,
      parameters,
    );
    assert.equal(rows[0]?.count, 1);
  }),
);
