import * as SqlClient from "effect/sql/SqlClient";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { CrewCaptainArchiveCascade } from "./CrewCaptainArchiveCascade.ts";
import { ServerConfig } from "../../config.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { ArtifactWorkspace } from "../artifacts/ArtifactWorkspace.ts";
import { playbookStoreLayer } from "../playbooks/PlaybookStore.ts";
import { CrewSeatFinishNotifier, manualLayer as notifierLayer } from "./CrewSeatFinishNotifier.ts";
import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  layer as proposalStoreLayer,
} from "./AgentCrewProposalService.ts";
import {
  CREW_LAUNCH_REPORT_WINDOW_MS,
  CrewLaunchReporter,
  layer as daemonReporterLayer,
  manualLayer as reporterLayer,
} from "./CrewLaunchReporter.ts";
import { crewSeatBriefMessageId, crewSeatThreadId } from "./crewSeatIds.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const projectId = LedgerProjectId.make("ledger:launch-report");
const captainThread = ThreadId.make("thread:captain");
const captainId = ParticipantId.make("agent:j5:a2a:thread:captain");
const createdAt = DateTime.makeUnsafe("2026-09-17T20:00:00.000Z");
const at = DateTime.formatIso(createdAt);

type RunFacts = {
  readonly status: OrchestrationV2Run["status"];
  readonly userMessageId: string;
  readonly activity?: boolean;
  readonly failure?: { readonly class: string; readonly message: string } | undefined;
};

const projection = (threadId: ThreadId, runs: ReadonlyArray<RunFacts>) =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:launch-report"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      archivedAt: null,
      createdAt,
    },
    runs: runs.map((run, index) => ({
      id: RunId.make(`run:${threadId}:${index}`),
      threadId,
      status: run.status,
      userMessageId: run.userMessageId,
    })),
    turnItems: runs.flatMap((run, index) => [
      ...(run.activity
        ? [
            {
              runId: RunId.make(`run:${threadId}:${index}`),
              type: "reasoning",
              text: "Working",
              status: "in_progress",
            },
          ]
        : []),
      ...(run.failure === undefined
        ? []
        : [
            {
              runId: RunId.make(`run:${threadId}:${index}`),
              type: "error",
              status: "failed",
              failure: { ...run.failure, code: null, retryable: null },
            },
          ]),
    ]),
    messages: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const runEvent = (threadId: ThreadId, facts: RunFacts): OrchestrationV2StoredEvent =>
  ({
    sequence: 1,
    commandId: null,
    event: {
      type: "run.updated",
      threadId,
      payload: {
        id: RunId.make(`run:${threadId}:0`),
        threadId,
        status: facts.status,
        userMessageId: facts.userMessageId,
      },
    },
  }) as unknown as OrchestrationV2StoredEvent;

const seat = (name: string, agentId: string) => ({ seat: name, agentId, reason: `${name} works` });

const captainMessage = (id: MessageId, text: string, threadId: ThreadId, label: string) => ({
  id: EventId.make(`event:${id}:${label}`),
  type: "message.updated" as const,
  threadId,
  occurredAt: createdAt,
  payload: {
    createdBy: "system" as const,
    creationSource: "server" as const,
    id,
    threadId,
    runId: null,
    nodeId: null,
    role: "user" as const,
    text,
    attachments: [],
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  },
});

/** Thread, run and item events for upstream's SQL store, as the seat's provider would leave them. */
const storeThread = (threadId: ThreadId) => {
  const instanceId = ProviderInstanceId.make("codex");
  return {
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created" as const,
    threadId,
    occurredAt: createdAt,
    payload: {
      id: threadId,
      projectId: ProjectId.make("project:launch-report"),
      title: threadId,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.6-sol" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user" as const,
      creationSource: "web" as const,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
};
const storeRun = (
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  userMessageId: MessageId,
) => {
  const instanceId = ProviderInstanceId.make("codex");
  const id = RunId.make(`run:${threadId}:${ordinal}`);
  const terminal = status === "failed" || status === "completed";
  return {
    id: EventId.make(`event:${id}:${status}`),
    type: "run.updated" as const,
    threadId,
    runId: id,
    occurredAt: createdAt,
    payload: {
      id,
      threadId,
      ordinal,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.6-sol" },
      providerThreadId: null,
      userMessageId,
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: terminal ? createdAt : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
};
const storeItem = (
  threadId: ThreadId,
  ordinal: number,
  body:
    | { readonly type: "reasoning"; readonly text: string; readonly streaming: boolean }
    | {
        readonly type: "error";
        readonly failure: {
          readonly class: "provider_error";
          readonly message: string;
          readonly code: null;
          readonly retryable: null;
        };
      },
) => {
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  const id = TurnItemId.make(`item:${runId}:${body.type}`);
  return {
    id: EventId.make(`event:${id}`),
    type: "turn-item.updated" as const,
    threadId,
    runId,
    occurredAt: createdAt,
    payload: {
      id,
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: body.type === "error" ? ("failed" as const) : ("completed" as const),
      title: body.type,
      startedAt: createdAt,
      completedAt: createdAt,
      updatedAt: createdAt,
      ...body,
    },
  };
};

/**
 * With `daemon`, the production layer runs its sweep and stream against these reads. With
 * `wrapCrews`, the reporter sees the wrapped Crew store; the fixture's own `crews` stays the real one.
 */
const makeFixture = Effect.fn("test.j5.crewLaunchReporter.fixture")(function* (
  daemon?: {
    readonly latestSequence: EventSinkV2["Service"]["latestSequence"];
    readonly streamStoredEventsFrom: ThreadManagementService["Service"]["streamStoredEventsFrom"];
  },
  options?: {
    readonly wrapCrews?: (
      crews: AgentCrewInstanceService["Service"],
    ) => AgentCrewInstanceService["Service"];
    /** Thread reads go to upstream's SQL store, so its filters decide the rows. */
    readonly realStore?: boolean;
  },
) {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const storage = Layer.mergeAll(crewInstanceLayer, proposalStoreLayer, ledgerLayer).pipe(
    Layer.provideMerge(database),
  );
  const context = yield* Layer.build(storage);
  // Upstream's tables too: whether the Captain's thread is shared reads its projection.
  yield* runMigrations().pipe(Effect.provide(context));
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  yield* Effect.provide(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES ('human:operator', 1, ${at})`;
      yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt: at });
    }),
    context,
  );
  const store = options?.realStore
    ? Context.get(
        yield* Layer.build(projectionStoreLayer.pipe(Layer.provide(Layer.succeedContext(context)))),
        ProjectionStoreV2,
      )
    : null;
  const threads = yield* Ref.make<ReadonlyMap<string, OrchestrationV2ThreadProjection>>(
    new Map([[captainThread, projection(captainThread, [])]]),
  );
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  // Each dispatch is also a receipt, so a test waits on the report rather than on the clock.
  const receipts = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  let onRead: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;
  const proposals = Context.get(context, AgentCrewProposalService);
  const crews = Context.get(context, AgentCrewInstanceService);
  const layer = (daemon === undefined ? reporterLayer : daemonReporterLayer).pipe(
    Layer.provideMerge(
      Layer.mock(ThreadManagementService)({
        ...(daemon === undefined ? {} : { streamStoredEventsFrom: daemon.streamStoredEventsFrom }),
        getThreadRecords: (threadId, fields, filter) =>
          Effect.gen(function* () {
            if (store !== null)
              return yield* store
                .getThreadRecords(threadId, fields, filter)
                .pipe(
                  Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
                );
            const found = (yield* Ref.get(threads)).get(threadId);
            if (onRead !== undefined) yield* onRead(threadId);
            if (found === undefined)
              return yield* new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreThreadNotFoundError({ threadId }),
              });
            return {
              ...found,
              messages: found.messages.filter(
                (message) =>
                  filter?.messageIds === undefined || filter.messageIds.includes(message.id),
              ),
              turnItems: found.turnItems.filter(
                (item) =>
                  filter?.turnItemRunId === undefined || item.runId === filter.turnItemRunId,
              ),
            } as never;
          }),
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(dispatched, (items) => [...items, command]);
            if (command.type === "message.dispatch" && store !== null)
              yield* store
                .apply(
                  captainMessage(command.messageId, command.text, command.threadId, command.type),
                )
                .pipe(Effect.orDie);
            else if (command.type === "message.dispatch")
              yield* Ref.update(threads, (map) => {
                const captain = map.get(command.threadId)!;
                return new Map(map).set(command.threadId, {
                  ...captain,
                  messages: [
                    ...captain.messages,
                    {
                      id: command.messageId,
                      threadId: command.threadId,
                      text: command.text,
                      role: "user" as const,
                      createdAt,
                      updatedAt: createdAt,
                      streaming: false,
                      runId: null,
                      nodeId: null,
                      createdBy: "system",
                      creationSource: "server",
                      attachments: [],
                    },
                  ],
                });
              });
            yield* Queue.offer(receipts, command);
            return { events: [], effects: [] } as never;
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(EventSinkV2)(
        daemon === undefined ? {} : { latestSequence: daemon.latestSequence },
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(AgentCrewInstanceService, options?.wrapCrews?.(crews) ?? crews),
    ),
    Layer.provideMerge(playbookStoreLayer),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.mock(A2ADeliveryWorker)({ notify: Effect.void })),
  );

  /** An approved proposal with its Crew recorded, the way the gate leaves them before the report. */
  const approvedLaunch = (input: {
    readonly id: string;
    readonly requested: ReadonlyArray<ReturnType<typeof seat>>;
    readonly approved: ReadonlyArray<ReturnType<typeof seat>>;
  }) =>
    Effect.gen(function* () {
      const crewId = `crew:${input.id}`;
      yield* proposals.create({
        id: input.id,
        projectId,
        captainParticipantId: captainId,
        captainThreadId: captainThread,
        crewInstanceId: null,
        kind: "roster",
        brief: "Tell two jokes.",
        displayName: "Comedy",
        requestedSeats: input.requested,
        createdAt: at,
      });
      yield* crews.record({
        id: crewId,
        projectId,
        captainParticipantId: captainId,
        captainThreadId: captainThread,
        displayName: "Comedy",
        brief: "Tell two jokes.",
        createdAt: at,
        members: input.approved.map((entry) => {
          const threadId = crewSeatThreadId(input.id, entry.seat);
          return {
            seatName: entry.seat,
            agentId: entry.agentId,
            participantId: participantIdForThread(threadId),
            threadId,
            reason: entry.reason,
          };
        }),
      });
      // A launched seat's thread exists with no run yet; tests add runs as the seat moves.
      yield* Ref.update(threads, (map) => {
        const next = new Map(map);
        for (const entry of input.approved) {
          const threadId = crewSeatThreadId(input.id, entry.seat);
          if (!next.has(threadId)) next.set(threadId, projection(threadId, []));
        }
        return next;
      });
      // As the gate does it: the Crew is recorded and linked, then the proposal resolves once.
      yield* proposals.attachInstance(input.id, crewId);
      yield* proposals.resolve({
        id: input.id,
        decision: "approve",
        approvedSeats: input.approved,
        resolvedAt: at,
      });
      return crewId;
    });
  /** An approved addition whose seats joined the Crew and whose threads exist with no run yet. */
  const approvedAddition = (input: {
    readonly id: string;
    readonly crewId: string;
    readonly added: ReadonlyArray<ReturnType<typeof seat>>;
  }) =>
    Effect.gen(function* () {
      yield* proposals.create({
        id: input.id,
        projectId,
        captainParticipantId: captainId,
        captainThreadId: captainThread,
        crewInstanceId: input.crewId,
        kind: "addition",
        brief: "Add a seat.",
        displayName: "Comedy",
        requestedSeats: input.added,
        createdAt: at,
      });
      yield* crews.addMembers(
        input.crewId,
        input.added.map((entry) => {
          const threadId = crewSeatThreadId(input.id, entry.seat);
          return {
            seatName: entry.seat,
            agentId: entry.agentId,
            participantId: participantIdForThread(threadId),
            threadId,
            reason: entry.reason,
          };
        }),
      );
      yield* Ref.update(threads, (map) => {
        const next = new Map(map);
        for (const entry of input.added) {
          const threadId = crewSeatThreadId(input.id, entry.seat);
          next.set(threadId, projection(threadId, []));
        }
        return next;
      });
      yield* proposals.resolve({
        id: input.id,
        decision: "approve",
        approvedSeats: input.added,
        resolvedAt: at,
      });
    });
  const setSeat = (proposalId: string, seatName: string, runs: ReadonlyArray<RunFacts>) =>
    Ref.update(threads, (map) => {
      const threadId = crewSeatThreadId(proposalId, seatName);
      return new Map(map).set(threadId, projection(threadId, runs));
    });
  const reports = () =>
    Ref.get(dispatched).pipe(
      Effect.map((commands) =>
        commands.flatMap((command) =>
          command.type === "message.dispatch" && command.threadId === captainThread
            ? [command.text]
            : [],
        ),
      ),
    );
  /** A seat whose thread never came to exist, as a restart mid-launch can leave it. */
  const dropThread = (proposalId: string, seatName: string) =>
    Ref.update(threads, (map) => {
      const next = new Map(map);
      next.delete(crewSeatThreadId(proposalId, seatName));
      return next;
    });
  return {
    layer,
    proposals,
    crews,
    approvedLaunch,
    approvedAddition,
    setSeat,
    dropThread,
    reports,
    receipts,
    store,
    setOnRead: (hook: typeof onRead) => {
      onRead = hook;
    },
  };
});

const fixture = makeFixture();
it.effect(
  "a launch that dropped a never-created seat and failed another's brief reports both by name",
  () =>
    Effect.gen(function* () {
      const { layer, crews, approvedLaunch, setSeat, dropThread, reports } = yield* fixture;
      const id = "proposal:partial";
      const roster = [seat("first", "scout"), seat("second", "critic"), seat("third", "sentry")];
      const crewId = yield* approvedLaunch({ id, requested: roster, approved: roster });
      // What the launch left: second's thread was never created and its row was dropped; third
      // exists but its brief did not go out.
      yield* dropThread(id, "second");
      yield* crews.removeMembers(crewId, ["second"]);
      yield* setSeat(id, "first", [
        { status: "running", activity: true, userMessageId: crewSeatBriefMessageId(id, "first") },
      ]);
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        yield* reporter.watch(id, [
          { seatName: "first", kind: "created" },
          { seatName: "second", kind: "not_created", detail: "thread.create was refused" },
          { seatName: "third", kind: "not_started", detail: "starting its brief failed: busy" },
        ]);
        // Every seat is decided, so the report posts at once.
        const [report] = yield* reports();
        assert.isDefined(report);
        assert.include(
          report!,
          "launch: 1 started, 1 failed, 1 not created, 0 start unconfirmed after 60s",
        );
        assert.include(report!, "seat_not_created: second | thread.create was refused");
        assert.include(
          report!,
          "seat_failed: third | not_started | starting its brief failed: busy",
        );
        assert.notInclude(report!, "- second:");
        assert.include(report!, `thread_id=${crewSeatThreadId(id, "third")} start=failed`);
        assert.include(report!, "j5_request_crew_member");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

/** The same seat under a participant id no proposal minted, as a later addition would bring it. */
const reseated = (name: string) => {
  const threadId = ThreadId.make(`thread:reseated:${name}`);
  return {
    seatName: name,
    agentId: "scout",
    participantId: participantIdForThread(threadId),
    threadId,
    reason: `${name} returns`,
  };
};

it.effect("a never-created seat whose drop failed in the launch is dropped by the report", () =>
  Effect.gen(function* () {
    const { layer, crews, approvedLaunch, setSeat, dropThread, reports } = yield* fixture;
    const id = "proposal:undropped";
    const roster = [seat("first", "scout"), seat("second", "critic"), seat("third", "sentry")];
    const crewId = yield* approvedLaunch({ id, requested: roster, approved: roster });
    // The launch could not delete second's row; third's thread read failed, so it was never
    // measured as missing, and its row stays.
    yield* dropThread(id, "second");
    yield* dropThread(id, "third");
    yield* setSeat(id, "first", [
      { status: "running", activity: true, userMessageId: crewSeatBriefMessageId(id, "first") },
    ]);
    yield* Effect.gen(function* () {
      const reporter = yield* CrewLaunchReporter;
      yield* reporter.watch(id, [
        { seatName: "first", kind: "created" },
        { seatName: "second", kind: "not_created", detail: "thread.create was refused" },
        {
          seatName: "third",
          kind: "not_started",
          detail: "reading the seat thread failed: database is locked",
        },
      ]);
      const [report] = yield* reports();
      assert.isDefined(report);
      assert.deepStrictEqual(
        (yield* crews.read(crewId))!.members.map((member) => member.seatName),
        ["first", "third"],
      );
      assert.include(report!, "seat_not_created: second | thread.create was refused");
      assert.include(report!, "seat_failed: third | not_started");
      assert.notInclude(report!, "- second:");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "after a restart mid-launch, a seat row with no thread leaves the roster and is reported as not created",
  () =>
    Effect.gen(function* () {
      const { layer, crews, approvedLaunch, setSeat, dropThread, reports } = yield* fixture;
      const id = "proposal:restart";
      const roster = [seat("first", "scout"), seat("second", "critic")];
      const crewId = yield* approvedLaunch({ id, requested: roster, approved: roster });
      yield* dropThread(id, "second");
      yield* setSeat(id, "first", [
        { status: "completed", userMessageId: crewSeatBriefMessageId(id, "first") },
      ]);
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        // The boot sweep has no launch outcomes; it measures each seat from its thread.
        yield* reporter.reconcile;
        const [report] = yield* reports();
        assert.isDefined(report);
        assert.include(report!, "launch: 1 started, 0 failed, 1 not created");
        assert.include(report!, "seat_not_created: second | its thread was never created");
        assert.notInclude(report!, "- second:");
        assert.lengthOf(yield* reports(), 1);
        assert.deepStrictEqual(
          (yield* crews.read(crewId))!.members.map((member) => member.seatName),
          ["first"],
        );
        // The name is free again: a later seat can take it.
        assert.equal((yield* crews.addMembers(crewId, [reseated("second")])).status, "added");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "an addition's seat with no thread after a restart leaves the roster and frees its name",
  () =>
    Effect.gen(function* () {
      const { layer, proposals, crews, approvedLaunch, approvedAddition, dropThread, reports } =
        yield* fixture;
      const rosterId = "proposal:before-addition";
      const crewId = yield* approvedLaunch({
        id: rosterId,
        requested: [seat("first", "scout")],
        approved: [seat("first", "scout")],
      });
      yield* proposals.markReported(rosterId, at);
      const id = "proposal:addition-restart";
      yield* approvedAddition({ id, crewId, added: [seat("extra", "critic")] });
      yield* dropThread(id, "extra");
      // The roster's seat has no thread either, but this report owns only the addition's rows.
      yield* dropThread(rosterId, "first");
      yield* Effect.gen(function* () {
        yield* (yield* CrewLaunchReporter).reconcile;
        const [report] = yield* reports();
        assert.isDefined(report);
        assert.include(report!, `proposal_id: ${id}`);
        assert.include(report!, "seat_not_created: extra | its thread was never created");
        assert.deepStrictEqual(
          (yield* crews.read(crewId))!.members.map((member) => member.seatName),
          ["first"],
        );
        assert.equal((yield* crews.addMembers(crewId, [reseated("extra")])).status, "added");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a cleanup that fails leaves the launch unreported, and the next sweep converges", () =>
  Effect.gen(function* () {
    let failNext = true;
    const { layer, proposals, crews, approvedLaunch, setSeat, dropThread, reports } =
      yield* makeFixture(undefined, {
        wrapCrews: (store) => ({
          ...store,
          removeMembers: (crewInstanceId, seatNames) =>
            Effect.suspend(() => {
              if (!failNext) return store.removeMembers(crewInstanceId, seatNames);
              failNext = false;
              return Effect.fail(
                new SqlError({ reason: new UnknownError({ cause: new Error("disk I/O error") }) }),
              );
            }),
        }),
      });
    const id = "proposal:cleanup-failed";
    const roster = [seat("first", "scout"), seat("second", "critic")];
    const crewId = yield* approvedLaunch({ id, requested: roster, approved: roster });
    yield* dropThread(id, "second");
    yield* setSeat(id, "first", [
      { status: "completed", userMessageId: crewSeatBriefMessageId(id, "first") },
    ]);
    const seatNames = () =>
      crews.read(crewId).pipe(Effect.map((crew) => crew!.members.map((member) => member.seatName)));
    yield* Effect.gen(function* () {
      const reporter = yield* CrewLaunchReporter;
      // The drop fails: nothing reaches the Captain, and the launch is still owed a report.
      yield* reporter.reconcile;
      assert.isFalse(failNext);
      assert.deepStrictEqual(yield* reports(), []);
      assert.isNull((yield* proposals.read(id))!.reportedAt);
      assert.deepStrictEqual(yield* seatNames(), ["first", "second"]);
      // The next sweep drops the row and reports once.
      yield* reporter.reconcile;
      assert.deepStrictEqual(yield* seatNames(), ["first"]);
      const texts = yield* reports();
      assert.lengthOf(texts, 1);
      assert.include(texts[0]!, "seat_not_created: second");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("posts one report once every seat has started or failed, with the run's error", () =>
  Effect.gen(function* () {
    const { layer, proposals, approvedLaunch, setSeat, reports } = yield* fixture;
    const id = "proposal:comedy";
    const requested = [seat("setup", "scout"), seat("punchline", "advocate")];
    const approved = [...requested, seat("prosecutor", "prosecutor")];
    yield* approvedLaunch({ id, requested, approved });
    const brief = (name: string) => crewSeatBriefMessageId(id, name);
    // What the seat threads already show when the watch starts: one running, one dead on its
    // provider, one whose first turn has not been created yet.
    yield* setSeat(id, "setup", [
      { status: "running", activity: true, userMessageId: brief("setup") },
    ]);
    yield* setSeat(id, "punchline", [
      {
        status: "failed",
        userMessageId: brief("punchline"),
        failure: { class: "provider_error", message: "API Error: Can't reach the API server" },
      },
    ]);
    yield* Effect.gen(function* () {
      const reporter = yield* CrewLaunchReporter;
      yield* reporter.watch(id);
      assert.deepStrictEqual(yield* reports(), []);
      // A queued first turn is not a verdict; the report waits.
      const queued = runEvent(crewSeatThreadId(id, "prosecutor"), {
        status: "queued",
        userMessageId: brief("prosecutor"),
      });
      assert.isNull(yield* reporter.handleStoredEvent(queued));
      // Nor is a first turn held as `preparing` while its worktree is being made, even though
      // ThreadLaunch's own preparation item reads as activity.
      yield* setSeat(id, "prosecutor", [
        { status: "preparing", activity: true, userMessageId: brief("prosecutor") },
      ]);
      const preparing = runEvent(crewSeatThreadId(id, "prosecutor"), {
        status: "preparing",
        userMessageId: brief("prosecutor"),
      });
      assert.isNull(yield* reporter.handleStoredEvent(preparing));
      assert.deepStrictEqual(yield* reports(), []);
      const punchlineRun = {
        id: RunId.make(`run:${crewSeatThreadId(id, "punchline")}:0`),
        threadId: crewSeatThreadId(id, "punchline"),
        userMessageId: brief("punchline"),
        status: "failed",
      } as unknown as OrchestrationV2Run;
      assert.isTrue(yield* reporter.coversFailure(crewSeatThreadId(id, "punchline"), punchlineRun));
      // The last seat opens its turn: the report posts, once, with every verdict.
      const running = runEvent(crewSeatThreadId(id, "prosecutor"), {
        status: "running",
        userMessageId: brief("prosecutor"),
      });
      yield* setSeat(id, "prosecutor", [
        { status: "running", activity: true, userMessageId: brief("prosecutor") },
      ]);
      assert.equal(yield* reporter.handleStoredEvent(running), id);
      const [report] = yield* reports();
      assert.isDefined(report);
      assert.include(
        report!,
        "launch: 2 started, 1 failed, 0 not created, 0 start unconfirmed after 60s",
      );
      assert.include(report!, "changes: added prosecutor");
      assert.include(
        report!,
        "seat_failed: punchline | failed | provider_error: API Error: Can't reach the API server",
      );
      assert.include(report!, `thread_id=${crewSeatThreadId(id, "setup")} start=started`);
      assert.include(report!, `thread_id=${crewSeatThreadId(id, "prosecutor")} start=started`);
      assert.isNotNull((yield* proposals.read(id))!.reportedAt);
      // Replayed or late events post nothing more, and the exact failed run stays covered.
      assert.isNull(yield* reporter.handleStoredEvent(running));
      assert.isTrue(yield* reporter.coversFailure(crewSeatThreadId(id, "punchline"), punchlineRun));
      assert.lengthOf(yield* reports(), 1);
      // Watching again finds nothing pending and posts nothing: the report is idempotent.
      yield* reporter.watch(id);
      assert.lengthOf(yield* reports(), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "the window closes on a seat that never starts, and the boot sweep catches a lost report",
  () =>
    Effect.gen(function* () {
      const { layer, proposals, approvedLaunch, setSeat, reports, receipts } = yield* fixture;
      const slow = "proposal:slow";
      yield* approvedLaunch({
        id: slow,
        requested: [seat("setup", "scout")],
        approved: [seat("setup", "scout")],
      });
      // A launch approved before a restart whose seat already started: the sweep reports it at once.
      const lost = "proposal:lost";
      yield* approvedLaunch({
        id: lost,
        requested: [seat("herald", "herald")],
        approved: [seat("herald", "herald")],
      });
      yield* setSeat(lost, "herald", [
        { status: "completed", userMessageId: crewSeatBriefMessageId(lost, "herald") },
      ]);
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        assert.sameMembers([...(yield* reporter.reconcile)], [slow, lost]);
        yield* Queue.take(receipts);
        let texts = yield* reports();
        assert.lengthOf(texts, 1);
        assert.include(texts[0]!, `proposal_id: ${lost}`);
        assert.include(
          texts[0]!,
          "launch: 1 started, 0 failed, 0 not created, 0 start unconfirmed after 60s",
        );
        assert.isNotNull((yield* proposals.read(lost))!.reportedAt);
        assert.isNull((yield* proposals.read(slow))!.reportedAt);
        // The slow seat's thread never even exists; when the window closes the Captain is told so.
        yield* TestClock.adjust(CREW_LAUNCH_REPORT_WINDOW_MS);
        yield* Queue.take(receipts);
        texts = yield* reports();
        assert.lengthOf(texts, 2);
        assert.include(texts[1]!, `proposal_id: ${slow}`);
        assert.include(
          texts[1]!,
          "launch: 0 started, 0 failed, 0 not created, 1 start unconfirmed after 60s",
        );
        assert.include(texts[1]!, "seat_pending: setup");
        assert.include(texts[1]!, "1 seat has no confirmed provider activity after 60s");
        assert.isNotNull((yield* proposals.read(slow))!.reportedAt);
        // Nothing is left for a second sweep.
        assert.deepStrictEqual(yield* reporter.reconcile, []);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "running intent followed by authentication failure produces only a failed launch report",
  () =>
    Effect.gen(function* () {
      const { layer, approvedLaunch, setSeat, reports } = yield* fixture;
      const id = "proposal:auth";
      yield* approvedLaunch({
        id,
        requested: [seat("critic", "critic")],
        approved: [seat("critic", "critic")],
      });
      const threadId = crewSeatThreadId(id, "critic");
      const userMessageId = crewSeatBriefMessageId(id, "critic");
      const failed = runEvent(threadId, { status: "failed", userMessageId }).event
        .payload as OrchestrationV2Run;
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        // A failed seat can arrive before watch is installed, while approval dispatches its siblings.
        assert.isTrue(yield* reporter.coversFailure(threadId, failed));
        yield* setSeat(id, "critic", [{ status: "running", userMessageId }]);
        yield* reporter.watch(id);
        yield* reporter.handleStoredEvent(runEvent(threadId, { status: "running", userMessageId }));
        assert.lengthOf(yield* reports(), 0);
        yield* setSeat(id, "critic", [
          {
            status: "failed",
            userMessageId,
            failure: { class: "provider_error", message: "credentials expired" },
          },
        ]);
        yield* reporter.handleStoredEvent(runEvent(threadId, { status: "failed", userMessageId }));
        assert.lengthOf(yield* reports(), 1);
        assert.include((yield* reports())[0]!, "credentials expired");
        assert.notInclude((yield* reports())[0]!, "Your crew is running.");
        assert.isTrue(yield* reporter.coversFailure(threadId, failed));
      }).pipe(Effect.provide(layer));
      // A fresh reporter has no pending map; the committed report still covers this precise run.
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        assert.isTrue(yield* reporter.coversFailure(threadId, failed));
        assert.isFalse(
          yield* reporter.coversFailure(threadId, { ...failed, id: RunId.make("run:later") }),
        );
        yield* reporter.reconcile;
        yield* reporter.watch(id);
        assert.lengthOf(yield* reports(), 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a provider activity update during initial reads is handled after the snapshot", () =>
  Effect.gen(function* () {
    const { layer, approvedLaunch, setSeat, reports, setOnRead } = yield* fixture;
    const id = "proposal:snapshot";
    const roster = [seat("first", "scout"), seat("second", "critic")];
    yield* approvedLaunch({ id, requested: roster, approved: roster });
    yield* setSeat(id, "first", []);
    yield* setSeat(id, "second", [
      { status: "running", activity: true, userMessageId: crewSeatBriefMessageId(id, "second") },
    ]);
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    setOnRead((threadId) =>
      threadId === crewSeatThreadId(id, "second")
        ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const reporter = yield* CrewLaunchReporter;
      const watching = yield* reporter.watch(id).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      const facts = {
        status: "running" as const,
        activity: true,
        userMessageId: crewSeatBriefMessageId(id, "first"),
      };
      yield* setSeat(id, "first", [facts]);
      const update = yield* reporter
        .handleStoredEvent(runEvent(crewSeatThreadId(id, "first"), facts))
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(watching);
      yield* Fiber.join(update);
      assert.lengthOf(yield* reports(), 1);
      assert.include(
        (yield* reports())[0]!,
        "launch: 2 started, 0 failed, 0 not created, 0 start unconfirmed",
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "the deadline rechecks provider activity and later first-turn failures remain reportable",
  () =>
    Effect.gen(function* () {
      const { layer, approvedLaunch, setSeat, reports, receipts } = yield* fixture;
      const id = "proposal:deadline";
      yield* approvedLaunch({
        id,
        requested: [seat("first", "scout")],
        approved: [seat("first", "scout")],
      });
      const threadId = crewSeatThreadId(id, "first");
      const userMessageId = crewSeatBriefMessageId(id, "first");
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        yield* reporter.watch(id);
        yield* setSeat(id, "first", [{ status: "running", activity: true, userMessageId }]);
        // No stream event was delivered; the timeout must use current facts.
        yield* TestClock.adjust(CREW_LAUNCH_REPORT_WINDOW_MS);
        yield* Queue.take(receipts);
        assert.include(
          (yield* reports())[0]!,
          "launch: 1 started, 0 failed, 0 not created, 0 start unconfirmed",
        );
        const run = runEvent(threadId, { status: "failed", userMessageId }).event
          .payload as OrchestrationV2Run;
        assert.isFalse(yield* reporter.coversFailure(threadId, run));
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "an approved launch covers early failures before its report, and provider items confirm startup",
  () =>
    Effect.gen(function* () {
      const { layer, approvedLaunch, setSeat, reports } = yield* fixture;
      const id = "proposal:claim";
      yield* approvedLaunch({
        id,
        requested: [seat("first", "scout")],
        approved: [seat("first", "scout")],
      });
      const threadId = crewSeatThreadId(id, "first");
      const userMessageId = crewSeatBriefMessageId(id, "first");
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        assert.isTrue(
          yield* reporter.coversFailure(
            threadId,
            runEvent(threadId, { status: "failed", userMessageId }).event
              .payload as OrchestrationV2Run,
          ),
        );
        yield* setSeat(id, "first", [{ status: "running", userMessageId }]);
        yield* reporter.watch(id);
        assert.lengthOf(yield* reports(), 0);
        const facts = { status: "running" as const, userMessageId, activity: true };
        yield* setSeat(id, "first", [facts]);
        const event = {
          sequence: 1,
          event: {
            type: "turn-item.updated",
            threadId,
            payload: projection(threadId, [facts]).turnItems[0],
          },
        } as unknown as OrchestrationV2StoredEvent;
        yield* reporter.handleStoredEvent(event);
        assert.lengthOf(yield* reports(), 1);
        assert.include((yield* reports())[0]!, "launch: 1 started");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "the real finish notifier is silent before, after, and on replay of a failed launch report",
  () =>
    Effect.gen(function* () {
      const { layer, approvedLaunch, setSeat, reports } = yield* fixture;
      const id = "proposal:notifier";
      yield* approvedLaunch({
        id,
        requested: [seat("first", "scout")],
        approved: [seat("first", "scout")],
      });
      const threadId = crewSeatThreadId(id, "first");
      const userMessageId = crewSeatBriefMessageId(id, "first");
      const facts = {
        status: "failed" as const,
        userMessageId,
        failure: { class: "provider_error", message: "expired token" },
      };
      yield* setSeat(id, "first", [facts]);
      const event = runEvent(threadId, facts);
      const integrated = notifierLayer.pipe(
        Layer.provideMerge(layer),
        Layer.provideMerge(Layer.mock(CrewCaptainArchiveCascade)({})),
        Layer.provideMerge(Layer.mock(ArtifactWorkspace)({})),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-launch-notice-" })),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Layer.mock(A2ADeliveryWorker)({ notify: Effect.void })),
      );
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        const notifier = yield* CrewSeatFinishNotifier;
        // A seat may die before all sibling briefs have even dispatched.
        yield* notifier.handleStoredEvent(event);
        assert.lengthOf(yield* reports(), 0);
        yield* reporter.watch(id);
        yield* reporter.handleStoredEvent(event);
        yield* notifier.handleStoredEvent(event);
        const texts = yield* reports();
        assert.lengthOf(texts, 1);
        assert.include(texts[0]!, "<j5_crew_gate>");
        assert.include(texts[0]!, "expired token");
      }).pipe(Effect.provide(integrated));
      // New services against the same durable projection, as after a server restart.
      yield* Effect.gen(function* () {
        yield* (yield* CrewLaunchReporter).reconcile;
        yield* (yield* CrewSeatFinishNotifier).handleStoredEvent(event);
        assert.lengthOf(yield* reports(), 1);
      }).pipe(Effect.provide(integrated));
    }).pipe(Effect.scoped),
);

it.effect(
  "the daemon's stream starts after the event store's latest sequence, not from the beginning",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<number>();
      const { layer } = yield* makeFixture({
        latestSequence: () => Effect.succeed(4200),
        streamStoredEventsFrom: (input) =>
          Stream.fromEffect(Deferred.succeed(started, input?.afterSequence ?? 0)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
      });
      yield* Effect.gen(function* () {
        yield* CrewLaunchReporter;
        assert.equal(yield* Deferred.await(started), 4200);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("reports created seats waiting for work immediately, including after a restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const id = "proposal:waiting";
    const roster = [seat("builder", "scout"), seat("reviewer", "critic")];
    yield* f.approvedLaunch({ id, requested: roster, approved: roster });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const entry of roster)
        yield* sql`
        INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace)
        VALUES (${crewSeatThreadId(id, entry.seat)}, 'approved context', '{"type":"shared"}')
      `;
      yield* (yield* CrewLaunchReporter).reconcile;
      const reports = yield* f.reports();
      assert.lengthOf(reports, 1);
      assert.include(reports[0]!, "2 created and waiting for work");
      assert.include(reports[0]!, "start=waiting");
      assert.notInclude(reports[0]!, "seat_pending:");
      assert.notInclude(reports[0]!, "unconfirmed");
      assert.notInclude(reports[0]!, "Your crew is running.");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "on the SQL store, a seat's verdict and failure come from its brief run's items and the report",
  () =>
    Effect.gen(function* () {
      const { layer, approvedLaunch, reports, store } = yield* makeFixture(undefined, {
        realStore: true,
      });
      const projections = store!;
      const id = "proposal:sql-items";
      const roster = [seat("first", "scout"), seat("second", "critic")];
      yield* approvedLaunch({ id, requested: roster, approved: roster });
      const first = crewSeatThreadId(id, "first");
      const second = crewSeatThreadId(id, "second");
      const firstBrief = MessageId.make(crewSeatBriefMessageId(id, "first"));
      const secondBrief = MessageId.make(crewSeatBriefMessageId(id, "second"));
      const earlier = MessageId.make("message:earlier-work");
      const provider = {
        class: "provider_error" as const,
        code: null,
        retryable: null,
      };
      yield* projections.apply(storeThread(captainThread));
      // A message on the Captain that names a failed run but is not the launch report.
      const lookalike = "failed_run: run:unreported";
      yield* projections.apply(
        captainMessage(MessageId.make("message:lookalike"), lookalike, captainThread, "seed"),
      );
      for (const threadId of [first, second]) {
        yield* projections.apply(storeThread(threadId));
        // Earlier work on the seat's thread: activity and a failure, neither of them its brief's.
        yield* projections.apply(storeRun(threadId, 1, "failed", earlier));
        yield* projections.apply(
          storeItem(threadId, 1, { type: "reasoning", text: "Earlier work", streaming: false }),
        );
        yield* projections.apply(
          storeItem(threadId, 1, {
            type: "error",
            failure: { ...provider, message: "the earlier run failed" },
          }),
        );
      }
      yield* projections.apply(storeRun(first, 2, "running", firstBrief));
      yield* projections.apply(storeRun(second, 2, "running", secondBrief));

      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        yield* reporter.watch(id);
        // Both brief runs are running with no activity of their own, so neither has started.
        assert.lengthOf(yield* reports(), 0);

        yield* projections.apply(storeRun(first, 2, "failed", firstBrief));
        yield* projections.apply(
          storeItem(first, 2, {
            type: "error",
            failure: { ...provider, message: "the brief run failed" },
          }),
        );
        const failed = storeRun(first, 2, "failed", firstBrief);
        assert.isNull(
          yield* reporter.handleStoredEvent({
            sequence: 2,
            commandId: null,
            event: failed,
          } as unknown as OrchestrationV2StoredEvent),
        );

        yield* projections.apply(
          storeItem(second, 2, { type: "reasoning", text: "On it", streaming: false }),
        );
        assert.equal(
          yield* reporter.handleStoredEvent({
            sequence: 3,
            commandId: null,
            event: storeRun(second, 2, "running", secondBrief),
          } as unknown as OrchestrationV2StoredEvent),
          id,
        );
        const [report] = yield* reports();
        assert.include(report!, "launch: 1 started, 1 failed");
        assert.include(report!, "the brief run failed");
        assert.notInclude(report!, "the earlier run failed");

        // The notice is found by its id: the failed run it names is covered, and a run named only
        // by another message on the Captain is not.
        assert.isTrue(yield* reporter.coversFailure(first, failed.payload as OrchestrationV2Run));
        assert.isFalse(
          yield* reporter.coversFailure(first, {
            ...failed.payload,
            id: RunId.make("run:unreported"),
          } as OrchestrationV2Run),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
