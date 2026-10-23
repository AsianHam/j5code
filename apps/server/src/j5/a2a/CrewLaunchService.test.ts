import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { BUILT_IN_AGENT_PERSONAS } from "../agents/agentPersonas.ts";
import { stringify as toYaml } from "yaml";
import { resolveAgentPersonaRuntime } from "../agents/agentPersonaRuntime.ts";
import { guardAgentPersonaThreadCreate } from "../agents/agentPersonaOrchestration.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { personaLibraryLayer } from "../test-support/personaLibrary.ts";
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
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
  type AgentCrewInstance,
} from "./AgentCrewInstanceService.ts";
import { ArchiveAgentService } from "./ArchiveAgentService.ts";
import { playbookStoreLayer } from "../playbooks/PlaybookStore.ts";
import { ArchiveCrewService, layer as archiveCrewLayer } from "./ArchiveCrewService.ts";
import { crewApprovalToken, describeCrewSeatRuntime } from "./crewRuntimePreview.ts";
import {
  CrewLaunchOperationError,
  CrewLaunchService,
  layer as crewLaunchLayer,
} from "./CrewLaunchService.ts";
import { A2AHomeConflictError, participantIdForThread } from "./HomeRegistrar.ts";
import { crewSeatRequestKey, spawnThreadId } from "./spawnIds.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import { type FakeCheckout, fakeSpawnWorkspaceLayer } from "./test-support/spawnWorkspaceFakes.ts";
import type { ThreadLaunchInput } from "../../orchestration-v2/ThreadLaunchService.ts";
import type { SpawnWorkspaceChoice } from "./spawnWorkspace.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const projectId = LedgerProjectId.make("ledger:crew-launch");
const captainThread = ThreadId.make("thread:captain");
const captainId = ParticipantId.make("agent:captain");
const createdAt = DateTime.makeUnsafe("2026-09-09T16:00:00.000Z");

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; options: ReadonlyArray<string> }>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-09T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: models.map((model) => ({
    slug: model.slug,
    name: model.slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          label: "Reasoning",
          type: "select",
          options: model.options.map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
});

const thread = (id: ThreadId): OrchestrationV2AppThread =>
  ({
    id,
    projectId: ProjectId.make("project:crew-launch"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/repo",
    createdAt,
    archivedAt: null,
  }) as unknown as OrchestrationV2AppThread;

const fixture = Effect.gen(function* () {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const storage = Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(Layer.provideMerge(database));
  const context = yield* Layer.build(storage);
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
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const captain = {
    projectId,
    projectTitle: "Launch project",
    participantId: captainId,
    thread: thread(captainThread),
  };
  return { context, commands, captain };
});

const threadManagementFake = (
  commands: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>,
  unreadableOnce: Set<string>,
  archived: Set<string>,
  realThreads: boolean,
  failBriefOnce: Set<string>,
  beforeDispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, OrchestratorDispatchError>,
) =>
  Layer.mock(ThreadManagementService)({
    getThreadProjection: (threadId) =>
      realThreads
        ? Ref.get(commands).pipe(
            Effect.flatMap((commands) => {
              const created = commands.find(
                (command) => command.type === "thread.create" && command.threadId === threadId,
              );
              return created?.type === "thread.create"
                ? Effect.succeed({
                    thread: { ...thread(threadId), ...created },
                    messages: commands.flatMap((command) =>
                      command.type === "message.dispatch" && command.threadId === threadId
                        ? [{ id: command.messageId, text: command.text }]
                        : [],
                    ),
                  } as unknown as OrchestrationV2ThreadProjection)
                : Effect.fail(
                    new OrchestratorProjectionError({
                      threadId,
                      cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                    }),
                  );
            }),
          )
        : unreadableOnce.delete(threadId)
          ? Effect.fail(
              new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreReadError({ threadId }),
              }),
            )
          : Effect.succeed({
              messages: [],
              thread: {
                ...thread(threadId),
                archivedAt: archived.has(threadId) ? createdAt : null,
              },
            } as unknown as OrchestrationV2ThreadProjection),
    dispatch: (command) =>
      Effect.gen(function* () {
        yield* beforeDispatch(command);
        if (command.type === "message.dispatch" && failBriefOnce.delete(command.threadId))
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
          });
        yield* Ref.update(commands, (items) => {
          if (command.type === "thread.archive") archived.add(command.threadId);
          return [...items, command];
        });
        return { events: [], effects: [] } as never;
      }),
  });

const dependencies = (
  commands: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>,
  providers: ReadonlyArray<ServerProvider>,
  /** Seat threads whose first home registration fails, to leave a launch half done. */
  failHomeOnce: Set<string> = new Set(),
  /** Seat threads whose projection the store cannot read, once; a not-found is not among them. */
  unreadableOnce: Set<string> = new Set(),
  archived: Set<string> = new Set(),
  realThreads = false,
  failBriefOnce: Set<string> = new Set(),
  /** Runs before each command lands, so a test can hold a spawn open. */
  beforeDispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, OrchestratorDispatchError> = () => Effect.void,
  // The Captain works in a worktree, so every seat shares it unless a test overrides one.
  workspace: Parameters<typeof fakeSpawnWorkspaceLayer>[0] = {
    checkout: { isRepo: true, refName: "main" },
  },
) =>
  Layer.mergeAll(
    fakeSpawnWorkspaceLayer(workspace).pipe(
      Layer.provideMerge(
        threadManagementFake(
          commands,
          unreadableOnce,
          archived,
          realThreads,
          failBriefOnce,
          beforeDispatch,
        ),
      ),
    ),
    Layer.mock(SpawnCompositionService)({
      recordFacts: (input) =>
        failHomeOnce.delete(input.threadId)
          ? Effect.fail(
              new A2AHomeConflictError({
                threadId: input.threadId,
                existingProjectId: "project:elsewhere",
                requestedProjectId: input.projectId,
              }),
            )
          : Effect.succeed({
              home: { projectId, participantId: participantIdForThread(input.threadId) },
              placement: {
                projectId,
                participantId: participantIdForThread(input.threadId),
                provenance: input.provenance,
                placementParentId:
                  input.provenance.kind === "spawned-by"
                    ? input.provenance.spawnedByParticipantId
                    : null,
                createdEventSeq: 1,
                updatedEventSeq: 1,
              },
            }),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
  );

it.effect("launches an approved roster whole, records it, briefs each seat, then adds a seat", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const codex = provider("codex", "codex", [
      { slug: "gpt-5.6-sol", options: ["high"] },
      { slug: "gpt-5.6-terra", options: ["high"] },
    ]);
    const launches: Array<Readonly<Record<string, unknown>>> = [];
    const layer = crewLaunchLayer.pipe(
      Layer.provide(
        Layer.succeed(
          AnalyticsService,
          AnalyticsService.of({
            record: (event, properties = {}) =>
              Effect.sync(() => void launches.push({ event, ...properties })),
            flush: Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(dependencies(commands, [codex])),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        personaLibraryLayer("j5-crew-launch-", Object.values(BUILT_IN_AGENT_PERSONAS)),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const crews = yield* AgentCrewInstanceService;

      // Publisher has no enforceable provider, so a roster containing it launches nothing.
      const refused = yield* launcher
        .launch({
          providerSessionId: "session",
          requestKey: "launch-1",
          captain,
          displayName: "Release Crew",
          seats: [
            {
              workspace: { type: "shared" as const },
              name: "builder",
              agentId: "builder",
              reason: "Implements",
            },
            {
              workspace: { type: "shared" as const },
              name: "publisher",
              agentId: "publisher",
              reason: "Publishes",
            },
          ],
          brief: "Ship the login fix.",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewLaunchSeatUnavailableError");
      assert.lengthOf(yield* Ref.get(commands), 0);

      const { instance } = yield* launcher.launch({
        providerSessionId: "session",
        requestKey: "launch-1",
        captain,
        displayName: "Review Pair",
        seats: [
          {
            workspace: { type: "shared" as const },
            name: "builder",
            agentId: "builder",
            reason: "Implements",
            instructions: "Send code to critic.",
          },
          {
            workspace: { type: "shared" as const },
            name: "critic",
            agentId: "critic",
            reason: "Reviews",
          },
        ],
        brief: "Ship the login fix.",
      });
      assert.equal(instance.version, 1);
      assert.equal(instance.captainThreadId, captainThread);
      assert.deepStrictEqual(
        instance.members.map((member) => [member.seatName, member.addedVersion]),
        [
          ["builder", 1],
          ["critic", 1],
        ],
      );
      const captured = yield* Ref.get(commands);
      assert.deepStrictEqual(
        captured.map((command) => command.type),
        ["thread.create", "thread.create", "message.dispatch", "message.dispatch"],
      );
      const builderBrief = captured[2];
      if (builderBrief?.type === "message.dispatch") {
        assert.include(builderBrief.text, "your_seat: builder");
        assert.include(builderBrief.text, `captain_participant_id: ${captainId}`);
        assert.include(builderBrief.text, "- critic: participant_id=");
        assert.include(builderBrief.text, "<seat_instructions>\nSend code to critic.");
        assert.include(builderBrief.text, "<spawner_brief>\nShip the login fix.");
      }
      assert.isNotNull(yield* crews.findMembership(instance.members[1]!.participantId));

      const { instance: grown } = yield* launcher.addSeats({
        providerSessionId: "session",
        requestKey: "add-1",
        captain,
        instance,
        seats: [
          {
            workspace: { type: "shared" as const },
            name: "sentry",
            agentId: "sentry",
            reason: "Security pass",
          },
        ],
      });
      assert.equal(grown.version, 2);
      assert.deepStrictEqual(
        grown.members.map((member) => [member.seatName, member.addedVersion]),
        [
          ["builder", 1],
          ["critic", 1],
          ["sentry", 2],
        ],
      );
      const sentryBrief = (yield* Ref.get(commands)).at(-1);
      if (sentryBrief?.type === "message.dispatch") {
        assert.include(sentryBrief.text, "your_seat: sentry");
        assert.include(sentryBrief.text, "- builder: participant_id=");
        assert.include(sentryBrief.text, "<spawner_brief>\nShip the login fix.");
      }
    }).pipe(Effect.provide(layer));
    // The refused roster launched nothing, so it reports nothing; the Crew and its addition do.
    const shape = { event: "j5.crew.launched", hasPlaybook: false, notCreated: 0, notStarted: 0 };
    assert.deepStrictEqual(
      launches.map(({ worktreeSeats: _w, fullAccessSeats: _f, models: _m, ...rest }) => rest),
      [
        { ...shape, addition: false, seats: 2, personaSeats: 2, created: 2 },
        { ...shape, addition: true, seats: 1, personaSeats: 1, created: 1 },
      ],
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "a custom seat runs on the Captain's model in Full access with no saved agent behind it",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const codex = provider("codex", "codex", [
        { slug: "gpt-5.6-sol", options: ["high"] },
        { slug: "gpt-5.6-terra", options: ["high"] },
      ]);
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(dependencies(commands, [codex])),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          personaLibraryLayer("j5-crew-custom-", Object.values(BUILT_IN_AGENT_PERSONAS)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const { instance } = yield* launcher.launch({
          providerSessionId: "session",
          requestKey: "launch-custom",
          captain,
          displayName: "Notes Crew",
          seats: [
            {
              workspace: { type: "shared" as const },
              name: "critic",
              agentId: "critic",
              reason: "Reviews",
            },
            {
              workspace: { type: "shared" as const },
              name: "scribe",
              agentId: null,
              reason: "Keeps notes",
              instructions: "Write the running notes.",
            },
          ],
          brief: "Review the login fix.",
        });
        assert.deepStrictEqual(
          instance.members.map((member) => [member.seatName, member.agentId]),
          [
            ["critic", "critic"],
            ["scribe", null],
          ],
        );
        const captured = yield* Ref.get(commands);
        const created = captured.find(
          (command) => command.type === "thread.create" && command.title === "scribe",
        );
        assert.equal(created?.type, "thread.create");
        if (created?.type === "thread.create") {
          // No definition to run as: the Captain's own route, Full access, and no persona assignment.
          assert.isUndefined(created.agentPersonaAssignment);
          assert.deepStrictEqual(created.modelSelection, captain.thread.modelSelection);
          assert.equal(created.runtimeMode, "full-access");
        }
        const brief = captured.find(
          (command) =>
            command.type === "message.dispatch" && command.text.includes("your_seat: scribe"),
        );
        assert.equal(brief?.type, "message.dispatch");
        if (brief?.type === "message.dispatch") {
          assert.include(brief.text, "<seat_instructions>\nWrite the running notes.");
          assert.notInclude(brief.text, "<seat_obligation>");
          assert.include(brief.text, "persona=custom");
        }

        // A persona Captain runs under its persona's policy (workspace write, auto-accept-edits here)
        // and has the person supervising it; its custom seat still defaults to Full access.
        const personaCaptain = {
          ...captain,
          thread: {
            ...captain.thread,
            runtimeMode: "approval-required",
            agentPersonaAssignment: {
              personaId: "builder",
              definitionVersion: 1,
              authorityPolicy: "workspace-write",
              resolvedRoute: "primary",
              resolvedDriver: "codex",
              resolvedModelSelection: captain.thread.modelSelection,
            },
          } as typeof captain.thread,
        };
        yield* launcher.launch({
          providerSessionId: "session",
          requestKey: "launch-custom-2",
          captain: personaCaptain,
          displayName: "Notes Crew 2",
          seats: [
            {
              workspace: { type: "shared" as const },
              name: "scribe",
              agentId: null,
              reason: "Keeps notes",
              instructions: "Notes.",
            },
          ],
          brief: "Review the login fix.",
        });
        const underPersona = (yield* Ref.get(commands)).findLast(
          (command) => command.type === "thread.create" && command.title === "scribe",
        );
        assert.equal(underPersona?.type, "thread.create");
        if (underPersona?.type === "thread.create") {
          assert.equal(underPersona.runtimeMode, "full-access");
          assert.isUndefined(underPersona.agentPersonaAssignment);
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a seat whose provider is signed out is refused at spawn, before anything is created",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const signedOut = {
        ...provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]),
        auth: { status: "unauthenticated" as const },
      };
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(dependencies(commands, [signedOut])),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          personaLibraryLayer("j5-crew-launch-", Object.values(BUILT_IN_AGENT_PERSONAS)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const refused = yield* launcher
          .launch({
            providerSessionId: "session",
            requestKey: "signed-out-1",
            captain,
            displayName: "Signed Out",
            seats: [
              {
                workspace: { type: "shared" as const },
                name: "builder",
                agentId: "builder",
                reason: "Implements",
              },
            ],
            brief: "Ship it.",
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "CrewLaunchSeatUnavailableError");
        assert.include(refused.message, "signed out");
        assert.lengthOf(yield* Ref.get(commands), 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("custom seats refuse unavailable providers before recording or spawning", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const available = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    for (const providers of [
      [],
      [{ ...available, auth: { status: "unauthenticated" as const } }],
      [{ ...available, enabled: false }],
      [{ ...available, models: [] }],
    ]) {
      const testLayer = crewLaunchLayer.pipe(
        Layer.provideMerge(dependencies(commands, providers)),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          personaLibraryLayer("j5-custom-unavailable-", Object.values(BUILT_IN_AGENT_PERSONAS)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const error = yield* launcher
          .launch({
            providerSessionId: "session",
            requestKey: "unavailable-custom",
            captain,
            displayName: "Notes",
            seats: [
              {
                workspace: { type: "shared" as const },
                name: "scribe",
                agentId: null,
                reason: "Notes",
                instructions: "Take notes.",
              },
            ],
            brief: "Review.",
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "CrewLaunchSeatUnavailableError");
        assert.lengthOf(yield* Ref.get(commands), 0);
        assert.lengthOf(yield* (yield* AgentCrewInstanceService).listLive(), 0);
      }).pipe(Effect.provide(testLayer));
    }
  }).pipe(Effect.scoped),
);

it.effect(
  "previews actual routes and pins custom defaults; approved launches keep that exact runtime",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high", "low"] }]);
      const withDefaults: ServerProvider = {
        ...codex,
        displayName: "Codex",
        models: codex.models.map((model) => ({
          ...model,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                currentValue: "high",
                options: [
                  { id: "high", label: "High" },
                  { id: "low", label: "Low" },
                ],
              },
            ],
          },
        })),
      };
      const providers = [withDefaults];
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(commands, providers, new Set(), new Set(), new Set(), true),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          personaLibraryLayer("j5-preview-runtime-", Object.values(BUILT_IN_AGENT_PERSONAS)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const seats = [
          {
            workspace: { type: "shared" as const },
            name: "scribe",
            agentId: null,
            reason: "Notes",
            instructions: "Take notes",
          },
        ];
        const resolvedSeats = yield* launcher.resolveSeats(captain, seats);
        assert.deepStrictEqual(resolvedSeats[0]?.runtime, {
          seat: "scribe",
          provider: "OpenAI",
          harness: "Codex",
          model: "gpt-5.6-sol",
          reasoning: "High",
          access: "Full access",
          modelSelection: {
            ...captain.thread.modelSelection,
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          runtimeMode: "full-access",
          workspace: { type: "shared" },
        });
        assert.deepStrictEqual(resolvedSeats[0]?.modelSelection.options, [
          { id: "reasoningEffort", value: "high" },
        ]);
        const input = {
          providerSessionId: "session",
          requestKey: "runtime-pinned",
          captain,
          displayName: "Notes",
          seats,
          resolvedSeats,
          brief: "Review",
        };
        // A changed provider default after validation cannot alter the approved launch.
        providers[0] = {
          ...withDefaults,
          models: withDefaults.models.map((model) => ({
            ...model,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "low",
                  options: [
                    { id: "high", label: "High" },
                    { id: "low", label: "Low" },
                  ],
                },
              ],
            },
          })),
        };
        yield* launcher.launch(input);
        const create = (yield* Ref.get(commands)).find(
          (command) => command.type === "thread.create",
        );
        assert.equal(create?.type, "thread.create");
        if (create?.type === "thread.create")
          assert.deepStrictEqual(create.modelSelection, resolvedSeats[0]?.modelSelection);
        const saved = yield* launcher.resolveSeats(captain, [
          {
            workspace: { type: "shared" as const },
            name: "builder",
            agentId: "builder",
            reason: "Build",
          },
        ]);
        assert.equal(saved[0]?.assignment?.resolvedDriver, "codex");
        assert.equal(saved[0]?.runtime.harness, "Codex");
        assert.equal(saved[0]?.runtime.access, "Repository write");
        const accessOnly = (yield* launcher.resolveSeats(captain, [
          {
            workspace: { type: "shared" as const },
            name: "builder",
            agentId: "builder",
            reason: "Build",
            runtimeMode: "full-access",
          },
        ]))[0]!;
        assert.deepStrictEqual(accessOnly.modelSelection, saved[0]?.modelSelection);
        assert.equal(accessOnly.assignment?.resolvedRoute, saved[0]?.assignment?.resolvedRoute);
        assert.equal(accessOnly.runtime.access, "Full access");
        const accessPolicy = yield* resolveAgentPersonaRuntime(
          {
            agentPersonaAssignment: accessOnly.assignment!,
            runtimeMode: accessOnly.runtimeMode,
          },
          yield* makeAgentPersonaLibrary,
        );
        assert.equal(accessPolicy.runtimeMode, "full-access");
        assert.notProperty(accessPolicy, "sandboxPolicy");

        assert.equal(
          saved[0]?.modelSelection.model,
          saved[0]?.assignment?.resolvedModelSelection.model,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.each([
  ["codex", "Codex", undefined, "OpenAI", "Codex"],
  ["claudeAgent", "Claude", undefined, "Anthropic", "Claude Code"],
  ["claudeAgent", "Claude Code", undefined, "Anthropic", "Claude Code"],
  ["codex", "Work account", undefined, "OpenAI (Work account)", "Codex"],
  ["codex", "Codex", "Other vendor", "Other vendor", "Codex"],
  ["opencode", "Team account", "OpenAI", "OpenAI (Team account)", "OpenCode"],
])(
  "runtime provider label for %s / %s respects the model vendor and configured instance",
  (driver, displayName, subProvider, expectedProvider, expectedHarness) => {
    const configured = provider("instance", driver!, [{ slug: "model", options: ["high"] }]);
    const runtime = describeCrewSeatRuntime(
      "seat",
      { instanceId: configured.instanceId, model: "model" },
      {
        ...configured,
        displayName: displayName!,
        models: configured.models.map((model) => ({
          ...model,
          ...(subProvider === undefined ? {} : { subProvider }),
        })),
      },
      "full-access",
      null,
    );
    assert.equal(runtime.provider, expectedProvider);
    assert.equal(runtime.harness, expectedHarness);
  },
);

it.effect(
  "custom runtime overrides select the advertised harness, model, reasoning, and access without fallback",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const providers = [
        provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]),
        provider("claude-work", "claudeAgent", [
          { slug: "claude-sonnet", options: ["high", "low"] },
        ]),
        provider("acp", "acpRegistry", [{ slug: "model", options: [] }]),
      ];
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(commands, providers, new Set(), new Set(), new Set(), true),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          personaLibraryLayer("j5-custom-runtime-", Object.values(BUILT_IN_AGENT_PERSONAS)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const custom = {
          workspace: { type: "shared" as const },
          name: "reviewer",
          agentId: null,
          reason: "Review",
          instructions: "Read changes",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-work"),
            model: "claude-sonnet",
            options: [{ id: "effort", value: "low" }],
          },
          runtimeMode: "approval-required" as const,
        };
        const resolvedSeats = yield* launcher.resolveSeats(captain, [custom]);
        const resolved = resolvedSeats[0]!;
        assert.deepStrictEqual(resolved.modelSelection, custom.modelSelection);
        assert.equal(resolved.runtimeMode, "approval-required");
        assert.equal(resolved.runtime.harness, "Claude Code");
        assert.equal(resolved.runtime.reasoning, "low");
        assert.equal(resolved.runtime.access, "Supervised");
        assert.deepStrictEqual(resolved.runtime.modelSelection, custom.modelSelection);
        assert.equal(resolved.runtime.runtimeMode, custom.runtimeMode);
        const { instance } = yield* launcher.launch({
          providerSessionId: "session",
          requestKey: "custom-override",
          captain,
          displayName: "Review",
          seats: [custom],
          resolvedSeats,
          brief: "Review",
        });
        const created = (yield* Ref.get(commands)).find(
          (command) => command.type === "thread.create",
        );
        assert.equal(created?.type, "thread.create");
        if (created?.type === "thread.create") {
          assert.deepStrictEqual(created.modelSelection, custom.modelSelection);
          assert.equal(created.runtimeMode, custom.runtimeMode);
          assert.isUndefined(created.agentPersonaAssignment);
        }
        const additional = { ...custom, name: "scribe", runtimeMode: "full-access" as const };
        const addedResolved = yield* launcher.resolveSeats(captain, [additional]);
        yield* launcher.addSeats({
          providerSessionId: "session",
          requestKey: "custom-override-add",
          captain,
          instance,
          seats: [additional],
          resolvedSeats: addedResolved,
        });
        const added = (yield* Ref.get(commands)).findLast(
          (command) => command.type === "thread.create",
        );
        if (added?.type === "thread.create") {
          assert.deepStrictEqual(added.modelSelection, additional.modelSelection);
          assert.equal(added.runtimeMode, "full-access");
        }
        for (const modelSelection of [
          { ...custom.modelSelection, instanceId: ProviderInstanceId.make("missing") },
          { ...custom.modelSelection, model: "missing" },
          { ...custom.modelSelection, options: [{ id: "effort", value: "unsupported" }] },
          { ...custom.modelSelection, options: [{ id: "effort", value: true }] },
          { ...custom.modelSelection, options: [{ id: "unknown", value: "high" }] },
          {
            ...custom.modelSelection,
            options: [
              { id: "effort", value: "low" },
              { id: "effort", value: "high" },
            ],
          },
        ]) {
          const invalid = yield* launcher
            .resolveSeats(captain, [{ ...custom, modelSelection }])
            .pipe(Effect.flip);
          assert.equal(invalid._tag, "CrewLaunchSeatUnavailableError");
        }
        const invalidAccess = yield* launcher
          .resolveSeats(captain, [
            {
              ...custom,
              modelSelection: { instanceId: ProviderInstanceId.make("acp"), model: "model" },
              runtimeMode: "auto-accept-edits",
            },
          ])
          .pipe(Effect.flip);
        assert.equal(invalidAccess._tag, "CrewLaunchSeatUnavailableError");
        assert.include(invalidAccess.message, "Choose Supervised or Full access");
        // Neither configured provider advertises Critic's saved model: the human override
        // still launches, preserving its snapshot and behavior on the selected harness.
        const personaSeat = {
          ...custom,
          name: "saved-reviewer",
          agentId: "critic",
          runtimeMode: "full-access" as const,
        };
        const personaOverride = yield* launcher.resolveSeats(captain, [personaSeat]);
        const saved = personaOverride[0]!;
        assert.equal(saved.assignment?.resolvedRoute, "override");
        assert.deepStrictEqual(saved.modelSelection, custom.modelSelection);
        assert.equal(saved.runtime.access, "Full access");
        const library = yield* makeAgentPersonaLibrary;
        const policy = yield* resolveAgentPersonaRuntime(
          { agentPersonaAssignment: saved.assignment!, runtimeMode: saved.runtimeMode },
          library,
        );
        assert.equal(policy.runtimeMode, "full-access");
        assert.notProperty(policy, "sandboxPolicy");
        assert.notProperty(policy, "approvalPolicy");
        assert.notInclude(policy.agentPersonaInstructions!, "Never commit or push.");
        const original = yield* library.readSnapshot(saved.assignment!);
        assert.include(policy.agentPersonaInstructions!, original.instructions);
        yield* launcher.addSeats({
          providerSessionId: "session",
          requestKey: "saved-override-add",
          captain,
          instance,
          seats: [personaSeat],
          resolvedSeats: personaOverride,
        });
        const savedCommand = (yield* Ref.get(commands)).findLast(
          (command) => command.type === "thread.create",
        );
        assert.equal(savedCommand?.type, "thread.create");
        if (savedCommand?.type === "thread.create") {
          assert.deepStrictEqual(savedCommand.modelSelection, personaSeat.modelSelection);
          assert.equal(savedCommand.runtimeMode, "full-access");
          assert.deepStrictEqual(savedCommand.agentPersonaAssignment, saved.assignment);
          yield* guardAgentPersonaThreadCreate(savedCommand, library, () =>
            Effect.succeed("claudeAgent"),
          );
        }
        for (const selection of [
          { ...custom.modelSelection, model: "missing" },
          { ...custom.modelSelection, options: [{ id: "effort", value: "unsupported" }] },
        ]) {
          const invalid = yield* launcher
            .resolveSeats(captain, [{ ...personaSeat, modelSelection: selection }])
            .pipe(Effect.flip);
          assert.equal(invalid._tag, "CrewLaunchSeatUnavailableError");
        }
        const modelOnly = (yield* launcher.resolveSeats(captain, [
          { ...personaSeat, runtimeMode: undefined },
        ]))[0]!;
        const defaultPolicy = yield* resolveAgentPersonaRuntime(
          { agentPersonaAssignment: modelOnly.assignment!, runtimeMode: modelOnly.runtimeMode },
          library,
        );
        assert.equal(modelOnly.runtime.access, "Read only");
        assert.equal(
          "sandboxPolicy" in defaultPolicy ? defaultPolicy.sandboxPolicy?.type : undefined,
          "readOnly",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it("runtime previews show advertised variant and boolean thinking choices", () => {
  const configured = provider("instance", "opencode", [{ slug: "model", options: [] }]);
  const selected = { instanceId: configured.instanceId, model: "model" };
  const variantProvider: ServerProvider = {
    ...configured,
    models: configured.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          {
            id: "variant",
            label: "Reasoning",
            type: "select",
            options: [{ id: "deep", label: "Deep reasoning" }],
          },
        ],
      },
    })),
  };
  assert.equal(
    describeCrewSeatRuntime(
      "seat",
      { ...selected, options: [{ id: "variant", value: "deep" }] },
      variantProvider,
      "auto",
      null,
    ).reasoning,
    "Deep reasoning",
  );
  const thinkingProvider: ServerProvider = {
    ...configured,
    models: configured.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: false },
        ],
      },
    })),
  };
  assert.equal(
    describeCrewSeatRuntime(
      "seat",
      { ...selected, options: [{ id: "thinking", value: true }] },
      thinkingProvider,
      "auto",
      null,
    ).reasoning,
    "On",
  );
  assert.equal(
    describeCrewSeatRuntime("seat", selected, thinkingProvider, "auto", null).reasoning,
    "Off",
  );
});

it.effect(
  "an unset custom seat resolves to Full access whatever the Captain runs; a persona seat keeps its policy and an explicit mode wins",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(commands, [
            provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]),
            provider("acp", "acpRegistry", [{ slug: "model", options: [] }]),
          ]),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          personaLibraryLayer("j5-custom-access-", Object.values(BUILT_IN_AGENT_PERSONAS)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const custom = {
          workspace: { type: "shared" as const },
          name: "reviewer",
          agentId: null,
          reason: "Review",
          instructions: "Review",
        };
        const acp = {
          ...custom,
          name: "acp-reviewer",
          modelSelection: { instanceId: ProviderInstanceId.make("acp"), model: "model" },
        };
        for (const runtimeMode of ["approval-required", "auto", "auto-accept-edits"] as const) {
          // Before #326 an ACP seat inherited Auto or Accept edits here and was refused; the
          // Full access default is one the harness enforces, so it now launches.
          const resolved = yield* launcher.resolveSeats(
            { ...captain, thread: { ...captain.thread, runtimeMode } },
            [
              custom,
              acp,
              {
                workspace: { type: "shared" as const },
                name: "builder",
                agentId: "builder",
                reason: "Build",
              },
            ],
          );
          assert.deepStrictEqual(
            resolved.map((seat) => [seat.seat.name, seat.runtimeMode, seat.runtime.access]),
            [
              ["reviewer", "full-access", "Full access"],
              ["acp-reviewer", "full-access", "Full access"],
              ["builder", "auto-accept-edits", "Repository write"],
            ],
          );
        }
        const explicit = yield* launcher.resolveSeats(captain, [
          { ...custom, runtimeMode: "approval-required" },
          { ...acp, runtimeMode: "approval-required" },
        ]);
        assert.deepStrictEqual(
          explicit.map((seat) => seat.runtimeMode),
          ["approval-required", "approval-required"],
        );
        // An explicit mode the ACP harness cannot enforce is still refused.
        for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
          const failure = yield* launcher
            .resolveSeats(captain, [{ ...acp, runtimeMode }])
            .pipe(Effect.flip);
          assert.equal(failure._tag, "CrewLaunchSeatUnavailableError");
          assert.include(failure.message, "cannot enforce the selected access mode");
        }
        assert.lengthOf(yield* Ref.get(commands), 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a full-access persona seat runs full access unless the seat overrides it", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(
        dependencies(commands, [
          provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]),
        ]),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        personaLibraryLayer("j5-full-access-seat-", Object.values(BUILT_IN_AGENT_PERSONAS)),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const library = yield* makeAgentPersonaLibrary;
      const route = {
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      };
      yield* library.importFiles({
        files: [
          {
            name: "operator.yaml",
            content: toYaml({
              ...BUILT_IN_AGENT_PERSONAS.scout,
              id: "operator",
              displayName: "Operator",
              authority: { defaultPolicy: "full-access", allowedPolicies: ["full-access"] },
              modelRoute: [{ ...route }, { ...route }],
            }),
          },
        ],
        replaceExisting: false,
      });
      const seat = {
        name: "operator",
        agentId: "operator",
        reason: "Operate",
        workspace: { type: "shared" as const },
      };
      const [unset] = yield* launcher.resolveSeats(captain, [seat]);
      assert.deepStrictEqual(
        [unset!.runtimeMode, unset!.runtime.access],
        ["full-access", "Full access"],
      );
      assert.equal(unset!.assignment?.authorityPolicy, "full-access");
      const unsetPolicy = yield* resolveAgentPersonaRuntime(
        { agentPersonaAssignment: unset!.assignment!, runtimeMode: unset!.runtimeMode },
        library,
      );
      assert.equal(unsetPolicy.runtimeMode, "full-access");
      assert.notProperty(unsetPolicy, "sandboxPolicy");
      assert.notProperty(unsetPolicy, "approvalPolicy");
      // An explicit seat mode still wins over the persona's policy.
      const [overridden] = yield* launcher.resolveSeats(captain, [
        { ...seat, runtimeMode: "approval-required" },
      ]);
      assert.deepStrictEqual(
        [overridden!.runtimeMode, overridden!.runtime.access],
        ["approval-required", "Supervised"],
      );
      // The override, not the persona's unrestricted policy, reaches the provider runtime.
      const overriddenPolicy = yield* resolveAgentPersonaRuntime(
        {
          agentPersonaAssignment: overridden!.assignment!,
          runtimeMode: overridden!.runtimeMode,
        },
        library,
      );
      assert.equal(overriddenPolicy.runtimeMode, "approval-required");
      assert.notProperty(overriddenPolicy, "sandboxPolicy");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("refuses persona seats whose effective ACP access the harness cannot enforce", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(
        dependencies(commands, [provider("acp", "acpRegistry", [{ slug: "model", options: [] }])]),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        personaLibraryLayer("j5-persona-acp-", Object.values(BUILT_IN_AGENT_PERSONAS)),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const seat = {
        workspace: { type: "shared" as const },
        name: "builder",
        agentId: "builder",
        reason: "Build",
        modelSelection: { instanceId: ProviderInstanceId.make("acp"), model: "model" },
      };
      // A workspace-write persona with no override: the harness cannot enforce its default.
      const inherited = yield* launcher.resolveSeats(captain, [seat]).pipe(Effect.flip);
      assert.equal(inherited._tag, "CrewLaunchSeatUnavailableError");
      assert.include(inherited.message, "cannot enforce the persona's default access");
      // An explicit auto mode is refused on the persona branch as it is for custom seats.
      for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
        const overridden = yield* launcher
          .resolveSeats(captain, [{ ...seat, runtimeMode }])
          .pipe(Effect.flip);
        assert.equal(overridden._tag, "CrewLaunchSeatUnavailableError");
        assert.include(overridden.message, "cannot enforce the selected access mode");
      }
      // Modes the harness enforces itself pass, and the approval-bound preview records them.
      const allowed = yield* launcher.resolveSeats(captain, [
        { ...seat, runtimeMode: "approval-required" },
      ]);
      assert.equal(allowed[0]?.runtimeMode, "approval-required");
      assert.lengthOf(yield* Ref.get(commands), 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("pins non-reasoning provider defaults for persona seats without overrides", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    const configured = (fastMode: boolean): ServerProvider => ({
      ...codex,
      models: codex.models.map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: [
            ...model.capabilities!.optionDescriptors!,
            {
              id: "fastMode",
              label: "Fast",
              type: "boolean",
              currentValue: fastMode,
            },
          ],
        },
      })),
    });
    const providers = [configured(true)];
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(dependencies(commands, providers)),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        personaLibraryLayer("j5-persona-defaults-", Object.values(BUILT_IN_AGENT_PERSONAS)),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const seats = [
        {
          workspace: { type: "shared" as const },
          name: "builder",
          agentId: "builder",
          reason: "Build",
        },
      ];
      const before = (yield* launcher.resolveSeats(captain, seats))[0]!;
      assert.deepStrictEqual(
        before.modelSelection.options?.find((option) => option.id === "fastMode"),
        { id: "fastMode", value: true },
      );
      assert.deepStrictEqual(before.assignment?.resolvedModelSelection, before.modelSelection);
      providers[0] = configured(false);
      const after = (yield* launcher.resolveSeats(captain, seats))[0]!;
      assert.equal(before.runtime.reasoning, after.runtime.reasoning);
      assert.deepStrictEqual(
        after.modelSelection.options?.find((option) => option.id === "fastMode"),
        { id: "fastMode", value: false },
      );
      assert.notDeepEqual(before, after);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

const unitFixture = Effect.gen(function* () {
  const { context, commands, captain } = yield* fixture;
  const codex = provider("codex", "codex", [
    { slug: "gpt-5.6-sol", options: ["high"] },
    { slug: "gpt-5.6-terra", options: ["high"] },
  ]);
  const entered = yield* Queue.unbounded<string>();
  const archivedSeats = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const factsRead = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const holdArchive = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const holdDispatch = yield* Ref.make<
    (command: OrchestrationV2ServerCommand) => Effect.Effect<void, OrchestratorDispatchError>
  >(() => Effect.void);
  const real = Context.get(context, AgentCrewInstanceService);
  const crews = Layer.succeed(AgentCrewInstanceService, {
    ...real,
    serialize: (id, effect) =>
      Queue.offer(entered, id).pipe(Effect.andThen(real.serialize(id, effect))),
  });
  const created = (threadId: ThreadId) =>
    Ref.get(commands).pipe(
      Effect.map((items) =>
        items.some((command) => command.type === "thread.create" && command.threadId === threadId),
      ),
    );
  const archiveAgent = Layer.mock(ArchiveAgentService)({
    readFacts: (target) =>
      Effect.gen(function* () {
        yield* Ref.update(factsRead, (items) => [...items, target.threadId]);
        if (!(yield* created(target.threadId))) return null;
        const archived = (yield* Ref.get(archivedSeats)).includes(target.threadId);
        return {
          facts: { openExchanges: [], runningTurn: null },
          threadArchived: archived,
          retired: archived,
        };
      }),
    archive: (input) =>
      Effect.gen(function* () {
        yield* Effect.flatten(Ref.get(holdArchive));
        yield* Ref.update(archivedSeats, (items) => [...items, input.target.threadId]);
        return "archived" as const;
      }),
  });
  const layer = Layer.mergeAll(
    crewLaunchLayer,
    archiveCrewLayer.pipe(
      Layer.provide(archiveAgent),
      Layer.provide(playbookStoreLayer),
      Layer.provide(
        Layer.mock(ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
        }),
      ),
    ),
  ).pipe(
    Layer.provideMerge(crews),
    Layer.provideMerge(
      dependencies(commands, [codex], new Set(), new Set(), new Set(), true, new Set(), (command) =>
        Ref.get(holdDispatch).pipe(Effect.flatMap((hold) => hold(command))),
      ),
    ),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(
      personaLibraryLayer("j5-crew-unit-", Object.values(BUILT_IN_AGENT_PERSONAS)),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const archiveInput = (crewInstanceId: string) => ({
    providerSessionId: "session",
    callerParticipantId: null,
    projectId: null,
    crewInstanceId,
    clientRequestKey: "archive-1",
    confirmationSatisfied: true,
    archivedAt: "2026-09-09T17:00:00.000Z",
    commandIds: (seat: string) => ({
      interruptCommandId: CommandId.make(`interrupt:${seat}`),
      archiveCommandId: CommandId.make(`archive:${seat}`),
    }),
  });
  const seatThread = (requestKey: string, seat: string) =>
    spawnThreadId({
      providerSessionId: "session",
      requestKey: crewSeatRequestKey(requestKey, seat),
    });
  const launchPair = Effect.gen(function* () {
    const launcher = yield* CrewLaunchService;
    const { instance } = yield* launcher.launch({
      providerSessionId: "session",
      requestKey: "unit-1",
      captain,
      displayName: "Review Pair",
      seats: [
        {
          workspace: { type: "shared" as const },
          name: "builder",
          agentId: "builder",
          reason: "Implements",
        },
      ],
      brief: "Ship the login fix.",
    });
    return instance;
  });
  const addSentry = (instance: AgentCrewInstance) =>
    Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const { instance: grown } = yield* launcher.addSeats({
        providerSessionId: "session",
        requestKey: "add-sentry",
        captain,
        instance,
        seats: [
          {
            workspace: { type: "shared" as const },
            name: "sentry",
            agentId: "sentry",
            reason: "Security pass",
          },
        ],
      });
      return grown;
    });
  return {
    layer,
    commands,
    entered,
    archivedSeats,
    factsRead,
    holdArchive,
    holdDispatch,
    archiveInput,
    seatThread,
    launchPair,
    addSentry,
    captain,
  };
});

it.effect(
  "a roster whose middle seat fails to create launches the others, drops its row, and reports every seat",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const crews = yield* AgentCrewInstanceService;
        const launcher = yield* CrewLaunchService;
        const critic = unit.seatThread("trio", "critic");
        yield* Ref.set(unit.holdDispatch, (command) =>
          command.type === "thread.create" && command.threadId === critic
            ? Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              )
            : Effect.void,
        );
        const launched = yield* launcher.launch({
          providerSessionId: "session",
          requestKey: "trio",
          captain: unit.captain,
          displayName: "Trio",
          seats: [
            {
              workspace: { type: "shared" as const },
              name: "builder",
              agentId: "builder",
              reason: "Implements",
            },
            {
              workspace: { type: "shared" as const },
              name: "critic",
              agentId: "critic",
              reason: "Reviews",
            },
            {
              workspace: { type: "shared" as const },
              name: "sentry",
              agentId: "sentry",
              reason: "Security pass",
            },
          ],
          brief: "Ship the login fix.",
        });
        // The seat after the failure was still attempted.
        assert.deepStrictEqual(
          launched.seats.map((outcome) => [outcome.seatName, outcome.kind]),
          [
            ["builder", "created"],
            ["critic", "not_created"],
            ["sentry", "created"],
          ],
        );
        assert.deepStrictEqual(
          launched.instance.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );
        assert.deepStrictEqual(
          (yield* crews.read(launched.instance.id))!.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );
        // Only the seats that exist got a brief, and their roster names only each other.
        const briefs = (yield* Ref.get(unit.commands)).flatMap((command) =>
          command.type === "message.dispatch" ? [command] : [],
        );
        assert.sameMembers(
          briefs.map((command) => command.threadId),
          [unit.seatThread("trio", "builder"), unit.seatThread("trio", "sentry")],
        );
        for (const brief of briefs) {
          assert.include(brief.text, "- builder");
          assert.notInclude(brief.text, "- critic");
        }
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "an addition approved while the unit archive runs is refused before any seat of it exists",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const archive = yield* ArchiveCrewService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* unit.launchPair;
        yield* Queue.clear(unit.entered);

        // The archive has read the roster and is retiring its first member when the addition,
        // already past the gate's checks, asks to reserve its seat. This proves the outcome, not
        // the lock: without it the addition may still happen to reserve after the stamp. The
        // mid-spawn test below is the one that fails without the lock.
        const archiving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(
          unit.holdArchive,
          Deferred.succeed(archiving, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const archiveFiber = yield* archive
          .archive(unit.archiveInput(instance.id))
          .pipe(Effect.forkChild);
        yield* Deferred.await(archiving);
        const addFiber = yield* unit.addSentry(instance).pipe(Effect.flip, Effect.forkChild);
        assert.deepStrictEqual(
          [yield* Queue.take(unit.entered), yield* Queue.take(unit.entered)],
          [instance.id, instance.id],
        );
        yield* Deferred.succeed(release, undefined);

        const archived = yield* Fiber.join(archiveFiber);
        assert.equal(archived.status, "archived");
        assert.deepStrictEqual(
          archived.members.map((member) => member.seatName),
          ["builder"],
        );
        const refused = yield* Fiber.join(addFiber);
        assert.equal(refused._tag, "CrewLaunchOperationError");
        assert.include(refused.message, "is retired");

        const sentry = unit.seatThread("add-sentry", "sentry");
        const commands = yield* Ref.get(unit.commands);
        assert.isFalse(
          commands.some((command) => "threadId" in command && command.threadId === sentry),
        );
        const after = (yield* crews.read(instance.id))!;
        assert.isNotNull(after.archivedAt);
        assert.deepStrictEqual(
          after.members.map((member) => member.seatName),
          ["builder"],
        );
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a unit archive that arrives while an addition spawns reads the roster after the seat exists and retires it",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const archive = yield* ArchiveCrewService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* unit.launchPair;
        yield* Queue.clear(unit.entered);
        const sentry = unit.seatThread("add-sentry", "sentry");

        // The addition has reserved its row and its seat thread is being created.
        const spawning = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(unit.holdDispatch, (command) =>
          command.type === "thread.create" && command.threadId === sentry
            ? Deferred.succeed(spawning, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const addFiber = yield* unit.addSentry(instance).pipe(Effect.forkChild);
        yield* Deferred.await(spawning);
        const reserved = (yield* crews.read(instance.id))!;
        assert.deepStrictEqual(
          reserved.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );

        const archiveFiber = yield* archive
          .archive(unit.archiveInput(instance.id))
          .pipe(Effect.forkChild);
        assert.deepStrictEqual(
          [yield* Queue.take(unit.entered), yield* Queue.take(unit.entered)],
          [instance.id, instance.id],
        );
        // Waiting on the addition, the archive has not read a single seat.
        assert.lengthOf(yield* Ref.get(unit.factsRead), 0);
        yield* Deferred.succeed(release, undefined);

        const grown = yield* Fiber.join(addFiber);
        assert.deepStrictEqual(
          grown.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );
        const archived = yield* Fiber.join(archiveFiber);
        assert.equal(archived.status, "archived");
        assert.deepStrictEqual(
          archived.members.map((member) => [member.seatName, member.result]),
          [
            ["builder", "archived"],
            ["sentry", "archived"],
          ],
        );
        assert.include(yield* Ref.get(unit.archivedSeats), sentry);
        assert.isNotNull((yield* crews.read(instance.id))!.archivedAt);
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "an addition whose seat was never created drops its row, and a unit archive still finishes over a row a restart left",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const archive = yield* ArchiveCrewService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* unit.launchPair;
        const sentry = unit.seatThread("add-sentry", "sentry");
        yield* Ref.set(unit.holdDispatch, (command) =>
          command.type === "thread.create" && command.threadId === sentry
            ? Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              )
            : Effect.void,
        );
        // Launch once: the failed create is reported, not raised, and its row is dropped.
        const launcher = yield* CrewLaunchService;
        const added = yield* launcher.addSeats({
          providerSessionId: "session",
          requestKey: "add-sentry",
          captain: unit.captain,
          instance,
          seats: [
            {
              workspace: { type: "shared" as const },
              name: "sentry",
              agentId: "sentry",
              reason: "Security pass",
            },
          ],
        });
        assert.deepStrictEqual(
          added.seats.map((outcome) => [outcome.seatName, outcome.kind]),
          [["sentry", "not_created"]],
        );
        assert.deepStrictEqual(
          (yield* crews.read(instance.id))!.members.map((member) => member.seatName),
          ["builder"],
        );

        // A server that stopped between reserving the seat and dropping it leaves the row with no
        // thread behind it; the unit archive still finishes and says the seat never ran.
        yield* crews.addMembers(instance.id, [
          {
            seatName: "sentry",
            agentId: "sentry",
            participantId: participantIdForThread(sentry),
            threadId: sentry,
            reason: "Security pass",
          },
        ]);
        const archived = yield* archive.archive(unit.archiveInput(instance.id));
        assert.equal(archived.status, "archived");
        assert.deepStrictEqual(
          archived.members.map((member) => [member.seatName, member.result]),
          [
            ["builder", "archived"],
            ["sentry", "never_created"],
          ],
        );
        assert.notInclude(yield* Ref.get(unit.archivedSeats), sentry);
        const retired = (yield* crews.read(instance.id))!;
        assert.isNotNull(retired.archivedAt);
        // The reserved row stays on the retired roster; the result says it never ran.
        assert.deepStrictEqual(
          retired.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "an addition whose approval cannot be recorded releases its reservation and spawns nothing",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const crews = yield* AgentCrewInstanceService;
        const launcher = yield* CrewLaunchService;
        const instance = yield* unit.launchPair;
        const sentry = unit.seatThread("add-sentry", "sentry");
        const created = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* Ref.set(unit.holdDispatch, (command) =>
          command.type === "thread.create"
            ? Ref.update(created, (ids) => [...ids, command.threadId])
            : Effect.void,
        );
        const failed = yield* launcher
          .addSeats({
            providerSessionId: "session",
            requestKey: "add-sentry",
            captain: unit.captain,
            instance,
            seats: [
              {
                workspace: { type: "shared" as const },
                name: "sentry",
                agentId: "sentry",
                reason: "Security pass",
              },
            ],
            onReserved: () =>
              Effect.fail(
                new CrewLaunchOperationError({
                  phase: "approving proposal",
                  seatName: null,
                  createdSeats: [],
                  cause: new Error("disk full"),
                }),
              ),
          })
          .pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        assert.notInclude(yield* Ref.get(created), sentry);
        assert.deepStrictEqual(
          (yield* crews.read(instance.id))!.members.map((member) => member.seatName),
          ["builder"],
        );
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);

it.effect("records a playbook Crew's step owners and surfaces a taken step unwrapped", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(dependencies(commands, [codex])),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        personaLibraryLayer("j5-crew-steps-", Object.values(BUILT_IN_AGENT_PERSONAS)),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const crews = yield* AgentCrewInstanceService;
      const playbook = {
        name: "release",
        definitionPath: "/repo/.j5/playbooks/release.yaml",
        title: "Release",
        steps: [
          { id: "plan", title: "Plan the release" },
          { id: "review", title: "Review" },
        ],
      };
      const custom = (name: string, steps?: ReadonlyArray<string>) => ({
        workspace: { type: "shared" as const },
        name,
        agentId: null,
        reason: `Seat ${name}`,
        instructions: `Do the ${name} work.`,
        ...(steps === undefined ? {} : { steps }),
      });
      const { instance } = yield* launcher.launch({
        providerSessionId: "session",
        requestKey: "playbook-crew",
        captain,
        displayName: "Release Crew",
        seats: [custom("planner", ["plan"]), custom("helper")],
        brief: "Ship it.",
        playbook,
      });
      assert.deepStrictEqual(instance.playbook, {
        name: "release",
        definitionPath: playbook.definitionPath,
      });
      assert.deepStrictEqual(
        instance.members.map(({ seatName, playbookStepIds }) => [seatName, playbookStepIds]),
        [
          ["planner", ["plan"]],
          ["helper", []],
        ],
      );
      const briefs = (yield* Ref.get(commands)).flatMap((command) =>
        command.type === "message.dispatch" ? [command.text] : [],
      );
      assert.include(briefs[0], "your_steps:\n- plan: Plan the release\n</seat_playbook>");
      assert.include(briefs[1], "your_steps: none\n</seat_playbook>");

      const sent = (yield* Ref.get(commands)).length;
      const refused = yield* launcher
        .addSeats({
          providerSessionId: "session",
          requestKey: "rival",
          captain,
          instance,
          seats: [custom("rival", ["plan"])],
          playbook,
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewStepAlreadyOwnedError");
      assert.lengthOf(yield* Ref.get(commands), sent);
      assert.deepStrictEqual(
        (yield* crews.read(instance.id))?.members.map(({ seatName }) => seatName),
        ["planner", "helper"],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a relaunch after a failed link stores the re-approved seat's steps", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(dependencies(commands, [codex])),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        personaLibraryLayer("j5-crew-relaunch-", Object.values(BUILT_IN_AGENT_PERSONAS)),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const crews = yield* AgentCrewInstanceService;
      const input = {
        providerSessionId: "session",
        requestKey: "relaunch",
        captain,
        displayName: "Release Crew",
        brief: "Ship it.",
        playbook: {
          name: "release",
          definitionPath: "/repo/.j5/playbooks/release.yaml",
          title: "Release",
          steps: [{ id: "plan", title: "Plan" }],
        },
      };
      const seat = (steps?: ReadonlyArray<string>) => ({
        workspace: { type: "shared" as const },
        name: "planner",
        agentId: null,
        reason: "Plans",
        instructions: "Plan it.",
        ...(steps === undefined ? {} : { steps }),
      });
      const failed = yield* launcher
        .launch({
          ...input,
          seats: [seat(["plan"])],
          onRecorded: () =>
            Effect.fail(
              new CrewLaunchOperationError({
                phase: "linking the proposal",
                seatName: null,
                createdSeats: [],
                cause: "disk I/O error",
              }),
            ),
        })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "CrewLaunchOperationError");
      const { instance } = yield* launcher.launch({ ...input, seats: [seat()] });
      assert.deepStrictEqual(
        (yield* crews.read(instance.id))?.members.map(({ seatName, playbookStepIds }) => [
          seatName,
          playbookStepIds,
        ]),
        [["planner", []]],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("launches each seat in the workspace it names, and refuses one git can't give", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchInput>>([]);
    const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    const layerFor = (checkout: FakeCheckout) =>
      crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(
            commands,
            [codex],
            new Set(),
            new Set(),
            new Set(),
            false,
            new Set(),
            () => Effect.void,
            { checkout, launches },
          ),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          personaLibraryLayer("j5-crew-launch-", Object.values(BUILT_IN_AGENT_PERSONAS)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
    const seat = (name: string, workspace: SpawnWorkspaceChoice) => ({
      name,
      agentId: null,
      reason: "Works",
      instructions: `Be the ${name}`,
      workspace,
    });
    const seats = [
      seat("builder", { type: "worktree", baseRef: "j5/main" }),
      seat("reviewer", { type: "existing_worktree", worktreePath: "/repo-worktrees/feature/" }),
      seat("scribe", { type: "shared" }),
    ];

    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      // Outside a git repository only the shared seat could resolve, so nothing is created.
      const refused = yield* launcher
        .launch({
          providerSessionId: "session",
          requestKey: "no-repo",
          captain,
          displayName: "Trio",
          seats,
          brief: "Ship it.",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewLaunchSeatUnavailableError");
      assert.include(refused.message, "not a git repository");
      assert.lengthOf(yield* Ref.get(commands), 0);
      assert.deepStrictEqual(yield* launcher.workspaceOptions(captain), {
        currentBranch: null,
        cwd: null,
        worktrees: [],
      });
    }).pipe(Effect.provide(layerFor({ isRepo: false, refName: null })));

    const repo: FakeCheckout = {
      isRepo: true,
      refName: "j5/main",
      localBranchNames: ["release"],
      worktrees: [{ path: "/repo-worktrees/feature", branch: "fix/login" }],
    };
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      // A path git doesn't list as a worktree is refused, naming the ones it does.
      const unknown = yield* launcher
        .resolveSeats(captain, [
          seat("reviewer", { type: "existing_worktree", worktreePath: "/elsewhere" }),
        ])
        .pipe(Effect.flip);
      assert.include(unknown.message, "isn't one of this project's worktrees");
      assert.include(unknown.message, "/repo-worktrees/feature");
      assert.deepStrictEqual(yield* launcher.workspaceOptions(captain), {
        currentBranch: "j5/main",
        // The branch picker searches where the Captain works; no list travels with the preview.
        cwd: "/repo",
        worktrees: [{ path: "/repo-worktrees/feature", branch: "fix/login" }],
      });

      const resolved = yield* launcher.resolveSeats(captain, seats);
      assert.deepStrictEqual(
        resolved.map((entry) => entry.runtime.workspace),
        [
          { type: "worktree", baseRef: "j5/main", startFromOrigin: false },
          {
            type: "existing_worktree",
            worktreePath: "/repo-worktrees/feature",
            branch: "fix/login",
          },
          { type: "shared" },
        ],
      );
      yield* launcher.launch({
        providerSessionId: "session",
        requestKey: "trio",
        captain,
        displayName: "Trio",
        seats,
        resolvedSeats: resolved,
        brief: "Ship it.",
      });
      const threadOf = (name: string) =>
        spawnThreadId({
          providerSessionId: "session",
          requestKey: crewSeatRequestKey("trio", name),
        });
      const captured = yield* Ref.get(commands);
      const createOf = (name: string) =>
        captured.find(
          (command) => command.type === "thread.create" && command.threadId === threadOf(name),
        );
      const builder = createOf("builder");
      const reviewer = createOf("reviewer");
      const scribe = createOf("scribe");
      if (builder?.type === "thread.create") {
        assert.isNull(builder.worktreePath);
        assert.include(builder.commandId, "spawn-create-worktree");
      }
      // The existing worktree binds at creation, on the branch git has there.
      if (reviewer?.type === "thread.create") {
        assert.equal(reviewer.worktreePath, "/repo-worktrees/feature");
        assert.equal(reviewer.branch, "fix/login");
        assert.include(reviewer.commandId, "spawn-create-existing");
      }
      if (scribe?.type === "thread.create") {
        assert.equal(scribe.worktreePath, captain.thread.worktreePath);
        assert.equal(scribe.branch, captain.thread.branch);
      }
      // Only the new worktree waits on ThreadLaunch; the other two briefs start at once.
      const briefs = captured.filter((command) => command.type === "message.dispatch");
      assert.sameMembers(
        briefs.map((command) => command.threadId),
        [threadOf("reviewer"), threadOf("scribe")],
      );
      const [launch] = yield* Ref.get(launches);
      assert.equal(launch?.threadId, threadOf("builder"));
      assert.isTrue(launch?.reuseExistingThread);
      assert.deepStrictEqual(launch?.workspaceStrategy, {
        type: "worktree",
        baseRef: "j5/main",
        startFromOrigin: false,
      });
      assert.include(launch?.initialMessage?.text, "your_seat: builder");
    }).pipe(Effect.provide(layerFor(repo)));
  }),
);

it.effect("binds an existing worktree's live branch, so a stale preview can't approve", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    const live = yield* Ref.make<FakeCheckout>({
      isRepo: true,
      refName: "j5/main",
      worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/login" }],
    });
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(
        dependencies(
          commands,
          [codex],
          new Set(),
          new Set(),
          new Set(),
          false,
          new Set(),
          () => Effect.void,
          { checkout: { isRepo: false, refName: null }, liveCheckout: live },
        ),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        personaLibraryLayer("j5-crew-launch-", Object.values(BUILT_IN_AGENT_PERSONAS)),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    const reviewer = (worktreePath: string) => ({
      name: "reviewer",
      agentId: null,
      reason: "Reviews",
      instructions: "Review it",
      workspace: { type: "existing_worktree" as const, worktreePath },
    });
    const proposal = {
      id: "proposal:fresh",
      brief: "Review it.",
      displayName: "Review",
    } as unknown as Parameters<typeof crewApprovalToken>[0];
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      // The preview binds the builder's worktree on fix/login and reads the card's lists.
      const shown = yield* launcher.resolveSeats(captain, [reviewer("/repo-worktrees/builder")]);
      yield* launcher.workspaceOptions(captain);
      assert.equal(
        shown[0]?.workspace.type === "existing_worktree" && shown[0].workspace.branch,
        "fix/login",
      );
      // From its own shell, the builder switches branch and adds a worktree, within upstream's
      // ref cache and refresh-coalescing window, which never hear about either.
      yield* Ref.set(live, {
        isRepo: true,
        refName: "j5/main",
        worktrees: [
          { path: "/repo-worktrees/builder", branch: "fix/signup" },
          { path: "/repo-worktrees/scout", branch: "spike" },
        ],
      });
      // The card's lists may still be the cached ones; nothing is bound from them.
      assert.deepStrictEqual((yield* launcher.workspaceOptions(captain)).worktrees, [
        { path: "/repo-worktrees/builder", branch: "fix/login" },
      ]);
      // Approval reads the worktree's branch live from the checkout, past the cached snapshot.
      const approving = yield* launcher.resolveSeats(captain, [
        reviewer("/repo-worktrees/builder"),
      ]);
      assert.deepStrictEqual(approving[0]?.runtime.workspace, {
        type: "existing_worktree",
        worktreePath: "/repo-worktrees/builder",
        branch: "fix/signup",
      });
      // Membership comes from the cached snapshot, so a worktree added inside its window is
      // refused once; retrying after it refreshes finds it.
      const tooNew = yield* launcher
        .resolveSeats(captain, [reviewer("/repo-worktrees/scout")])
        .pipe(Effect.flip);
      assert.include(tooNew.message, "isn't one of this project's worktrees");
      // The token the stale preview showed no longer matches, so the gate asks for a fresh one.
      assert.notEqual(
        crewApprovalToken(proposal, captain, shown),
        crewApprovalToken(proposal, captain, approving),
      );
    }).pipe(Effect.provide(layer));
  }),
);
