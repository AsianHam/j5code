import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewLayer,
  layerNotifying as crewNotifyingLayer,
} from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  layer as proposalLayer,
  layerNotifying as proposalNotifyingLayer,
  type CreateCrewProposalInput,
} from "./AgentCrewProposalService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { layer as readChangesLayer } from "./ReadChanges.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";
import { settledReadRevisions } from "./test-support/readRevisions.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(
  database,
  ledgerLayer.pipe(Layer.provide(database)),
  crewLayer.pipe(Layer.provide(database)),
  proposalLayer.pipe(Layer.provide(database)),
);
const createdAt = "2026-09-22T09:00:00.000Z";
const projectId = LedgerProjectId.make("project:crew-proposals");
const captain = ParticipantId.make("agent:j5:a2a:captain-proposals");
const captainThreadId = ThreadId.make("thread:captain-proposals");

const seat = (name: string) => ({
  workspace: { type: "shared" as const },
  seat: name,
  agentId: "scout",
  reason: "Holds a seat",
});

/** A roster row minted by a launch: its identity is its own, not derived from any proposal. */
const rosterMember = (crewId: string, name: string) => ({
  workspace: { type: "shared" as const },
  seatName: name,
  agentId: "scout",
  participantId: ParticipantId.make(`agent:j5:a2a:thread:${crewId}:${name}`),
  threadId: ThreadId.make(`thread:${crewId}:${name}`),
  reason: null,
});

/** The row an addition reserves for one of its seats, under the ids the launcher derives. */
const addition = (
  id: string,
  crewInstanceId: string,
  seats: ReadonlyArray<string>,
): CreateCrewProposalInput => ({
  id,
  projectId,
  captainParticipantId: captain,
  captainThreadId,
  crewInstanceId,
  kind: "addition",
  brief: "Join in.",
  displayName: "Counted",
  requestedSeats: seats.map(seat),
  createdAt,
});

it.effect(
  "admits against rows and open requests, and files one of two racing for the last seat",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt });
      const crews = yield* AgentCrewInstanceService;
      const proposals = yield* AgentCrewProposalService;
      const crewId = "crew:counted";
      yield* crews.record({
        id: crewId,
        projectId,
        captainParticipantId: captain,
        captainThreadId,
        displayName: "Counted",
        brief: "Join in.",
        createdAt,
        members: Array.from({ length: 9 }, (_, index) => rosterMember(crewId, `s${index}`)),
      });

      // Nine rows and P's two open seats leave room for one more; a resolved request holds nothing.
      const p = yield* proposals.admit(addition("proposal:p", crewId, ["p", "p-two"]), {
        maxSeats: 12,
      });
      assert.equal(p.status, "created");
      const declined = yield* proposals.admit(addition("proposal:d", crewId, ["d"]), {
        maxSeats: 12,
      });
      assert.equal(declined.status, "created");
      assert.isNotNull(
        yield* proposals.resolve({
          id: "proposal:d",
          decision: "decline",
          approvedSeats: null,
          resolvedAt: createdAt,
        }),
      );

      // Two requests racing for that last seat: one is filed, one refused and never written.
      const a = addition("proposal:a", crewId, ["a"]);
      const b = addition("proposal:b", crewId, ["b"]);
      const [left, right] = yield* Effect.all(
        [proposals.admit(a, { maxSeats: 12 }), proposals.admit(b, { maxSeats: 12 })],
        { concurrency: "unbounded" },
      );
      assert.sameMembers([left.status, right.status], ["created", "cap-exceeded"]);
      const [winner, loser] = left.status === "created" ? [a, b] : [b, a];
      assert.deepStrictEqual(left.status === "created" ? right : left, {
        status: "cap-exceeded",
        held: 12,
        adding: 1,
      });
      assert.isNull(yield* proposals.read(loser.id));

      // The winner's replay finds its row before anything is counted, though the Crew is full.
      const replay = yield* proposals.admit(winner, { maxSeats: 12 });
      assert.equal(replay.status, "existing");
      if (replay.status === "existing") assert.equal(replay.proposal.id, winner.id);
      assert.equal((yield* proposals.admit(loser, { maxSeats: 12 })).status, "cap-exceeded");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a proposal resolves once: the second resolution finds it closed", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt });
    const crews = yield* AgentCrewInstanceService;
    const proposals = yield* AgentCrewProposalService;
    const crewId = "crew:resolve-once";
    yield* crews.record({
      id: crewId,
      projectId,
      captainParticipantId: captain,
      captainThreadId,
      displayName: "Resolve once",
      brief: "Join in.",
      createdAt,
      members: [rosterMember(crewId, "s0")],
    });
    const filed = yield* proposals.admit(addition("proposal:once", crewId, ["p"]), {
      maxSeats: 12,
    });
    assert.equal(filed.status, "created");
    const approvedSeats = [
      { ...addition("proposal:once", crewId, ["renamed"]).requestedSeats[0]! },
    ];
    const approved = yield* proposals.resolve({
      id: "proposal:once",
      decision: "approve",
      approvedSeats,
      resolvedAt: createdAt,
    });
    assert.equal(approved?.status, "approved");
    assert.deepStrictEqual(
      approved?.approvedSeats?.map(({ seat }) => seat),
      ["renamed"],
    );
    // Neither a second approval nor a decline can follow the first resolution.
    for (const decision of ["approve", "decline"] as const)
      assert.isNull(
        yield* proposals.resolve({
          id: "proposal:once",
          decision,
          approvedSeats: null,
          resolvedAt: createdAt,
        }),
      );
    assert.equal((yield* proposals.read("proposal:once"))?.status, "approved");
    // An approved request is no longer counted as pending; its seat is held once it is a row.
    assert.deepStrictEqual(
      yield* proposals.admit(addition("proposal:next", crewId, ["q"]), { maxSeats: 1 }),
      { status: "cap-exceeded", held: 1, adding: 1 },
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a stored seat workspace this version can't read costs that seat its workspace", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt });
    const proposals = yield* AgentCrewProposalService;
    yield* proposals.create({
      ...addition("proposal:stored", "crew:stored", ["a", "b"]),
      kind: "roster",
      crewInstanceId: null,
    });
    // Written by another version: a new worktree with no base, and a type this one doesn't know.
    const sql = yield* SqlClient.SqlClient;
    const stored = `[
      {"seat":"a","agentId":"scout","reason":"Holds a seat","workspace":{"type":"worktree"}},
      {"seat":"b","agentId":"scout","reason":"Holds a seat","workspace":{"type":"sandbox"}},
      {"seat":"c","agentId":"scout","reason":"Holds a seat","workspace":{"type":"shared"}}
    ]`;
    yield* sql`UPDATE j5_agent_crew_proposal SET requested_seats = ${stored} WHERE id = 'proposal:stored'`;
    const open = yield* proposals.listOpen();
    assert.deepStrictEqual(
      open.map((proposal) => proposal.requestedSeats.map((seat) => [seat.seat, seat.workspace])),
      [
        [
          ["a", undefined],
          ["b", undefined],
          ["c", { type: "shared" }],
        ],
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "moves the crew revision for a write that changed a proposal or a Crew, and for no other",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      yield* (yield* A2ALedger).ensureProject({ projectId: projectId, createdAt });
      const crews = yield* AgentCrewInstanceService;
      const proposals = yield* AgentCrewProposalService;
      const crewRevision = settledReadRevisions.pipe(Effect.map((revisions) => revisions.crew));
      const crewId = "crew:notifying";

      yield* crews.record({
        id: crewId,
        projectId,
        captainParticipantId: captain,
        captainThreadId,
        displayName: "Notifying",
        brief: "Join in.",
        createdAt,
        members: [rosterMember(crewId, "first")],
      });
      assert.equal(yield* crewRevision, 1);

      const request = addition("proposal:notifying", crewId, ["second"]);
      assert.equal((yield* proposals.admit(request, { maxSeats: 12 })).status, "created");
      assert.equal(yield* crewRevision, 2);
      // A replayed request and one over the cap write nothing.
      assert.equal((yield* proposals.admit(request, { maxSeats: 12 })).status, "existing");
      assert.equal(
        (yield* proposals.admit(addition("proposal:over", crewId, ["third"]), { maxSeats: 2 }))
          .status,
        "cap-exceeded",
      );
      assert.equal(yield* crewRevision, 2);

      const decision = {
        id: request.id,
        decision: "approve" as const,
        approvedSeats: request.requestedSeats,
        resolvedAt: createdAt,
      };
      assert.isNotNull(yield* proposals.resolve(decision));
      assert.equal(yield* crewRevision, 3);
      // A second answer to a resolved proposal changes nothing.
      assert.isNull(yield* proposals.resolve(decision));
      assert.equal(yield* crewRevision, 3);

      yield* crews.addMembers(crewId, [rosterMember(crewId, "second")]);
      assert.equal(yield* crewRevision, 4);
      assert.deepStrictEqual(yield* crews.removeMembers(crewId, ["nobody"]), []);
      assert.equal(yield* crewRevision, 4);
      assert.deepStrictEqual(yield* crews.removeMembers(crewId, ["second"]), ["second"]);
      assert.equal(yield* crewRevision, 5);

      yield* crews.markArchived(crewId, createdAt, { withCaptain: true });
      assert.equal(yield* crewRevision, 6);
      assert.isTrue(yield* crews.restoreWithCaptain(crewId));
      assert.equal(yield* crewRevision, 7);
      assert.isFalse(yield* crews.restoreWithCaptain(crewId));
      assert.equal(yield* crewRevision, 7);

      // Reads move nothing.
      yield* crews.listLive();
      yield* proposals.listOpen();
      assert.deepStrictEqual(yield* settledReadRevisions, {
        inbox: 0,
        crew: 7,
        fleet: 0,
        runtimeRequests: 0,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(crewNotifyingLayer, proposalNotifyingLayer).pipe(
          Layer.provideMerge(readChangesLayer),
          Layer.provideMerge(ledgerLayer),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
);
