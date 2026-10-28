import * as SpawnAgentService from "./SpawnAgentService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthMcpClientAccess,
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { layerMemory } from "../../persistence/Sqlite.ts";
import * as RequestReplayService from "./RequestReplayService.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import type { ThreadLaunchInput } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../../orchestration-v2/Orchestrator.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { CrewProposalService } from "./CrewProposalService.ts";
import { CrewStopService } from "./CrewStopService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHomeRegistrar } from "./HomeRegistrar.ts";
import { A2ALedger } from "./LedgerService.ts";
import { ParticipantPlacementService, PlacementStorageError } from "./PlacementService.ts";
import { A2ASendService } from "./SendService.ts";
import { type RecordSpawnFactsInput, SpawnCompositionService } from "./SpawnCompositionService.ts";
import { ThreadRegistration } from "./ThreadRegistration.ts";
import { ParticipantId, LedgerProjectId, type ParticipantDirectoryRow } from "./contracts.ts";
import { J5ToolkitHandlersLive } from "./mcp/handlers.ts";
import { J5SpawnAgentInput, J5Toolkit } from "./mcp/tools.ts";
import {
  SpawnWorkspaceChoice,
  resolveSpawnWorkspace,
  type SpawnCheckout,
} from "./spawnWorkspace.ts";
import { type FakeCheckout, fakeSpawnWorkspaceLayer } from "./test-support/spawnWorkspaceFakes.ts";
import { noDocumentTextLayer } from "../test-support/documentText.ts";

const checkout = (
  overrides: Partial<Extract<SpawnCheckout, { readonly readable: true }>> = {},
): SpawnCheckout => ({
  readable: true,
  worktrees: [{ path: "/repo-worktrees/feature", branch: "fix/login" }],
  localBranchNames: ["j5/main", "taken"],
  missingBaseRefs: [],
  ...overrides,
});

it("resolves each explicit choice; only shared asks nothing of git", () => {
  const resolve = (...args: Parameters<typeof resolveSpawnWorkspace>) =>
    Result.getOrThrow(resolveSpawnWorkspace(...args));
  const unreadable: SpawnCheckout = { readable: false, problem: "git is not installed" };
  assert.deepStrictEqual(resolve(unreadable, { type: "shared" }), { type: "shared" });
  assert.deepStrictEqual(
    resolve(checkout(), {
      type: "worktree",
      baseRef: "release",
      branch: "fix/new",
      startFromOrigin: true,
    }),
    { type: "worktree", baseRef: "release", branch: "fix/new", startFromOrigin: true },
  );
  assert.deepStrictEqual(resolve(checkout(), { type: "worktree", baseRef: "j5/main" }), {
    type: "worktree",
    baseRef: "j5/main",
    startFromOrigin: false,
  });
  // An existing worktree resolves to git's own path and the branch checked out there.
  assert.deepStrictEqual(
    resolve(checkout(), { type: "existing_worktree", worktreePath: "/repo-worktrees/feature/" }),
    { type: "existing_worktree", worktreePath: "/repo-worktrees/feature", branch: "fix/login" },
  );
});

it("refuses a choice git can't give, with the next step", () => {
  const refusal = (...args: Parameters<typeof resolveSpawnWorkspace>) => {
    const result = resolveSpawnWorkspace(...args);
    assert.isTrue(Result.isFailure(result));
    return Result.isFailure(result) ? result.failure : undefined;
  };
  // An unreadable repository refuses rather than falling back to the caller's checkout.
  const unreadable = refusal(
    { readable: false, problem: "git is not installed" },
    { type: "worktree", baseRef: "j5/main" },
  );
  assert.include(unreadable?.detail, "can't be read (git is not installed)");
  assert.include(unreadable?.nextStep, '{"type":"shared"}');
  assert.include(
    refusal(checkout(), { type: "worktree", baseRef: "j5/main", branch: "taken" })?.detail,
    "Branch 'taken' already exists",
  );
  const unknown = refusal(checkout(), { type: "existing_worktree", worktreePath: "/repo" });
  assert.include(unknown?.detail, "isn't one of this project's worktrees");
  assert.include(unknown?.detail, "/repo-worktrees/feature");
  assert.include(
    refusal(checkout({ worktrees: [] }), {
      type: "existing_worktree",
      worktreePath: "/repo-worktrees/feature",
    })?.detail,
    "The project has none",
  );
});

const invocation = {
  environmentId: EnvironmentId.make("environment:j5:spawn-workspace"),
  requestNamespace: "provider-session:j5:spawn-workspace",
  thread: {
    threadId: ThreadId.make("thread:j5:spawn-workspace-caller"),
    providerSessionId: "provider-session:j5:spawn-workspace",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};
const ledgerProjectId = LedgerProjectId.make("ledger:j5:spawn-workspace");
const callerParticipantId = ParticipantId.make("agent:j5:spawn-workspace-caller");
const childParticipantId = ParticipantId.make("agent:j5:spawn-workspace-child");
const projectId = ProjectId.make("project:j5:spawn-workspace");
const createdAt = DateTime.makeUnsafe("2026-10-02T12:00:00.000Z");
const otherProjectId = ProjectId.make("project:j5:spawn-workspace-other");
const scratchProjectId = ProjectId.make("project:j5:spawn-workspace-scratch");
const scratchFolder = "/scratch/2026-10-02-fix-the-login-bug";
const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "j5-spawn-workspace-",
}).pipe(Layer.provide(NodeServices.layer));

/** The caller works on the project's root checkout, which records no branch or worktree. */
const callerThread = (threadId: ThreadId, runtimeMode: RuntimeMode = "full-access") =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "Caller",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
  }) as unknown as OrchestrationV2ThreadProjection;

const spawnHarness = (input: {
  readonly checkout: FakeCheckout;
  readonly replay?: Layer.Layer<RequestReplayService.RequestReplayService>;
  /** Git as an agent's shell leaves it, served through upstream-style cached refs. */
  readonly liveCheckout?: Ref.Ref<FakeCheckout>;
  /** The durable command log; pass one from an earlier harness to model a restart. */
  readonly commands?: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>;
  /** Runs inside each thread.create before it lands, so a test can hold a start open. */
  readonly beforeCreate?: Effect.Effect<void>;
  /** The caller's own permission mode; full access unless a test narrows it. */
  readonly callerRuntimeMode?: RuntimeMode;
  readonly liveCaller?: Ref.Ref<OrchestrationV2ThreadProjection>;
  /** The agent an earlier attempt of the same request already created, in this mode. */
  readonly existingChildRuntimeMode?: RuntimeMode;
  /** Runs inside each read of the target project, so a test can hold a call before its start. */
  readonly beforeProjectRead?: Effect.Effect<void>;
  /** Who calls; the thread caller unless a test calls as an outside agent. */
  readonly scope?: McpInvocationScope;
}) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    const commands =
      input.commands ?? (yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]));
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchInput>>([]);
    const failFacts = yield* Ref.make(false);
    const failCreate = yield* Ref.make(false);
    const failBrief = yield* Ref.make(false);
    const factProjects = yield* Ref.make<ReadonlyArray<LedgerProjectId>>([]);
    const folderClaims = yield* Ref.make(0);
    const recorded = yield* Ref.make<ReadonlyArray<RecordSpawnFactsInput>>([]);
    const callerRow = {
      projectId: ledgerProjectId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.thread.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const dependencies = Layer.mergeAll(
      noDocumentTextLayer,
      Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([callerRow]) }),
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: () =>
          Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
      }),
      Layer.mock(A2ALedger)({
        readProjectLedger: () =>
          Effect.succeed({
            id: ledgerProjectId,
            name: "Workspace",
            createdAt: DateTime.formatIso(createdAt),
          }),
      }),
      Layer.mock(SpawnCompositionService)({
        recordFacts: (facts) =>
          Effect.gen(function* () {
            yield* Ref.update(recorded, (items) => [...items, facts]);
            if (yield* Ref.get(failFacts))
              return yield* new PlacementStorageError({
                operation: "record spawn facts",
                cause: new Error("injected"),
              });
            yield* Ref.update(log, (items) => [...items, "facts"]);
            yield* Ref.update(factProjects, (items) => [...items, facts.projectId]);
            return {
              home: { projectId: facts.projectId, participantId: childParticipantId },
              placement: {
                projectId: facts.projectId,
                participantId: childParticipantId,
                provenance: facts.provenance,
                // The placement tree is one project's: a spawner elsewhere is no parent.
                placementParentId: facts.projectId === ledgerProjectId ? callerParticipantId : null,
                createdEventSeq: 1,
                updatedEventSeq: 1,
              },
            };
          }),
      }),
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          input.liveCaller !== undefined && threadId === invocation.thread.threadId
            ? Ref.get(input.liveCaller)
            : Ref.get(commands).pipe(
                Effect.map((all) => {
                  const create = all.find(
                    (command) => command.type === "thread.create" && command.threadId === threadId,
                  );
                  return create?.type === "thread.create"
                    ? {
                        ...callerThread(threadId),
                        thread: { ...callerThread(threadId).thread, ...create, id: threadId },
                      }
                    : callerThread(threadId, input.callerRuntimeMode);
                }),
              ),
        // The caller is mid-run, as upstream's tool access check requires; the child does not
        // exist yet.
        getThreadShell: (threadId) =>
          (input.liveCaller !== undefined && threadId === invocation.thread.threadId
            ? Ref.get(input.liveCaller).pipe(
                Effect.map(
                  (projection) =>
                    ({
                      ...projection.thread,
                      providerInstanceId: invocation.thread.providerInstanceId,
                      archivedAt: null,
                      deletedAt: null,
                      activeRunId: "run:caller",
                    }) as never,
                ),
              )
            : Effect.succeed(
                threadId === invocation.thread.threadId
                  ? ({
                      ...callerThread(threadId, input.callerRuntimeMode).thread,
                      providerInstanceId: invocation.thread.providerInstanceId,
                      activeRunId: "run:j5:spawn-workspace-caller",
                      archivedAt: null,
                      deletedAt: null,
                    } as never)
                  : input.existingChildRuntimeMode === undefined
                    ? null
                    : ({
                        ...callerThread(threadId, input.existingChildRuntimeMode).thread,
                        archivedAt: null,
                        deletedAt: null,
                      } as never),
              )
          ).pipe(
            // A thread this harness has created exists from then on, as a real one does.
            Effect.filterOrElse(
              (shell) => shell !== null,
              () =>
                Ref.get(commands).pipe(
                  Effect.map((all) => {
                    const create = all.find(
                      (command) =>
                        command.type === "thread.create" && command.threadId === threadId,
                    );
                    return create?.type === "thread.create"
                      ? ({
                          ...callerThread(threadId, create.runtimeMode).thread,
                          modelSelection: create.modelSelection,
                          interactionMode: create.interactionMode,
                          branch: create.branch,
                          worktreePath: create.worktreePath,
                          archivedAt: null,
                          deletedAt: null,
                        } as never)
                      : null;
                  }),
                ),
            ),
          ),
        dispatch: (command) =>
          Effect.gen(function* () {
            if (
              (command.type === "thread.create" && (yield* Ref.get(failCreate))) ||
              (command.type === "message.dispatch" && (yield* Ref.get(failBrief)))
            )
              return yield* new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
              });
            if (command.type === "thread.create" && input.beforeCreate) yield* input.beforeCreate;
            yield* Ref.update(commands, (items) => [...items, command]);
            yield* Ref.update(log, (items) => [...items, command.type]);
            return { events: [], effects: [] } as never;
          }),
      }),
      Layer.mock(OrchestratorMcpService)({
        capabilities: () =>
          Effect.succeed({
            parentThreadId: invocation.thread.threadId,
            inheritedProviderInstanceId: invocation.thread.providerInstanceId,
            inheritedModel: "gpt-5.6-sol",
            runtimeMode: "full-access",
            interactionMode: "default",
            providers: [
              {
                providerInstanceId: ProviderInstanceId.make("codex"),
                driverKind: ProviderDriverKind.make("codex"),
                displayName: "Codex",
                models: [
                  {
                    id: "gpt-5.6-sol",
                    label: "GPT-5.6 Sol",
                    options: [{ id: "reasoningEffort", values: ["high"] }],
                  },
                ],
                canRunChildTask: true,
                canRunCrossProviderChildTask: true,
                constraints: [],
              },
            ],
            features: {
              appOwnedSubagents: true,
              asyncPolling: true,
              cancellation: true,
              batchThreadCreation: true,
              threadManagement: true,
              incrementalThreadRead: true,
              scheduledTasks: true,
              maxBatchThreads: 8,
            },
          }),
      }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),
      Layer.mock(ThreadRegistration)({
        ensureRegistered: () =>
          Effect.succeed({ projectId: ledgerProjectId, participantId: callerParticipantId }),
      }),
      Layer.mock(ProjectService)({
        getById: (id) =>
          (input.beforeProjectRead ?? Effect.void).pipe(
            Effect.as(
              id === otherProjectId || id === scratchProjectId
                ? Option.some({
                    id,
                    title: id === otherProjectId ? "Other project" : "No project",
                    workspaceRoot: "/other-repo",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: DateTime.formatIso(createdAt),
                    updatedAt: DateTime.formatIso(createdAt),
                    deletedAt: null,
                  })
                : Option.none(),
            ),
          ),
      }),
      Layer.mock(ManagedProjectFolders)({
        namedProjectsRoot: "/named-projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
        folderForThread: ({ projectId }) =>
          Ref.update(folderClaims, (count) => count + 1).pipe(
            Effect.as(projectId === scratchProjectId ? Option.some(scratchFolder) : Option.none()),
          ),
      }),
      serverConfigLayer,
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(
        fakeSpawnWorkspaceLayer({
          checkout: input.checkout,
          ...(input.replay === undefined ? {} : { replay: input.replay }),
          ...(input.liveCheckout === undefined ? {} : { liveCheckout: input.liveCheckout }),
          launches,
          launch: () => Ref.update(log, (items) => [...items, "launch"]),
          // An accepted command leaves its receipt, as the orchestrator's does, and a launch its
          // initial message's, as ThreadLaunch's does.
          accepted: Effect.all([Ref.get(commands), Ref.get(launches)]).pipe(
            Effect.map(([all, launched]) => [
              ...all.map((command) => command.commandId),
              ...launched.map((launch) => CommandId.make(`${launch.commandId}:initial-message`)),
            ]),
          ),
        }),
      ),
      Layer.provideMerge(dependencies),
    );
    const call = (args: J5SpawnAgentInput) =>
      Effect.gen(function* () {
        const toolkit = yield* J5Toolkit;
        return yield* toolkit
          .handle("j5_spawn_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, input.scope ?? invocation),
          );
      });
    const serviceCall = (args: J5SpawnAgentInput) =>
      Effect.gen(function* () {
        const service = yield* SpawnAgentService.SpawnAgentService;
        return yield* service
          .spawn(args, input.scope ?? invocation)
          .pipe(Effect.provideService(McpInvocationContext, input.scope ?? invocation));
      });
    return {
      layer,
      call,
      serviceCall,
      log,
      commands,
      launches,
      failFacts,
      failCreate,
      failBrief,
      factProjects,
      folderClaims,
      recorded,
    };
  });

const spawnArgs = {
  brief: "Fix the login bug and report back.",
  title: "Login fixer",
  provider: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  reasoning: "high",
  workspace: { type: "worktree", base_ref: "j5/main" },
} satisfies J5SpawnAgentInput;

const message = (response: { readonly result: unknown }) =>
  (response.result as { readonly message: string }).message;

it.effect("accepts and replays a direct domain-service spawn", () =>
  Effect.gen(function* () {
    const { layer, serviceCall, commands } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const args = {
        ...spawnArgs,
        workspace: { type: "shared" as const },
        client_request_id: "domain-service",
      };
      const original = yield* serviceCall(args);
      assert.deepStrictEqual(yield* serviceCall(args), original);
      const beforeRefusal = yield* Ref.get(commands);
      const refused = yield* serviceCall({ ...args, brief: "Different work" }).pipe(Effect.flip);
      assert.include(refused.message, "different request");
      assert.deepStrictEqual(yield* Ref.get(commands), beforeRefusal);
      const briefIds = beforeRefusal.flatMap((command) =>
        command.type === "message.dispatch" ? [command.commandId] : [],
      );
      assert.isAbove(briefIds.length, 0);
      assert.lengthOf([...new Set(briefIds)], 1, "retries keep the same dispatch identity");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("spawns into another project's main checkout, as a root of that project", () =>
  Effect.gen(function* () {
    const { layer, call, commands, factProjects } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      // The caller's own checkout belongs to the caller's project.
      const shared = yield* call({
        ...spawnArgs,
        project_id: LedgerProjectId.make(otherProjectId),
        workspace: { type: "shared" },
      });
      assert.isTrue(shared.isFailure);
      assert.include(message(shared), "Your own checkout belongs to your project");
      const missing = yield* call({
        ...spawnArgs,
        project_id: LedgerProjectId.make("project:j5:spawn-workspace-gone"),
        workspace: { type: "root" },
      });
      assert.isTrue(missing.isFailure);
      assert.include(message(missing), "no project project:j5:spawn-workspace-gone");
      assert.lengthOf(yield* Ref.get(commands), 0, "a refused spawn creates nothing");

      const spawned = yield* call({
        ...spawnArgs,
        project_id: LedgerProjectId.make(otherProjectId),
        workspace: { type: "root" },
        client_request_id: "other-project",
      });
      assert.isFalse(spawned.isFailure);
      const result = spawned.result as { readonly thread_id: ThreadId };
      assert.deepStrictEqual(spawned.result, {
        participant_id: childParticipantId,
        thread_id: result.thread_id,
        project_id: LedgerProjectId.make(otherProjectId),
        project_title: "Other project",
        placement: {
          // The spawner is recorded, and is no parent in a project it is not in.
          placement_parent_id: null,
          provenance: {
            kind: "spawned-by",
            spawned_by_participant_id: callerParticipantId,
            source: "j5_spawn",
          },
        },
      });
      assert.deepStrictEqual(yield* Ref.get(factProjects), [LedgerProjectId.make(otherProjectId)]);
      const [create, brief] = yield* Ref.get(commands);
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.equal(create.projectId, otherProjectId);
        assert.isNull(create.branch);
        assert.isNull(create.worktreePath);
      }
      assert.equal(brief?.type, "message.dispatch");
      if (brief?.type === "message.dispatch") assert.include(brief.text, "Other project");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("spawns an agent with no project into a folder of its own", () =>
  Effect.gen(function* () {
    const { layer, call, commands } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const withProject = yield* call({
        ...spawnArgs,
        scratch: true,
        project_id: LedgerProjectId.make(otherProjectId),
        workspace: { type: "root" },
      });
      assert.isTrue(withProject.isFailure);
      const inWorktree = yield* call({ ...spawnArgs, scratch: true });
      assert.isTrue(inWorktree.isFailure);
      assert.include(message(inWorktree), "works in a folder of its own");
      assert.lengthOf(yield* Ref.get(commands), 0);

      const spawned = yield* call({ ...spawnArgs, scratch: true, workspace: { type: "root" } });
      assert.isFalse(spawned.isFailure);
      // Naming the "No project" project by its id is the same spawn: the project decides
      // whether a main-checkout thread gets a folder, not how the caller spelled it.
      const byId = yield* call({
        ...spawnArgs,
        project_id: LedgerProjectId.make(scratchProjectId),
        workspace: { type: "root" },
      });
      assert.isFalse(byId.isFailure);
      assert.deepStrictEqual(
        (yield* Ref.get(commands)).flatMap((command) =>
          command.type === "thread.create" ? [[command.projectId, command.worktreePath]] : [],
        ),
        [
          [scratchProjectId, scratchFolder],
          [scratchProjectId, scratchFolder],
        ],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("claims one folder when the same no-project spawn is sent twice at once", () =>
  Effect.gen(function* () {
    const reachedCreate = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { layer, call, folderClaims } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      beforeCreate: Deferred.succeed(reachedCreate, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    yield* Effect.gen(function* () {
      const args = {
        ...spawnArgs,
        scratch: true,
        workspace: { type: "root" },
        client_request_id: "scratch-twice",
      } satisfies J5SpawnAgentInput;
      const first = yield* call(args).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(reachedCreate);
      const second = yield* call(args);
      assert.isTrue(second.isFailure);
      assert.include(message(second), "already in progress");
      yield* Deferred.succeed(release, undefined);
      assert.isFalse((yield* Fiber.join(first)).isFailure);
      assert.equal(yield* Ref.get(folderClaims), 1, "the refused call claimed no folder");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("claims no second folder for a retry that read the thread before it existed", () =>
  Effect.gen(function* () {
    // The retry reads "no thread yet", then is held until the first call has created it.
    const projectReads = yield* Ref.make(0);
    const retryHeld = yield* Deferred.make<void>();
    const releaseRetry = yield* Deferred.make<void>();
    const { layer, call, commands, folderClaims } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      beforeProjectRead: Ref.getAndUpdate(projectReads, (count) => count + 1).pipe(
        Effect.flatMap((earlier) =>
          earlier === 0
            ? Deferred.succeed(retryHeld, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRetry)),
              )
            : Effect.void,
        ),
      ),
    });
    yield* Effect.gen(function* () {
      const args = {
        ...spawnArgs,
        scratch: true,
        workspace: { type: "root" },
        client_request_id: "scratch-delayed-retry",
      } satisfies J5SpawnAgentInput;
      const retry = yield* call(args).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(retryHeld);
      assert.isFalse((yield* call(args)).isFailure);
      yield* Deferred.succeed(releaseRetry, undefined);
      assert.isFalse((yield* Fiber.join(retry)).isFailure);
      assert.equal(yield* Ref.get(folderClaims), 1);
      assert.deepStrictEqual(
        (yield* Ref.get(commands)).flatMap((command) =>
          command.type === "thread.create" ? [command.worktreePath] : [],
        )[0],
        scratchFolder,
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses to finish an agent a retry finds in broader modes than the caller has now", () =>
  Effect.gen(function* () {
    // The first attempt created the agent in full access; the caller has since been narrowed.
    const { layer, call, commands } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      callerRuntimeMode: "approval-required",
      existingChildRuntimeMode: "full-access",
    });
    yield* Effect.gen(function* () {
      const retried = yield* call({
        ...spawnArgs,
        workspace: { type: "shared" },
        client_request_id: "narrowed-since",
      });
      assert.isTrue(retried.isFailure);
      assert.include(message(retried), "broader than yours is now");
      assert.lengthOf(yield* Ref.get(commands), 0, "the brief is not started on it");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("gives the agent the caller's modes, or narrower ones the caller chose", () =>
  Effect.gen(function* () {
    const narrow = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      callerRuntimeMode: "auto-accept-edits",
    });
    yield* Effect.gen(function* () {
      const broader = yield* narrow.call({
        ...spawnArgs,
        workspace: { type: "shared" },
        runtime_mode: "full-access",
      });
      assert.isTrue(broader.isFailure);
      assert.include(message(broader), "broader than your own");
      assert.lengthOf(yield* Ref.get(narrow.commands), 0);

      yield* narrow.call({ ...spawnArgs, workspace: { type: "shared" } });
      yield* narrow.call({
        ...spawnArgs,
        workspace: { type: "shared" },
        runtime_mode: "approval-required",
        interaction_mode: "plan",
      });
      assert.deepStrictEqual(
        (yield* Ref.get(narrow.commands)).flatMap((command) =>
          command.type === "thread.create" ? [[command.runtimeMode, command.interactionMode]] : [],
        ),
        [
          ["auto-accept-edits", "default"],
          ["approval-required", "plan"],
        ],
      );
    }).pipe(Effect.provide(narrow.layer));
  }),
);

/** An outside agent's scope, as the MCP OAuth authenticator builds it. */
const outsideScope = (
  access: AuthMcpClientAccess,
  sessionId = "session-1",
): McpInvocationScope => ({
  environmentId: invocation.environmentId,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"] as const),
  issuedAt: 1,
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: { sessionId, label: "Claude Code\n(laptop)", access },
});
const outsideId = ParticipantId.make("outside:session-1");

it.effect("an outside agent starts a top-level agent in the project it names", () =>
  Effect.gen(function* () {
    const { layer, call, commands, recorded, log } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      scope: outsideScope("auto-accept-edits"),
    });
    yield* Effect.gen(function* () {
      const args = {
        ...spawnArgs,
        project_id: LedgerProjectId.make(otherProjectId),
        workspace: { type: "root" },
        client_request_id: "outside-root",
      } satisfies J5SpawnAgentInput;
      const spawned = yield* call(args);
      assert.isFalse(spawned.isFailure, JSON.stringify(spawned.result));
      const result = spawned.result as { readonly thread_id: ThreadId };
      assert.deepStrictEqual(spawned.result, {
        participant_id: childParticipantId,
        thread_id: result.thread_id,
        project_id: LedgerProjectId.make(otherProjectId),
        project_title: "Other project",
        placement: {
          placement_parent_id: null,
          provenance: {
            kind: "spawned-by",
            spawned_by_participant_id: outsideId,
            source: "j5_spawn",
          },
        },
      });
      const [fact] = yield* Ref.get(recorded);
      assert.equal(fact?.projectId, LedgerProjectId.make(otherProjectId));
      assert.equal(fact?.outsideSpawnerName, "Claude Code\n(laptop)");
      const [create, brief] = yield* Ref.get(commands);
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.equal(create.projectId, otherProjectId);
        // No mode was asked for, so the agent runs at the level the sign-in was approved at.
        assert.equal(create.runtimeMode, "auto-accept-edits");
        assert.equal(create.interactionMode, "default");
        assert.isNull(create.worktreePath);
      }
      assert.equal(brief?.type, "message.dispatch");
      if (brief?.type === "message.dispatch") {
        assert.include(brief.text, `spawned_by: ${outsideId}\n`);
        // The label stays on one line of the identity block.
        assert.include(brief.text, "spawned_by_outside_agent: Claude Code (laptop)\n");
        assert.include(brief.text, "You were started by an outside agent");
        assert.include(brief.text, "You cannot reply to it with j5_send_message.");
        assert.notInclude(brief.text, "spawner_thread_id");
        assert.isTrue(brief.text.endsWith(`<spawner_brief>\n${spawnArgs.brief}\n</spawner_brief>`));
      }

      // A retry with the same key replays the first spawn.
      const replay = yield* call(args);
      assert.deepStrictEqual(replay.result, spawned.result);

      // A narrower mode is the caller's to choose, and a new worktree is prepared as usual.
      const narrower = yield* call({
        ...spawnArgs,
        project_id: LedgerProjectId.make(otherProjectId),
        runtime_mode: "approval-required",
      });
      assert.isFalse(narrower.isFailure, JSON.stringify(narrower.result));
      assert.equal((yield* Ref.get(log)).at(-1), "launch");
      assert.equal(
        (yield* Ref.get(commands))
          .flatMap((command) => (command.type === "thread.create" ? [command.runtimeMode] : []))
          .at(-1),
        "approval-required",
      );

      const scratch = yield* call({ ...spawnArgs, scratch: true, workspace: { type: "root" } });
      assert.isFalse(scratch.isFailure, JSON.stringify(scratch.result));
      const scratchCreate = (yield* Ref.get(commands)).findLast(
        (command) => command.type === "thread.create",
      );
      if (scratchCreate?.type === "thread.create") {
        assert.equal(scratchCreate.projectId, scratchProjectId);
        assert.equal(scratchCreate.worktreePath, scratchFolder);
      }
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a retry key belongs to one sign-in, so a new sign-in starts its own agent", () =>
  Effect.gen(function* () {
    const args = {
      ...spawnArgs,
      project_id: LedgerProjectId.make(otherProjectId),
      workspace: { type: "root" },
      client_request_id: "same-key",
    } satisfies J5SpawnAgentInput;
    const broad = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      scope: outsideScope("full-access", "session-broad"),
    });
    const first = yield* broad.call(args).pipe(Effect.provide(broad.layer));
    // The same key from a sign-in approved for less, on the same command log.
    const narrow = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      scope: outsideScope("approval-required", "session-narrow"),
      commands: broad.commands,
    });
    const second = yield* narrow.call(args).pipe(Effect.provide(narrow.layer));
    assert.isFalse(first.isFailure);
    assert.isFalse(second.isFailure);
    assert.notEqual(
      (second.result as { readonly thread_id: ThreadId }).thread_id,
      (first.result as { readonly thread_id: ThreadId }).thread_id,
    );
    assert.deepStrictEqual(
      (yield* Ref.get(broad.commands)).flatMap((command) =>
        command.type === "thread.create" ? [command.runtimeMode] : [],
      ),
      ["full-access", "approval-required"],
    );
  }),
);

it.effect(
  "refuses an outside agent's spawn that names no project, shares a checkout or exceeds its level",
  () =>
    Effect.gen(function* () {
      const { layer, call, commands } = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
        scope: outsideScope("auto-accept-edits"),
      });
      const inProject = { ...spawnArgs, project_id: LedgerProjectId.make(otherProjectId) };
      yield* Effect.gen(function* () {
        const nowhere = yield* call({ ...spawnArgs, workspace: { type: "root" } });
        assert.isTrue(nowhere.isFailure);
        assert.include(message(nowhere), "An outside agent has no project of its own");
        assert.include(message(nowhere), "project_id");
        assert.include(message(nowhere), "scratch");

        const shared = yield* call({ ...inProject, workspace: { type: "shared" } });
        assert.isTrue(shared.isFailure);
        assert.include(message(shared), "an outside agent has none");
        assert.include(message(shared), '{"type":"root"}');

        const broader = yield* call({ ...inProject, runtime_mode: "full-access" });
        assert.isTrue(broader.isFailure);
        assert.include(message(broader), "broader than your own");
        assert.lengthOf(yield* Ref.get(commands), 0, "a refused spawn creates nothing");
      }).pipe(Effect.provide(layer));

      const readOnly = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
        scope: outsideScope("read-only"),
      });
      const refused = yield* readOnly
        .call({ ...inProject, workspace: { type: "root" } })
        .pipe(Effect.provide(readOnly.layer));
      assert.isTrue(refused.isFailure);
      assert.include(message(refused), "approved for read-only access");
      assert.lengthOf(yield* Ref.get(readOnly.commands), 0);

      // A retry that finds an agent above the approved level is refused, as a thread caller's is.
      const above = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
        scope: outsideScope("approval-required"),
        existingChildRuntimeMode: "full-access",
      });
      const retried = yield* above
        .call({ ...inProject, workspace: { type: "root" }, client_request_id: "above-level" })
        .pipe(Effect.provide(above.layer));
      assert.isTrue(retried.isFailure);
      assert.include(message(retried), "broader than yours is now");
      assert.lengthOf(yield* Ref.get(above.commands), 0);
    }),
);

it.effect("claims the brief's attachments into the new agent's thread", () =>
  Effect.gen(function* () {
    const { layer, call, commands } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make(createPendingAttachmentId()!),
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      yield* fs.writeFile(
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
        new Uint8Array([1, 2, 3]),
      );
      const spawned = yield* call({
        ...spawnArgs,
        workspace: { type: "shared" },
        attachments: [attachment],
      });
      assert.isFalse(spawned.isFailure);
      const brief = (yield* Ref.get(commands)).find(
        (command) => command.type === "message.dispatch",
      );
      assert.equal(brief?.type, "message.dispatch");
      if (brief?.type !== "message.dispatch") return;
      assert.lengthOf(brief.attachments, 1);
      const claimed = brief.attachments[0]!;
      assert.notEqual(claimed.id, attachment.id, "the brief carries the claimed copy");
      assert.deepEqual(
        yield* fs.readFile(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: claimed })!,
        ),
        new Uint8Array([1, 2, 3]),
      );
    }).pipe(Effect.provide(layer));
  }),
);

/** A finished pending upload of three bytes, as the attachment tool leaves one. */
const writePendingUpload = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const attachment = {
    type: "image" as const,
    id: ChatAttachmentId.make(createPendingAttachmentId()!),
    name: "screen.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
  yield* fs.writeFile(path, new Uint8Array([1, 2, 3]));
  const stored = fs.readDirectory(config.attachmentsDir).pipe(Effect.map((names) => names.length));
  return { attachment, path, stored };
});

it.effect.each(["shared", "worktree"] as const)(
  "replays an accepted %s spawn without claiming its files again, even after the upload is swept",
  (type) =>
    Effect.gen(function* () {
      const { layer, call, commands, launches } = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
      });
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const upload = yield* writePendingUpload;
        const args = {
          ...spawnArgs,
          workspace:
            type === "shared"
              ? { type: "shared" as const }
              : { type: "worktree" as const, base_ref: "j5/main" },
          attachments: [upload.attachment],
          client_request_id: `accepted-attached-${type}`,
        };
        const original = yield* call(args);
        assert.isFalse(original.isFailure);
        const briefs = Effect.all([Ref.get(commands), Ref.get(launches)]).pipe(
          Effect.map(([all, launched]) => [
            ...all.flatMap((command) =>
              command.type === "message.dispatch" ? [command.attachments] : [],
            ),
            ...launched.map((launch) => launch.initialMessage?.attachments ?? []),
          ]),
        );
        assert.lengthOf((yield* briefs)[0] ?? [], 1, "the first brief carries the claimed copy");
        const stored = yield* upload.stored;

        const immediate = yield* call(args);
        assert.deepStrictEqual(immediate.result, original.result);
        assert.equal(yield* upload.stored, stored, "a replay makes no second copy");

        yield* fs.remove(upload.path);
        const swept = yield* call(args);
        assert.isFalse(swept.isFailure, message(swept));
        assert.deepStrictEqual(swept.result, original.result);
        assert.equal(yield* upload.stored, stored - 1, "only the swept upload is gone");

        const changed = yield* call({ ...args, brief: "Different work" });
        assert.isTrue(changed.isFailure);
        assert.include(message(changed), "different request");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("claims again on a retry after the brief failed, since only its receipt proves it", () =>
  Effect.gen(function* () {
    const { layer, call, commands, failBrief } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const upload = yield* writePendingUpload;
      const args = {
        ...spawnArgs,
        workspace: { type: "shared" as const },
        attachments: [upload.attachment],
        client_request_id: "partial-attached",
      };
      yield* Ref.set(failBrief, true);
      const failed = yield* call(args);
      assert.isTrue(failed.isFailure);
      assert.include(message(failed), "brief did not start");
      yield* Ref.set(failBrief, false);

      const retried = yield* call(args);
      assert.isFalse(retried.isFailure, message(retried));
      const brief = (yield* Ref.get(commands)).find(
        (command) => command.type === "message.dispatch",
      );
      const claimed = brief?.type === "message.dispatch" ? brief.attachments[0] : undefined;
      assert.notEqual(claimed?.id, upload.attachment.id, "the brief carries a claimed copy");
      assert.deepEqual(
        yield* fs.readFile(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: claimed! })!,
        ),
        new Uint8Array([1, 2, 3]),
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "refuses invalid attachments before binding, so the same key takes a corrected list",
  () =>
    Effect.gen(function* () {
      const { layer, call, commands } = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
      });
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const attachment = {
          type: "image" as const,
          id: ChatAttachmentId.make(createPendingAttachmentId()!),
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 3,
        };
        yield* fs.writeFile(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          new Uint8Array([1, 2, 3]),
        );
        const args = {
          ...spawnArgs,
          workspace: { type: "shared" as const },
          client_request_id: "duplicate-attachments",
        };
        const duplicated = yield* call({ ...args, attachments: [attachment, attachment] });
        assert.isTrue(duplicated.isFailure);
        assert.include(message(duplicated), "Duplicate attachment ids");
        assert.lengthOf(yield* Ref.get(commands), 0, "nothing is created");

        const corrected = yield* call({ ...args, attachments: [attachment] });
        assert.isFalse(corrected.isFailure);
        const brief = (yield* Ref.get(commands)).find(
          (command) => command.type === "message.dispatch",
        );
        assert.lengthOf(brief?.type === "message.dispatch" ? brief.attachments : [], 1);

        const changed = yield* call(args);
        assert.isTrue(changed.isFailure);
        assert.include(message(changed), "different request");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["size", "type"] as const)(
  "refuses incorrect upload %s before binding and accepts a corrected same-key retry",
  (mismatch) =>
    Effect.gen(function* () {
      const { layer, call, commands } = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
      });
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const attachment = {
          type: "image" as const,
          id: ChatAttachmentId.make(createPendingAttachmentId()!),
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 3,
        };
        yield* fs.writeFile(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          new Uint8Array([1, 2, 3]),
        );
        const args = {
          ...spawnArgs,
          workspace: { type: "shared" as const },
          client_request_id: `incorrect-upload-${mismatch}`,
        };
        const incorrect =
          mismatch === "size"
            ? { ...attachment, sizeBytes: 2 }
            : { ...attachment, mimeType: "image/jpeg" };
        const refused = yield* call({ ...args, attachments: [incorrect] });
        assert.isTrue(refused.isFailure);
        assert.notInclude(message(refused), attachment.name);
        assert.include(
          message(refused),
          mismatch === "size" ? "stored size does not match" : "type does not match",
        );
        assert.lengthOf(yield* Ref.get(commands), 0, "nothing is created");

        const corrected = yield* call({ ...args, attachments: [attachment] });
        assert.isFalse(corrected.isFailure);
        const brief = (yield* Ref.get(commands)).find(
          (command) => command.type === "message.dispatch",
        );
        assert.lengthOf(brief?.type === "message.dispatch" ? brief.attachments : [], 1);
        const changed = yield* call({ ...args, attachments: [incorrect] });
        assert.isTrue(changed.isFailure);
        assert.include(message(changed), "different request");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("tells a caller to retry the same key when the replay store cannot be read", () =>
  Effect.gen(function* () {
    const unreadable = Effect.fail(
      new SqlError({ reason: new UnknownError({ cause: new Error("disk I/O error") }) }),
    );
    const replay = Layer.succeed(
      RequestReplayService.RequestReplayService,
      RequestReplayService.RequestReplayService.of({
        check: () => unreadable,
        bind: () => unreadable,
      }),
    );
    const { layer, call, commands } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      replay,
    });
    yield* Effect.gen(function* () {
      const failed = yield* call({
        ...spawnArgs,
        workspace: { type: "shared" },
        client_request_id: "storage-down",
      });
      assert.isTrue(failed.isFailure);
      assert.include(message(failed), "Retry j5_spawn_agent with the same client_request_id");
      assert.notInclude(message(failed), "Inspect the original target");
      assert.lengthOf(yield* Ref.get(commands), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("spawns into a new worktree from base_ref, keeping home, placement, and result", () =>
  Effect.gen(function* () {
    const { layer, call, log, commands, launches } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const spawned = yield* call({ ...spawnArgs, client_request_id: "new-worktree" });
      assert.isFalse(spawned.isFailure);
      const result = spawned.result as { readonly thread_id: ThreadId };
      assert.deepStrictEqual(spawned.result, {
        participant_id: childParticipantId,
        thread_id: result.thread_id,
        project_id: ledgerProjectId,
        project_title: "Workspace",
        placement: {
          placement_parent_id: callerParticipantId,
          provenance: {
            kind: "spawned-by",
            spawned_by_participant_id: callerParticipantId,
            source: "j5_spawn",
          },
        },
      });
      // Home and placement are committed before ThreadLaunch claims the thread for its brief.
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "facts", "launch"]);
      const [create] = yield* Ref.get(commands);
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.isNull(create.branch);
        assert.isNull(create.worktreePath);
        assert.include(create.commandId, "spawn-create-worktree");
      }
      const [launch] = yield* Ref.get(launches);
      assert.equal(launch?.threadId, result.thread_id);
      assert.isTrue(launch?.reuseExistingThread);
      assert.equal(launch?.projectId, projectId);
      assert.deepStrictEqual(launch?.workspaceStrategy, {
        type: "worktree",
        baseRef: "j5/main",
        startFromOrigin: false,
      });
      assert.include(launch?.initialMessage?.text, `participant_id: ${childParticipantId}`);
      assert.include(launch?.initialMessage?.text, spawnArgs.brief);
      assert.include(String(launch?.initialMessage?.messageId), "spawn-brief");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("an explicit shared workspace keeps the caller's checkout and starts the brief", () =>
  Effect.gen(function* () {
    const { layer, call, log, commands, launches } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const spawned = yield* call({
        ...spawnArgs,
        workspace: { type: "shared" },
        client_request_id: "explicit-shared",
      });
      assert.isFalse(spawned.isFailure);
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "facts", "message.dispatch"]);
      const [create, brief] = yield* Ref.get(commands);
      if (create?.type === "thread.create") assert.notInclude(create.commandId, "worktree");
      if (brief?.type === "message.dispatch")
        assert.deepStrictEqual(brief.dispatchMode, { type: "start_immediately" });
      assert.lengthOf(yield* Ref.get(launches), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("records no replay binding for a spawn without client_request_id", () =>
  Effect.gen(function* () {
    const unused = Effect.die(new Error("a keyless spawn has no retry key to bind"));
    const replay = Layer.succeed(
      RequestReplayService.RequestReplayService,
      RequestReplayService.RequestReplayService.of({ check: () => unused, bind: () => unused }),
    );
    const { layer, call } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      replay,
    });
    const spawned = yield* call({ ...spawnArgs, workspace: { type: "shared" } }).pipe(
      Effect.provide(layer),
    );
    assert.isFalse(spawned.isFailure);
  }),
);

it.effect("binds a client_request_id to its first workspace type, across a restart", () =>
  Effect.gen(function* () {
    const replayContext = yield* Layer.build(
      RequestReplayService.layer.pipe(Layer.provide(layerMemory)),
    );
    const replay = Layer.succeed(
      RequestReplayService.RequestReplayService,
      Context.get(replayContext, RequestReplayService.RequestReplayService),
    );
    const first = yield* spawnHarness({ checkout: { isRepo: true, refName: "j5/main" }, replay });
    yield* Effect.gen(function* () {
      // The worktree create is accepted, then the spawn stops before its home is recorded.
      yield* Ref.set(first.failFacts, true);
      const halfDone = yield* first.call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "j5/main" },
        client_request_id: "bound",
      });
      assert.isTrue(halfDone.isFailure);
      assert.include(message(halfDone), "visible orphan");
      assert.lengthOf(yield* Ref.get(first.commands), 1);
    }).pipe(Effect.provide(first.layer));

    // A fresh server: a new permit, the same durable receipts.
    const restarted = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      commands: first.commands,
      replay,
    });
    yield* Effect.gen(function* () {
      const switched = yield* restarted.call({
        ...spawnArgs,
        workspace: { type: "shared" },
        client_request_id: "bound",
      });
      assert.isTrue(switched.isFailure);
      assert.include(
        (switched.result as { readonly message: string }).message,
        "already bound to a different request",
      );
      assert.lengthOf(yield* Ref.get(restarted.commands), 1);

      // A changed base is a different request, even before workspace preparation.
      const changed = yield* restarted.call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "release" },
        client_request_id: "bound",
      });
      assert.isTrue(changed.isFailure);
      assert.include(message(changed), "different request");
      const resumed = yield* restarted.call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "j5/main" },
        client_request_id: "bound",
      });
      assert.isFalse(resumed.isFailure);
      const [original, replay] = yield* Ref.get(restarted.commands);
      assert.equal(replay?.commandId, original?.commandId);
      const launches = yield* Ref.get(restarted.launches);
      assert.lengthOf(launches, 1);
      assert.equal(
        launches[0]?.workspaceStrategy.type === "worktree" && launches[0].workspaceStrategy.baseRef,
        "j5/main",
      );
    }).pipe(Effect.provide(restarted.layer));
  }),
);

it.effect.each([
  {
    mismatched: false,
    name: "concurrent identical requests retain the in-flight guard and create only one agent",
  },
  {
    mismatched: true,
    name: "concurrent different requests on one key refuse the loser and create only the winner",
  },
])("$name", ({ mismatched }) =>
  Effect.gen(function* () {
    const createsEntered = yield* Ref.make(0);
    const createEntered = yield* Deferred.make<void>();
    const secondCreateEntered = yield* Deferred.make<void>();
    const releaseCreate = yield* Deferred.make<void>();
    const harness = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      // Every create waits for the release, and says whether it is the first or a second one.
      beforeCreate: Ref.updateAndGet(createsEntered, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          Deferred.succeed(count === 1 ? createEntered : secondCreateEntered, undefined),
        ),
        Effect.andThen(Deferred.await(releaseCreate)),
      ),
    });
    yield* Effect.gen(function* () {
      const winner = yield* harness
        .call({
          ...spawnArgs,
          workspace: { type: "worktree", base_ref: "j5/main" },
          client_request_id: "raced",
        })
        .pipe(Effect.forkChild);
      // The first start is in flight, stopped inside its create.
      yield* Deferred.await(createEntered);
      const loser = yield* harness
        .call({
          ...spawnArgs,
          workspace: mismatched ? { type: "shared" } : { type: "worktree", base_ref: "j5/main" },
          client_request_id: "raced",
        })
        .pipe(Effect.forkChild);
      // The second start returns while the first still holds its create; without the guard it
      // would reach a create of its own instead, which ends this race the other way.
      const second = yield* Effect.raceFirst(
        Fiber.join(loser).pipe(Effect.map((result) => ({ kind: "returned" as const, result }))),
        Deferred.await(secondCreateEntered).pipe(Effect.as({ kind: "second create" as const })),
      );
      yield* Deferred.succeed(releaseCreate, undefined);
      assert.equal(second.kind, "returned");
      if (second.kind === "returned") {
        assert.isTrue(second.result.isFailure);
        assert.include(
          (second.result.result as { readonly message: string }).message,
          mismatched ? "different request" : "already in progress",
        );
      }

      assert.isFalse((yield* Fiber.join(winner)).isFailure);
      const commands = yield* Ref.get(harness.commands);
      const creates = commands.filter((command) => command.type === "thread.create");
      assert.lengthOf(creates, 1);
      // The one thread is the winner's: unbound until ThreadLaunch prepares its worktree.
      const [create] = creates;
      if (create?.type === "thread.create") {
        assert.include(create.commandId, "spawn-create-worktree");
        assert.isNull(create.worktreePath);
      }
      assert.lengthOf(yield* Ref.get(harness.launches), 1);
      assert.lengthOf(
        commands.filter((command) => command.type === "message.dispatch"),
        0,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it("refuses a git ref git would read as an option, in both the MCP and stored forms", () => {
  const mcp = Schema.decodeUnknownExit(J5SpawnAgentInput);
  const stored = Schema.decodeUnknownExit(SpawnWorkspaceChoice);
  for (const ref of ["--force", "-b", "main --orphan", "fix\nlogin", "\tmain"]) {
    for (const field of ["base_ref", "branch"] as const)
      assert.isTrue(
        Exit.isFailure(mcp({ ...spawnArgs, workspace: { type: "worktree", [field]: ref } })),
        `${field} ${JSON.stringify(ref)}`,
      );
    assert.isTrue(Exit.isFailure(stored({ type: "worktree", baseRef: ref })));
    // The person's card edits use the unconstrained client contract; the resolver refuses too.
    assert.isTrue(
      Result.isFailure(resolveSpawnWorkspace(checkout(), { type: "worktree", baseRef: ref })),
    );
  }
  for (const ref of ["j5/main", "release-1.2", "feature/a-b"])
    assert.isTrue(
      Exit.isSuccess(
        mcp({ ...spawnArgs, workspace: { type: "worktree", base_ref: ref, branch: ref } }),
      ),
    );
});

it.effect("refuses a base ref git can't resolve before anything is created", () =>
  Effect.gen(function* () {
    const { layer, call, commands, launches } = yield* spawnHarness({
      checkout: {
        isRepo: true,
        refName: "j5/main",
        missingRefs: ["no-such-ref", "only-on-origin"],
      },
    });
    yield* Effect.gen(function* () {
      const refused = yield* call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "no-such-ref" },
        client_request_id: "missing-base",
      });
      assert.isTrue(refused.isFailure);
      assert.include(
        (refused.result as { readonly message: string }).message,
        "Base ref 'no-such-ref' doesn't resolve to a commit",
      );
      assert.lengthOf(yield* Ref.get(commands), 0);
      // From origin, its fetched copy is enough; locally it isn't.
      const local = yield* call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "only-on-origin" },
        client_request_id: "remote-base-local",
      });
      assert.isTrue(local.isFailure);
      const fromOrigin = yield* call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "only-on-origin", start_from_origin: true },
        client_request_id: "remote-base-origin",
      });
      assert.isFalse(fromOrigin.isFailure);
      assert.lengthOf(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }),
);

const decodeSpawnInput = Schema.decodeUnknownExit(J5SpawnAgentInput);

it("requires a workspace on every spawn", () => {
  const { workspace: _workspace, ...withoutWorkspace } = spawnArgs;
  assert.isTrue(Exit.isFailure(decodeSpawnInput(withoutWorkspace)));
  assert.isTrue(
    Exit.isFailure(
      decodeSpawnInput({
        ...spawnArgs,
        workspace: { type: "worktree" },
      }),
    ),
  );
});

it.effect("spawns into an existing worktree on its branch, with no preparation", () =>
  Effect.gen(function* () {
    const { layer, call, log, commands, launches } = yield* spawnHarness({
      checkout: {
        isRepo: true,
        refName: "j5/main",
        worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/login" }],
      },
    });
    yield* Effect.gen(function* () {
      const spawned = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/repo-worktrees/builder" },
        client_request_id: "existing",
      });
      assert.isFalse(spawned.isFailure);
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "facts", "message.dispatch"]);
      const [create] = yield* Ref.get(commands);
      if (create?.type === "thread.create") {
        assert.equal(create.worktreePath, "/repo-worktrees/builder");
        assert.equal(create.branch, "fix/login");
        assert.include(create.commandId, "spawn-create-existing");
      }
      assert.lengthOf(yield* Ref.get(launches), 0);
      // The key is now bound to the existing worktree; a new-worktree retry is refused.
      const switched = yield* call({ ...spawnArgs, client_request_id: "existing" });
      assert.isTrue(switched.isFailure);
      assert.include(
        (switched.result as { readonly message: string }).message,
        "already bound to a different request",
      );
      const elsewhere = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/tmp/not-a-worktree" },
        client_request_id: "elsewhere",
      });
      assert.isTrue(elsewhere.isFailure);
      assert.include(
        (elsewhere.result as { readonly message: string }).message,
        "Its worktrees: /repo-worktrees/builder",
      );
      assert.lengthOf(yield* Ref.get(commands), 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reads git fresh for each spawn that binds a worktree", () =>
  Effect.gen(function* () {
    const live = yield* Ref.make<FakeCheckout>({
      isRepo: true,
      refName: "j5/main",
      worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/login" }],
    });
    const { layer, call, commands } = yield* spawnHarness({
      checkout: { isRepo: false, refName: null },
      liveCheckout: live,
    });
    yield* Effect.gen(function* () {
      const first = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/repo-worktrees/builder" },
        client_request_id: "before",
      });
      assert.isFalse(first.isFailure);
      // From its own shell, the builder switches branch; upstream's ref cache doesn't hear it.
      yield* Ref.set(live, {
        isRepo: true,
        refName: "j5/main",
        worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/signup" }],
      });
      const second = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/repo-worktrees/builder" },
        client_request_id: "after",
      });
      assert.isFalse(second.isFailure);
      const branches = (yield* Ref.get(commands)).flatMap((command) =>
        command.type === "thread.create" ? [command.branch] : [],
      );
      assert.deepStrictEqual(branches, ["fix/login", "fix/signup"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "retries failures before creation, after creation and after registration without changing the request",
  () =>
    Effect.gen(function* () {
      for (const phase of ["failCreate", "failFacts", "failBrief"] as const) {
        const harness = yield* spawnHarness({ checkout: { isRepo: false, refName: null } });
        yield* Effect.gen(function* () {
          const args = {
            ...spawnArgs,
            workspace: { type: "shared" as const },
            client_request_id: phase,
          };
          yield* Ref.set(harness[phase], true);
          const failed = yield* harness.call(args);
          assert.isTrue(failed.isFailure);
          assert.include(
            message(failed),
            phase === "failCreate"
              ? "could not be created"
              : phase === "failFacts"
                ? "visible orphan"
                : "brief did not start",
          );
          const before = yield* Ref.get(harness.commands);
          assert.lengthOf(before, phase === "failCreate" ? 0 : 1);
          for (const change of [
            { brief: "changed" },
            { title: "changed" },
            { persona: "other" },
            { model: "changed" },
            { reasoning: "medium" },
            { runtime_mode: "approval-required" as const },
            { interaction_mode: "plan" as const },
            { project_id: LedgerProjectId.make("other") },
            { workspace: { type: "root" as const } },
          ]) {
            const mismatch = yield* harness.call({ ...args, ...change });
            assert.isTrue(mismatch.isFailure);
            assert.include(message(mismatch), "different request");
            assert.include(message(mismatch), "agent:j5:a2a:");
            assert.include(message(mismatch), "fresh client_request_id");
          }
          assert.deepStrictEqual(yield* Ref.get(harness.commands), before);
          yield* Ref.set(harness[phase], false);
          assert.isFalse((yield* harness.call(args)).isFailure);
          const commands = yield* Ref.get(harness.commands);
          assert.equal(
            new Set(
              commands
                .filter((command) => command.type === "thread.create")
                .map((command) => command.threadId),
            ).size,
            1,
          );
          assert.equal(
            new Set(
              commands
                .filter((command) => command.type === "message.dispatch")
                .map((command) => command.messageId),
            ).size,
            1,
          );
        }).pipe(Effect.provide(harness.layer));
      }
    }),
);

it.effect(
  "normalizes workspace defaults and resumes the child's persisted modes and checkout",
  () =>
    Effect.gen(function* () {
      const liveCaller = yield* Ref.make(
        callerThread(invocation.thread.threadId, "approval-required"),
      );
      const harness = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
        liveCaller,
      });
      yield* Effect.gen(function* () {
        const args = {
          ...spawnArgs,
          workspace: { type: "worktree" as const, base_ref: "j5/main" },
          client_request_id: "same-defaults",
        };
        yield* Ref.set(harness.failFacts, true);
        const failed = yield* harness.call(args);
        assert.isTrue(failed.isFailure);
        assert.include(message(failed), "visible orphan");
        assert.lengthOf(yield* Ref.get(harness.commands), 1);
        yield* Ref.set(harness.failFacts, false);
        yield* Ref.set(liveCaller, {
          ...callerThread(invocation.thread.threadId),
          thread: {
            ...callerThread(invocation.thread.threadId).thread,
            branch: "new-branch",
            worktreePath: "/new-checkout",
          },
        });
        assert.isFalse(
          (yield* harness.call({
            ...args,
            workspace: { ...args.workspace, start_from_origin: false },
          })).isFailure,
        );
        const launch = (yield* Ref.get(harness.launches))[0];
        assert.equal(launch?.runtimeMode, "approval-required");
        const creates = (yield* Ref.get(harness.commands)).filter(
          (command) => command.type === "thread.create",
        );
        assert.equal(creates[0]?.worktreePath, creates[1]?.worktreePath);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it("optional spawn fields reject null rather than treating it as an omitted choice", () => {
  for (const key of [
    "persona",
    "title",
    "runtime_mode",
    "interaction_mode",
    "project_id",
    "scratch",
    "attachments",
  ])
    assert.isTrue(Exit.isFailure(decodeSpawnInput({ ...spawnArgs, [key]: null })));
});

it.effect(
  "a delayed retry re-reads persisted child modes under the start guard and checks its authorization",
  () =>
    Effect.gen(function* () {
      for (const childMode of ["approval-required", "full-access"] as const) {
        const originalMode = childMode === "full-access" ? "approval-required" : "full-access";
        const liveCaller = yield* Ref.make(callerThread(invocation.thread.threadId, originalMode));
        const reads = yield* Ref.make(0);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* spawnHarness({
          checkout: { isRepo: true, refName: "j5/main" },
          liveCaller,
          beforeProjectRead: Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 0
                ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
            ),
          ),
        });
        yield* Effect.gen(function* () {
          const args = {
            ...spawnArgs,
            scratch: true,
            workspace: { type: "root" as const },
            client_request_id: childMode,
          };
          const delayed = yield* harness
            .call(args)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(held),
            Fiber.join(delayed).pipe(
              Effect.flatMap((result) =>
                Effect.die(
                  new Error(`Delayed call returned before reaching the gate: ${message(result)}`),
                ),
              ),
            ),
          );
          yield* Ref.set(liveCaller, callerThread(invocation.thread.threadId, childMode));
          yield* Ref.set(harness.failBrief, true);
          const failed = yield* harness.call(args);
          assert.isTrue(failed.isFailure);
          assert.include(message(failed), "brief did not start");
          assert.lengthOf(yield* Ref.get(harness.commands), 1);
          yield* Ref.set(harness.failBrief, false);
          yield* Ref.set(liveCaller, callerThread(invocation.thread.threadId, originalMode));
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(delayed);
          assert.equal(result.isFailure, childMode === "full-access");
          if (result.isFailure) assert.include(message(result), "broader than yours is now");
          const creates = (yield* Ref.get(harness.commands)).filter(
            (command) => command.type === "thread.create",
          );
          assert.deepStrictEqual(
            creates.map((command) => command.runtimeMode),
            childMode === "full-access" ? [childMode] : [childMode, childMode],
          );
          assert.deepStrictEqual(
            creates.map((command) => command.worktreePath),
            childMode === "full-access" ? [scratchFolder] : [scratchFolder, scratchFolder],
          );
          assert.equal(yield* Ref.get(harness.folderClaims), 1);
        }).pipe(Effect.provide(harness.layer));
      }
    }),
);

it.effect("an outside agent's narrowed approved level still caps an identical replay", () =>
  Effect.gen(function* () {
    let access: AuthMcpClientAccess = "full-access";
    const scope = {
      ...outsideScope(access),
      client: {
        sessionId: "session-1",
        label: "Outside",
        get access() {
          return access;
        },
      },
    };
    const harness = yield* spawnHarness({ checkout: { isRepo: false, refName: null }, scope });
    yield* Effect.gen(function* () {
      const args = {
        ...spawnArgs,
        project_id: LedgerProjectId.make(otherProjectId),
        workspace: { type: "root" as const },
        client_request_id: "outside-narrowed",
      };
      yield* Ref.set(harness.failBrief, true);
      const failed = yield* harness.call(args);
      assert.isTrue(failed.isFailure);
      assert.include(message(failed), "brief did not start");
      assert.lengthOf(yield* Ref.get(harness.commands), 1);
      yield* Ref.set(harness.failBrief, false);
      access = "approval-required";
      const replay = yield* harness.call(args);
      assert.isTrue(replay.isFailure);
      assert.include(message(replay), "broader than yours is now");
      assert.lengthOf(
        (yield* Ref.get(harness.commands)).filter((command) => command.type === "message.dispatch"),
        0,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each(["shared", "worktree"] as const)(
  "refuses a cross-type pre-upgrade %s retry without binding or changing the thread",
  (type) =>
    Effect.gen(function* () {
      const replayContext = yield* Layer.build(
        RequestReplayService.layer.pipe(Layer.provideMerge(layerMemory)),
      );
      const replay = Layer.succeed(
        RequestReplayService.RequestReplayService,
        Context.get(replayContext, RequestReplayService.RequestReplayService),
      );
      const sql = Context.get(replayContext, SqlClient.SqlClient);
      const harness = yield* spawnHarness({
        checkout: { isRepo: true, refName: "j5/main" },
        replay,
      });
      yield* Effect.gen(function* () {
        const args = {
          ...spawnArgs,
          title: "Original title",
          workspace:
            type === "shared"
              ? { type: "shared" as const }
              : { type: "worktree" as const, base_ref: "j5/main" },
          client_request_id: `pre-upgrade-cross-${type}`,
        };
        const original = yield* harness.call(args);
        assert.isFalse(original.isFailure, message(original));
        // This thread predates request binding, so only its create receipt survives the upgrade.
        yield* sql`DELETE FROM j5_a2a_request_replay`;
        const beforeCommands = yield* Ref.get(harness.commands);
        const beforeLaunches = yield* Ref.get(harness.launches);
        const threads = yield* ThreadManagementService;
        const id = (original.result as { readonly thread_id: ThreadId }).thread_id;
        const beforeThread = yield* threads.getThreadProjection(id);
        const refused = yield* harness.call({
          ...args,
          title: "Must not overwrite",
          workspace:
            type === "shared"
              ? { type: "worktree" as const, base_ref: "j5/main" }
              : { type: "shared" as const },
        });
        assert.isTrue(refused.isFailure);
        assert.include(message(refused), "already bound to workspace");
        assert.deepStrictEqual(yield* Ref.get(harness.commands), beforeCommands);
        assert.deepStrictEqual(yield* Ref.get(harness.launches), beforeLaunches);
        assert.deepStrictEqual(yield* threads.getThreadProjection(id), beforeThread);
        assert.lengthOf(yield* sql`SELECT id FROM j5_a2a_request_replay`, 0);

        const corrected = yield* harness.call(args);
        assert.isFalse(corrected.isFailure, message(corrected));
        assert.deepStrictEqual(corrected.result, original.result);
        assert.lengthOf(yield* sql`SELECT id FROM j5_a2a_request_replay`, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("binds the first retry of a pre-upgrade spawn and holds its key to it", () =>
  Effect.gen(function* () {
    // The agent exists from before replay binding, so its key has no stored request.
    const harness = yield* spawnHarness({
      checkout: { isRepo: false, refName: null },
      existingChildRuntimeMode: "full-access",
    });
    yield* Effect.gen(function* () {
      const args = {
        ...spawnArgs,
        workspace: { type: "shared" as const },
        client_request_id: "pre-upgrade",
      };
      const first = yield* harness.call(args);
      assert.isFalse(first.isFailure, message(first));
      const finished = yield* Ref.get(harness.commands);
      assert.deepStrictEqual(
        finished.map((command) => command.type),
        ["thread.create", "message.dispatch"],
        "the retry finishes the agent as before",
      );

      const changed = yield* harness.call({ ...args, brief: "Different work" });
      assert.isTrue(changed.isFailure);
      assert.include(message(changed), "different request");
      assert.deepStrictEqual(yield* Ref.get(harness.commands), finished);
      const again = yield* harness.call(args);
      assert.deepStrictEqual(again.result, first.result);
    }).pipe(Effect.provide(harness.layer));
  }),
);
