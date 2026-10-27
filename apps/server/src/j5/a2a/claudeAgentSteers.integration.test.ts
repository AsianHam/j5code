import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";

// Case 84 through the real Claude adapter and orchestrator, with a scripted Claude Code stream.

const sessionId = "agent-steer-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

const frame = (value: unknown) => value as SDKMessage;
const assistant = (uuid: string, content: ReadonlyArray<unknown>) =>
  frame({
    type: "assistant",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `message-${uuid}`,
      role: "assistant",
      type: "message",
      model: modelSelection.model,
      content,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
const build = assistant("build-call", [
  { type: "tool_use", id: "build", name: "Bash", input: { command: "make" } },
]);
const buildResult = frame({
  type: "user",
  uuid: "build-result",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "build", is_error: false, content: "build OK" }],
  },
});
const result = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });
const lifecycle = (commandUuid: string, state: string) =>
  frame({
    type: "command_lifecycle",
    command_uuid: commandUuid,
    state,
    uuid: `lifecycle-${state}-${commandUuid}`,
    session_id: sessionId,
  });

it.effect.each([
  { case: "an agent's steer joins the turn at the next tool result", steer: "agent-mid" },
  { case: "an agent's late steer keeps the turn open for its own result", steer: "agent-late" },
  { case: "a person's Stop ends a turn held open for a late steer", steer: "agent-stopped" },
  { case: "a person's steer still uses now", steer: "person" },
] as const)("$case", ({ steer }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("j5-claude-agent-steers");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const offers: SDKUserMessage[] = [];
      let interrupts = 0;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          open: () =>
            Effect.succeed({
              messages: Stream.fromQueue(sdkMessages),
              offer: (message) => Effect.sync(() => void offers.push(message)),
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.sync(() => void interrupts++),
              close: Queue.shutdown(sdkMessages),
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:j5-agent-steer");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:j5-agent-steer"),
          title: "Agent steer",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Run the build.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const building = yield* watch(
          (event) =>
            event.type === "turn-item.updated" && event.payload.nativeItemRef?.nativeId === "build",
        );
        yield* Queue.offer(sdkMessages, build);
        yield* Fiber.join(building);
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("steer"),
          text: "Also update the changelog.",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: parent.id },
          createdBy: steer === "person" ? "user" : "agent",
          creationSource: steer === "person" ? "web" : "server",
        });
        yield* worker.drain();
        assert.lengthOf(offers, 2);
        const offered = offers[1]!;
        if (steer === "person") {
          assert.equal(offered.priority, "now");
          assert.isUndefined(offered.uuid);
          return;
        }
        assert.equal(offered.priority, "next");
        const steerUuid = offered.uuid ?? assert.fail("An agent's steer has a uuid.");

        if (steer === "agent-stopped") {
          const stopped = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === parent.id &&
              event.payload.status === "interrupted",
          );
          // A frame after the held result, so the result is known to be processed first.
          const held = yield* watch(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.nativeItemRef?.nativeId === "held",
          );
          yield* Queue.offer(sdkMessages, lifecycle(steerUuid, "queued"));
          yield* Queue.offer(sdkMessages, buildResult);
          yield* Queue.offer(sdkMessages, result("first-segment"));
          yield* Queue.offer(
            sdkMessages,
            assistant("held-call", [
              { type: "tool_use", id: "held", name: "Bash", input: { command: "true" } },
            ]),
          );
          yield* Fiber.join(held);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "running",
          );
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: parent.id,
          });
          yield* worker.drain();
          yield* Fiber.join(stopped);
          assert.equal(interrupts, 1);
          return;
        }

        const finished = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === parent.id &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(sdkMessages, lifecycle(steerUuid, "queued"));
        if (steer === "agent-mid") {
          yield* Queue.offer(sdkMessages, lifecycle(steerUuid, "started"));
          yield* Queue.offer(sdkMessages, buildResult);
        } else {
          yield* Queue.offer(sdkMessages, buildResult);
          yield* Queue.offer(sdkMessages, result("first-segment"));
          yield* Queue.offer(sdkMessages, lifecycle(steerUuid, "started"));
        }
        yield* Queue.offer(
          sdkMessages,
          assistant("changelog", [{ type: "text", text: "Updated the changelog too." }]),
        );
        yield* Queue.offer(sdkMessages, result("last-segment"));
        yield* Fiber.join(finished);
        yield* worker.drain();

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(after.runs, 1);
        const buildItem = after.turnItems.find((item) => item.nativeItemRef?.nativeId === "build");
        assert.equal(buildItem?.status, "completed");
        assert.isTrue(
          after.turnItems.some(
            (item) =>
              item.runId === parent.id &&
              item.type === "assistant_message" &&
              item.text === "Updated the changelog too.",
          ),
        );
        // One provider turn bills both of a late steer's segments.
        const turn = after.providerTurns.find(
          (providerTurn) => providerTurn.status === "completed",
        );
        assert.equal(turn?.turnTokenUsage?.outputTokens, steer === "agent-late" ? 2 : 1);
        assert.equal(interrupts, 0);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "j5-claude-agent-steers" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  ),
);
