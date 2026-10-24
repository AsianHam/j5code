import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import {
  McpInvocationContext,
  type McpInvocationScope,
} from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import {
  J5OrchestratorSurface,
  J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION,
} from "./orchestratorSurface.ts";
import * as J5OrchestratorSurfaceHandlers from "./orchestratorSurfaceHandlers.ts";

const threadId = ThreadId.make("thread:j5:orchestrator-surface");
const providerInstanceId = ProviderInstanceId.make("codex-j5-orchestrator-surface");
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:j5:orchestrator-surface"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
  requestNamespace: "provider-session:j5:orchestrator-surface",
  thread: {
    threadId,
    providerSessionId: "provider-session:j5:orchestrator-surface",
    providerInstanceId,
  },
  client: undefined,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "j5-orchestrator-surface-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "j5-orchestrator-surface-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const rawCapabilities = {
  parentThreadId: threadId,
  inheritedProviderInstanceId: providerInstanceId,
  inheritedModel: "gpt-5.6-sol",
  inheritedOptions: [{ id: "effort", value: "xhigh" }],
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  providers: [
    {
      providerInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      models: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          options: [{ id: "effort", values: ["high", "xhigh"], default: "high" }],
        },
      ],
      omittedModels: 3,
      runtimeModes: ["approval-required", "full-access"] as const,
      canRunChildTask: false,
      canRunCrossProviderChildTask: false,
      constraints: ["Provider authentication is required."],
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
    maxBatchThreads: 20,
  },
};

const searches: Array<string | undefined> = [];

const TestLayer = McpHttpServer.toolkitRegistration(
  J5OrchestratorSurface,
  J5OrchestratorSurfaceHandlers.layer,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(OrchestratorMcpService)({
        capabilities: (_scope, input) => {
          searches.push(input?.search);
          return Effect.succeed(rawCapabilities);
        },
      }),
      Layer.mock(ThreadManagementService)({}),
      Layer.mock(ProviderRegistry)({}),
    ),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
);

const hasKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (typeof value !== "object" || value === null) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKey(item, key));
};

it.effect("registers the two orchestrator tools J5 declares, with a factual description", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
      "delegate_task",
      "orchestrator_capabilities",
    ]);

    const description = server.tools.find(({ tool }) => tool.name === "orchestrator_capabilities")
      ?.tool.description;
    expect(description).toBe(J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION);
    // J5 hides upstream's launch tool, so its capabilities text must not point at it.
    expect(description).not.toContain("t3_thread_launch");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("maps capabilities without inherited model or delegation claims", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    searches.length = 0;
    const result = yield* server
      .callTool({ name: "orchestrator_capabilities", arguments: { search: "sonnet 4.6" } })
      .pipe(
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(searches).toEqual(["sonnet 4.6"]);
    expect(result.structuredContent).toEqual({
      parentThreadId: threadId,
      // J5's instructions send same-model children through delegate_task when this is nonempty.
      inheritedOptions: [{ id: "effort", value: "xhigh" }],
      runtimeMode: "full-access",
      interactionMode: "default",
      providers: [
        {
          providerInstanceId,
          driverKind: "codex",
          displayName: "Codex",
          models: rawCapabilities.providers[0]!.models,
          omittedModels: 3,
          // Delegation refuses a runtime mode the provider does not list, so the caller sees them.
          runtimeModes: ["approval-required", "full-access"],
          constraints: ["Provider authentication is required."],
        },
      ],
      features: {
        incrementalThreadRead: true,
        scheduledTasks: true,
      },
    });

    for (const excluded of [
      "inheritedProviderInstanceId",
      "inheritedModel",
      "canRunChildTask",
      "canRunCrossProviderChildTask",
      "appOwnedSubagents",
      "asyncPolling",
      "cancellation",
      "threadManagement",
    ]) {
      expect(hasKey(result.structuredContent, excluded)).toBe(false);
    }
  }).pipe(Effect.provide(TestLayer)),
);
