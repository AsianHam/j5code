import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { isNativeMaintenanceCommand } from "../../orchestration-v2/CommandPolicy.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import { humanPersonRegistryLayer } from "../a2a/HumanPersonRegistry.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import * as PersonAccess from "./PersonAccess.ts";
import * as SharedConversation from "./SharedConversation.ts";
import * as SharedThreads from "./SharedThreads.ts";
import { quietAccessLayer } from "./test-support/conversationHarness.ts";

/**
 * A shared conversation over upstream's real orchestrator and its real projections, with no
 * provider running: a run that starts stays active, so what is sent after it queues. The other
 * tests stand in for upstream and write its rows by hand; this one fails if upstream reshapes
 * what J5 reads from it by SQL: a run's `status` and the `userMessageId` and `startedAt` in its
 * payload, a message's `run_id` and `role`, and the event log's `command_id`, `aggregate_kind`,
 * `stream_id`, `event_type` and the `id` in its payload.
 */

const threadId = ThreadId.make("thread:shared-live");

const layerFor = (harness: ReturnType<typeof makeHarness>) =>
  SharedConversation.layer.pipe(
    Layer.provideMerge(SharedThreads.layer),
    Layer.provide(quietAccessLayer),
    Layer.provideMerge(PersonAccess.layer),
    Layer.provideMerge(humanPersonRegistryLayer),
    Layer.provideMerge(harness.layer),
  );

let counter = 0;
const message = (text: string, on = threadId) => {
  counter += 1;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`command:live:${counter}`),
    threadId: on,
    messageId: MessageId.make(`message:live:${counter}`),
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    // What upstream's client sends for an ordinary send.
    deliveryIntent: "auto",
    dispatchMode: { type: "start_immediately" },
  } as const satisfies OrchestrationV2Command;
};

/** What `ws.ts` does with a client's command: J5 takes it in, then upstream dispatches it. */
const send = Effect.fn("test.send")(function* (
  personId: ParticipantId,
  command: OrchestrationV2Command,
) {
  const conversation = yield* SharedConversation.SharedConversation;
  const admitted = yield* conversation.admit(personId, command);
  yield* (yield* ThreadManagementService).dispatch(admitted);
  return admitted;
});

const runs = (on: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly status: string;
      readonly message_id: string | null;
      readonly started_at: string | null;
    }>`
      SELECT status, json_extract(payload_json, '$.userMessageId') AS message_id,
        json_extract(payload_json, '$.startedAt') AS started_at
      FROM orchestration_v2_projection_runs
      WHERE thread_id = ${on}
      ORDER BY ordinal
    `;
  });

const storedText = (on: ThreadId, messageId: string) =>
  ThreadManagementService.use((threads) => threads.getThreadProjection(on)).pipe(
    Effect.map((projection) => projection.messages.find((entry) => entry.id === messageId)?.text),
  );

it.effect(
  "a person's message is named, noted, queued and withdrawn on upstream's own records",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const conversation = yield* SharedConversation.SharedConversation;
      const threads = yield* ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      yield* threads.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:live:create"),
        threadId,
        projectId,
        title: "Shared",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const owner = (yield* people.firstOwner).personId;
      yield* people.setName({ personId: owner, displayName: "Jackson" });

      // Before anyone else can write, the owner's message is stored exactly as typed. No provider
      // is running, so its run stays active and everything sent after it queues.
      const before = message("Let us review the plan.");
      assert.strictEqual(yield* send(owner, before), before);
      assert.strictEqual(yield* storedText(threadId, before.messageId), "Let us review the plan.");
      // Who answered a prompt is read from upstream's log by the command that settled it. No
      // prompt is raised without a provider, so this pins what that check reads on an event
      // upstream does write for this command.
      const logged = yield* sql<{ readonly event_type: string; readonly id: string | null }>`
      SELECT event_type, json_extract(payload_json, '$.id') AS id FROM orchestration_events
      WHERE command_id = ${before.commandId}
        AND aggregate_kind = 'thread'
        AND stream_id = ${threadId}
    `;
      assert.isTrue(
        logged.some(
          (event) => event.event_type === "message.updated" && event.id === before.messageId,
        ),
        JSON.stringify(logged),
      );

      const priya = yield* people.createPerson({ displayName: "Priya" });
      const scope = { kind: "thread" as const, threadId };
      yield* people.setLevel({ personId: priya.personId, scope, level: "collaborator" });

      // Her first message carries the note at the top, ahead of her line; the earlier message, a
      // user message in upstream's records, is named as the owner's.
      const carrier = message("What does the plan change?");
      yield* send(priya.personId, carrier);
      const carried = (yield* conversation.threadAuthors(owner, threadId)).authors.find(
        (author) => author.messageId === carrier.messageId,
      )!;
      assert.include(carried.note, "carry no such line: Jackson (owner) wrote them.");
      assert.strictEqual(
        yield* storedText(threadId, carrier.messageId),
        `${carried.storedPrefix}What does the plan change?`,
      );
      assert.isTrue(carried.storedPrefix.endsWith("\n[Message from Priya (collaborator)]\n\n"));
      // It queued behind the owner's run.
      assert.deepStrictEqual(
        (yield* runs(threadId)).map((run) => [run.message_id, run.status === "queued"]),
        [
          [before.messageId, false],
          [carrier.messageId, true],
        ],
      );

      // The carrier still waits, so the next message carries the note too.
      const second = message("And what does it cost?");
      yield* send(owner, second);
      assert.strictEqual(
        yield* storedText(threadId, second.messageId),
        `${carried.note}\n[Message from Jackson (owner)]\n\nAnd what does it cost?`,
      );

      // Edited by the owner while it waits, with the platform's text sent back, it keeps her line.
      const carrierRun = (yield* threads.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === carrier.messageId,
      )!;
      yield* send(owner, {
        type: "queued-run.edit",
        commandId: CommandId.make("command:live:edit"),
        threadId,
        runId: carrierRun.id,
        text: `${(yield* storedText(threadId, carrier.messageId))!} Exactly.`,
      });
      assert.strictEqual(
        yield* storedText(threadId, carrier.messageId),
        `${carried.note}\n[Message from Priya (collaborator), edited by Jackson (owner)]\n\nWhat does the plan change? Exactly.`,
      );

      // Lowered to Viewer: her queued run is withdrawn through upstream's own cancel and never
      // started. The owner's stays queued.
      yield* people.setLevel({ personId: priya.personId, scope, level: "viewer" });
      yield* conversation.withdrawQueued(priya.personId);
      const after = yield* runs(threadId);
      const withdrawn = after.find((run) => run.message_id === carrier.messageId)!;
      assert.strictEqual(withdrawn.status, "cancelled");
      assert.isNull(withdrawn.started_at);
      assert.deepStrictEqual(
        after.filter((run) => run.status === "queued").map((run) => run.message_id),
        [second.messageId],
      );
    }).pipe(Effect.provide(layerFor(harness)));
  },
);

it.effect(
  "a thread started in a shared project is shared from its first message, and a command still is one",
  () => {
    const harness = makeHarness();
    const on = ThreadId.make("thread:shared-born");
    return Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const conversation = yield* SharedConversation.SharedConversation;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const owner = (yield* people.firstOwner).personId;
      yield* people.setName({ personId: owner, displayName: "Jackson" });
      const priya = yield* people.createPerson({ displayName: "Priya" });
      yield* people.setLevel({
        personId: priya.personId,
        scope: { kind: "project", projectId },
        level: "collaborator",
      });

      // A new thread's first message comes in upstream's launch request, not as a command, and
      // the thread has no record yet when it is taken in.
      const launch = {
        commandId: CommandId.make("command:live:launch"),
        threadId: on,
        projectId,
        title: "Review the plan",
        generateTitle: true,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("message:live:launch"),
          text: "Let us review the plan.",
          attachments: [],
        },
      } as const satisfies OrchestrationV2ThreadLaunchInput;
      const admitted = yield* conversation.admitLaunch(owner, launch);
      yield* launches.launch({
        ...launch,
        initialMessage: { ...launch.initialMessage, text: admitted.initialMessage!.text },
        createdBy: "user",
        creationSource: "web",
      });
      const first = yield* storedText(on, launch.initialMessage.messageId);
      assert.include(first, "Who can write: Jackson (owner), Priya (collaborator).");
      assert.isTrue(first?.endsWith("\n[Message from Jackson (owner)]\n\nLet us review the plan."));

      // Her `/compact` goes on as typed, so upstream takes it for the command it is (AC5).
      const compact = message("/compact", on);
      yield* send(priya.personId, compact);
      const compactText = yield* storedText(on, compact.messageId);
      assert.strictEqual(compactText, "/compact");
      assert.isTrue(isNativeMaintenanceCommand({ text: compactText!, attachments: [] }));
    }).pipe(Effect.provide(layerFor(harness)));
  },
);
