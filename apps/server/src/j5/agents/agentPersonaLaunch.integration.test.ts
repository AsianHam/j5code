import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { stringify as yamlStringify } from "yaml";
import { createPendingAttachmentId } from "../../attachmentStore.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { definitionDigest, makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import { personaLibraryLayer } from "../test-support/personaLibrary.ts";
import { noDocumentTextLayer } from "../test-support/documentText.ts";

const isThreadLaunchError = Schema.is(ThreadLaunch.ThreadLaunchError);
function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

it.effect("refuses a former bundled persona when the library is empty", () => {
  const harness = makeHarness({ providers: [] });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = "thread:unconfigured-persona";
    const error = yield* launches
      .launch({
        ...launchInput({ command: "command:unconfigured-persona", thread: threadId }),
        agentPersona: { personaId: "scout" },
      })
      .pipe(Effect.flip);
    assert.equal(error.message, "Unknown persona in this environment.");
    assert.isNull(yield* threads.getThreadShell(ThreadId.make(threadId)));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("launches one persona directly without requiring workflow sequencing", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-02T00:00:00.000Z",
          availability: "available",
          models: [
            {
              slug: "gpt-5.6-terra",
              name: "GPT-5.6 Terra",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: [
                      { id: "medium", label: "Medium" },
                      { id: "high", label: "High" },
                    ],
                  },
                ],
              },
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ],
    });

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch({
        ...launchInput({
          command: "command:launch:agent-persona",
          thread: "thread:launch:agent-persona",
        }),
        agentPersona: { personaId: "scout" },
      });

      const expectedAssignment = {
        personaId: "scout",
        definitionVersion: 1,
        definitionDigest: definitionDigest(BUILT_IN_AGENT_PERSONAS.scout),
        displayName: "Scout",
        authorityPolicy: "read-only",
        resolvedRoute: "primary",
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      } as const;
      assert.deepEqual(launched.projection.thread.agentPersonaAssignment, expectedAssignment);
      assert.deepEqual(
        launched.projection.thread.modelSelection,
        expectedAssignment.resolvedModelSelection,
      );
      assert.deepEqual(
        (yield* threads.getThreadShell(launched.threadId))?.agentPersonaAssignment,
        expectedAssignment,
      );

      const switchError = yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("command:launch:agent-persona:switch"),
          threadId: launched.threadId,
          modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(
        switchError.cause,
        `Persona thread ${launched.threadId} has an immutable model route.`,
      );

      const messageOverrideError = yield* threads
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:launch:agent-persona:model-override"),
          threadId: launched.threadId,
          messageId: MessageId.make("message:launch:agent-persona:model-override"),
          text: "Use another model",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      assert.equal(
        messageOverrideError.cause,
        `Persona thread ${launched.threadId} has an immutable model route.`,
      );

      const publisherError = yield* launches
        .launch({
          ...launchInput({
            command: "command:launch:publisher-blocked",
            thread: "thread:launch:publisher-blocked",
          }),
          agentPersona: { personaId: "publisher" },
        })
        .pipe(Effect.flip);
      assert.equal(
        publisherError.message,
        "Persona publisher is blocked because neither route can enforce its authority policy.",
      );

      const invalidAuthorityError = yield* launches
        .launch({
          ...launchInput({
            command: "command:launch:persona-invalid-authority",
            thread: "thread:launch:persona-invalid-authority",
          }),
          agentPersona: { personaId: "scout", authorityPolicy: "publish-only" },
        })
        .pipe(Effect.flip);
      assert.equal(
        invalidAuthorityError.message,
        "Authority policy publish-only is not allowed for scout.",
      );
    }).pipe(
      Effect.provide(
        harness.layer.pipe(
          Layer.provideMerge(
            personaLibraryLayer("j5-direct-persona-", [
              BUILT_IN_AGENT_PERSONAS.scout,
              BUILT_IN_AGENT_PERSONAS.publisher,
            ]),
          ),
        ),
      ),
      Effect.scoped,
    );
  }),
);
it.effect("blocks a direct persona launch when both declared model routes are unavailable", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ providers: [] });

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .launch({
          ...launchInput({
            command: "command:launch:blocked-agent-persona",
            thread: "thread:launch:blocked-agent-persona",
          }),
          agentPersona: { personaId: "scout" },
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ThreadLaunch.ThreadLaunchError);
      assert.equal(error._tag, "ThreadLaunchError");
      assert.equal(
        error._tag === "ThreadLaunchError" ? error.operation : undefined,
        "resolve-agent-persona",
      );
      assert.include(
        error.message,
        "Persona scout is blocked because its primary and fallback models are unavailable: ",
      );
    }).pipe(
      Effect.provide(
        harness.layer.pipe(
          Layer.provideMerge(
            personaLibraryLayer("j5-blocked-persona-", [BUILT_IN_AGENT_PERSONAS.scout]),
          ),
        ),
      ),
      Effect.scoped,
    );
  }),
);

const yamlPersonaFixture = (value: unknown) => yamlStringify(value);

it.effect(
  "launches an imported persona and replays its receipt after the source is removed",
  () => {
    const definition = {
      ...BUILT_IN_AGENT_PERSONAS.scout,
      id: "team-researcher",
      displayName: "Team Researcher",
      version: 2,
    };
    const harness = makeHarness({
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-08T00:00:00.000Z",
          availability: "available",
          slashCommands: [],
          skills: [],
          models: [
            {
              slug: definition.modelRoute[0].model,
              name: "Research model",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const environment = ServerConfig.layerTest("/repo", { prefix: "j5-persona-launch-" });
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(config.stateDir, "personas");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "team.yaml"), yamlPersonaFixture(definition));
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = {
        ...launchInput({ command: "command:imported-persona", thread: "thread:imported-persona" }),
        agentPersona: { personaId: definition.id },
      };
      const launched = yield* launches.launch(input);
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.agentPersonaAssignment?.displayName, definition.displayName);
      assert.match(
        projection.thread.agentPersonaAssignment?.definitionDigest ?? "",
        /^[a-f0-9]{64}$/,
      );
      const library = yield* makeAgentPersonaLibrary;
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yamlPersonaFixture(definition) }],
        replaceExisting: true,
      });
      yield* library.setImportedEnabled(definition.id, false);
      const disabledError = yield* launches
        .launch({
          ...input,
          commandId: CommandId.make("command:imported-persona:disabled"),
          threadId: ThreadId.make("thread:imported-persona:disabled"),
        })
        .pipe(Effect.flip);
      assert.equal(disabledError._tag, "ThreadLaunchError");
      assert.equal(
        disabledError._tag === "ThreadLaunchError" ? disabledError.operation : undefined,
        "resolve-agent-persona",
      );
      assert.include(disabledError.message, "disabled");
      assert.equal((yield* launches.launch(input)).threadId, launched.threadId);
      yield* library.setImportedEnabled(definition.id, true);
      const reenabled = yield* launches.launch({
        ...input,
        commandId: CommandId.make("command:imported-persona:enabled"),
        threadId: ThreadId.make("thread:imported-persona:enabled"),
      });
      assert.equal(
        reenabled.projection.thread.agentPersonaAssignment?.definitionDigest,
        projection.thread.agentPersonaAssignment?.definitionDigest,
      );
      yield* library.removeImported(definition.id);
      yield* fs.remove(folder, { recursive: true });
      const replay = yield* launches.launch(input);
      assert.equal(replay.threadId, launched.threadId);
      const policy = yield* resolveAgentPersonaRuntime(projection.thread, library);
      assert.include(
        "agentPersonaInstructions" in policy ? policy.agentPersonaInstructions : "",
        definition.instructions,
      );
      const error = yield* launches
        .launch({
          ...input,
          commandId: CommandId.make("command:imported-persona:missing"),
          threadId: ThreadId.make("thread:imported-persona:missing"),
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ThreadLaunchError");
      assert.equal(
        error._tag === "ThreadLaunchError" ? error.operation : undefined,
        "resolve-agent-persona",
      );
      assert.include(error.message, "Unknown persona");
    }).pipe(
      Effect.provide(
        harness.layer.pipe(Layer.provideMerge(environment), Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  },
);

it.effect(
  "launches a full-access persona unrestricted, replays it after the source is removed, and round-trips its export",
  () => {
    const definition = {
      ...BUILT_IN_AGENT_PERSONAS.scout,
      id: "unrestricted-builder",
      displayName: "Unrestricted Builder",
      version: 1,
      authority: {
        defaultPolicy: "full-access",
        allowedPolicies: ["full-access"],
      } as const,
    };
    const harness = makeHarness({
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-05T00:00:00.000Z",
          availability: "available",
          slashCommands: [],
          skills: [],
          models: [
            {
              slug: definition.modelRoute[0].model,
              name: "Research model",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const environment = ServerConfig.layerTest("/repo", { prefix: "j5-persona-full-access-" });
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(config.stateDir, "personas");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "builder.yaml"), yamlPersonaFixture(definition));
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = {
        ...launchInput({ command: "command:full-access", thread: "thread:full-access" }),
        agentPersona: { personaId: definition.id },
      };
      const launched = yield* launches.launch(input);
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.agentPersonaAssignment?.authorityPolicy, "full-access");
      const library = yield* makeAgentPersonaLibrary;
      // The effective provider policy comes from the persona snapshot, not the stored thread mode.
      const policy = yield* resolveAgentPersonaRuntime(
        { ...projection.thread, runtimeMode: "approval-required" },
        library,
      );
      assert.equal(policy.runtimeMode, "full-access");
      assert.notProperty(policy, "sandboxPolicy");
      assert.notProperty(policy, "approvalPolicy");

      // Export and re-import keep the policy.
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yamlPersonaFixture(definition) }],
        replaceExisting: true,
      });
      const exported = yield* library.read(definition.id);
      assert.deepEqual(exported.authority, definition.authority);
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yamlPersonaFixture(exported) }],
        replaceExisting: true,
      });
      assert.deepEqual((yield* library.read(definition.id)).authority, definition.authority);

      // Replay after the source disappears still resolves the persisted snapshot.
      yield* library.removeImported(definition.id);
      yield* fs.remove(folder, { recursive: true });
      assert.equal((yield* launches.launch(input)).threadId, launched.threadId);
      const replayed = yield* resolveAgentPersonaRuntime(projection.thread, library);
      assert.equal(replayed.runtimeMode, "full-access");
      assert.notProperty(replayed, "sandboxPolicy");
    }).pipe(
      Effect.provide(
        harness.layer.pipe(Layer.provideMerge(environment), Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  },
);

it.effect("releases claimed uploads when persona resolution refuses a launch", () => {
  const harness = makeHarness({ providers: [] });
  const environment = ServerConfig.layerTest("/repo", { prefix: "j5-persona-intake-" });
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const id = ChatAttachmentId.make(createPendingAttachmentId());
    const pendingName = `${id}.png`;
    yield* fs.writeFile(path.join(config.attachmentsDir, pendingName), new Uint8Array([1, 2, 3]));
    const before = yield* fs.readDirectory(config.attachmentsDir);
    const error = yield* ThreadMessageIntake.launchThread({
      ...launchInput({ command: "command:blocked-upload", thread: "thread-blocked-upload" }),
      agentPersona: { personaId: "scout" },
      initialMessage: {
        messageId: MessageId.make("blocked-upload-message"),
        text: "Inspect this image",
        attachments: [
          { type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 },
        ],
      },
    }).pipe(Effect.flip);
    assert.instanceOf(error, ThreadLaunch.ThreadLaunchError);
    if (!isThreadLaunchError(error)) return;
    assert.equal(error.operation, "resolve-agent-persona");
    assert.deepStrictEqual(
      (yield* fs.readDirectory(config.attachmentsDir)).toSorted(),
      before.toSorted(),
    );
    assert.deepStrictEqual(
      yield* fs.readFile(path.join(config.attachmentsDir, pendingName)),
      new Uint8Array([1, 2, 3]),
    );
  }).pipe(
    Effect.provide(
      harness.layer.pipe(
        Layer.provideMerge(environment),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(noDocumentTextLayer),
      ),
    ),
    Effect.scoped,
  );
});
