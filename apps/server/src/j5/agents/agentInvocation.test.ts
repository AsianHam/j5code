import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  EventId,
  type ServerProvider,
  OrchestrationV2PublicCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { stringify as yaml } from "yaml";
import { ServerConfig } from "../../config.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService, resolveRuntimeMode } from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { InvokeAgentInput, invokeAgent } from "./agentInvocation.ts";
import { makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";
import { validateAgentPersonaSubagent } from "./agentPersonaSubagent.ts";

const definition = {
  ...BUILT_IN_AGENT_PERSONAS.scout,
  id: "team-researcher",
  displayName: "Team Researcher",
  instructions: "Return cited evidence from the workspace.",
};
const definitionYaml = yaml(definition);
const isPublicCommand = Schema.is(OrchestrationV2PublicCommand);
const decodeInvokeAgentInput = Schema.decodeUnknownSync(InvokeAgentInput);
const providers: ServerProvider[] = definition.modelRoute.map((target) => ({
  instanceId: ProviderInstanceId.make(target.driver),
  driver: ProviderDriverKind.make(target.driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-08T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: target.model,
      name: target.model,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: target.driver === "codex" ? "reasoningEffort" : "effort",
            label: "Reasoning",
            type: "select",
            options: [{ id: target.reasoningEffort, label: "High" }],
          },
        ],
      },
    },
  ],
}));
const fixture = Effect.gen(function* () {
  const library = yield* makeAgentPersonaLibrary;
  yield* library.importFiles({
    files: [{ name: "agent.yaml", content: definitionYaml }],
    replaceExisting: false,
  });
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("parent");
  const parent = {
    ...emptyProjection({
      id: EventId.make("created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: ProjectId.make("project"),
        createdBy: "user",
        creationSource: "web",
        title: "Parent",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "parent-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    }),
  };
  const calls: Array<Parameters<OrchestratorMcpService["Service"]["delegateTask"]>[1]> = [];
  const invoke = (id = definition.id, available = providers, driver = "codex", authorized = true) =>
    invokeAgent({ personaId: id, task: "Review the API", clientRequestId: "request" }).pipe(
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("remote"),
        requestNamespace: "session",
        thread: {
          threadId,
          providerInstanceId: ProviderInstanceId.make(driver),
          providerSessionId: "session",
        },
        client: undefined,
        capabilities: new Set(authorized ? ["orchestration" as const] : []),
        issuedAt: 1,
      }),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(parent),
          }),
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(available) }),
          Layer.mock(OrchestratorMcpService)({
            delegateTask: (_, input) =>
              // The real delegation guard compares the request with the parent's stored mode.
              resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode).pipe(
                Effect.andThen(() => {
                  calls.push(input);
                  return Effect.succeed({
                    taskId: NodeId.make("child-task"),
                    childThreadId: ThreadId.make("child"),
                    childRunId: null,
                    childNodeId: NodeId.make("child-node"),
                    status: "running" as const,
                    workState: "working" as const,
                    hasPendingChildRuns: true,
                    hasPendingQuestion: false,
                    pendingApproval: null,
                    latestTerminalRunId: null,
                    latestTerminalStatus: null,
                    latestTerminalSummary: null,
                    latestTerminalResultContextTransferId: null,
                    providerInstanceId: input.target!.providerInstanceId!,
                    model: input.target!.model!,
                    summary: null,
                    resultContextTransferId: null,
                    waitTimedOut: false,
                  });
                }),
              ),
          }),
        ),
      ),
      Effect.exit,
    );
  return { library, parent, calls, invoke };
});
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "j5-agent-invocation-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("saved agent subagent invocation", () => {
  it.effect(
    "resolves the same saved agent from Codex and Claude and preserves its snapshot after removal",
    () =>
      Effect.gen(function* () {
        const { library, calls, invoke, parent } = yield* fixture;
        yield* invoke();
        yield* invoke(definition.id, providers, "claudeAgent");
        assert.lengthOf(calls, 2);
        assert.deepEqual(calls[0]?.target, calls[1]?.target);
        const assignment = calls[0]!.agentPersonaAssignment!;
        assert.equal(assignment.displayName, "Team Researcher");
        assert.equal(calls[0]?.target?.model, definition.modelRoute[0].model);
        assert.equal(calls[0]?.runtimeMode, "approval-required");
        yield* validateAgentPersonaSubagent(
          { agentPersonaAssignment: assignment, modelSelection: assignment.resolvedModelSelection },
          library,
          "codex",
        );
        yield* library.removeAgent(definition.id);
        const runtime = yield* resolveAgentPersonaRuntime(
          { ...parent.thread, agentPersonaAssignment: assignment },
          library,
        );
        assert.isTrue("agentPersonaInstructions" in runtime);
        if ("agentPersonaInstructions" in runtime)
          assert.include(runtime.agentPersonaInstructions!, definition.instructions);
        const mismatch = yield* validateAgentPersonaSubagent(
          {
            agentPersonaAssignment: assignment,
            modelSelection: { ...assignment.resolvedModelSelection, model: "different" },
          },
          library,
          "codex",
        ).pipe(Effect.flip);
        assert.include(mismatch.message, "must match");
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("uses the declared fallback provider when the primary is unavailable", () =>
    Effect.gen(function* () {
      const { calls, invoke } = yield* fixture;
      yield* invoke(definition.id, providers.slice(1));
      assert.equal(calls[0]?.agentPersonaAssignment?.resolvedDriver, "claudeAgent");
      assert.equal(calls[0]?.agentPersonaAssignment?.resolvedRoute, "fallback");
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "does not delegate disabled, removed, unknown, unavailable or unauthorized agents",
    () =>
      Effect.gen(function* () {
        const { library, calls, invoke } = yield* fixture;
        yield* invoke("unknown-agent");
        yield* invoke(definition.id, []);
        yield* invoke(definition.id, providers, "codex", false);
        yield* library.setImportedEnabled(definition.id, false);
        yield* invoke();
        yield* library.removeAgent(definition.id);
        yield* invoke();
        assert.lengthOf(calls, 0);
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("does not broaden a saved read-only parent's permissions", () =>
    Effect.gen(function* () {
      const { library, calls, invoke, parent } = yield* fixture;
      yield* invoke();
      parent.thread = {
        ...parent.thread,
        agentPersonaAssignment: calls[0]!.agentPersonaAssignment!,
      };
      const writer = {
        ...definition,
        id: "team-writer",
        authority: { defaultPolicy: "workspace-write", allowedPolicies: ["workspace-write"] },
      };
      const content = yaml(writer);
      yield* library.importFiles({
        files: [{ name: "writer.yaml", content }],
        replaceExisting: false,
      });
      calls.length = 0;
      yield* invoke("team-writer");
      assert.lengthOf(calls, 0);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "judges delegation by the parent's effective persona permissions and runs the child unrestricted",
    () =>
      Effect.gen(function* () {
        const { library, calls, invoke, parent } = yield* fixture;
        const unrestricted = {
          ...definition,
          id: "team-operator",
          authority: { defaultPolicy: "full-access", allowedPolicies: ["full-access"] },
        };
        yield* library.importFiles({
          files: [
            { name: "operator.yaml", content: yaml(unrestricted) },
            {
              name: "writer.yaml",
              content: yaml({
                ...definition,
                id: "team-writer",
                authority: {
                  defaultPolicy: "workspace-write",
                  allowedPolicies: ["workspace-write"],
                },
              }),
            },
          ],
          replaceExisting: false,
        });
        const effective = (call: (typeof calls)[number]) =>
          resolveAgentPersonaRuntime(
            {
              agentPersonaAssignment: call.agentPersonaAssignment!,
              runtimeMode: parent.thread.runtimeMode,
            },
            library,
          );

        // A plain full-access parent delegates it directly.
        yield* invoke("team-operator");
        assert.lengthOf(calls, 1);
        assert.equal(calls[0]?.runtimeMode, "full-access");
        const child = calls[0]!;
        const childPolicy = yield* effective(child);
        assert.equal(childPolicy.runtimeMode, "full-access");
        assert.notProperty(childPolicy, "sandboxPolicy");
        assert.notProperty(childPolicy, "approvalPolicy");

        // A full-access persona parent whose stored thread mode is narrower (a composer launch)
        // may still delegate; the child inherits the stored mode but runs on its snapshot.
        for (const runtimeMode of ["approval-required", "auto-accept-edits"] as const) {
          parent.thread = {
            ...parent.thread,
            runtimeMode,
            agentPersonaAssignment: child.agentPersonaAssignment,
          };
          yield* invoke("team-operator");
          const delegated = calls.at(-1)!;
          assert.equal(delegated.runtimeMode, "inherit");
          const inherited = yield* effective(delegated);
          assert.equal(inherited.runtimeMode, "full-access");
          assert.notProperty(inherited, "sandboxPolicy");
          assert.notProperty(inherited, "approvalPolicy");
        }
        assert.lengthOf(calls, 3);

        // A workspace-write persona parent may not delegate broader access, even when its
        // stored thread mode (the composer's) is full-access.
        yield* invoke("team-writer");
        const writer = calls.pop()!;
        parent.thread = {
          ...parent.thread,
          runtimeMode: "full-access",
          agentPersonaAssignment: writer.agentPersonaAssignment,
        };
        calls.length = 0;
        assert.isTrue((yield* invoke("team-operator"))._tag === "Failure");
        assert.lengthOf(calls, 0);

        // Nor may a read-only persona parent.
        yield* invoke();
        parent.thread = {
          ...parent.thread,
          agentPersonaAssignment: calls.pop()!.agentPersonaAssignment,
        };
        assert.isTrue((yield* invoke("team-operator"))._tag === "Failure");
        assert.lengthOf(calls, 0);
      }).pipe(Effect.provide(testLayer)),
  );
  it("drops a caller-provided runtime mode before delegating", () => {
    const decoded = decodeInvokeAgentInput({
      personaId: "team-operator",
      task: "x",
      clientRequestId: "r",
      runtimeMode: "full-access",
    });
    assert.notProperty(decoded, "runtimeMode");
  });
  it.effect("rejects a forged child assignment on the public command boundary", () =>
    Effect.gen(function* () {
      const { calls, invoke } = yield* fixture;
      yield* invoke();
      assert.isFalse(
        isPublicCommand({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: "request",
          parentThreadId: "parent",
          parentRunId: "run",
          parentNodeId: "node",
          task: "Review",
          modelSelection: calls[0]!.agentPersonaAssignment!.resolvedModelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          agentPersonaAssignment: calls[0]!.agentPersonaAssignment,
        }),
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
