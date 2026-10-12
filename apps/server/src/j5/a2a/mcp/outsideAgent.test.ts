import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthMcpClientAccess,
  EnvironmentId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../../config.ts";
import {
  McpInvocationContext,
  type McpInvocationScope,
} from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { PlaybookCrewRelay } from "../../playbooks/PlaybookCrewRelay.ts";
import { PlaybookStore } from "../../playbooks/PlaybookStore.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "../ArchiveCrewService.ts";
import { CrewProposalService } from "../CrewProposalService.ts";
import { CrewStopService } from "../CrewStopService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../LedgerService.ts";
import { runJ5A2AMigrations } from "../Migrations.ts";
import { noneLayer as peerDirectoryNoneLayer } from "../PeerDirectory.ts";
import { PeerRegistryService } from "../PeerRegistryService.ts";
import { ParticipantPlacementService, PlacementProjectNotFoundError } from "../PlacementService.ts";
import { layer as sendLayer } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { ThreadRegistration } from "../ThreadRegistration.ts";
import {
  type AgentParticipant,
  CommCommandId,
  LedgerProjectId,
  MessageSentPayload,
  ParticipantId,
} from "../contracts.ts";
import { fakeSpawnWorkspaceLayer, noRepository } from "../test-support/spawnWorkspaceFakes.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5ListParticipantsResult, J5Toolkit } from "./tools.ts";

const timestamp = "2026-10-12T12:00:00.000Z";
const projectId = LedgerProjectId.make("project:j5:outside");
const otherProjectId = LedgerProjectId.make("project:j5:outside-other");
const emptyProjectId = LedgerProjectId.make("project:j5:outside-empty");
const agent = (name: string): AgentParticipant => ({
  kind: "agent",
  id: ParticipantId.make(`agent:j5:outside:${name}`),
  threadId: ThreadId.make(`thread:j5:outside:${name}`),
});
/** Runs with approvals, so every approved level but read-only covers it. */
const careful = agent("careful");
/** Runs in full access, above a client approved for less. */
const unrestricted = agent("unrestricted");
const elsewhere = agent("elsewhere");
const person = ParticipantId.make("human:outside-person");
const outsideId = ParticipantId.make("outside:session-1");
const runtimeModes = new Map<ThreadId, RuntimeMode>([
  [careful.threadId, "approval-required"],
  [unrestricted.threadId, "full-access"],
  [elsewhere.threadId, "approval-required"],
]);

/** An outside agent's scope, as the MCP OAuth authenticator builds it. */
const outsideScope = (access: AuthMcpClientAccess): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:j5:outside"),
  capabilities: new Set(["orchestration", "worktree", "pull-requests"] as const),
  issuedAt: 1,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code (laptop)", access },
});

const decodeList = Schema.decodeUnknownEffect(J5ListParticipantsResult);
const decodeSent = Schema.decodeUnknownEffect(Schema.fromJsonString(MessageSentPayload));
const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "j5-mcp-outside-",
}).pipe(Layer.provide(NodeServices.layer));

interface Stop {
  readonly commandId: string;
  readonly threadId: ThreadId;
}

/** The real ledger and send service on an in-memory database; everything else is a stand-in. */
const makeLayer = (stops: Ref.Ref<ReadonlyArray<Stop>>) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const idle = (threadId: ThreadId) =>
    ({
      thread: {
        id: threadId,
        projectId: ProjectId.make(projectId),
        archivedAt: null,
        runtimeMode: runtimeModes.get(threadId),
        interactionMode: "default",
      },
      runs: [] as ReadonlyArray<OrchestrationV2Run>,
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    }) as unknown as OrchestrationV2ThreadProjection;
  const dependencies = Layer.mergeAll(
    database,
    ledger,
    send,
    Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          runtimeModes.has(threadId)
            ? liveThreadShell(threadId, { runtimeMode: runtimeModes.get(threadId)! })
            : null,
        ),
      getThreadProjection: (threadId) => Effect.succeed(idle(threadId)),
      dispatch: (command) =>
        command.type === "thread.stop"
          ? Ref.update(stops, (items) => [
              ...items,
              { commandId: command.commandId, threadId: command.threadId },
            ]).pipe(Effect.as({ sequence: 1, storedEvents: [] }))
          : Effect.die(`unexpected dispatch ${command.type}`),
      stopDelegatedTasks: () => Effect.void,
    }),
    Layer.mock(OrchestratorV2)({
      getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] } as never),
      getThreadRecords: ((threadId: ThreadId) => Effect.succeed(idle(threadId))) as never,
    }),
    Layer.mock(ParticipantPlacementService)({
      // A project no thread was ever created in has no ledger, as the real service reports.
      listParticipants: (id) =>
        id === emptyProjectId
          ? Effect.fail(new PlacementProjectNotFoundError({ projectId: id }))
          : Effect.succeed([]),
    }),
    Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
    Layer.mock(A2AHomeRegistrar)({}),
    Layer.mock(SpawnCompositionService)({}),
    Layer.mock(OrchestratorMcpService)({}),
    Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
    Layer.mock(ArchiveCrewService)({}),
    Layer.mock(CrewStopService)({}),
    Layer.mock(CrewProposalService)({}),
    Layer.mock(ThreadRegistration)({}),
    Layer.mock(PlaybookStore)({}),
    Layer.mock(PlaybookCrewRelay)({}),
    Layer.mock(ProjectService)({
      getById: (id) =>
        Effect.succeedSome({
          id,
          title: "Outside project",
          workspaceRoot: "/tmp/j5-mcp-outside",
          defaultModelSelection: null,
          scripts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: null,
        }),
    }),
    peerDirectoryNoneLayer,
    Layer.mock(PeerRegistryService)({}),
    serverConfigLayer,
    NodeServices.layer,
  );
  return J5ToolkitHandlersLive.pipe(
    Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
    Layer.provideMerge(dependencies),
  );
};

const setup = Effect.fn("test.j5.a2a.mcp.outside.setup")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  const sql = yield* SqlClient.SqlClient;
  const members = [
    [projectId, careful],
    [projectId, unrestricted],
    [otherProjectId, elsewhere],
  ] as const;
  for (const id of [projectId, otherProjectId]) {
    yield* ledger.ensureProject({ projectId: id, createdAt: timestamp });
  }
  for (const [index, [id, participant]] of members.entries()) {
    yield* ledger.append({
      commandId: CommCommandId.make(`command:join:${String(index)}`),
      projectId: id,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participant.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  }
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES (${person}, 1, ${timestamp})
  `;
});

/** One tool call as an outside agent approved at `access`. */
const callAs = Effect.fn("test.j5.a2a.mcp.outside.call")(function* <
  Name extends keyof typeof J5Toolkit.tools,
>(access: AuthMcpClientAccess, name: Name, args: object) {
  const toolkit = yield* J5Toolkit;
  const result = yield* toolkit
    .handle(name, args as never)
    .pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(Effect.fromOption),
      Effect.provideService(McpInvocationContext, outsideScope(access)),
    );
  return {
    isFailure: result.isFailure,
    result: result.result as unknown,
    encoded: result.encodedResult as unknown,
    text: JSON.stringify(result.encodedResult),
  };
});

it.effect(
  "sends an outside agent's plain message into the receiver's project, capped by its approved level",
  () =>
    Effect.gen(function* () {
      const stops = yield* Ref.make<ReadonlyArray<Stop>>([]);
      yield* Effect.gen(function* () {
        yield* setup();
        const sql = yield* SqlClient.SqlClient;
        const args = {
          to: careful.id,
          message: "The deploy is red.",
          client_request_id: "deploy-red-1",
        };

        const sent = yield* callAs("auto-accept-edits", "j5_send_message", args);
        assert.isFalse(sent.isFailure, sent.text);
        const replay = yield* callAs("auto-accept-edits", "j5_send_message", args);
        assert.deepStrictEqual(replay.encoded, sent.encoded);
        const events = yield* sql<{
          readonly project_id: string;
          readonly command_id: string;
          readonly sender: string;
          readonly receiver: string;
        }>`SELECT project_id, command_id, sender, receiver
           FROM j5_a2a_comm_event WHERE kind = 'message.sent'`;
        // One message, in the receiver's project, under the client session's retry namespace.
        assert.deepStrictEqual(events, [
          {
            project_id: projectId,
            command_id: "command:j5:a2a:mcp:client%3Asession-1:send_message:deploy-red-1",
            sender: outsideId,
            receiver: careful.id,
          },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT participant_id, name FROM j5_a2a_outside_agent`, [
          { participant_id: outsideId, name: "Claude Code (laptop)" },
        ]);

        // A steer is allowed under the same cap and carries the limit to delivery.
        const steer = yield* callAs("auto-accept-edits", "j5_send_message", {
          to: careful.id,
          message: "Stop the rollout now.",
          mode: "steer",
        });
        assert.isFalse(steer.isFailure, steer.text);
        const payloads = yield* sql<{ readonly payload: string }>`
          SELECT payload FROM j5_a2a_comm_event WHERE kind = 'message.sent' ORDER BY seq
        `;
        const steered = yield* decodeSent(payloads[1]?.payload);
        assert.equal(steered.mode, "steer");
        assert.deepStrictEqual(steered.modeLimit, {
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
        });
        assert.isUndefined((yield* decodeSent(payloads[0]?.payload)).modeLimit);

        // The receiver runs above the approved level: refused, for a plain queued send too.
        for (const mode of [undefined, "steer", "restart"] as const) {
          const above = yield* callAs("auto-accept-edits", "j5_send_message", {
            to: unrestricted.id,
            message: "Above my level.",
            ...(mode === undefined ? {} : { mode }),
          });
          assert.isTrue(above.isFailure);
          assert.include(above.text, "broader permissions than this MCP client was approved for");
        }
        // A client approved for full access reaches it.
        assert.isFalse(
          (yield* callAs("full-access", "j5_send_message", {
            to: unrestricted.id,
            message: "Within my level.",
          })).isFailure,
        );

        // A read-only client changes nothing.
        const readOnly = yield* callAs("read-only", "j5_send_message", args);
        assert.isTrue(readOnly.isFailure);
        assert.include(readOnly.text, "read-only access");

        assert.lengthOf(yield* sql`SELECT 1 FROM j5_a2a_delivery`, 3);
      }).pipe(Effect.provide(makeLayer(stops)));
    }),
);

it.effect("refuses what an outside agent cannot send, naming the legal move", () =>
  Effect.gen(function* () {
    const stops = yield* Ref.make<ReadonlyArray<Stop>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const message = "Can you check this?";

      // No reply can reach it, so every ask and reply field is refused.
      for (const field of [
        { expect_reply: true, intent: "Check the deploy" },
        { exchange_id: "exchange:j5:a2a:some-ask" },
        { intent: "Check the deploy" },
        { urgency: "soon" },
      ]) {
        const refused = yield* callAs("full-access", "j5_send_message", {
          to: careful.id,
          message,
          ...field,
        });
        assert.isTrue(refused.isFailure);
        assert.include(refused.text, "cannot receive a reply");
        assert.include(refused.text, "Retry j5_send_message without them.");
      }

      const toPerson = yield* callAs("full-access", "j5_send_message", { to: person, message });
      assert.isTrue(toPerson.isFailure);
      assert.include(toPerson.text, "an outside agent cannot ask");

      const toPeer = yield* callAs("full-access", "j5_send_message", {
        to: "agent:j5:a2a:thread:on-a-peer",
        message,
      });
      assert.isTrue(toPeer.isFailure);
      assert.include(toPeer.text, "sign in to that server's own MCP URL");

      const toOutside = yield* callAs("full-access", "j5_send_message", {
        to: "outside:session-2",
        message,
      });
      assert.isTrue(toOutside.isFailure);
      assert.include(toOutside.text, "nothing can be delivered to it");

      assert.lengthOf(yield* sql`SELECT 1 FROM j5_a2a_delivery`, 0);
    }).pipe(Effect.provide(makeLayer(stops)));
  }),
);

it.effect("lists one project for any outside agent, with no row of its own", () =>
  Effect.gen(function* () {
    const stops = yield* Ref.make<ReadonlyArray<Stop>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      // It has sent, so it has a name on record; it is still listed for nobody.
      yield* callAs("full-access", "j5_send_message", { to: careful.id, message: "Hello." });

      const listed = yield* callAs("read-only", "j5_list_participants", {
        project_id: projectId,
      });
      assert.isFalse(listed.isFailure, listed.text);
      const rows = (yield* decodeList(listed.encoded)).participants;
      assert.sameMembers(
        rows.map((row) => row.participant_id),
        [person, careful.id, unrestricted.id],
      );
      assert.isTrue(rows.every((row) => !row.self && row.project_id === projectId));
      assert.isTrue(rows.find((row) => row.participant_id === careful.id)?.can_receive_message);
      // It sends plain messages only: nobody takes an Exchange or an urgency from it, and a
      // person, who takes only asks, takes nothing.
      assert.isTrue(rows.every((row) => !row.can_open_exchange && !row.accepts_urgency));
      assert.isFalse(rows.find((row) => row.participant_id === person)?.can_receive_message);

      // A project with no thread yet has no ledger. It lists the people and no agents.
      const empty = yield* callAs("read-only", "j5_list_participants", {
        project_id: emptyProjectId,
      });
      assert.isFalse(empty.isFailure, empty.text);
      assert.deepStrictEqual(
        (yield* decodeList(empty.encoded)).participants.map((row) => row.participant_id),
        [person],
      );

      const noProject = yield* callAs("read-only", "j5_list_participants", {});
      assert.isTrue(noProject.isFailure);
      assert.include(noProject.text, "needs a project_id");
      assert.include(noProject.text, "t3_project_list");
    }).pipe(Effect.provide(makeLayer(stops)));
  }),
);

it.effect("stops an agent for an outside agent only within its approved level", () =>
  Effect.gen(function* () {
    const stops = yield* Ref.make<ReadonlyArray<Stop>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      // The target is in another project than any the client has named: a stop reaches the server.
      const args = { participant_id: elsewhere.id, client_request_id: "stop-1" };
      const stopped = yield* callAs("approval-required", "j5_stop_agent", args);
      assert.equal(stopped.result, "already_idle", stopped.text);
      yield* callAs("approval-required", "j5_stop_agent", args);
      const dispatched = yield* Ref.get(stops);
      assert.deepStrictEqual(
        dispatched.map((stop) => stop.threadId),
        [elsewhere.threadId, elsewhere.threadId],
      );
      // A retry reuses the command, which is namespaced by the client session.
      assert.equal(dispatched[0]?.commandId, dispatched[1]?.commandId);
      assert.include(dispatched[0]?.commandId, "client%3Asession-1");

      const above = yield* callAs("auto", "j5_stop_agent", { participant_id: unrestricted.id });
      assert.isTrue(above.isFailure);
      assert.include(above.text, "broader permissions than you do");
      const readOnly = yield* callAs("read-only", "j5_stop_agent", args);
      assert.isTrue(readOnly.isFailure);
      assert.include(readOnly.text, "read-only access");
      assert.lengthOf(yield* Ref.get(stops), 2, "a refused stop dispatches nothing");
    }).pipe(Effect.provide(makeLayer(stops)));
  }),
);

it.effect("keeps thread-only tools refused for an outside agent, naming what it can do", () =>
  Effect.gen(function* () {
    const stops = yield* Ref.make<ReadonlyArray<Stop>>([]);
    yield* Effect.gen(function* () {
      const workspace = { type: "shared" } as const;
      const refusals = [
        [
          "j5_propose_crew",
          {
            name: "Deploy crew",
            brief: "Fix the deploy.",
            seats: [{ seat: "builder", reason: "Builds", instructions: "Build.", workspace }],
          },
          "j5_spawn_agent and brief it to propose the Crew",
        ],
        [
          "j5_request_crew_member",
          { seat: "reviewer", reason: "Reviews", instructions: "Review.", workspace },
          "j5_spawn_agent and brief it to",
        ],
        ["j5_stop_crew", { crew_instance_id: "crew:1" }, "Only a Crew's Captain stops it"],
        ["j5_archive_crew", { crew_instance_id: "crew:1" }, "Only a Crew's Captain archives it"],
        [
          "j5_clear_own_ask",
          { exchange_id: "exchange:j5:a2a:some-ask", client_request_id: "clear-1" },
          "has no ask to withdraw",
        ],
        [
          "j5_playbook_next",
          { runId: "run:1", client_request_id: "next-1", expectedStepId: "step-1" },
          "j5_spawn_agent and brief it to run the playbook",
        ],
        [
          "j5_playbook_start",
          { name: "release", client_request_id: "start-1" },
          "j5_spawn_agent and brief it to run the playbook",
        ],
      ] as const;
      for (const [name, args, legalMove] of refusals) {
        const refused = yield* callAs("full-access", name, args);
        assert.isTrue(refused.isFailure, name);
        assert.include(refused.text, "signed in from outside a thread", name);
        assert.include(refused.text, legalMove, name);
        // A read-only client is refused as one before anything else.
        assert.include((yield* callAs("read-only", name, args)).text, "read-only access", name);
      }
      // The reads that need a calling thread name the legal move at every level, read-only too.
      for (const [name, args] of [
        ["j5_playbook_list", {}],
        ["j5_playbook_read", { name: "release" }],
        ["j5_playbook_current", {}],
      ] as const) {
        const refused = yield* callAs("read-only", name, args);
        assert.isTrue(refused.isFailure, name);
        assert.include(refused.text, "signed in from outside a thread", name);
        assert.include(refused.text, "j5_spawn_agent and brief it to read or run", name);
      }
    }).pipe(Effect.provide(makeLayer(stops)));
  }),
);
