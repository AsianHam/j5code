import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  PlacementCycleError,
  PlacementGraphCorruptError,
  PlacementHumanTargetError,
  PlacementParentIneligibleError,
  PlacementParentNotFoundError,
  PlacementParticipantNotFoundError,
  PlacementProjectNotFoundError,
  ParticipantPlacementService,
  layer as placementLayer,
} from "./PlacementService.ts";
import { CommCommandId, LedgerProjectId, ParticipantId, type Participant } from "./contracts.ts";
import { PlacementCommandId, type ParticipantProvenance } from "./placementContracts.ts";

const timestamp = "2026-08-16T16:00:00.000Z";
const projectId = LedgerProjectId.make("project:placement");
const legacyGlobalHumanId = ParticipantId.make("human:global");
const isCycle = Schema.is(PlacementCycleError);
const isGraphCorrupt = Schema.is(PlacementGraphCorruptError);
const isHumanTarget = Schema.is(PlacementHumanTargetError);
const isParentIneligible = Schema.is(PlacementParentIneligibleError);
const isParentNotFound = Schema.is(PlacementParentNotFoundError);
const isParticipantNotFound = Schema.is(PlacementParticipantNotFoundError);
const isProjectLedgerNotFound = Schema.is(PlacementProjectNotFoundError);
const TestLayer = Layer.merge(ledgerLayer, placementLayer).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const agent = (name: string): Extract<Participant, { kind: "agent" }> => ({
  kind: "agent",
  id: ParticipantId.make(`agent:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
});

const spawnedBy = (participant: Participant): ParticipantProvenance => ({
  kind: "spawned-by",
  spawnedByParticipantId:
    participant.kind === "agent" ? participant.id : ParticipantId.make("human:global"),
  source: "j5_spawn",
});

const joinParticipant = (index: number, participant: Participant) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    yield* ledger.append({
      commandId: CommCommandId.make(`membership:${index}`),
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participant.kind === "agent" ? participant.id : null,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  });

const prepare = (participants: ReadonlyArray<Participant>) =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    yield* ledger.ensureProject({ projectId: projectId, createdAt: timestamp });
    for (const [index, participant] of participants.entries()) {
      yield* joinParticipant(index + 1, participant);
    }
  });

const record = (input: {
  readonly index: number;
  readonly participant: Extract<Participant, { kind: "agent" }>;
  readonly provenance: ParticipantProvenance;
}) =>
  Effect.gen(function* () {
    const placements = yield* ParticipantPlacementService;
    return yield* placements.recordCreation({
      commandId: PlacementCommandId.make(`placement:${input.index}`),
      projectId,
      participantId: input.participant.id,
      actor: "platform",
      provenance: input.provenance,
      createdAt: timestamp,
    });
  });

it.effect("records a spawner from another project and makes its child a root there", () =>
  Effect.gen(function* () {
    const spawner = agent("cross-project-spawner");
    const child = agent("cross-project-child");
    const elsewhere = LedgerProjectId.make("project:placement-elsewhere");
    yield* prepare([spawner]);
    const ledger = yield* A2ALedger;
    yield* ledger.ensureProject({ projectId: elsewhere, createdAt: timestamp });
    yield* ledger.append({
      commandId: CommCommandId.make("membership:cross-project-child"),
      projectId: elsewhere,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: child },
        createdAt: timestamp,
      },
    });
    const placements = yield* ParticipantPlacementService;
    const recorded = yield* placements.recordCreation({
      commandId: PlacementCommandId.make("placement:cross-project-child"),
      projectId: elsewhere,
      participantId: child.id,
      actor: "agent",
      provenance: spawnedBy(spawner),
      createdAt: timestamp,
    });
    assert.deepStrictEqual(recorded.placement.provenance, spawnedBy(spawner));
    assert.isNull(recorded.placement.placementParentId);
    assert.deepStrictEqual(
      (yield* placements.listParticipants(elsewhere)).map((row) => [
        row.participantId,
        row.placementParentId,
      ]),
      [[child.id, null]],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("places wrapper-created children under their current caller", () =>
  Effect.gen(function* () {
    const spawner = agent("spawner");
    const child = agent("wrapper-child");
    yield* prepare([spawner, child]);

    yield* record({
      index: 1,
      participant: spawner,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    const childResult = yield* record({
      index: 2,
      participant: child,
      provenance: spawnedBy(spawner),
    });

    assert.deepStrictEqual(childResult.placement.provenance, spawnedBy(spawner));
    assert.equal(childResult.placement.placementParentId, spawner.id);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("places through retained departed ancestors using the placement-row safety bound", () =>
  Effect.gen(function* () {
    const root = agent("departed-chain-root");
    const first = agent("departed-chain-first");
    const second = agent("departed-chain-second");
    const spawner = agent("departed-chain-spawner");
    const child = agent("departed-chain-child");
    yield* prepare([root, first, second, spawner, child]);
    yield* record({
      index: 101,
      participant: root,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({ index: 102, participant: first, provenance: spawnedBy(root) });
    yield* record({ index: 103, participant: second, provenance: spawnedBy(first) });
    yield* record({ index: 104, participant: spawner, provenance: spawnedBy(second) });

    const ledger = yield* A2ALedger;
    for (const participant of [root, first, second]) {
      yield* ledger.append({
        commandId: CommCommandId.make(`membership:${participant.id}:left`),
        projectId,
        acceptedAt: timestamp,
        event: {
          kind: "participant.left",
          sender: participant.id,
          receiver: null,
          exchangeId: null,
          correlationId: null,
          payload: { participant },
          createdAt: timestamp,
        },
      });
    }

    const result = yield* record({
      index: 105,
      participant: child,
      provenance: spawnedBy(spawner),
    });
    assert.deepStrictEqual(result.placement.provenance, spawnedBy(spawner));
    assert.equal(result.placement.placementParentId, spawner.id);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "types fork provenance without coercing it to spawned-by and defaults forks to source siblings",
  () =>
    Effect.gen(function* () {
      const group = agent("group");
      const source = agent("fork-source");
      const rootFork = agent("fork-root");
      const nestedFork = agent("fork-nested");
      yield* prepare([group, source, rootFork, nestedFork]);
      yield* record({
        index: 1,
        participant: group,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      yield* record({
        index: 2,
        participant: source,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      const rootForkResult = yield* record({
        index: 3,
        participant: rootFork,
        provenance: {
          kind: "forked-from",
          sourceParticipantId: source.id,
          source: "upstream_lineage",
        },
      });
      assert.deepStrictEqual(rootForkResult.placement.provenance, {
        kind: "forked-from",
        sourceParticipantId: source.id,
        source: "upstream_lineage",
      });
      assert.notEqual(rootForkResult.placement.provenance.kind, "spawned-by");
      assert.equal(rootForkResult.placement.placementParentId, null);
      assert.notEqual(rootForkResult.placement.placementParentId, source.id);

      const placements = yield* ParticipantPlacementService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE j5_a2a_participant_placement
        SET placement_parent_id = ${group.id}
        WHERE project_id = ${projectId} AND participant_id = ${source.id}
      `;
      const nestedForkResult = yield* record({
        index: 4,
        participant: nestedFork,
        provenance: {
          kind: "forked-from",
          sourceParticipantId: source.id,
          source: "upstream_lineage",
        },
      });
      assert.equal(nestedForkResult.placement.placementParentId, group.id);

      yield* sql`
        UPDATE j5_a2a_participant_placement
        SET placement_parent_id = NULL
        WHERE project_id = ${projectId} AND participant_id = ${source.id}
      `;
      assert.equal(
        (yield* placements.readPlacement({ projectId, participantId: nestedFork.id }))
          ?.placementParentId,
        group.id,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "records ordinary creation as unknown and keeps missing placement explicitly unrecorded",
  () =>
    Effect.gen(function* () {
      const native = agent("native");
      const unrecorded = agent("unrecorded");
      yield* prepare([native, unrecorded]);
      yield* record({
        index: 1,
        participant: native,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      const placements = yield* ParticipantPlacementService;

      const rows = yield* placements.listParticipants(projectId);
      const nativeRow = rows.find((row) => row.participantId === native.id);
      const unrecordedRow = rows.find((row) => row.participantId === unrecorded.id);
      assert.deepStrictEqual(nativeRow?.provenance, {
        kind: "unknown",
        source: "native_or_unobserved",
      });
      assert.equal(nativeRow?.placementParentId, null);
      assert.notEqual(nativeRow?.provenance.kind, "spawned-by");
      assert.deepStrictEqual(unrecordedRow?.provenance, { kind: "unrecorded" });
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("roots departed lineage backfill while refusing a participant id that never joined", () =>
  Effect.gen(function* () {
    const departedParent = agent("departed-parent");
    const child = agent("departed-child");
    const wrapperChild = agent("departed-wrapper-child");
    const fabricatedTarget = agent("fabricated-target");
    const fabricatedSource = agent("never-joined-source");
    yield* prepare([departedParent, child, wrapperChild, fabricatedTarget]);
    yield* record({
      index: 1,
      participant: departedParent,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* (yield* A2ALedger).append({
      commandId: CommCommandId.make("membership:departed-parent:left"),
      projectId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.left",
        sender: departedParent.id,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: departedParent },
        createdAt: timestamp,
      },
    });

    const departedResult = yield* record({
      index: 2,
      participant: child,
      provenance: {
        kind: "spawned-by",
        spawnedByParticipantId: departedParent.id,
        source: "upstream_lineage",
      },
    });
    assert.deepStrictEqual(departedResult.placement.provenance, {
      kind: "spawned-by",
      spawnedByParticipantId: departedParent.id,
      source: "upstream_lineage",
    });
    assert.equal(departedResult.placement.placementParentId, null);

    const wrapperError = yield* Effect.flip(
      record({
        index: 3,
        participant: wrapperChild,
        provenance: {
          kind: "spawned-by",
          spawnedByParticipantId: departedParent.id,
          source: "j5_spawn",
        },
      }),
    );
    assert.isTrue(isParentNotFound(wrapperError));
    assert.include(wrapperError.message, departedParent.id);
    assert.equal(
      yield* (yield* ParticipantPlacementService).readPlacement({
        projectId,
        participantId: wrapperChild.id,
      }),
      null,
    );

    const fabricatedError = yield* Effect.flip(
      record({
        index: 4,
        participant: fabricatedTarget,
        provenance: {
          kind: "spawned-by",
          spawnedByParticipantId: fabricatedSource.id,
          source: "upstream_lineage",
        },
      }),
    );
    assert.isTrue(isParticipantNotFound(fabricatedError));
    assert.include(fabricatedError.message, fabricatedSource.id);
    assert.equal(
      yield* (yield* ParticipantPlacementService).readPlacement({
        projectId,
        participantId: fabricatedTarget.id,
      }),
      null,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("replays placement creation without changing immutable provenance", () =>
  Effect.gen(function* () {
    const parent = agent("replay-parent");
    const child = agent("replay-child");
    yield* prepare([parent, child]);
    yield* record({
      index: 1,
      participant: parent,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    const placements = yield* ParticipantPlacementService;
    const input = {
      commandId: PlacementCommandId.make("placement:replay"),
      projectId,
      participantId: child.id,
      actor: "agent" as const,
      provenance: spawnedBy(parent),
      createdAt: timestamp,
    };

    const first = yield* placements.recordCreation(input);
    const replayProvenance: ParticipantProvenance = {
      source: "j5_spawn",
      spawnedByParticipantId: parent.id,
      kind: "spawned-by",
    };
    const replay = yield* placements.recordCreation({
      ...input,
      provenance: replayProvenance,
    });

    assert.isTrue(first.committed);
    assert.isFalse(replay.committed);
    assert.deepStrictEqual(replay.event, first.event);
    assert.deepStrictEqual(replay.placement.provenance, spawnedBy(parent));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses self-provenance as a placement cycle without writing placement", () =>
  Effect.gen(function* () {
    const participant = agent("self-provenance");
    yield* prepare([participant]);
    const placements = yield* ParticipantPlacementService;

    const error = yield* Effect.flip(
      record({ index: 1, participant, provenance: spawnedBy(participant) }),
    );
    assert.isTrue(isCycle(error));
    assert.include(error.message, participant.id);
    assert.equal(
      yield* placements.readPlacement({ projectId, participantId: participant.id }),
      null,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses both human participant id shapes as immutable placement targets", () =>
  Effect.gen(function* () {
    const durablePersonId = ParticipantId.make("human:placement-person");
    yield* prepare([]);
    const placements = yield* ParticipantPlacementService;

    for (const [index, personId] of [
      [1, legacyGlobalHumanId],
      [2, durablePersonId],
    ] as const) {
      const creationError = yield* Effect.flip(
        placements.recordCreation({
          commandId: PlacementCommandId.make(`placement:human-target-refused:${index}`),
          projectId,
          participantId: personId,
          actor: "platform",
          provenance: { kind: "unknown", source: "native_or_unobserved" },
          createdAt: timestamp,
        }),
      );
      assert.isTrue(isHumanTarget(creationError));
      assert.include(creationError.message, "immutable-human");
      assert.include(creationError.message, "record-creation");
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses both retained human id shapes as j5_spawn provenance parents", () =>
  Effect.gen(function* () {
    const child = agent("human-provenance-parent-child");
    const durablePersonId = ParticipantId.make("human:placement-parent-person");
    yield* prepare([child]);
    const placements = yield* ParticipantPlacementService;
    const sql = yield* SqlClient.SqlClient;

    for (const [index, personId] of [
      [1, legacyGlobalHumanId],
      [2, durablePersonId],
    ] as const) {
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
          created_at
        ) VALUES (
          ${100 + index},
          ${projectId},
          'participant.joined',
          NULL,
          NULL,
          NULL,
          NULL,
          json_object('participant', json_object('kind', 'human', 'id', ${personId})),
          ${timestamp}
        )
      `;

      const error = yield* Effect.flip(
        record({
          index: 10 + index,
          participant: child,
          provenance: {
            kind: "spawned-by",
            spawnedByParticipantId: personId,
            source: "j5_spawn",
          },
        }),
      );
      assert.isTrue(isParentIneligible(error));
      assert.include(error.message, "ineligible-non-agent");
      assert.include(error.message, personId);
      assert.equal(yield* placements.readPlacement({ projectId, participantId: child.id }), null);
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("detects corrupt stored cycles in creation and subtree traversal", () =>
  Effect.gen(function* () {
    const first = agent("corrupt-first");
    const second = agent("corrupt-second");
    const child = agent("corrupt-child");
    yield* prepare([first, second, child]);
    yield* record({
      index: 1,
      participant: first,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({
      index: 2,
      participant: second,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE j5_a2a_participant_placement
      SET placement_parent_id = CASE participant_id
        WHEN ${first.id} THEN ${second.id}
        WHEN ${second.id} THEN ${first.id}
      END
      WHERE project_id = ${projectId} AND participant_id IN (${first.id}, ${second.id})
    `;
    const placements = yield* ParticipantPlacementService;

    const mutationError = yield* Effect.flip(
      record({ index: 3, participant: child, provenance: spawnedBy(first) }),
    );
    assert.isTrue(isGraphCorrupt(mutationError));
    assert.include(mutationError.message, "Placement graph state");
    assert.include(mutationError.message, "placement bound");
    assert.equal(yield* placements.readPlacement({ projectId, participantId: child.id }), null);

    const traversalError = yield* Effect.flip(
      placements.listSubtree({ projectId, participantId: first.id }),
    );
    assert.isTrue(isGraphCorrupt(traversalError));
    assert.include(traversalError.message, "Placement graph state");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("distinguishes missing project state from a missing subtree participant", () =>
  Effect.gen(function* () {
    const missingProjectId = LedgerProjectId.make("project:placement-missing");
    const missingParticipantId = ParticipantId.make("agent:placement-missing");
    yield* prepare([]);
    const placements = yield* ParticipantPlacementService;

    const projectError = yield* Effect.flip(
      placements.listSubtree({
        projectId: missingProjectId,
        participantId: missingParticipantId,
      }),
    );
    assert.isTrue(isProjectLedgerNotFound(projectError));
    assert.include(projectError.message, missingProjectId);

    const participantError = yield* Effect.flip(
      placements.listSubtree({ projectId, participantId: missingParticipantId }),
    );
    assert.isTrue(isParticipantNotFound(participantError));
    assert.include(participantError.message, projectId);
    assert.include(participantError.message, missingParticipantId);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("walks the mutable placement subtree leaves-first rather than following provenance", () =>
  Effect.gen(function* () {
    const firstRoot = agent("tree-a-root");
    const secondRoot = agent("tree-b-root");
    const movedToSecond = agent("spawned-by-a-placed-b");
    const childOfMoved = agent("child-of-moved");
    const movedToFirst = agent("spawned-by-b-placed-a");
    yield* prepare([firstRoot, secondRoot, movedToSecond, childOfMoved, movedToFirst]);
    yield* record({
      index: 1,
      participant: firstRoot,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({
      index: 2,
      participant: secondRoot,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({
      index: 3,
      participant: movedToSecond,
      provenance: spawnedBy(firstRoot),
    });
    yield* record({ index: 4, participant: childOfMoved, provenance: spawnedBy(movedToSecond) });
    yield* record({
      index: 5,
      participant: movedToFirst,
      provenance: spawnedBy(secondRoot),
    });
    const placements = yield* ParticipantPlacementService;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE j5_a2a_participant_placement
      SET placement_parent_id = CASE participant_id
        WHEN ${movedToSecond.id} THEN ${secondRoot.id}
        WHEN ${movedToFirst.id} THEN ${firstRoot.id}
        ELSE placement_parent_id
      END
      WHERE project_id = ${projectId}
        AND participant_id IN (${movedToSecond.id}, ${movedToFirst.id})
    `;

    const firstSubtree = yield* placements.listSubtree({
      projectId,
      participantId: firstRoot.id,
    });
    const secondSubtree = yield* placements.listSubtree({
      projectId,
      participantId: secondRoot.id,
    });

    assert.deepStrictEqual(
      firstSubtree.map((participant) => participant.participantId),
      [movedToFirst.id, firstRoot.id],
    );
    assert.deepStrictEqual(
      secondSubtree.map((participant) => participant.participantId),
      [childOfMoved.id, movedToSecond.id, secondRoot.id],
    );
  }).pipe(Effect.provide(TestLayer)),
);
