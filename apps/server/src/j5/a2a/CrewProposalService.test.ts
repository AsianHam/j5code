import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { stringify } from "yaml";

import { ServerConfig } from "../../config.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { createAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { buildAgentPersonaCatalog } from "../agents/agentPersonaRouting.ts";
import { playbookTools } from "../playbooks/mcp.ts";
import { makePlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import { crewLaunchReportText } from "./crewGateNotice.ts";
import { crewSeatFromInput } from "./mcp/handlers.ts";
import { J5ProposeCrewInput } from "./mcp/tools.ts";
import { PlaybookStore, playbookStoreLayer } from "../playbooks/PlaybookStore.ts";
import { seedPersonas, seedPlaybookOwners } from "../playbooks/testFixtures.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
  type AgentCrewInstance,
} from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  layer as proposalStoreLayer,
} from "./AgentCrewProposalService.ts";
import { CrewLaunchReporter } from "./CrewLaunchReporter.ts";
import {
  CrewLaunchOperationError,
  CrewLaunchService,
  layer as crewLaunchLayer,
  type CrewCaptain,
  type CrewLaunchSeat,
  type ResolvedCrewLaunchSeat,
} from "./CrewLaunchService.ts";
import {
  CREW_SEAT_CAP,
  CrewProposalService,
  layer as crewProposalLayer,
  type ResolveCrewProposalInput,
  proposalForGuest,
  withoutHostPaths,
} from "./CrewProposalService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import type { ResolvedSpawnWorkspace } from "./spawnWorkspace.ts";
import { fakeSpawnWorkspaceLayer, noRepository } from "./test-support/spawnWorkspaceFakes.ts";
import { crewSeatRequestKey, spawnThreadId } from "./spawnIds.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const projectId = LedgerProjectId.make("ledger:crew-proposal");
const captainThread = ThreadId.make("thread:captain");
const captainId = ParticipantId.make("agent:j5:a2a:thread:captain");
const createdAt = DateTime.makeUnsafe("2026-09-09T16:00:00.000Z");
const thread = (id: ThreadId): OrchestrationV2AppThread =>
  ({
    id,
    projectId: ProjectId.make("project:crew-proposal"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2AppThread;
const captain: CrewCaptain = {
  projectId,
  projectTitle: "Proposal project",
  participantId: captainId,
  thread: thread(captainThread),
};

const launchFailure = (cause: unknown) =>
  new CrewLaunchOperationError({ phase: "test launcher", seatName: null, createdSeats: [], cause });

const decodeProposeCrewInput = Schema.decodeUnknownEffect(J5ProposeCrewInput);

/** The launcher's resolution is tested on its own; here a seat's choice passes through as given. */
const fakeWorkspace = (seat: CrewLaunchSeat): ResolvedSpawnWorkspace =>
  seat.workspace.type === "worktree"
    ? { type: "worktree", baseRef: seat.workspace.baseRef, startFromOrigin: false }
    : seat.workspace.type === "existing_worktree"
      ? {
          type: "existing_worktree",
          worktreePath: seat.workspace.worktreePath,
          branch: "fix/login",
        }
      : { type: "shared" };

/** What the fake launcher offers the card: the Captain on main, with one worktree. */
const fakeWorkspaceOptions = {
  currentBranch: "main",
  cwd: "/repo",
  worktrees: [{ path: "/repo-worktrees/feature", branch: "fix/login" }],
};

/**
 * The launcher is exercised by its own test; here it records members so the gate can be proven.
 * Like the real one it records the Crew before any seat spawns and reports it through
 * `onRecorded`; a display name of "Boom" fails before recording, "Boom after record" fails after.
 */
const fakeLauncher = (crews: AgentCrewInstanceService["Service"]) =>
  Layer.mock(CrewLaunchService)({
    workspaceOptions: () => Effect.succeed(fakeWorkspaceOptions),
    resolveSeats: (captain, seats) =>
      Effect.succeed(
        seats.map(
          (seat) =>
            ({
              seat,
              assignment: null,
              modelSelection: seat.modelSelection ?? captain.thread.modelSelection,
              runtimeMode: seat.runtimeMode ?? captain.thread.runtimeMode,
              outputArtifact: null,
              agentDisplayName: seat.agentId ?? "custom",
              workspace: fakeWorkspace(seat),
              runtime: {
                seat: seat.name,
                provider: "Codex",
                harness: "Codex",
                model: (seat.modelSelection ?? captain.thread.modelSelection).model,
                reasoning: "High",
                access: "Full access",
                modelSelection: seat.modelSelection ?? captain.thread.modelSelection,
                runtimeMode: seat.runtimeMode ?? captain.thread.runtimeMode,
                workspace: fakeWorkspace(seat),
              },
            }) satisfies ResolvedCrewLaunchSeat,
        ),
      ),
    launch: (input) =>
      input.displayName === "Boom"
        ? Effect.fail(launchFailure(new Error("provider unavailable")))
        : crews
            .record({
              id: `crew:${input.requestKey}`,
              projectId: input.captain.projectId,
              captainParticipantId: input.captain.participantId,
              captainThreadId: input.captain.thread.id,
              displayName: input.displayName,
              brief: input.brief,
              createdAt: DateTime.formatIso(createdAt),
              members: input.seats.map((seat) => ({
                seatName: seat.name,
                agentId: seat.agentId,
                participantId: ParticipantId.make(`agent:j5:a2a:thread:${seat.name}`),
                threadId: ThreadId.make(`thread:${seat.name}`),
                reason: seat.reason,
              })),
            })
            .pipe(
              Effect.mapError(launchFailure),
              Effect.tap((instance) => input.onRecorded?.(instance) ?? Effect.void),
              // Launch once: a seat that fails to spawn is an outcome, not an error. "Boom after
              // record" loses its second seat, which the real launcher drops from the record.
              Effect.flatMap((instance) =>
                input.displayName === "Boom after record"
                  ? crews.removeMembers(instance.id, [input.seats[1]!.name]).pipe(
                      Effect.mapError(launchFailure),
                      Effect.andThen(crews.read(instance.id).pipe(Effect.mapError(launchFailure))),
                      Effect.map((current) => ({
                        instance: current!,
                        seats: input.seats.map((seat, index) =>
                          index === 1
                            ? {
                                seatName: seat.name,
                                kind: "not_created" as const,
                                detail: "second seat failed to spawn",
                              }
                            : { seatName: seat.name, kind: "created" as const },
                        ),
                      })),
                    )
                  : Effect.succeed({
                      instance,
                      seats: input.seats.map((seat) => ({
                        seatName: seat.name,
                        kind: "created" as const,
                      })),
                    }),
              ),
            ),
    // Additions reserve rows under the real deterministic ids before spawning, like the launcher,
    // then resolve the proposal through `onReserved` before any seat spawns.
    addSeats: (input) =>
      Effect.gen(function* () {
        const outcome = yield* crews.addMembers(
          input.instance.id,
          input.seats.map((seat) => {
            const threadId = spawnThreadId({
              providerSessionId: input.providerSessionId,
              requestKey: crewSeatRequestKey(input.requestKey, seat.name),
            });
            return {
              seatName: seat.name,
              agentId: seat.agentId,
              participantId: participantIdForThread(threadId),
              threadId,
              reason: seat.reason,
            };
          }),
        );
        if (outcome.instance === null) return yield* launchFailure(new Error("crew is gone"));
        if (input.onReserved !== undefined)
          yield* input.onReserved(outcome.instance).pipe(
            Effect.tapError(() =>
              crews
                .removeMembers(
                  outcome.instance!.id,
                  input.seats.map((seat) => seat.name),
                )
                .pipe(Effect.ignore),
            ),
          );
        return {
          instance: outcome.instance,
          seats: input.seats.map((seat) => ({ seatName: seat.name, kind: "created" as const })),
        };
      }).pipe(Effect.mapError(launchFailure)),
  });

const withPreview = (gate: CrewProposalService["Service"]): CrewProposalService["Service"] => ({
  ...gate,
  resolve: (input: ResolveCrewProposalInput) =>
    Effect.gen(function* () {
      if (input.decision === "decline") return yield* gate.resolve(input);
      const preview = yield* gate.preview({
        proposalId: input.proposalId,
        ...(input.seats === undefined ? {} : { seats: input.seats }),
      });
      return yield* gate.resolve({ ...input, approvalToken: preview.approvalToken });
    }),
});

/** A live Crew of `size` scout seats, approved through the gate; the seat names are s0, s1, ... */
const seedCrew = (gate: CrewProposalService["Service"], requestKey: string, size: number) =>
  Effect.gen(function* () {
    const opened = yield* gate.propose({
      requestKey,
      captain,
      displayName: `Crew ${requestKey}`,
      brief: "Fill the seats.",
      seats: Array.from({ length: size }, (_, index) => ({
        workspace: { type: "shared" as const },
        seat: `s${index}`,
        agentId: "scout",
        reason: "Holds a seat",
      })),
    });
    const approved = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "approve" });
    return approved.instance as AgentCrewInstance;
  });

/** How the gate refuses an addition the Crew cannot seat, whichever door it came through. */
const assertCrewFull = (error: { readonly _tag: string; readonly message: string }) => {
  assert.equal(error._tag, "CrewProposalRequestError");
  assert.include(error.message, "is full");
  assert.include(error.message, "propose a new crew");
};

const fixture = Effect.gen(function* () {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const storage = Layer.mergeAll(crewInstanceLayer, proposalStoreLayer, ledgerLayer).pipe(
    Layer.provideMerge(database),
  );
  const context = yield* Layer.build(storage);
  const crews = Context.get(context, AgentCrewInstanceService);
  yield* runMigrations().pipe(Effect.provide(context));
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  yield* Effect.provide(
    Effect.gen(function* () {
      yield* (yield* A2ALedger).ensureProject({
        projectId: projectId,
        createdAt: DateTime.formatIso(createdAt),
      });
    }),
    context,
  );
  const captainModel = yield* Ref.make("gpt-5.6-sol");
  const notices = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  // Seat threads whose archive the store refuses, to prove a decline whose cleanup fails stays open.
  const noticeFailure = yield* Ref.make(false);
  const archiveFailures = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Seat threads that never came to exist (a not-found), and ones whose read the store cannot answer.
  const missingThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  const unreadableThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Threads the person archived, and ones they deleted (the store keeps the row, stamped).
  const archivedThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  const deletedThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  // An approval is told to the Captain by the launch report, once its seats have started; here the
  // reporter records which proposals it was handed.
  const watched = yield* Ref.make<ReadonlyArray<string>>([]);
  // While set, a resolution lands nothing: the store answers as if the row were no longer open.
  const resolveFailure = yield* Ref.make(false);
  // While set, the proposal-to-Crew link write fails with a database error.
  const attachFailure = yield* Ref.make(false);
  const store = Context.get(context, AgentCrewProposalService);
  const flakyStore = Layer.succeed(AgentCrewProposalService, {
    ...store,
    resolve: (input) =>
      Ref.get(resolveFailure).pipe(
        Effect.flatMap((failing) => (failing ? Effect.succeed(null) : store.resolve(input))),
      ),
    attachInstance: (id, crewInstanceId) =>
      Ref.get(attachFailure).pipe(
        Effect.flatMap((failing) =>
          failing
            ? Effect.fail(
                new SqlError({ reason: new UnknownError({ cause: new Error("disk I/O error") }) }),
              )
            : store.attachInstance(id, crewInstanceId),
        ),
      ),
  });
  const layer = crewProposalLayer.pipe(
    Layer.provideMerge(flakyStore),
    Layer.provideMerge(fakeLauncher(crews)),
    Layer.provideMerge(
      Layer.mock(CrewLaunchReporter)({
        watch: (proposalId) => Ref.update(watched, (items) => [...items, proposalId]),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.gen(function* () {
            // The orchestrator wraps the store's failure either way; the cause tells them apart.
            if ((yield* Ref.get(missingThreads)).has(threadId))
              return yield* new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreThreadNotFoundError({ threadId }),
              });
            if ((yield* Ref.get(unreadableThreads)).has(threadId))
              return yield* new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreReadError({ threadId }),
              });
            return {
              thread: {
                ...thread(threadId),
                archivedAt: (yield* Ref.get(archivedThreads)).has(threadId) ? createdAt : null,
                deletedAt: (yield* Ref.get(deletedThreads)).has(threadId) ? createdAt : null,
                modelSelection: {
                  ...thread(threadId).modelSelection,
                  model: yield* Ref.get(captainModel),
                },
              },
            } as unknown as OrchestrationV2ThreadProjection;
          }),
        dispatch: (command) =>
          Effect.gen(function* () {
            if (
              (command.type === "thread.archive" &&
                (yield* Ref.get(archiveFailures)).has(command.threadId)) ||
              (command.type === "message.dispatch" && (yield* Ref.get(noticeFailure)))
            )
              return yield* Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              );
            yield* Ref.update(notices, (items) => [...items, command]);
            return { events: [], effects: [] } as never;
          }),
      }),
    ),
    Layer.provideMerge(playbookStoreLayer),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-proposal-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    notices,
    watched,
    archiveFailures,
    missingThreads,
    unreadableThreads,
    archivedThreads,
    deletedThreads,
    noticeFailure,
    resolveFailure,
    attachFailure,
    captainModel,
  };
});

it.effect("reports what the person decided about a roster, and what they changed first", () =>
  Effect.gen(function* () {
    const { layer } = yield* fixture;
    const recorded: Array<Readonly<Record<string, unknown>>> = [];
    const analytics = Layer.succeed(
      AnalyticsService,
      AnalyticsService.of({
        record: (event, properties = {}) =>
          Effect.sync(() => void recorded.push({ event, ...properties })),
        flush: Effect.void,
      }),
    );
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const seat = (name: string) => ({
        workspace: { type: "shared" as const },
        seat: name,
        agentId: name,
        reason: `Does the ${name} work`,
      });
      const edited = yield* gate.propose({
        requestKey: "analytics-edited",
        captain,
        displayName: "Edited Crew",
        brief: "Fix the flaky login test.",
        seats: [seat("builder"), seat("critic")],
      });
      // The person drops the critic and adds a security pass.
      yield* gate.resolve({
        proposalId: edited.proposal.id,
        decision: "approve",
        seats: [seat("builder"), seat("sentry")],
      });
      const refused = yield* gate.propose({
        requestKey: "analytics-declined",
        captain,
        displayName: "Declined Crew",
        brief: "Rewrite everything.",
        seats: [seat("builder")],
      });
      yield* gate.resolve({ proposalId: refused.proposal.id, decision: "decline" });
    }).pipe(Effect.provide(layer.pipe(Layer.provide(analytics))));

    const resolved = { event: "j5.crew.proposal.resolved", kind: "roster", hasPlaybook: false };
    assert.deepStrictEqual(recorded, [
      {
        ...resolved,
        decision: "approved",
        requestedSeats: 2,
        durationMs: 0,
        approvedSeats: 2,
        seatsAdded: 1,
        seatsRemoved: 1,
        seatsRenamed: 0,
        seatsRuntimeChanged: 0,
        seatsInstructionsChanged: 0,
      },
      { ...resolved, decision: "declined", requestedSeats: 1, durationMs: 0 },
    ]);
  }),
);

it.effect(
  "holds a roster until the human approves, honours human-added seats, and hands the launch to the report",
  () =>
    Effect.gen(function* () {
      const { layer, notices, watched } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const store = yield* AgentCrewProposalService;
        const seats = [
          {
            workspace: { type: "shared" as const },
            seat: "builder",
            agentId: "builder",
            reason: "Implements the fix",
          },
          {
            workspace: { type: "shared" as const },
            seat: "critic",
            agentId: "critic",
            reason: "Reviews it",
          },
        ];
        const open = yield* gate.propose({
          requestKey: "propose-1",
          captain,
          displayName: "Login Fix Crew",
          brief: "Fix the flaky login test.",
          seats,
        });
        assert.equal(open.proposal.status, "open");
        assert.isNull(open.instance);
        assert.lengthOf(yield* store.listOpen(), 1);
        assert.lengthOf(yield* Ref.get(notices), 0);

        const replay = yield* gate.propose({
          requestKey: "propose-1",
          captain,
          displayName: "Login Fix Crew",
          brief: "Fix the flaky login test.",
          seats,
        });
        assert.equal(replay.proposal.id, open.proposal.id);
        assert.lengthOf(yield* store.listOpen(), 1);

        const approved = yield* gate.resolve({
          proposalId: open.proposal.id,
          decision: "approve",
          seats: [
            ...seats,
            {
              workspace: { type: "shared" as const },
              seat: "sentry",
              agentId: "sentry",
              reason: "Human added a security pass",
            },
          ],
        });
        assert.equal(approved.proposal.status, "approved");
        assert.deepStrictEqual(
          approved.instance?.members.map((member) => member.seatName),
          ["builder", "critic", "sentry"],
        );
        assert.lengthOf(yield* store.listOpen(), 0);
        // Nothing is said to the Captain yet: the launch report speaks once the seats are up.
        assert.lengthOf(
          (yield* Ref.get(notices)).filter((command) => command.type === "message.dispatch"),
          0,
        );
        assert.deepStrictEqual(yield* Ref.get(watched), [open.proposal.id]);
        assert.isNull((yield* store.read(open.proposal.id))!.reportedAt);

        const again = yield* gate
          .resolve({ proposalId: open.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(again._tag, "CrewProposalNotOpenError");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("gates every roster on the human and gates additions with the seat cap", () =>
  Effect.gen(function* () {
    const { layer, notices } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const opened = yield* gate.propose({
        requestKey: "gate-1",
        captain,
        displayName: "Release Crew",
        brief: "Follow the release runbook.",
        seats: [
          {
            workspace: { type: "shared" as const },
            seat: "builder",
            agentId: "builder",
            reason: "Release step 1",
          },
        ],
      });
      assert.equal(opened.proposal.status, "open");
      assert.isNull(opened.instance);
      const approvedOutcome = yield* gate.resolve({
        proposalId: opened.proposal.id,
        decision: "approve",
      });
      assert.equal(approvedOutcome.proposal.status, "approved");
      const instance = approvedOutcome.instance as AgentCrewInstance;

      const request = yield* gate.requestMember({
        requestKey: "add-1",
        captain,
        crewInstanceId: null,
        seat: {
          workspace: { type: "shared" as const },
          seat: "critic",
          agentId: "critic",
          reason: "Needs review",
        },
        brief: null,
      });
      assert.equal(request.proposal.status, "open");
      assert.equal(request.proposal.kind, "addition");
      assert.equal(request.proposal.crewInstanceId, instance.id);
      assert.equal(request.proposal.brief, "Follow the release runbook.");

      const duplicate = yield* gate
        .requestMember({
          requestKey: "add-2",
          captain,
          crewInstanceId: instance.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "builder",
            agentId: "scout",
            reason: "Duplicate seat name",
          },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(duplicate.message, "already has a seat named builder");

      const unknown = yield* gate
        .requestMember({
          requestKey: "add-3",
          captain,
          crewInstanceId: instance.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "ghost",
            agentId: "nobody",
            reason: "Not in library",
          },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(unknown.message, 'names persona "nobody"');

      // A custom seat has nothing but its instructions to run on, so it cannot be filed without them.
      const bare = yield* gate
        .requestMember({
          requestKey: "add-custom-bare",
          captain,
          crewInstanceId: instance.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "scribe",
            agentId: null,
            reason: "Keeps notes",
          },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(bare.message, "A custom seat needs instructions");

      const blank = yield* gate
        .requestMember({
          requestKey: "add-custom-blank",
          captain,
          crewInstanceId: instance.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "scribe",
            agentId: null,
            reason: "Keeps notes",
            instructions: " \n\t ",
          },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(blank.message, "Seat instructions");

      // A custom seat names no agent, so the library is not consulted; it is filed like any other.
      const custom = yield* gate.requestMember({
        requestKey: "add-custom",
        captain,
        crewInstanceId: instance.id,
        seat: {
          workspace: { type: "shared" as const },
          seat: "scribe",
          agentId: null,
          reason: "Keeps notes",
          instructions: "Write the running notes.",
        },
        brief: null,
      });
      assert.equal(custom.proposal.status, "open");
      assert.isNull(custom.proposal.requestedSeats[0]?.agentId);
      // In a shared conversation the Captain is told who answered, and the record keeps it.
      const named = yield* gate.resolve({
        proposalId: custom.proposal.id,
        decision: "decline",
        decidedBy: "Priya (guest)",
      });
      assert.equal(named.proposal.decidedBy, "Priya (guest)");
      const namedNotice = (yield* Ref.get(notices)).at(-1);
      if (namedNotice?.type === "message.dispatch") {
        assert.include(
          namedNotice.text,
          "decision: declined\ndecided_by: Priya (guest)\ncrew_name:",
        );
      }

      const declined = yield* gate.resolve({
        proposalId: request.proposal.id,
        decision: "decline",
      });
      assert.equal(declined.proposal.status, "declined");
      assert.isNull(declined.instance);
      const last = (yield* Ref.get(notices)).at(-1);
      // Anywhere else the notice is what it always was.
      if (last?.type === "message.dispatch") {
        assert.include(last.text, "decision: declined\ncrew_name:");
        assert.notInclude(last.text, "decided_by");
      }

      const tooMany = yield* gate
        .propose({
          requestKey: "cap-1",
          captain,
          displayName: "Too Big",
          brief: "x",
          seats: Array.from({ length: CREW_SEAT_CAP + 1 }, (_, index) => ({
            workspace: { type: "shared" as const },
            seat: `s${index}`,
            agentId: "scout",
            reason: "r",
          })),
        })
        .pipe(Effect.flip);
      assert.include(tooMany.message, `at most ${CREW_SEAT_CAP} seats`);

      const notCaptain = yield* gate
        .requestMember({
          requestKey: "add-4",
          captain: { ...captain, participantId: ParticipantId.make("agent:j5:a2a:thread:other") },
          crewInstanceId: instance.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "x",
            agentId: "scout",
            reason: "r",
          },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(notCaptain.message, "command no live crew");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "resolves a proposal before spawning and refuses approved seats the roster already has",
  () =>
    Effect.gen(function* () {
      const { layer, resolveFailure } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;

        // A failure before the Crew is recorded launches nothing and leaves the proposal open.
        const boom = yield* gate.propose({
          requestKey: "boom-1",
          captain,
          displayName: "Boom",
          brief: "This launch fails.",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "builder",
              agentId: "builder",
              reason: "r",
            },
          ],
        });
        const failed = yield* gate
          .resolve({ proposalId: boom.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        assert.equal((yield* proposals.read(boom.proposal.id))?.status, "open");

        const roster = yield* gate.propose({
          requestKey: "claim-1",
          captain,
          displayName: "Claim Crew",
          brief: "Build it.",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "builder",
              agentId: "builder",
              reason: "Builds",
            },
          ],
        });
        const approved = yield* gate.resolve({
          proposalId: roster.proposal.id,
          decision: "approve",
        });
        assert.equal(approved.proposal.status, "approved");
        assert.equal(approved.proposal.crewInstanceId, approved.instance?.id);

        // A second approval finds the proposal resolved and never spawns again.
        const again = yield* gate
          .resolve({ proposalId: roster.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(again._tag, "CrewProposalNotOpenError");

        // The human edits an addition on the card into a seat name the crew already has.
        const addition = yield* gate.requestMember({
          requestKey: "claim-add-1",
          captain,
          crewInstanceId: approved.instance!.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "critic",
            agentId: "critic",
            reason: "Reviews",
          },
          brief: null,
        });
        const duplicate = yield* gate
          .resolve({
            proposalId: addition.proposal.id,
            decision: "approve",
            seats: [
              {
                workspace: { type: "shared" as const },
                seat: "builder",
                agentId: "critic",
                reason: "Renamed on the card",
              },
            ],
          })
          .pipe(Effect.flip);
        assert.include(duplicate.message, "already has a seat named builder");
        assert.equal((yield* proposals.read(addition.proposal.id))?.status, "open");
        assert.lengthOf(
          (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!.members,
          1,
        );

        // An addition whose approval cannot be recorded after its seat is reserved releases the
        // reservation and stays open, so approving it again is not refused as a name clash.
        const flaky = yield* gate.requestMember({
          requestKey: "flaky-add-1",
          captain,
          crewInstanceId: approved.instance!.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "sentry",
            agentId: "critic",
            reason: "Security pass",
          },
          brief: null,
        });
        yield* Ref.set(resolveFailure, true);
        const firstTry = yield* gate
          .resolve({ proposalId: flaky.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        yield* Ref.set(resolveFailure, false);
        assert.equal(firstTry._tag, "CrewLaunchOperationError");
        assert.equal((yield* proposals.read(flaky.proposal.id))?.status, "open");
        assert.sameMembers(
          (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!.members.map(
            ({ seatName }) => seatName,
          ),
          ["builder"],
        );
        const secondTry = yield* gate.resolve({
          proposalId: flaky.proposal.id,
          decision: "approve",
        });
        assert.equal(secondTry.proposal.status, "approved");
        assert.lengthOf(secondTry.instance!.members, 2);
        // A different proposal asking for that same seat name is still a clash.
        const clash = yield* gate
          .requestMember({
            requestKey: "clash-add-1",
            captain,
            crewInstanceId: approved.instance!.id,
            seat: {
              workspace: { type: "shared" as const },
              seat: "sentry",
              agentId: "critic",
              reason: "r",
            },
            brief: null,
          })
          .pipe(Effect.flip);
        assert.include(clash.message, "already has a seat named sentry");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("holds every door to the same seat shape and seats nobody into a retired Crew", () =>
  Effect.gen(function* () {
    const { layer } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const crews = yield* AgentCrewInstanceService;
      const opened = yield* gate.propose({
        requestKey: "shape-1",
        captain,
        displayName: "Shape Crew",
        brief: "Mind the names.",
        seats: [
          {
            workspace: { type: "shared" as const },
            seat: "builder",
            agentId: "builder",
            reason: "Builds",
          },
        ],
      });
      // The card can submit any string; the rule the MCP schema enforces holds here too.
      for (const seat of ["", "Two Words", "colon:name", "x".repeat(101)]) {
        const refused = yield* gate
          .resolve({
            proposalId: opened.proposal.id,
            decision: "approve",
            seats: [
              {
                workspace: { type: "shared" as const },
                seat,
                agentId: "builder",
                reason: "Builds",
              },
            ],
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "CrewProposalRequestError", seat);
      }
      const tooLong = yield* gate
        .resolve({
          proposalId: opened.proposal.id,
          decision: "approve",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "builder",
              agentId: "builder",
              reason: "r".repeat(501),
            },
          ],
        })
        .pipe(Effect.flip);
      assert.equal(tooLong._tag, "CrewProposalRequestError");

      const approved = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "approve" });
      const addition = yield* gate.requestMember({
        requestKey: "shape-add-1",
        captain,
        crewInstanceId: approved.instance!.id,
        seat: {
          workspace: { type: "shared" as const },
          seat: "critic",
          agentId: "critic",
          reason: "Reviews",
        },
        brief: null,
      });
      const rawGate = yield* CrewProposalService;
      const duplicateSeats = [
        {
          workspace: { type: "shared" as const },
          seat: "builder",
          agentId: "critic",
          reason: "Already held",
        },
      ];
      const duplicatePreview = yield* rawGate
        .preview({ proposalId: addition.proposal.id, seats: duplicateSeats })
        .pipe(Effect.flip);
      const duplicateApproval = yield* rawGate
        .resolve({ proposalId: addition.proposal.id, decision: "approve", seats: duplicateSeats })
        .pipe(Effect.flip);
      assert.equal(duplicatePreview._tag, "CrewProposalRequestError");
      assert.include(duplicatePreview.message, "already has a seat named builder");
      assert.equal(duplicateApproval.message, duplicatePreview.message);
      // j5_archive_crew retires the Crew while the request still sits in the inbox.
      yield* crews.markArchived(approved.instance!.id, "2026-09-09T17:00:00.000Z");
      const late = yield* gate
        .resolve({ proposalId: addition.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      assert.equal(late._tag, "CrewProposalRequestError");
      assert.include(late.message, "retired");
      const retiredPreview = yield* rawGate
        .preview({ proposalId: addition.proposal.id })
        .pipe(Effect.flip);
      const retiredApproval = yield* rawGate
        .resolve({ proposalId: addition.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      assert.equal(retiredPreview._tag, "CrewProposalRequestError");
      assert.equal(retiredPreview.message, late.message);
      assert.equal(retiredApproval.message, retiredPreview.message);
      assert.lengthOf((yield* crews.read(approved.instance!.id))!.members, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("a decision that races another device's on the same gate is refused, not undone", () =>
  Effect.gen(function* () {
    const { layer, watched } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const proposals = yield* AgentCrewProposalService;
      const roster = yield* gate.propose({
        requestKey: "race-1",
        captain,
        displayName: "Race Pair",
        brief: "Two devices decide at once.",
        seats: [
          {
            workspace: { type: "shared" as const },
            seat: "builder",
            agentId: "builder",
            reason: "Builds",
          },
          {
            workspace: { type: "shared" as const },
            seat: "critic",
            agentId: "critic",
            reason: "Reviews",
          },
        ],
      });
      // Device A approves while device B declines: exactly one resolution lands.
      const [approval, decline] = yield* Effect.all(
        [
          Effect.result(gate.resolve({ proposalId: roster.proposal.id, decision: "approve" })),
          Effect.result(gate.resolve({ proposalId: roster.proposal.id, decision: "decline" })),
        ],
        { concurrency: "unbounded" },
      );
      const outcomes = [approval, decline].map((result) =>
        Result.isSuccess(result) ? result.success.proposal.status : result.failure._tag,
      );
      assert.sameMembers(
        outcomes,
        outcomes.includes("approved")
          ? ["approved", "CrewProposalNotOpenError"]
          : ["declined", "CrewProposalNotOpenError"],
      );
      const final = (yield* proposals.read(roster.proposal.id))!;
      assert.include(["approved", "declined"], final.status);
      // Only a winning approval launches and is reported.
      assert.deepStrictEqual(
        yield* Ref.get(watched),
        final.status === "approved" ? [roster.proposal.id] : [],
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "an approval launches once: a seat that is never created is reported, and nothing can resolve it again",
  () =>
    Effect.gen(function* () {
      const { layer, watched } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const roster = yield* gate.propose({
          requestKey: "once-1",
          captain,
          displayName: "Boom after record",
          brief: "The second seat never spawns.",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "builder",
              agentId: "builder",
              reason: "Builds",
            },
            {
              workspace: { type: "shared" as const },
              seat: "critic",
              agentId: "critic",
              reason: "Reviews",
            },
          ],
        });
        // The approval resolves the card even though one seat was never created.
        const approved = yield* gate.resolve({
          proposalId: roster.proposal.id,
          decision: "approve",
        });
        assert.equal(approved.proposal.status, "approved");
        assert.deepStrictEqual(
          approved.instance?.members.map((member) => member.seatName),
          ["builder"],
        );
        assert.deepStrictEqual(
          (yield* crews.read(approved.instance!.id))!.members.map((member) => member.seatName),
          ["builder"],
        );
        assert.deepStrictEqual(yield* Ref.get(watched), [roster.proposal.id]);
        // Neither a second approval nor a decline follows; nothing is launched or retired.
        for (const decision of ["approve", "decline"] as const) {
          const again = yield* gate
            .resolve({ proposalId: roster.proposal.id, decision })
            .pipe(Effect.flip);
          assert.equal(again._tag, "CrewProposalNotOpenError");
        }
        assert.isNull((yield* crews.read(approved.instance!.id))!.archivedAt);
        assert.equal((yield* proposals.read(roster.proposal.id))!.status, "approved");
        assert.lengthOf(yield* Ref.get(watched), 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a failed decline notice leaves the decision retryable", () =>
  Effect.gen(function* () {
    const { layer, noticeFailure, notices } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = yield* CrewProposalService;
      const store = yield* AgentCrewProposalService;
      const open = yield* gate.propose({
        requestKey: "decline-notice-failure",
        captain,
        displayName: "Review",
        brief: "Review the change",
        seats: [
          {
            workspace: { type: "shared" as const },
            seat: "critic",
            agentId: "critic",
            reason: "Review",
          },
        ],
      });
      yield* Ref.set(noticeFailure, true);
      yield* gate.resolve({ proposalId: open.proposal.id, decision: "decline" }).pipe(Effect.flip);
      assert.equal((yield* store.read(open.proposal.id))?.status, "open");
      yield* Ref.set(noticeFailure, false);
      const result = yield* gate.resolve({ proposalId: open.proposal.id, decision: "decline" });
      assert.equal(result.proposal.status, "declined");
      assert.lengthOf(yield* Ref.get(notices), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "requires the displayed runtime token and refuses changed defaults or edited seats before claiming approval",
  () =>
    Effect.gen(function* () {
      const { layer, captainModel } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = yield* CrewProposalService;
        const store = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const open = yield* gate.propose({
          requestKey: "preview-token",
          captain,
          displayName: "Review",
          brief: "Review changes",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "reader",
              agentId: null,
              reason: "Read",
              instructions: "Read changes",
            },
          ],
        });
        const proposalId = open.proposal.id;
        const preview = yield* gate.preview({ proposalId });
        assert.equal(preview.seats[0]?.model, "gpt-5.6-sol");
        const missing = yield* gate.resolve({ proposalId, decision: "approve" }).pipe(Effect.flip);
        assert.equal(missing._tag, "CrewProposalRequestError");
        const edited = yield* gate
          .resolve({
            proposalId,
            decision: "approve",
            approvalToken: preview.approvalToken,
            seats: [{ ...open.proposal.requestedSeats[0]!, instructions: "Write changes" }],
          })
          .pipe(Effect.flip);
        assert.equal(edited._tag, "CrewProposalRequestError");
        yield* Ref.set(captainModel, "gpt-6-astra");
        const stale = yield* gate
          .resolve({ proposalId, decision: "approve", approvalToken: preview.approvalToken })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "CrewProposalRequestError");
        assert.equal((yield* store.read(proposalId))?.status, "open");
        assert.lengthOf(yield* crews.listLive(), 0);
        const refreshed = yield* gate.preview({ proposalId });
        assert.equal(refreshed.seats[0]?.model, "gpt-6-astra");
        const approved = yield* gate.resolve({
          proposalId,
          decision: "approve",
          approvalToken: refreshed.approvalToken,
        });
        assert.equal(approved.proposal.status, "approved");
        const addition = yield* gate.requestMember({
          requestKey: "preview-addition",
          captain,
          crewInstanceId: approved.instance!.id,
          brief: null,
          seat: {
            workspace: { type: "shared" as const },
            seat: "writer",
            agentId: null,
            reason: "Write",
            instructions: "Write notes",
          },
        });
        const additionPreview = yield* gate.preview({ proposalId: addition.proposal.id });
        yield* Ref.set(captainModel, "gpt-5.6-sol");
        const staleAddition = yield* gate
          .resolve({
            proposalId: addition.proposal.id,
            decision: "approve",
            approvalToken: additionPreview.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(staleAddition._tag, "CrewProposalRequestError");
        assert.lengthOf((yield* crews.read(approved.instance!.id))!.members, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "carries a seat's workspace from j5_propose_crew through storage, preview, and approval",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = yield* CrewProposalService;
        const store = yield* AgentCrewProposalService;
        const input = yield* decodeProposeCrewInput({
          name: "Pair",
          brief: "Ship it",
          seats: [
            {
              seat: "builder",
              persona: "builder",
              reason: "Implements",
              workspace: { type: "worktree", base_ref: "release", branch: "fix/login" },
            },
          ],
        });
        const proposed = input.seats.map(crewSeatFromInput);
        assert.deepStrictEqual(proposed[0]?.workspace, {
          type: "worktree",
          baseRef: "release",
          branch: "fix/login",
        });
        // A Captain may choose a saved persona's workspace; only its runtime is the human's to change.
        const open = yield* gate.propose({
          requestKey: "workspace-round-trip",
          captain,
          displayName: input.name,
          brief: input.brief,
          seats: proposed,
        });
        assert.deepStrictEqual((yield* store.read(open.proposal.id))?.requestedSeats, proposed);
        const first = yield* gate.preview({ proposalId: open.proposal.id });
        // Every preview carries what the card offers: the Captain's branch, where it works, worktrees.
        assert.deepStrictEqual(first.workspaceOptions, fakeWorkspaceOptions);
        // A guest's connection is shown the same seats and the same approval token, with none
        // of the host's folders and branches.
        const forGuest = yield* gate.preview({ proposalId: open.proposal.id }, { forGuest: true });
        assert.isFalse("workspaceOptions" in forGuest);
        assert.strictEqual(forGuest.approvalToken, first.approvalToken);
        assert.deepStrictEqual(
          forGuest.seats.map((seat) => seat.seat),
          first.seats.map((seat) => seat.seat),
        );
        assert.deepStrictEqual(
          withoutHostPaths({
            seat: "builder",
            workspace: {
              type: "existing_worktree",
              worktreePath: "/home/owner/repo-wt",
              branch: "fix",
            },
          }),
          {
            seat: "builder",
            workspace: { type: "existing_worktree", worktreePath: "/", branch: "fix" },
          },
        );
        // What a guest is handed back after answering is reduced the same way, and a problem
        // reading the playbook is said without the reader's words, which can name a file.
        const reduced = proposalForGuest({
          ...open.proposal,
          requestedSeats: [
            {
              ...open.proposal.requestedSeats[0]!,
              workspace: {
                type: "existing_worktree",
                worktreePath: "/home/owner/repo-wt",
                branch: "fix",
              },
            },
          ],
          playbook: {
            name: "review",
            title: "review",
            steps: [],
            issue: "ENOENT: no such file, open '/home/owner/repo/.j5/playbooks/review.yaml'",
          },
        });
        assert.deepStrictEqual(reduced.requestedSeats[0]?.workspace, {
          type: "existing_worktree",
          worktreePath: "/",
          branch: "fix",
        });
        assert.isFalse(JSON.stringify(reduced).includes("/home/owner"));
        assert.isTrue(reduced.playbook?.issue?.startsWith("This roster's playbook has a problem"));
        assert.deepStrictEqual(first.seats[0]?.workspace, {
          type: "worktree",
          baseRef: "release",
          startFromOrigin: false,
        });
        const shared = [{ ...proposed[0]!, workspace: { type: "shared" as const } }];
        const stale = yield* gate
          .resolve({
            proposalId: open.proposal.id,
            decision: "approve",
            seats: shared,
            approvalToken: first.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "CrewProposalRequestError");
        const current = yield* gate.preview({ proposalId: open.proposal.id, seats: shared });
        assert.notEqual(current.approvalToken, first.approvalToken);
        yield* gate.resolve({
          proposalId: open.proposal.id,
          decision: "approve",
          seats: shared,
          approvalToken: current.approvalToken,
        });
        assert.deepStrictEqual((yield* store.read(open.proposal.id))?.approvedSeats, shared);
        // A seat with no workspace, as one recorded before they were required, is refused.
        const { workspace: _workspace, ...unplaced } = shared[0]!;
        const refused = yield* gate
          .propose({
            requestKey: "workspace-missing",
            captain,
            displayName: "Pair",
            brief: "Ship it",
            seats: [unplaced],
          })
          .pipe(Effect.flip);
        assert.include(refused.message, "A seat needs a workspace");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "persists custom runtime overrides through proposal storage, human edits, and approval",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = yield* CrewProposalService;
        const store = yield* AgentCrewProposalService;
        const proposed = {
          workspace: { type: "shared" as const },
          seat: "custom-reviewer",
          agentId: null,
          reason: "Reviews",
          instructions: "Review the change",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-work"),
            model: "claude-sonnet",
            options: [{ id: "effort", value: "high" }],
          },
          runtimeMode: "approval-required" as const,
        };
        const open = yield* gate.propose({
          requestKey: "custom-config-recovery",
          captain,
          displayName: "Custom Review",
          brief: "Review",
          seats: [proposed],
        });
        assert.deepStrictEqual((yield* store.read(open.proposal.id))?.requestedSeats, [proposed]);
        const first = yield* gate.preview({ proposalId: open.proposal.id });
        assert.deepStrictEqual(first.seats[0]?.modelSelection, proposed.modelSelection);
        assert.equal(first.seats[0]?.runtimeMode, "approval-required");
        const edited = {
          ...proposed,
          runtimeMode: "full-access" as const,
          modelSelection: { ...proposed.modelSelection, options: [{ id: "effort", value: "low" }] },
        };
        const stale = yield* gate
          .resolve({
            proposalId: open.proposal.id,
            decision: "approve",
            seats: [edited],
            approvalToken: first.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "CrewProposalRequestError");
        const current = yield* gate.preview({ proposalId: open.proposal.id, seats: [edited] });
        assert.deepStrictEqual(current.seats[0]?.modelSelection, edited.modelSelection);
        assert.equal(current.seats[0]?.runtimeMode, edited.runtimeMode);
        const savedSeat = { ...edited, agentId: "critic" };
        const savedOverride = yield* gate.preview({
          proposalId: open.proposal.id,
          seats: [savedSeat],
        });
        assert.deepStrictEqual(savedOverride.seats[0]?.modelSelection, edited.modelSelection);
        assert.equal(savedOverride.seats[0]?.runtimeMode, edited.runtimeMode);
        assert.notEqual(savedOverride.approvalToken, current.approvalToken);
        const stalePersona = yield* gate
          .resolve({
            proposalId: open.proposal.id,
            seats: [savedSeat],
            decision: "approve",
            approvalToken: current.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(stalePersona._tag, "CrewProposalRequestError");
        const approved = yield* gate.resolve({
          proposalId: open.proposal.id,
          seats: [savedSeat],
          decision: "approve",
          approvalToken: savedOverride.approvalToken,
        });
        assert.equal(approved.proposal.status, "approved");
        assert.deepStrictEqual((yield* store.read(open.proposal.id))?.approvedSeats, [savedSeat]);
        const agentOverride = yield* gate
          .propose({
            requestKey: "agent-saved-override",
            captain,
            displayName: "Review",
            brief: "Review",
            seats: [savedSeat],
          })
          .pipe(Effect.flip);
        assert.equal(agentOverride._tag, "CrewProposalRequestError");
        assert.include(agentOverride.message, "only the human can override");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "two requests racing at eleven held seats admit exactly one, and the winner's retry is not a thirteenth",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* seedCrew(gate, "race-cap", 11);
        const request = (requestKey: string, seat: string) =>
          gate.requestMember({
            requestKey,
            captain,
            crewInstanceId: instance.id,
            seat: {
              workspace: { type: "shared" as const },
              seat,
              agentId: "scout",
              reason: "Wants the last seat",
            },
            brief: null,
          });

        // Both count eleven rows and no open request unless the count and the filing are one
        // decision: exactly one may be filed.
        const outcomes = yield* Effect.all(
          [Effect.result(request("race-a", "left")), Effect.result(request("race-b", "right"))],
          { concurrency: "unbounded" },
        );
        const admitted = outcomes.filter(Result.isSuccess).map((result) => result.success);
        const refused = outcomes.filter(Result.isFailure).map((result) => result.failure);
        assert.lengthOf(admitted, 1);
        assert.lengthOf(refused, 1);
        assert.equal(admitted[0]!.proposal.status, "open");
        assertCrewFull(refused[0]!);
        assert.include(refused[0]!.message, `holds 12 of ${CREW_SEAT_CAP} seats`);
        const openAdditions = (yield* proposals.listForCaptain(captainId)).filter(
          (proposal) => proposal.crewInstanceId === instance.id && proposal.status === "open",
        );
        assert.lengthOf(openAdditions, 1);
        assert.lengthOf((yield* crews.read(instance.id))!.members, 11);

        // The request holding seat twelve is found by its key before anything is counted, so a
        // retry is the same request, not a thirteenth seat.
        const winner = admitted[0]!.proposal;
        const winnerKey = winner.requestedSeats[0]!.seat === "left" ? "race-a" : "race-b";
        const replay = yield* request(winnerKey, winner.requestedSeats[0]!.seat);
        assert.equal(replay.proposal.id, winner.id);
        assert.equal(replay.proposal.status, "open");
        assert.lengthOf(
          (yield* proposals.listForCaptain(captainId)).filter(
            (proposal) => proposal.crewInstanceId === instance.id && proposal.status === "open",
          ),
          1,
        );
        const approved = yield* gate.resolve({ proposalId: winner.id, decision: "approve" });
        assert.equal(approved.proposal.status, "approved");
        assert.lengthOf(approved.instance!.members, 12);
        // Replayed after its seat launched: the seat name is now a member, and the retry still
        // gets its own proposal back rather than a clash or a full-crew refusal.
        const afterLaunch = yield* request(winnerKey, winner.requestedSeats[0]!.seat);
        assert.equal(afterLaunch.proposal.id, winner.id);
        assert.equal(afterLaunch.proposal.status, "approved");
        assert.lengthOf(afterLaunch.instance!.members, 12);
        // The loser's key never filed anything, so its retry is counted afresh and still refused.
        assertCrewFull(
          yield* request(winnerKey === "race-a" ? "race-b" : "race-a", "late").pipe(Effect.flip),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a roster whose Crew link cannot be written fails its approval and is never reported",
  () =>
    Effect.gen(function* () {
      const { layer, attachFailure, watched } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;
        const opened = yield* gate.propose({
          requestKey: "link-fails",
          captain,
          displayName: "Unlinked Crew",
          brief: "Build it.",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "maker",
              agentId: "builder",
              reason: "Builds",
            },
          ],
        });
        yield* Ref.set(attachFailure, true);
        // The launch report finds its Crew through the link, so a swallowed failure would launch
        // seats the Captain is never told about; the approval fails instead, before any spawn.
        const failed = yield* gate
          .resolve({ proposalId: opened.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        assert.include(failed.message, `linking proposal ${opened.proposal.id}`);
        const after = (yield* proposals.read(opened.proposal.id))!;
        assert.notEqual(after.status, "approved");
        assert.isNull(after.crewInstanceId);
        assert.deepStrictEqual(yield* Ref.get(watched), []);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a roster left open while its Captain was archived is refused, and still declines", () =>
  Effect.gen(function* () {
    const { layer, archivedThreads, watched } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = yield* CrewProposalService;
      const crews = yield* AgentCrewInstanceService;
      const opened = yield* gate.propose({
        requestKey: "archived-captain",
        captain,
        displayName: "Late Crew",
        brief: "Pick up after the Captain.",
        seats: [
          {
            workspace: { type: "shared" as const },
            seat: "builder",
            agentId: "builder",
            reason: "Builds",
          },
        ],
      });
      yield* Ref.set(archivedThreads, new Set([captainThread]));

      // The card's preview and its approval both meet the refusal, naming the Captain.
      const previewed = yield* gate.preview({ proposalId: opened.proposal.id }).pipe(Effect.flip);
      assert.equal(previewed._tag, "CrewProposalRequestError");
      assert.include(previewed.message, `Captain Thread ${captainThread} is archived`);
      const refused = yield* gate
        .resolve({ proposalId: opened.proposal.id, decision: "approve", approvalToken: "stale" })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewProposalRequestError");
      assert.include(refused.message, "Unarchive the Captain");
      assert.isNull(yield* crews.read(`crew:archived-captain`));
      assert.lengthOf(yield* Ref.get(watched), 0);

      const declined = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "decline" });
      assert.equal(declined.proposal.status, "declined");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "a roster or addition left open while its Captain was deleted is refused, and declines untold",
  () =>
    Effect.gen(function* () {
      const { layer, deletedThreads, missingThreads, notices } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* seedCrew(gate, "deleted-captain-crew", 1);
        const roster = yield* gate.propose({
          requestKey: "deleted-captain",
          captain,
          displayName: "Orphan Crew",
          brief: "Nobody commands this.",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "builder",
              agentId: "builder",
              reason: "Builds",
            },
          ],
        });
        const addition = yield* gate.requestMember({
          requestKey: "deleted-captain-add",
          captain,
          crewInstanceId: instance.id,
          seat: {
            workspace: { type: "shared" as const },
            seat: "critic",
            agentId: "critic",
            reason: "Reviews",
          },
          brief: null,
        });
        yield* Ref.set(deletedThreads, new Set([captainThread]));
        const toldBefore = (yield* Ref.get(notices)).length;

        for (const proposalId of [roster.proposal.id, addition.proposal.id]) {
          const refused = yield* gate
            .resolve({ proposalId, decision: "approve" })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "CrewProposalRequestError");
          assert.include(refused.message, `Captain Thread ${captainThread} has been deleted`);
        }
        assert.isNull(yield* crews.read(`crew:deleted-captain`));
        assert.deepStrictEqual(
          (yield* crews.read(instance.id))!.members.map((member) => member.seatName),
          ["s0"],
        );

        // A Captain the store no longer holds at all reads the same way.
        yield* Ref.set(missingThreads, new Set([captainThread]));
        const gone = yield* gate
          .resolve({ proposalId: roster.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.include(gone.message, `Captain ${captainId} has been deleted`);

        for (const proposalId of [roster.proposal.id, addition.proposal.id]) {
          const declined = yield* gate.resolve({ proposalId, decision: "decline" });
          assert.equal(declined.proposal.status, "declined");
        }
        assert.lengthOf(yield* Ref.get(notices), toldBefore);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

// Playbook Crews run through the real launcher and member store: step ownership is decided where
// member rows are written, so the gate's refusals are proven against that store, not a stand-in.
const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-09T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "gpt-5.6-sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "high" }],
          },
        ],
      },
    },
  ],
};
const release = () => ({
  title: "Release",
  description: "Ship a change.",
  steps: [
    { id: "plan", title: "Plan", prompt: "Plan it.", persona: "planner" },
    { id: "build", title: "Build", prompt: "Build it." },
    { id: "review", title: "Review", prompt: "Review it." },
  ],
});
const custom = (seat: string, steps?: ReadonlyArray<string>) => ({
  workspace: { type: "shared" as const },
  seat,
  agentId: null,
  reason: `Seat ${seat}`,
  instructions: `Do the ${seat} work.`,
  ...(steps === undefined ? {} : { steps }),
});

// The Captain's tool calls go through the tools' own input schemas.
const decodeProposeCrew = Schema.decodeUnknownEffect(J5ProposeCrewInput);
const playbookStartTool = playbookTools.find(
  (tool): tool is Extract<(typeof playbookTools)[number], { readonly name: "j5_playbook_start" }> =>
    tool.name === "j5_playbook_start",
)!;
const decodePlaybookStart = Schema.decodeUnknownEffect(playbookStartTool.parametersSchema);

const playbookFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "j5-crew-playbook-" });
  yield* fs.makeDirectory(path.join(workspaceRoot, ".j5/playbooks"), { recursive: true });
  const writePlaybook = (name: string, text: string) =>
    fs.writeFileString(path.join(workspaceRoot, ".j5/playbooks", `${name}.yaml`), text);
  yield* writePlaybook("release", stringify(release()));
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const storage = Layer.mergeAll(crewInstanceLayer, proposalStoreLayer, ledgerLayer).pipe(
    Layer.provideMerge(database),
  );
  const context = yield* Layer.build(storage);
  yield* Effect.provide(
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      yield* seedPlaybookOwners([captainThread]);
      yield* (yield* A2ALedger).ensureProject({
        projectId: projectId,
        createdAt: DateTime.formatIso(createdAt),
      });
    }),
    context,
  );
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  // Armed, provider reads wait until two approvals have both passed validation, so they race
  // for the member store rather than one refusing in the other's wake.
  const barrier = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const arrivals = yield* Ref.make(0);
  const layer = crewProposalLayer.pipe(
    Layer.provideMerge(crewLaunchLayer),
    Layer.provideMerge(Layer.mock(CrewLaunchReporter)({ watch: () => Effect.void })),
    Layer.provideMerge(playbookStoreLayer),
    Layer.provideMerge(fakeSpawnWorkspaceLayer({ checkout: noRepository })),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.succeed({
            thread: thread(threadId),
            messages: [],
          } as unknown as OrchestrationV2ThreadProjection),
        dispatch: (command) =>
          Ref.update(commands, (items) => [...items, command]).pipe(
            Effect.as({ events: [], effects: [] } as never),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(SpawnCompositionService)({
        recordFacts: (input) =>
          Effect.succeed({
            home: { projectId, participantId: participantIdForThread(input.threadId) },
            placement: {
              projectId,
              participantId: participantIdForThread(input.threadId),
              provenance: input.provenance,
              placementParentId: captainId,
              createdEventSeq: 1,
              updatedEventSeq: 1,
            },
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.gen(function* () {
          const gate = yield* Ref.get(barrier);
          if (gate !== null) {
            if ((yield* Ref.updateAndGet(arrivals, (count) => count + 1)) === 2)
              yield* Deferred.succeed(gate, undefined);
            yield* Deferred.await(gate);
          }
          return [codex];
        }),
      }),
    ),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-playbook-state-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const armBarrier = Effect.gen(function* () {
    yield* Ref.set(arrivals, 0);
    yield* Ref.set(barrier, yield* Deferred.make<void>());
  });
  return { layer, workspaceRoot, writePlaybook, commands, armBarrier };
}).pipe(Effect.provide(NodeServices.layer));

/** Proposes the release Crew: planner owns plan, builder owns build, review is left unowned. */
const proposeRelease = (
  gate: CrewProposalService["Service"],
  workspaceRoot: string,
  requestKey = "release",
) =>
  gate.propose({
    requestKey,
    captain,
    displayName: "Release Crew",
    brief: "Ship the change.",
    playbook: { name: "release", workspaceRoot },
    seats: [custom("planner", ["plan"]), custom("builder", ["build"])],
  });

it.effect(
  "records a playbook Crew on its proposal, instance, and members, and briefs each seat",
  () =>
    Effect.gen(function* () {
      const { layer, workspaceRoot, commands } = yield* playbookFixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const store = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const opened = yield* proposeRelease(gate, workspaceRoot);
        assert.deepStrictEqual(opened.playbook, {
          name: "release",
          title: "Release",
          unownedSteps: ["review"],
          swaps: [
            {
              seat: "planner",
              swap: {
                stepId: "plan",
                wanted: "planner",
                seatPersona: null,
                wantedProblem: "missing",
              },
            },
          ],
        });
        const stored = (yield* store.read(opened.proposal.id))!;
        assert.deepStrictEqual(stored.playbook, {
          name: "release",
          definitionPath: `${workspaceRoot}/.j5/playbooks/release.yaml`,
        });
        assert.deepStrictEqual(
          stored.requestedSeats.map(({ seat, steps }) => [seat, steps]),
          [
            ["planner", ["plan"]],
            ["builder", ["build"]],
          ],
        );

        const approved = yield* gate.resolve({
          proposalId: opened.proposal.id,
          decision: "approve",
        });
        const instance = (yield* crews.read(approved.instance!.id))!;
        assert.deepStrictEqual(instance.playbook, stored.playbook);
        assert.deepStrictEqual(
          instance.members.map(({ seatName, playbookStepIds }) => [seatName, playbookStepIds]),
          [
            ["planner", ["plan"]],
            ["builder", ["build"]],
          ],
        );
        const brief = (yield* Ref.get(commands)).find(
          (command) => command.type === "message.dispatch",
        );
        assert.include(
          brief?.type === "message.dispatch" ? brief.text : "",
          "<seat_playbook>\nplaybook: release (Release)\nyour_steps:\n- plan: Plan\n</seat_playbook>",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("refuses a playbook Crew it cannot follow, each with a next step", () =>
  Effect.gen(function* () {
    const { layer, workspaceRoot, writePlaybook } = yield* playbookFixture;
    yield* writePlaybook("broken", "title: [");
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const refusal = (name: string, seats: ReadonlyArray<ReturnType<typeof custom>>) =>
        gate
          .propose({
            requestKey: `refused-${name}-${seats.length}`,
            captain,
            displayName: "Refused Crew",
            brief: "Never launches.",
            playbook: { name, workspaceRoot },
            seats,
          })
          .pipe(Effect.flip);
      const cases = [
        {
          error: yield* refusal("nope", [custom("planner", ["plan"])]),
          detail: "No playbook named nope in your workspace.",
          nextStep: "Call j5_playbook_list and pass a name it returns.",
        },
        {
          error: yield* refusal("broken", [custom("planner")]),
          detail: "Playbook broken cannot be followed:",
          nextStep:
            "Fix the definition until j5_playbook_list lists it without an issue, then retry.",
        },
        {
          error: yield* refusal("release", [custom("planner", ["ship"])]),
          detail: "Seat planner lists step ship, which playbook release does not have.",
          nextStep: "Call j5_playbook_read for release and use its step ids.",
        },
        {
          error: yield* refusal("release", [
            custom("planner", ["plan"]),
            custom("builder", ["plan"]),
          ]),
          detail: "Step plan is claimed by seat planner and seat builder; a step has one owner.",
          nextStep: "Give each step to one seat, or leave it unowned for the Captain.",
        },
      ];
      for (const { error, detail, nextStep } of cases) {
        assert.equal(error._tag, "CrewProposalRequestError");
        if (error._tag !== "CrewProposalRequestError") continue;
        assert.include(error.detail, detail);
        assert.equal(error.nextStep, nextStep);
      }

      const opened = yield* proposeRelease(gate, workspaceRoot);
      const approved = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "approve" });
      const taken = yield* gate
        .requestMember({
          requestKey: "taken",
          captain,
          crewInstanceId: approved.instance!.id,
          seat: custom("rival", ["plan"]),
          brief: null,
        })
        .pipe(Effect.flip);
      assert.equal(taken._tag, "CrewProposalRequestError");
      assert.include(taken.message, "Step plan is already owned by seat planner.");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "two additions racing for one step: the first approval wins, the second is refused and stays open",
  () =>
    Effect.gen(function* () {
      const { layer, workspaceRoot, armBarrier } = yield* playbookFixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const raw = yield* CrewProposalService;
        const store = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const opened = yield* proposeRelease(gate, workspaceRoot);
        const crewId = (yield* gate.resolve({
          proposalId: opened.proposal.id,
          decision: "approve",
        })).instance!.id;
        const request = (seat: string) =>
          raw.requestMember({
            requestKey: seat,
            captain,
            crewInstanceId: crewId,
            seat: custom(seat, ["review"]),
            brief: null,
          });
        const first = yield* request("reviewer-a");
        const second = yield* request("reviewer-b");
        const tokens = yield* Effect.forEach([first, second], ({ proposal }) =>
          raw.preview({ proposalId: proposal.id }),
        );

        yield* armBarrier;
        const outcomes = yield* Effect.forEach(
          [first, second],
          ({ proposal }, index) =>
            Effect.result(
              raw.resolve({
                proposalId: proposal.id,
                decision: "approve",
                approvalToken: tokens[index]!.approvalToken,
              }),
            ),
          { concurrency: "unbounded" },
        );
        const won = outcomes.filter(Result.isSuccess);
        const lost = outcomes.flatMap((outcome, index) =>
          Result.isFailure(outcome)
            ? [
                {
                  error: outcome.failure,
                  seat: index === 0 ? "reviewer-a" : "reviewer-b",
                  proposal: [first, second][index]!.proposal,
                },
              ]
            : [],
        );
        assert.lengthOf(won, 1);
        assert.lengthOf(lost, 1);
        const winner = lost[0]!.seat === "reviewer-a" ? "reviewer-b" : "reviewer-a";
        const refused = lost[0]!.error;
        assert.equal(refused._tag, "CrewProposalRequestError");
        if (refused._tag === "CrewProposalRequestError") {
          assert.equal(refused.detail, `Step review is already owned by seat ${winner}.`);
          assert.equal(
            refused.nextStep,
            "Ask the Captain to request the seat again with only unowned steps.",
          );
        }
        assert.equal((yield* store.read(lost[0]!.proposal.id))!.status, "open");
        const members = (yield* crews.read(crewId))!.members;
        assert.deepStrictEqual(
          members.map(({ seatName, playbookStepIds }) => [seatName, playbookStepIds]),
          [
            ["planner", ["plan"]],
            ["builder", ["build"]],
            [winner, ["review"]],
          ],
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "binds the plan the card showed: a same-id title, persona, or catalog change needs a fresh preview",
  () =>
    Effect.gen(function* () {
      const { layer, workspaceRoot, writePlaybook } = yield* playbookFixture;
      yield* Effect.gen(function* () {
        const stateDir = yield* seedPersonas([{ id: "planner", enabled: true }]);
        const library = createAgentPersonaLibrary({
          fs: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          stateDir,
        });
        const gate = yield* CrewProposalService;
        const opened = yield* proposeRelease(gate, workspaceRoot);
        const preview = () => gate.preview({ proposalId: opened.proposal.id });
        const first = yield* preview();
        assert.deepStrictEqual(first.unownedSteps, ["review"]);
        assert.deepStrictEqual(first.seats[0]?.personaSwaps, [
          { stepId: "plan", wanted: "planner", seatPersona: null, wantedProblem: null },
        ]);

        const definition = release();
        definition.steps[0]!.prompt = "Plan it with care.";
        yield* writePlaybook("release", stringify(definition));
        assert.equal((yield* preview()).approvalToken, first.approvalToken);

        const edits = [
          writePlaybook(
            "release",
            stringify({
              ...definition,
              steps: definition.steps.map((step, index) =>
                index === 0 ? { ...step, title: "Plan the release" } : step,
              ),
            }),
          ),
          writePlaybook(
            "release",
            stringify({
              ...definition,
              steps: definition.steps.map((step, index) =>
                index === 0
                  ? { ...step, title: "Plan the release" }
                  : index === 1
                    ? { ...step, persona: "builder-bot" }
                    : step,
              ),
            }),
          ),
          library.setEnabled("planner", false),
        ];
        let token = first.approvalToken;
        for (const edit of edits) {
          yield* edit;
          const stale = yield* gate
            .resolve({ proposalId: opened.proposal.id, decision: "approve", approvalToken: token })
            .pipe(Effect.flip);
          assert.equal(stale._tag, "CrewProposalRequestError");
          assert.include(stale.message, "Refresh the preview");
          const next = (yield* preview()).approvalToken;
          assert.notEqual(next, token);
          token = next;
        }
        const approved = yield* gate.resolve({
          proposalId: opened.proposal.id,
          decision: "approve",
          approvalToken: token,
        });
        assert.equal(approved.proposal.status, "approved");
        assert.deepStrictEqual(
          approved.proposal.approvedSeats?.map(({ seat, personaSwaps }) => [seat, personaSwaps]),
          [
            [
              "planner",
              [{ stepId: "plan", wanted: "planner", seatPersona: null, wantedProblem: "disabled" }],
            ],
            [
              "builder",
              [
                {
                  stepId: "build",
                  wanted: "builder-bot",
                  seatPersona: null,
                  wantedProblem: "missing",
                },
              ],
            ],
          ],
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "takes a playbook Crew while the Captain runs a playbook; j5_playbook_start keeps one run per thread",
  () =>
    Effect.gen(function* () {
      const { layer, workspaceRoot } = yield* playbookFixture;
      yield* Effect.gen(function* () {
        const gate = yield* CrewProposalService;
        yield* (yield* PlaybookStore).start(captainThread, workspaceRoot, "release", "run-1");
        const opened = yield* proposeRelease(gate, workspaceRoot);
        assert.equal(opened.proposal.status, "open");
        assert.equal(opened.playbook?.name, "release");
        const plain = yield* gate.propose({
          requestKey: "plain",
          captain,
          displayName: "Plain Crew",
          brief: "No playbook.",
          seats: [custom("helper")],
        });
        assert.equal(plain.proposal.status, "open");
        assert.isNull(plain.playbook);
        assert.isNull((yield* (yield* AgentCrewProposalService).read(plain.proposal.id))!.playbook);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a Crew whose playbook file is gone still takes a seat that claims no steps", () =>
  Effect.gen(function* () {
    const { layer, workspaceRoot, commands } = yield* playbookFixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const crews = yield* AgentCrewInstanceService;
      const opened = yield* proposeRelease(gate, workspaceRoot);
      const crewId = (yield* gate.resolve({ proposalId: opened.proposal.id, decision: "approve" }))
        .instance!.id;
      yield* (yield* FileSystem.FileSystem).remove(
        (yield* Path.Path).join(workspaceRoot, ".j5/playbooks/release.yaml"),
      );

      const claiming = yield* gate
        .requestMember({
          requestKey: "claims-review",
          captain,
          crewInstanceId: crewId,
          seat: custom("reviewer", ["review"]),
          brief: null,
        })
        .pipe(Effect.flip);
      assert.equal(claiming._tag, "CrewProposalRequestError");
      assert.include(
        claiming.message,
        "Playbook release, which this crew follows, can no longer be read",
      );
      assert.include(claiming.message, "request the seat without steps");
      assert.notInclude(claiming.message, "No playbook named");

      const filed = yield* gate.requestMember({
        requestKey: "stepless",
        captain,
        crewInstanceId: crewId,
        seat: custom("helper"),
        brief: null,
      });
      const approved = yield* gate.resolve({ proposalId: filed.proposal.id, decision: "approve" });
      assert.equal(approved.proposal.status, "approved");
      const members = (yield* crews.read(crewId))!.members;
      assert.deepStrictEqual(
        members.map(({ seatName, playbookStepIds }) => [seatName, playbookStepIds]),
        [
          ["planner", ["plan"]],
          ["builder", ["build"]],
          ["helper", []],
        ],
      );
      const brief = (yield* Ref.get(commands)).findLast(
        (command) => command.type === "message.dispatch",
      );
      assert.include(
        brief?.type === "message.dispatch" ? brief.text : "",
        "<seat_playbook>\nplaybook: release (release)\nyour_steps: none\n</seat_playbook>",
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("records a persona swap in the stored seats and returns it on the preview", () =>
  Effect.gen(function* () {
    const { layer, workspaceRoot } = yield* playbookFixture;
    yield* Effect.gen(function* () {
      yield* seedPersonas([{ id: "planner", enabled: false }]);
      const gate = yield* CrewProposalService;
      const opened = yield* proposeRelease(gate, workspaceRoot);
      const swap = {
        stepId: "plan",
        wanted: "planner",
        seatPersona: null,
        wantedProblem: "disabled" as const,
      };
      const stored = yield* (yield* AgentCrewProposalService).read(opened.proposal.id);
      assert.deepStrictEqual(stored?.requestedSeats[0]?.personaSwaps, [swap]);
      const preview = yield* gate.preview({ proposalId: opened.proposal.id });
      assert.deepStrictEqual(preview.seats[0]?.personaSwaps, [swap]);
      assert.isUndefined(preview.seats[1]?.personaSwaps);
      assert.deepStrictEqual(preview.playbook?.steps[0], {
        id: "plan",
        title: "Plan",
        persona: "planner",
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("stores and reads back a step id longer than a seat name", () =>
  Effect.gen(function* () {
    const { layer, workspaceRoot, writePlaybook } = yield* playbookFixture;
    const longId = `s${"x".repeat(120)}`;
    yield* writePlaybook(
      "long",
      stringify({
        title: "Long ids",
        description: "Step ids are not seat names.",
        steps: [{ id: longId, title: "Long", prompt: "Do it." }],
      }),
    );
    yield* Effect.gen(function* () {
      const gate = yield* CrewProposalService;
      const opened = yield* gate.propose({
        requestKey: "long-id",
        captain,
        displayName: "Long Crew",
        brief: "Own the long step.",
        playbook: { name: "long", workspaceRoot },
        seats: [custom("owner", [longId])],
      });
      const stored = yield* (yield* AgentCrewProposalService).read(opened.proposal.id);
      assert.deepStrictEqual(stored?.requestedSeats[0]?.steps, [longId]);
      assert.deepStrictEqual(opened.playbook?.unownedSteps, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "the headline Crew: a playbook with two personas, a persona-less step, and a disabled persona launches with the right owners",
  () =>
    Effect.gen(function* () {
      const { layer, workspaceRoot, writePlaybook, commands } = yield* playbookFixture;
      yield* writePlaybook(
        "ship",
        stringify({
          title: "Ship",
          description: "Plan, build, review, and release a change.",
          steps: [
            { id: "plan", title: "Plan", prompt: "Plan it.", persona: "planner" },
            { id: "build", title: "Build", prompt: "Build it.", persona: "builder" },
            { id: "review", title: "Review", prompt: "Review the diff.", persona: "reviewer" },
            { id: "release", title: "Release", prompt: "Release it." },
          ],
        }),
      );
      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const library = createAgentPersonaLibrary({
          fs: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          stateDir,
        });
        // builder is bundled; planner and reviewer are added through the library's own API.
        for (const id of ["planner", "reviewer"])
          yield* library.createPersona({
            id,
            displayName: id,
            description: `The ${id} persona.`,
            instructions: `You are ${id}.`,
            authorityPolicy: "read-only",
            modelRoute: [
              {
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
              },
              {
                driver: ProviderDriverKind.make("claudeAgent"),
                model: "claude-opus-5-5",
                reasoningEffort: "high",
              },
            ],
          });
        yield* library.setEnabled("reviewer", false);

        // 1) Read: the playbook warns about the disabled persona, and j5_list_personas' own
        // projection shows it unavailable while the other two are available.
        const read = yield* (yield* PlaybookStore).read(workspaceRoot, "ship");
        assert.deepStrictEqual(
          read.warnings.map(({ code, stepId }) => [code, stepId]),
          [["persona_disabled", "review"]],
        );
        const current = yield* library.catalog();
        const catalog = buildAgentPersonaCatalog([codex], current.definitions);
        const usable = (id: string) =>
          !current.disabledIds.includes(id) &&
          catalog.personas.find(({ personaId }) => personaId === id)?.availability.status ===
            "available";
        assert.deepStrictEqual(
          ["planner", "builder", "reviewer"].map((id) => [id, usable(id)]),
          [
            ["planner", true],
            ["builder", true],
            ["reviewer", false],
          ],
        );

        // 2) Propose: the tool JSON the Captain sends, through the tool schema and the handler's
        // seat mapping.
        const input = yield* decodeProposeCrew({
          project_id: projectId,
          name: "Ship Crew",
          brief: "Implement what we discussed. Ship: plan, build, review, and release a change.",
          playbook: "ship",
          seats: [
            {
              workspace: { type: "shared" as const },
              seat: "planner",
              persona: "planner",
              reason: "Owns the plan step.",
              steps: ["plan"],
            },
            {
              workspace: { type: "shared" as const },
              seat: "builder",
              persona: "builder",
              reason: "Owns build, and release, which names no persona.",
              steps: ["build", "release"],
            },
            {
              workspace: { type: "shared" as const },
              seat: "reviewer-stand-in",
              reason: "Stands in for reviewer, which is turned off.",
              instructions: "Review the diff for correctness and report findings with evidence.",
              steps: ["review"],
            },
          ],
          client_request_id: "headline",
        });
        const gate = yield* CrewProposalService;
        const opened = yield* gate.propose({
          requestKey: "headline",
          captain,
          displayName: input.name,
          brief: input.brief,
          playbook: { name: input.playbook!, workspaceRoot },
          seats: input.seats.map(crewSeatFromInput),
        });
        const swap = {
          stepId: "review",
          wanted: "reviewer",
          seatPersona: null,
          wantedProblem: "disabled" as const,
        };

        // 3) The proposal records the plan the card shows.
        assert.equal(opened.playbook?.name, "ship");
        assert.deepStrictEqual(opened.playbook?.unownedSteps, []);
        assert.deepStrictEqual(opened.playbook?.swaps, [{ seat: "reviewer-stand-in", swap }]);
        const stored = (yield* (yield* AgentCrewProposalService).read(opened.proposal.id))!;
        assert.deepStrictEqual(
          stored.requestedSeats.map(({ seat, steps, personaSwaps }) => [seat, steps, personaSwaps]),
          [
            ["planner", ["plan"], undefined],
            ["builder", ["build", "release"], undefined],
            ["reviewer-stand-in", ["review"], [swap]],
          ],
        );
        const preview = yield* gate.preview({ proposalId: opened.proposal.id });
        assert.deepStrictEqual(preview.seats[2]?.personaSwaps, [swap]);
        assert.isNotEmpty(preview.approvalToken);

        // 4) Approve with the preview's token and launch.
        const approved = yield* gate.resolve({
          proposalId: opened.proposal.id,
          decision: "approve",
          approvalToken: preview.approvalToken,
        });
        const instance = (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!;
        assert.deepStrictEqual(instance.playbook, stored.playbook);
        assert.deepStrictEqual(
          instance.members.map(({ seatName, playbookStepIds }) => [seatName, playbookStepIds]),
          [
            ["planner", ["plan"]],
            ["builder", ["build", "release"]],
            ["reviewer-stand-in", ["review"]],
          ],
        );
        const builderThread = instance.members.find(
          ({ seatName }) => seatName === "builder",
        )!.threadId;
        const builderBrief = (yield* Ref.get(commands)).find(
          (command) => command.type === "message.dispatch" && command.threadId === builderThread,
        );
        assert.include(
          builderBrief?.type === "message.dispatch" ? builderBrief.text : "",
          "your_steps:\n- build: Build\n- release: Release\n</seat_playbook>",
        );

        // 5) The launch notice gives the Captain the Crew id and the start call.
        const notice = crewLaunchReportText({
          proposal: (yield* (yield* AgentCrewProposalService).read(opened.proposal.id))!,
          instance,
          verdicts: new Map(),
          windowMs: 60_000,
          playbook: { name: "ship", title: read.title },
        });
        assert.include(notice, `crew_instance_id: ${instance.id}\n`);
        assert.include(notice, 'j5_playbook_start(name: "ship"');

        // 6) Start: the first step reaches the planner seat.
        const start = yield* decodePlaybookStart({
          name: "ship",
          client_request_id: "start-ship",
          crew_instance_id: instance.id,
        });
        const before = (yield* Ref.get(commands)).length;
        const relay = yield* makePlaybookCrewRelay;
        const started = yield* relay.start({
          owner: captainThread,
          root: workspaceRoot,
          name: start.name,
          key: start.client_request_id,
          crewInstanceId: start.crew_instance_id!,
        });
        const plannerThread = instance.members.find(
          ({ seatName }) => seatName === "planner",
        )!.threadId;
        assert.deepStrictEqual(started.delivery, {
          state: "delivered",
          seat: "planner",
          threadId: plannerThread,
        });
        const handedOff = (yield* Ref.get(commands)).slice(before);
        assert.lengthOf(handedOff, 1);
        const stepNotice = handedOff[0];
        assert.equal(
          stepNotice?.type === "message.dispatch" ? stepNotice.threadId : null,
          plannerThread,
        );
        assert.include(
          stepNotice?.type === "message.dispatch" ? stepNotice.text : "",
          "<j5_playbook_step>",
        );
        assert.include(
          stepNotice?.type === "message.dispatch" ? stepNotice.text : "",
          "step: plan | Plan",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
