import {
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { J5_CLIENT_READ_WS_METHODS, type J5ActionError } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { SqlError } from "effect/sql/SqlError";

import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import { PlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import { PlaybookStore, playbookStoreLayer } from "../playbooks/PlaybookStore.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { AgentCrewProposalService, type CrewProposal } from "./AgentCrewProposalService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { A2AArchiveFacts, A2AArchiveFactsError } from "./ArchiveFactsService.ts";
import { makeClientReadRpcHandlers } from "./clientReadRpc.ts";
import { ClientReadsService, layer as clientReadsLayer } from "./ClientReadsService.ts";
import { CrewRuntimeRequestService } from "./CrewRuntimeRequestService.ts";
import { A2AHumanInbox, A2AHumanPersonIdError } from "./HumanInboxService.ts";
import { A2ALocalOperatorNotFoundError } from "./HumanPersonRegistry.ts";
import { A2ALedger } from "./LedgerService.ts";
import { PeerAdminService } from "./PeerAdminService.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { COALESCE_WINDOW, ReadChanges, layer as readChangesLayer } from "./ReadChanges.ts";
import { A2AParticipantNotFoundError } from "./SendService.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const METHODS = J5_CLIENT_READ_WS_METHODS;
const database = NodeSqliteClient.layer({ filename: ":memory:" });

/** The handlers over a given reads service; the peer list is not under test here. */
const handlersOver = (reads: Layer.Layer<ClientReadsService, SqlError>) =>
  makeClientReadRpcHandlers().pipe(
    Effect.provide(Layer.mergeAll(reads, Layer.mock(PeerAdminService)({}), readChangesLayer)),
  );

/**
 * The handlers over the real reads service, with the services a test cares about given and every
 * other one unimplemented, so a read that strays outside what the test set up fails loudly.
 */
const handlersWith = (given: {
  readonly inbox?: Layer.Layer<A2AHumanInbox>;
  readonly proposals?: Layer.Layer<AgentCrewProposalService>;
  readonly playbooks?: Layer.Layer<PlaybookStore, SqlError>;
  readonly runtimeRequests?: Layer.Layer<CrewRuntimeRequestService>;
  readonly archiveFacts?: Layer.Layer<A2AArchiveFacts>;
}) =>
  handlersOver(
    clientReadsLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          given.inbox ?? Layer.mock(A2AHumanInbox)({}),
          given.proposals ?? Layer.mock(AgentCrewProposalService)({}),
          given.playbooks ?? Layer.mock(PlaybookStore)({}),
          given.runtimeRequests ?? Layer.mock(CrewRuntimeRequestService)({}),
          given.archiveFacts ?? Layer.mock(A2AArchiveFacts)({}),
          Layer.mock(A2ALedger)({}),
          Layer.mock(ParticipantPlacementService)({}),
          Layer.mock(AgentCrewInstanceService)({}),
          Layer.mock(PlaybookCrewRelay)({}),
          Layer.mock(ArchiveCrewService)({}),
          database,
        ),
      ),
    ),
  );

/** The refusal a call ended in, as the client receives it. */
const refusalOf = <A>(call: Effect.Effect<A, J5ActionError>) =>
  call.pipe(
    Effect.flip,
    Effect.map(({ code, message }) => ({ code, message })),
  );

it("requires read scope for every client read and the change stream, and access:read for the peer list", () => {
  for (const method of Object.values(METHODS)) {
    assert.equal(
      requiredScopeForRpcMethod(method),
      method === METHODS.listPeers ? AuthAccessReadScope : AuthOrchestrationReadScope,
      method,
    );
  }
});

it.effect("returns the resolved person above an empty inbox and preserves explicit selection", () =>
  Effect.gen(function* () {
    const localPersonId = ParticipantId.make("human:local-operator");
    const explicitPersonId = ParticipantId.make("human:second-person");
    const missingPersonId = ParticipantId.make("human:missing-person");
    const requested: Array<string | undefined> = [];
    const requestedStatuses: Array<string | undefined> = [];
    const handlers = yield* handlersWith({
      inbox: Layer.mock(A2AHumanInbox)({
        resolvePersonId: (personId) => {
          requested.push(personId);
          if (personId === missingPersonId) {
            return Effect.fail(new A2AParticipantNotFoundError({ participantId: personId }));
          }
          return Effect.succeed(personId ?? localPersonId);
        },
        list: (_personId, status) => {
          requestedStatuses.push(status);
          return Effect.succeed([]);
        },
      }),
    });
    const list = handlers[METHODS.listHumanInbox];

    assert.deepStrictEqual(yield* list({ status: "open" }), {
      personId: localPersonId,
      items: [],
    });
    assert.deepStrictEqual(yield* list({ status: "open", personId: explicitPersonId }), {
      personId: explicitPersonId,
      items: [],
    });
    // A person who is not one of this server's people is a refusal in its own words.
    const missing = yield* refusalOf(list({ status: "open", personId: missingPersonId }));
    assert.equal(missing.code, "A2AParticipantNotFoundError");
    assert.include(missing.message, "Participant human:missing-person is not currently reachable");
    // An empty selection is no selection: the local person's inbox.
    assert.deepStrictEqual(yield* list({ status: "answered", personId: "" }), {
      personId: localPersonId,
      items: [],
    });
    assert.deepStrictEqual(requested, [undefined, explicitPersonId, missingPersonId, undefined]);
    assert.deepStrictEqual(requestedStatuses, ["open", "open", "answered"]);
  }),
);

it.effect("refuses a bad person selection in its own words, not as a server failure", () =>
  Effect.gen(function* () {
    const invalidPerson = ParticipantId.make("agent:client-reads:not-human");
    const missingPerson = ParticipantId.make("human:client-reads:missing");
    const handlers = yield* handlersWith({
      inbox: Layer.mock(A2AHumanInbox)({
        resolvePersonId: (personId) => {
          if (personId === invalidPerson) {
            return Effect.fail(new A2AHumanPersonIdError({ personId }));
          }
          if (personId === missingPerson) {
            return Effect.fail(new A2AParticipantNotFoundError({ participantId: personId }));
          }
          return Effect.fail(new A2ALocalOperatorNotFoundError());
        },
      }),
    });
    const count = handlers[METHODS.readOpenInboxCount];

    assert.deepStrictEqual(yield* refusalOf(count({ personId: invalidPerson })), {
      code: "A2AHumanPersonIdError",
      message:
        "Person agent:client-reads:not-human is not a durable human:<person-id>. Select an explicit person-scoped inbox.",
    });
    assert.deepStrictEqual(yield* refusalOf(count({ personId: missingPerson })), {
      code: "A2AParticipantNotFoundError",
      message:
        "Participant human:client-reads:missing is not currently reachable. Call j5_list_participants and choose an agent row with canReceiveMessage=true, or a human row with canOpenExchange=true to open an ask.",
    });
    assert.deepStrictEqual(yield* refusalOf(count({})), {
      code: "A2ALocalOperatorNotFoundError",
      message: "The host-local human operator registry entry is missing.",
    });
  }),
);

it.effect("keeps identity requests exact, ordered, and total, and refuses an id that is none", () =>
  Effect.gen(function* () {
    const alpha = ParticipantId.make("agent:client-reads:alpha");
    const unknown = ParticipantId.make("agent:client-reads:unknown");
    const received: Array<ReadonlyArray<ParticipantId>> = [];
    const entries = [
      { participantId: unknown, identity: { kind: "unknown" as const } },
      { participantId: alpha, identity: { kind: "known" as const, displayName: "Alpha" } },
    ];
    const handlers = yield* handlersOver(
      Layer.mock(ClientReadsService)({
        participantIdentities: ({ participantIds }) => {
          received.push(participantIds);
          return Effect.succeed({ entries });
        },
        openInboxCount: (personId) => Effect.succeed({ personId: personId ?? alpha, count: 3 }),
      }),
    );
    const identities = handlers[METHODS.readParticipantIdentities];

    // Repeats and order reach the service untouched; it alone decides what one entry per id means.
    assert.deepStrictEqual(yield* identities({ participantIds: [unknown, alpha, unknown] }), {
      entries,
    });
    assert.deepStrictEqual(received, [[unknown, alpha, unknown]]);

    assert.deepStrictEqual(yield* refusalOf(identities({ participantIds: [alpha, ""] })), {
      code: "invalid_request",
      message: "A participant id is invalid.",
    });
    assert.lengthOf(received, 1);

    assert.deepStrictEqual(yield* handlers[METHODS.readOpenInboxCount]({ personId: unknown }), {
      personId: unknown,
      count: 3,
    });
  }),
);

const proposal: CrewProposal = {
  id: "crew:j5:a2a:mcp:j5-crew-proposal:proposal:req",
  projectId: LedgerProjectId.make("project:gate"),
  captainParticipantId: ParticipantId.make("agent:j5:a2a:thread:captain"),
  captainThreadId: ThreadId.make("thread:captain"),
  crewInstanceId: null,
  kind: "roster",
  status: "open",
  brief: "Fix the flaky login test.",
  displayName: "Login Fix Crew",
  requestedSeats: [
    {
      workspace: { type: "shared" as const },
      seat: "builder",
      agentId: "builder",
      reason: "Implements the fix",
    },
  ],
  approvedSeats: null,
  createdAt: "2026-09-09T16:00:00.000Z",
  resolvedAt: null,
  reportedAt: null,
};

it.effect(
  "lists each open proposal with its playbook from the live YAML, and a broken one as its issue",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-crew-proposals-read-" });
      yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".j5/playbooks/release.yaml"),
        "title: Release\ndescription: Ship.\nsteps:\n  - id: plan\n    title: Plan\n    prompt: Plan.\n    persona: planner\n  - id: review\n    title: Review\n    prompt: Review.\n",
      );
      const withPlaybook = (
        id: string,
        name: string,
        steps: ReadonlyArray<string>,
      ): CrewProposal => ({
        ...proposal,
        id,
        requestedSeats: [
          {
            workspace: { type: "shared" as const },
            seat: "planner",
            agentId: null,
            reason: "Plans",
            steps,
          },
        ],
        playbook: { name, definitionPath: path.join(root, ".j5/playbooks", `${name}.yaml`) },
      });
      const handlers = yield* handlersWith({
        proposals: Layer.mock(AgentCrewProposalService)({
          listOpen: () =>
            Effect.succeed([
              proposal,
              withPlaybook("p-live", "release", ["plan"]),
              withPlaybook("p-lost", "release", ["ship"]),
              withPlaybook("p-gone", "gone", []),
            ]),
        }),
        playbooks: playbookStoreLayer.pipe(
          Layer.provide(database),
          Layer.provide(NodeServices.layer),
        ),
      });
      const { proposals } = yield* handlers[METHODS.listCrewProposals]();

      assert.equal(proposals[0]?.id, proposal.id);
      assert.lengthOf(proposals[0]?.requestedSeats ?? [], 1);
      assert.isNull(proposals[0]?.playbook);
      assert.deepStrictEqual(proposals[1]?.playbook, {
        name: "release",
        title: "Release",
        steps: [
          { id: "plan", title: "Plan", persona: "planner" },
          { id: "review", title: "Review" },
        ],
        issue: null,
      });
      assert.include(proposals[2]?.playbook?.issue, "Step ship is no longer in the playbook");
      assert.deepStrictEqual(proposals[3]?.playbook?.steps, []);
      assert.include(proposals[3]?.playbook?.issue, "No playbook named gone");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lists a live Crew seat's approvals", () =>
  Effect.gen(function* () {
    const request = {
      threadId: ThreadId.make("thread:builder"),
      requestId: RuntimeRequestId.make("req:1"),
      crewInstanceId: "crew:1",
      crewName: "Release Crew",
      projectId: "project:1",
      seat: "builder",
      threadTitle: "builder",
      createdAt: "2026-09-24T12:00:00.000Z",
      requestKind: "command" as const,
      detail: "Run the tests?",
    };
    const handlers = yield* handlersWith({
      runtimeRequests: Layer.mock(CrewRuntimeRequestService)({ list: Effect.succeed([request]) }),
    });
    assert.deepStrictEqual(yield* handlers[METHODS.listCrewRuntimeRequests](), {
      requests: [request],
    });
  }),
);

it.effect("tells a failed pre-archive read as a failure, never as a clean archive", () =>
  Effect.gen(function* () {
    const handlers = yield* handlersWith({
      archiveFacts: Layer.mock(A2AArchiveFacts)({
        readForThread: () =>
          Effect.fail(
            new A2AArchiveFactsError({
              operation: "read pre-archive facts",
              cause: new Error("placement unavailable"),
            }),
          ),
      }),
    });
    assert.deepStrictEqual(
      yield* refusalOf(
        handlers[METHODS.readPreArchiveFacts]({ threadId: ThreadId.make("thread:pre-archive") }),
      ),
      { code: "A2AArchiveFactsError", message: "Pre-archive fact lookup failed." },
    );
  }),
);

it.effect("streams the read revisions, starting with where they stand", () =>
  Effect.gen(function* () {
    const changes = yield* ReadChanges;
    yield* changes.notify("crew");
    // The handlers stream the server's one instance, the one the writers notify.
    const handlers = yield* makeClientReadRpcHandlers().pipe(
      Effect.provide(
        Layer.merge(Layer.mock(ClientReadsService)({}), Layer.mock(PeerAdminService)({})),
      ),
    );
    const first = yield* handlers[METHODS.subscribeReadChanges]().pipe(
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust(COALESCE_WINDOW);
    assert.deepStrictEqual(
      yield* Fiber.join(first),
      Option.some({
        inbox: 0,
        crew: 1,
        fleet: 0,
        runtimeRequests: 0,
        peers: 0,
        sharing: 0,
      }),
    );
  }).pipe(Effect.provide(readChangesLayer)),
);
