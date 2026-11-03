import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for a recorded message"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "platform-message" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect(
  "a platform message joins the history without starting or queuing a run, and replays once",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:platform-message");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-platform-message"),
        threadId,
        projectId: ProjectId.make("project:platform-message"),
        title: "Member",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("assignment"),
        threadId,
        messageId: MessageId.make("message:assignment"),
        text: "Review the fix.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const before = yield* projections.getThreadProjection(threadId);
      const shellBefore = yield* projections.getThreadShell(threadId);

      const record = {
        type: "platform-message.record" as const,
        commandId: CommandId.make("record-introduction"),
        threadId,
        runId: before.runs[0]!.id,
        messageId: MessageId.make("message:introduction"),
        text: "<j5_crew_delivery_context>\nYou are on a Crew.\n</j5_crew_delivery_context>",
      };
      const first = yield* orchestrator.dispatch(record);
      assert.isUndefined(first.replayed);
      const replay = yield* orchestrator.dispatch(record);
      assert.isTrue(replay.replayed);

      const after = yield* projections.getThreadProjection(threadId);
      // The run the assignment started is the only one: nothing started, nothing queued.
      assert.deepStrictEqual(
        after.runs.map((run) => [run.id, run.status]),
        before.runs.map((run) => [run.id, run.status]),
      );
      const messages = after.messages.filter((message) => message.id === record.messageId);
      assert.lengthOf(messages, 1);
      assert.deepInclude(messages[0]!, {
        role: "user",
        createdBy: "system",
        creationSource: "server",
        runId: before.runs[0]!.id,
        text: record.text,
      });
      const items = after.turnItems
        .filter((item) => item.type === "user_message")
        .toSorted((left, right) => left.ordinal - right.ordinal);
      assert.lengthOf(items, 2);
      // It sits in the run it was told with, right after the assignment that began it.
      assert.equal(items[1]!.type === "user_message" && items[1]!.messageId, record.messageId);
      assert.equal(items[1]!.runId, before.runs[0]!.id);
      assert.isAbove(items[1]!.ordinal, items[0]!.ordinal);
      // A steer never opens a new response group, so it does not split the assignment from its work.
      assert.equal(items[1]!.type === "user_message" && items[1]!.inputIntent, "steer");

      // A system message is neither the person's activity nor pending work: the shell is as it was.
      const shellAfter = yield* projections.getThreadShell(threadId);
      assert.equal(shellAfter?.status, shellBefore?.status);
      assert.equal(shellAfter?.latestRunId, shellBefore?.latestRunId);
      assert.deepStrictEqual(
        shellAfter?.latestUserAuthoredMessageAt,
        shellBefore?.latestUserAuthoredMessageAt,
      );

      // History rebuilds read it as something the model was told in that run, never as a turn
      // it is asked to answer: no run takes it as its input.
      const history = yield* projections.getTurnStartHistory(threadId, [before.runs[0]!.id]);
      const rebuilt = history.flatMap((item) => {
        const message = historicalMessage(item);
        return message === null ? [] : [message];
      });
      assert.deepInclude(rebuilt.at(-1)!, {
        role: "user",
        kind: "user_message",
        text: record.text,
      });
      assert.isFalse(after.runs.some((run) => run.userMessageId === record.messageId));
    }).pipe(Effect.provide(layerTest)),
);
