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

import { layerFromProjectStore, RuntimePolicyV2 } from "../../orchestration-v2/RuntimePolicy.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1 } from "./agentPersonaPrompts.ts";

// Mirrors the fixtures in orchestration-v2/RuntimePolicy.test.ts (FORK.md).
const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const TestLayer = layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Effect.undefined,
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId,
          title: "Project",
          workspaceRoot: "/project-root",
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
);

it.layer(TestLayer)("agent persona runtime policy", (it) => {
  it.effect("lets durable persona authority override the thread runtime mode", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = {
        ...makeThread({ now, worktreePath: "/project-worktree" }),
        agentPersonaAssignment: {
          personaId: "critic",
          definitionVersion: 1,
          authorityPolicy: "critic-review",
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: modelSelection,
        },
      } satisfies OrchestrationV2AppThread;
      const resolved = yield* policy.resolve({ thread, modelSelection });

      assert.deepEqual(resolved, {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/project-worktree",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      });
    }),
  );

  it.effect("degrades an unsafe historical persona assignment to read-only", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = {
        ...makeThread({ now, worktreePath: "/project-worktree" }),
        agentPersonaAssignment: {
          personaId: "publisher",
          definitionVersion: 1,
          authorityPolicy: "publish-only",
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: modelSelection,
        },
      } satisfies OrchestrationV2AppThread;
      const resolved = yield* policy.resolve({ thread, modelSelection });

      assert.equal(resolved.runtimeMode, "approval-required");
      assert.equal(resolved.approvalPolicy, "never");
      assert.deepEqual(resolved.sandboxPolicy, {
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: false,
      });
    }),
  );

  it.effect("refuses a stored policy this server does not know instead of running another", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = {
        ...makeThread({ now, worktreePath: "/project-worktree" }),
        agentPersonaAssignment: {
          personaId: "scout",
          definitionVersion: 1,
          authorityPolicy: "sandboxed-network",
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: modelSelection,
        },
      } satisfies OrchestrationV2AppThread;

      const error = yield* Effect.flip(policy.resolve({ thread, modelSelection }));

      assert.include(String(error.cause), "sandboxed-network is not supported");
    }),
  );

  it.effect("adds the versioned Builder instructions to its runtime policy", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = {
        ...makeThread({ now, worktreePath: "/project-worktree" }),
        agentPersonaAssignment: {
          personaId: "builder",
          definitionVersion: 1,
          authorityPolicy: "workspace-write",
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: modelSelection,
        },
      } satisfies OrchestrationV2AppThread;

      const resolved = yield* policy.resolve({ thread, modelSelection });

      assert.equal(resolved.agentPersonaInstructions, BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1);
    }),
  );

  it.effect("runs a full-access persona unrestricted regardless of the thread runtime mode", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = {
        ...makeThread({ now, worktreePath: "/project-worktree" }),
        runtimeMode: "approval-required",
        agentPersonaAssignment: {
          personaId: "builder",
          definitionVersion: 1,
          authorityPolicy: "full-access",
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: modelSelection,
        },
      } satisfies OrchestrationV2AppThread;

      const resolved = yield* policy.resolve({ thread, modelSelection });

      assert.equal(resolved.runtimeMode, "full-access");
      assert.isUndefined(resolved.approvalPolicy);
      assert.isUndefined(resolved.sandboxPolicy);
    }),
  );
});
