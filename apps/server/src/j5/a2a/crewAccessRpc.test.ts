import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS, type PersonLevel, type PersonScope } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { Access } from "../sharing/Access.ts";
import { PersonAccess } from "../sharing/PersonAccess.ts";
import { PROJECT, device, thread } from "../sharing/test-support/accessHarness.ts";
import { conversationLayer } from "../sharing/test-support/conversationHarness.ts";
import { makeClientActionRpcHandlers } from "./clientActionRpc.ts";
import { ClientActionsService } from "./ClientActionsService.ts";
import { makeClientReadRpcHandlers } from "./clientReadRpc.ts";
import { ClientReadsService } from "./ClientReadsService.ts";
import { PeerAdminService } from "./PeerAdminService.ts";
import { layer as readChangesLayer } from "./ReadChanges.ts";

/**
 * Who reads and answers a Crew's prompts (Crews AC23, Shared conversations AC12): the access
 * checks of the real handlers, over real people and levels, with the Crew services stood in for.
 */

const AT = "2026-10-18T00:00:00.000Z";
const CAPTAIN = "thread:captain" as ThreadId;
const SEAT = "thread:seat" as ThreadId;

const crewServices = Layer.mergeAll(
  Layer.mock(ClientReadsService)({
    crewProposals: Effect.succeed({
      proposals: [{ id: "proposal:roster", captainThreadId: CAPTAIN } as never],
    }),
    crewRuntimeRequests: Effect.succeed({
      requests: [{ threadId: SEAT, requestId: "request:seat", crewInstanceId: "crew:1" } as never],
    }),
  }),
  Layer.mock(ClientActionsService)({
    resolveCrewProposal: () => Effect.succeed({ proposal: {} as never, crewInstanceId: null }),
    respondCrewRuntimeRequest: (input) =>
      Effect.succeed({ threadId: input.threadId, requestId: input.requestId }),
    archiveCrew: (input) =>
      Effect.succeed({ crewInstanceId: input.crewInstanceId, status: "archived", members: [] }),
  }),
  Layer.mock(PeerAdminService)({}),
  readChangesLayer,
);

/** A person's device, with the levels given through the access core. */
const connection = Effect.fn("test.connection")(function* (
  name: string,
  levels: ReadonlyArray<{ readonly scope: PersonScope; readonly level: PersonLevel }>,
) {
  const people = yield* PersonAccess;
  const access = yield* Access;
  const person = yield* people.createPerson({ displayName: name });
  for (const held of levels) yield* access.setLevel({ personId: person.personId, ...held });
  return (yield* device(person.personId, LEVEL_PERMISSIONS.collaborator)).identity;
});

const handlersFor = (session: { readonly sessionId: string; readonly subject: string }) =>
  Effect.gen(function* () {
    const reads = yield* makeClientReadRpcHandlers(session as never);
    const actions = yield* makeClientActionRpcHandlers(session as never);
    return { reads, actions };
  }).pipe(Effect.provide(crewServices));

/** The Captain's thread with its seat beneath it, and an open roster it proposed. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* thread(CAPTAIN);
  yield* thread(SEAT, PROJECT, { parent: CAPTAIN, relationship: "subagent" });
  yield* sql`
    INSERT OR IGNORE INTO j5_a2a_project_ledger (project_id, created_at) VALUES (${PROJECT}, ${AT})
  `;
  yield* sql`
    INSERT INTO j5_agent_crew_proposal (
      id, project_id, captain_participant_id, captain_thread_id, crew_instance_id, kind, status,
      brief, display_name, requested_seats, approved_seats, created_at
    ) VALUES (
      'proposal:roster', ${PROJECT}, 'agent:captain', ${CAPTAIN}, NULL, 'roster', 'open',
      'Review.', 'Review', '[]', NULL, ${AT}
    )
  `;
});

const outcome = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("allowed"),
    Effect.catch((error) => Effect.succeed(`refused: ${error.message}`)),
  );

it.effect("a Viewer of the Captain sees the roster's prompt and cannot decide it (AC12)", () =>
  Effect.gen(function* () {
    yield* seed;
    const viewer = yield* connection("Vic", [
      { scope: { kind: "thread", threadId: CAPTAIN }, level: "viewer" },
    ]);
    const { reads, actions } = yield* handlersFor(viewer);
    const listed = yield* reads["j5.crews.listProposals"]();
    assert.deepStrictEqual(
      listed.proposals.map((proposal) => proposal.id),
      ["proposal:roster"],
    );
    assert.match(
      yield* outcome(
        actions["j5.crews.resolveProposal"]({ proposalId: "proposal:roster", decision: "decline" }),
      ),
      /^refused: You cannot write to this thread/,
    );
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("a Collaborator on a seat alone receives and answers that seat's approvals", () =>
  Effect.gen(function* () {
    yield* seed;
    const onSeat = yield* connection("Sam", [
      { scope: { kind: "thread", threadId: SEAT }, level: "collaborator" },
    ]);
    const { reads, actions } = yield* handlersFor(onSeat);
    const listed = yield* reads["j5.crews.listRuntimeRequests"]();
    assert.deepStrictEqual(
      listed.requests.map((request) => request.threadId),
      [SEAT],
    );
    assert.strictEqual(
      yield* outcome(
        actions["j5.crews.respondRuntimeRequest"]({
          threadId: SEAT,
          requestId: RuntimeRequestId.make("request:seat"),
          decision: "accept",
        }),
      ),
      "allowed",
    );
    // The Captain's own roster is not theirs to decide.
    assert.match(
      yield* outcome(
        actions["j5.crews.resolveProposal"]({ proposalId: "proposal:roster", decision: "decline" }),
      ),
      /^refused/,
    );
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("only an Owner archives a Crew, for now", () =>
  Effect.gen(function* () {
    yield* seed;
    const wide = yield* connection("Wendy", [{ scope: { kind: "server" }, level: "collaborator" }]);
    const owner = yield* connection("Olga", [{ scope: { kind: "server" }, level: "owner" }]);
    const archive = (session: typeof wide) =>
      handlersFor(session).pipe(
        Effect.flatMap(({ actions }) =>
          outcome(actions["j5.crews.archive"]({ crewInstanceId: "crew:1" } as never)),
        ),
      );
    assert.match(yield* archive(wide), /^refused: Only an Owner/);
    assert.strictEqual(yield* archive(owner), "allowed");
  }).pipe(Effect.provide(conversationLayer)),
);
