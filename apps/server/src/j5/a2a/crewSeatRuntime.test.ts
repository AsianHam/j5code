import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  layer as runtimePolicyLayer,
  layerFromProjectStore,
  RuntimePolicyV2,
} from "../../orchestration-v2/RuntimePolicy.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { AgentCrewInstanceService, layer as crewLayer } from "./AgentCrewInstanceService.ts";
import { CREW_SEAT_QUESTION_INSTRUCTIONS } from "./crewSeatQuestions.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { LedgerProjectId } from "./contracts.ts";

const projectId = ProjectId.make("project:crew-seat-runtime");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
} satisfies ModelSelection;
const createdAt = "2026-09-28T12:00:00.000Z";

const makeThread = (
  now: DateTime.Utc,
  id: string,
  origin: Pick<OrchestrationV2AppThread, "createdBy" | "creationSource"> = {
    createdBy: "agent",
    creationSource: "mcp",
  },
): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  return {
    ...origin,
    id: threadId,
    projectId,
    title: id,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/worktree",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
  get: () => Effect.succeedNone,
});
const providerInstances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: () => Effect.undefined,
  listInstances: Effect.succeed([]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});
const testLayer = Layer.mergeAll(
  database,
  ledgerLayer.pipe(Layer.provide(database)),
  crewLayer.pipe(Layer.provide(database)),
  // Production resolves the policy over the server's SQL client; so does this layer.
  layerFromProjectStore.pipe(
    Layer.provide(projects),
    Layer.provide(providerInstances),
    Layer.provide(database),
  ),
);

const seatThreadId = "thread:j5:a2a:seat-reviewer";
const captainThreadId = "thread:j5:a2a:captain";

const recordCrew = (id: string, seatThread: string) =>
  Effect.gen(function* () {
    const ledgerProjectId = LedgerProjectId.make(`project:${id}`);
    yield* (yield* A2ALedger).ensureProject({ projectId: ledgerProjectId, createdAt });
    return yield* (yield* AgentCrewInstanceService).record({
      id,
      projectId: ledgerProjectId,
      captainParticipantId: participantIdForThread(ThreadId.make(captainThreadId)),
      captainThreadId: ThreadId.make(captainThreadId),
      displayName: "Review",
      brief: "Review the change.",
      createdAt,
      members: [
        {
          seatName: "reviewer",
          agentId: null,
          participantId: participantIdForThread(ThreadId.make(seatThread)),
          threadId: ThreadId.make(seatThread),
          reason: null,
        },
      ],
    });
  });

it.layer(testLayer)("crew seat runtime policy", (it) => {
  it.effect("marks a live seat and leaves its Captain and other threads alone", () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      yield* recordCrew("crew:seat-runtime", seatThreadId);
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;

      const seat = yield* policy.resolve({
        thread: makeThread(now, seatThreadId),
        modelSelection,
      });
      assert.isTrue(seat.crewSeat);
      assert.equal(seat.agentPersonaInstructions, CREW_SEAT_QUESTION_INSTRUCTIONS);
      assert.include(seat.agentPersonaInstructions!, "ask your Captain with `j5_send_message`");

      const captain = yield* policy.resolve({
        thread: makeThread(now, captainThreadId),
        modelSelection,
      });
      assert.notProperty(captain, "crewSeat");
      assert.notProperty(captain, "agentPersonaInstructions");

      // Only platform-spawned threads are seats; a person's thread is never looked up.
      const human = yield* policy.resolve({
        thread: makeThread(now, seatThreadId, { createdBy: "user", creationSource: "web" }),
        modelSelection,
      });
      assert.notProperty(human, "crewSeat");
    }),
  );

  it.effect("appends the seat rule after a saved persona's instructions", () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const personaSeat = "thread:j5:a2a:seat-builder";
      yield* recordCrew("crew:persona-seat", personaSeat);
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: {
          ...makeThread(now, personaSeat),
          agentPersonaAssignment: {
            personaId: "builder",
            definitionVersion: 1,
            authorityPolicy: "workspace-write",
            resolvedRoute: "primary",
            resolvedDriver: ProviderDriverKind.make("codex"),
            resolvedModelSelection: modelSelection,
          },
        },
        modelSelection,
      });
      assert.isTrue(resolved.crewSeat);
      const instructions = resolved.agentPersonaInstructions!;
      assert.isTrue(instructions.endsWith(CREW_SEAT_QUESTION_INSTRUCTIONS));
      assert.isAbove(instructions.length, CREW_SEAT_QUESTION_INSTRUCTIONS.length);
    }),
  );

  it.effect("stops treating a thread as a seat once its Crew is archived", () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const archivedSeat = "thread:j5:a2a:seat-archived";
      const instance = yield* recordCrew("crew:archived", archivedSeat);
      yield* (yield* AgentCrewInstanceService).markArchived(instance.id, createdAt);
      const policy = yield* RuntimePolicyV2;
      const resolved = yield* policy.resolve({
        thread: makeThread(yield* DateTime.now, archivedSeat),
        modelSelection,
      });
      assert.notProperty(resolved, "crewSeat");
    }),
  );
});

it.effect("treats nothing as a seat without a SQL client", () =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicyV2;
    const resolved = yield* policy.resolve({
      thread: makeThread(yield* DateTime.now, seatThreadId),
      modelSelection,
    });
    assert.notProperty(resolved, "crewSeat");
  }).pipe(Effect.provide(runtimePolicyLayer)),
);
