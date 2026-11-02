import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  ProviderDriverKind,
  ProjectId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { isNativeMaintenanceCommand } from "../../orchestration-v2/CommandPolicy.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import { humanPersonRegistryLayer } from "../a2a/HumanPersonRegistry.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import * as PersonAccess from "./PersonAccess.ts";
import * as SharedConversation from "./SharedConversation.ts";
import * as SharedThreads from "./SharedThreads.ts";
import { quietAccessLayer, quietLifecycleLayer } from "./test-support/conversationHarness.ts";

/**
 * A shared conversation over upstream's real orchestrator and projections, with no provider, so
 * a started run stays active and later sends queue. It fails if upstream reshapes what J5 reads by
 * SQL: a run's `status`, payload `userMessageId`/`startedAt`; a message's `run_id`, `role`; the
 * event log's columns and payload `id`; and a command's receipt.
 */

const threadId = ThreadId.make("thread:shared-live");

const layerFor = (harness: ReturnType<typeof makeHarness>) =>
  SharedConversation.layer.pipe(
    Layer.provideMerge(SharedThreads.layer),
    Layer.provide(quietAccessLayer),
    Layer.provide(quietLifecycleLayer),
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
  const threads = yield* ThreadManagementService;
  return yield* conversation.dispatch(personId, command, (admitted) =>
    threads.dispatch(admitted).pipe(Effect.as(admitted)),
  );
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

      // A command upstream has taken has a receipt by its id: a replayed answer is told by it.
      assert.lengthOf(
        yield* sql`
          SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${before.commandId}
        `,
        1,
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
      assert.include(
        carried.note,
        "was sent before this thread was shared, when only Jackson (owner) could write here.",
      );
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
      yield* conversation.launch(owner, launch, (admitted) =>
        launches.launch({
          ...launch,
          initialMessage: { ...launch.initialMessage, text: admitted.initialMessage!.text },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      const first = yield* storedText(on, launch.initialMessage.messageId);
      assert.include(first, "Who can write: Jackson (owner), Priya (collaborator).");
      assert.isTrue(first?.endsWith("\n[Message from Jackson (owner)]\n\nLet us review the plan."));
      const recorded = (yield* conversation.threadAuthors(owner, on)).authors.find(
        (author) => author.messageId === launch.initialMessage.messageId,
      )!;
      assert.strictEqual(first, `${recorded.storedPrefix}Let us review the plan.`);

      // Her `/compact` goes on as typed, so upstream takes it for the command it is (AC5).
      const compact = message("/compact", on);
      yield* send(priya.personId, compact);
      const compactText = yield* storedText(on, compact.messageId);
      assert.strictEqual(compactText, "/compact");
      assert.isTrue(isNativeMaintenanceCommand({ text: compactText!, attachments: [] }));
    }).pipe(Effect.provide(layerFor(harness)));
  },
);

it.effect("an edit upstream refuses leaves its message's record as it was", () => {
  const harness = makeHarness();
  const on = ThreadId.make("thread:shared-refused-edit");
  return Effect.gen(function* () {
    const people = yield* PersonAccess.PersonAccess;
    const conversation = yield* SharedConversation.SharedConversation;
    const threads = yield* ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:refused-edit:create"),
      threadId: on,
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
    const priya = yield* people.createPerson({ displayName: "Priya" });
    yield* people.setLevel({
      personId: priya.personId,
      scope: { kind: "thread", threadId: on },
      level: "collaborator",
    });
    // The first run stays active with no provider, so both of hers queue behind it.
    yield* send(owner, message("Let us review the plan.", on));
    const refusedMessage = message("Keep the migration step.", on);
    const acceptedMessage = message("Ship Friday.", on);
    yield* send(priya.personId, refusedMessage);
    yield* send(priya.personId, acceptedMessage);
    const recordOf = (messageId: string) =>
      conversation
        .threadAuthors(owner, on)
        .pipe(
          Effect.map((authors) => authors.authors.find((entry) => entry.messageId === messageId)!),
        );
    const runOf = (messageId: string) =>
      threads
        .getThreadProjection(on)
        .pipe(
          Effect.map(
            (projection) => projection.runs.find((run) => run.userMessageId === messageId)!.id,
          ),
        );
    const before = yield* recordOf(refusedMessage.messageId);
    const beforeText = yield* storedText(on, refusedMessage.messageId);

    // Its run leaves the queue before the owner's edit lands, so upstream refuses the edit.
    yield* threads.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("command:refused-edit:cancel"),
      threadId: on,
      runId: yield* runOf(refusedMessage.messageId),
    });
    const refusal = yield* send(owner, {
      type: "queued-run.edit",
      commandId: CommandId.make("command:refused-edit:edit"),
      threadId: on,
      runId: yield* runOf(refusedMessage.messageId),
      text: "Drop the migration step.",
    }).pipe(Effect.flip);
    assert.strictEqual(refusal._tag, "OrchestratorCommandRejectedError");
    assert.strictEqual(yield* storedText(on, refusedMessage.messageId), beforeText);
    const after = yield* recordOf(refusedMessage.messageId);
    assert.isNull(after.editedBy);
    assert.strictEqual(after.storedPrefix, before.storedPrefix);
    assert.deepStrictEqual(after, before);

    // An edit upstream takes is recorded.
    yield* send(owner, {
      type: "queued-run.edit",
      commandId: CommandId.make("command:accepted-edit:edit"),
      threadId: on,
      runId: yield* runOf(acceptedMessage.messageId),
      text: "Ship Monday.",
    });
    const accepted = yield* recordOf(acceptedMessage.messageId);
    assert.strictEqual(accepted.editedBy, "Jackson");
    assert.strictEqual(
      yield* storedText(on, acceptedMessage.messageId),
      `${accepted.storedPrefix}Ship Monday.`,
    );
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("an edit's record is written only while the stored text is the edit's own", () => {
  const harness = makeHarness();
  const on = ThreadId.make("thread:shared-edit-race");
  return Effect.gen(function* () {
    const people = yield* PersonAccess.PersonAccess;
    const conversation = yield* SharedConversation.SharedConversation;
    const threads = yield* ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:edit-race:create"),
      threadId: on,
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
    const scope = { kind: "thread" as const, threadId: on };
    const priya = (yield* people.createPerson({ displayName: "Priya" })).personId;
    const sam = (yield* people.createPerson({ displayName: "Sam" })).personId;
    yield* people.setLevel({ personId: priya, scope, level: "collaborator" });
    yield* people.setLevel({ personId: sam, scope, level: "collaborator" });
    yield* send(owner, message("Let us review the plan.", on));
    const replayed = message("Ship Friday.", on);
    const raced = message("Keep the migration step.", on);
    yield* send(priya, replayed);
    yield* send(priya, raced);
    const runOf = (messageId: string) =>
      threads
        .getThreadProjection(on)
        .pipe(
          Effect.map(
            (projection) => projection.runs.find((run) => run.userMessageId === messageId)!.id,
          ),
        );
    const edit = (commandId: string, messageId: string, text: string) =>
      runOf(messageId).pipe(
        Effect.map(
          (runId) =>
            ({
              type: "queued-run.edit",
              commandId: CommandId.make(commandId),
              threadId: on,
              runId,
              text,
            }) as const satisfies OrchestrationV2Command,
        ),
      );
    const recordOf = (messageId: string) =>
      conversation
        .threadAuthors(owner, on)
        .pipe(
          Effect.map((authors) => authors.authors.find((entry) => entry.messageId === messageId)!),
        );

    // Jackson edits, Sam edits after him, and Jackson's client retries his command: upstream
    // replays its receipt and leaves Sam's text, so the record stays Sam's.
    const jacksons = yield* edit("command:edit-race:jackson", replayed.messageId, "Ship Monday.");
    yield* send(owner, jacksons);
    yield* send(sam, yield* edit("command:edit-race:sam", replayed.messageId, "Ship Tuesday."));
    const samsRecord = yield* recordOf(replayed.messageId);
    assert.strictEqual(samsRecord.editedBy, "Sam");
    yield* send(owner, jacksons);
    assert.deepStrictEqual(yield* recordOf(replayed.messageId), samsRecord);
    assert.strictEqual(
      yield* storedText(on, replayed.messageId),
      `${samsRecord.storedPrefix}Ship Tuesday.`,
    );

    // Sam's edit is taken and recorded after Jackson's commits and before Jackson's is recorded:
    // the record stays Sam's, which the stored text carries.
    const samsEdit = yield* edit("command:edit-race:sam-2", raced.messageId, "Drop it.");
    yield* conversation.dispatch(
      owner,
      yield* edit("command:edit-race:jackson-2", raced.messageId, "Keep it."),
      (admitted) =>
        threads.dispatch(admitted).pipe(Effect.andThen(send(sam, samsEdit)), Effect.as(admitted)),
    );
    const raceRecord = yield* recordOf(raced.messageId);
    assert.strictEqual(raceRecord.editedBy, "Sam");
    assert.strictEqual(
      yield* storedText(on, raced.messageId),
      `${raceRecord.storedPrefix}Drop it.`,
    );
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a person's approval feedback, written by upstream, is recorded as theirs", () => {
  const harness = makeHarness();
  const on = ThreadId.make("thread:shared-feedback");
  return Effect.gen(function* () {
    const people = yield* PersonAccess.PersonAccess;
    const conversation = yield* SharedConversation.SharedConversation;
    const threads = yield* ThreadManagementService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:feedback:create"),
      threadId: on,
      projectId,
      title: "Shared",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const owner = (yield* people.firstOwner).personId;
    const priya = yield* people.createPerson({ displayName: "Priya" });
    yield* people.setLevel({
      personId: priya.personId,
      scope: { kind: "thread", threadId: on },
      level: "collaborator",
    });
    // An approval the agent asked for, as upstream records one from a live provider session.
    const now = yield* DateTime.now;
    const sessionId = ProviderSessionId.make("session:shared-feedback");
    yield* projections.apply({
      id: EventId.make("event:feedback:session"),
      type: "provider-session.attached",
      threadId: on,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: modelSelection.instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const requestId = RuntimeRequestId.make("request:shared-feedback");
    yield* projections.apply({
      id: EventId.make("event:feedback:request"),
      type: "runtime-request.updated",
      threadId: on,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: NodeId.make("node:shared-feedback"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId, supportsFeedback: true },
        createdAt: now,
        resolvedAt: null,
      },
    });

    const decline = {
      type: "runtime-request.respond",
      commandId: CommandId.make("command:feedback:decline"),
      threadId: on,
      requestId,
      decision: "decline",
      feedback: "Run the tests first.",
    } as const satisfies OrchestrationV2Command;
    yield* send(priya.personId, decline);
    // Sent again, upstream takes it as before and nothing changes.
    yield* send(priya.personId, decline);

    // Named from upstream's log: the feedback's `message.updated` under the decline's command id,
    // with its `id` and `role` in the payload.
    const written = (yield* threads.getThreadProjection(on)).messages.find(
      (entry) => entry.text === decline.feedback,
    )!;
    assert.strictEqual(written.id, `approval-feedback:${requestId}`);
    const named = (viewer: ParticipantId) =>
      conversation
        .threadAuthors(viewer, on)
        .pipe(
          Effect.map((read) =>
            read.authors.map((author) => [author.messageId, author.name, author.you]),
          ),
        );
    assert.deepStrictEqual(yield* named(owner), [[written.id, "Priya", false]]);
    assert.deepStrictEqual(yield* named(priya.personId), [[written.id, "Priya", true]]);
  }).pipe(Effect.provide(Layer.provideMerge(ProjectionStore.layer, layerFor(harness))));
});

/** The author record J5 keeps for a message, or none. */
const authorRecord = (messageId: string) =>
  SqlClient.SqlClient.use(
    (sql) => sql<{ readonly display_name: string | null; readonly stored_prefix: string }>`
      SELECT display_name, stored_prefix FROM j5_a2a_message_author
      WHERE message_id = ${messageId}
    `,
  ).pipe(Effect.map((rows) => rows[0] ?? null));

it.effect(
  "a new message upstream refuses leaves no author record, and its retry is recorded",
  () => {
    const harness = makeHarness();
    const on = ThreadId.make("thread:shared-refused-message");
    return Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const threads = yield* ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:refused-message:create"),
        threadId: on,
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
      const priya = yield* people.createPerson({ displayName: "Priya" });
      yield* people.setLevel({
        personId: priya.personId,
        scope: { kind: "thread", threadId: on },
        level: "collaborator",
      });

      // Upstream refuses to continue a run the thread never had, so nothing is stored.
      const typed = "Pick up where you left off.";
      const refused = {
        ...message(typed, on),
        manualContinuationOfRunId: RunId.make("run:never-ran"),
      } satisfies OrchestrationV2Command;
      const refusal = yield* send(priya.personId, refused).pipe(Effect.flip);
      assert.strictEqual(refusal._tag, "OrchestratorDispatchError");
      assert.isUndefined(yield* storedText(on, refused.messageId));
      assert.isNull(yield* authorRecord(refused.messageId));

      // She is renamed, then sends it again under the same id: it is recorded as now sent.
      yield* people.setName({ personId: priya.personId, displayName: "Priya Shah" });
      const retried = { ...message(typed, on), messageId: refused.messageId };
      yield* send(priya.personId, retried);
      const record = (yield* authorRecord(refused.messageId))!;
      assert.strictEqual(record.display_name, "Priya Shah");
      assert.include(record.stored_prefix, "[Message from Priya Shah (collaborator)]");
      assert.strictEqual(
        yield* storedText(on, refused.messageId),
        `${record.stored_prefix}${typed}`,
      );
    }).pipe(Effect.provide(layerFor(harness)));
  },
);

it.effect(
  "a message's id is held from admission, and its record kept once upstream stored it",
  () => {
    const harness = makeHarness();
    const on = ThreadId.make("thread:shared-held-id");
    return Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const conversation = yield* SharedConversation.SharedConversation;
      const threads = yield* ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:held-id:create"),
        threadId: on,
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
      const scope = { kind: "thread" as const, threadId: on };
      const priya = (yield* people.createPerson({ displayName: "Priya" })).personId;
      const sam = (yield* people.createPerson({ displayName: "Sam" })).personId;
      yield* people.setLevel({ personId: priya, scope, level: "collaborator" });
      yield* people.setLevel({ personId: sam, scope, level: "collaborator" });

      // Sam sends under her id while hers is still on its way to upstream: his is refused.
      const hers = message("Ship Friday.", on);
      const samsRefusal = yield* conversation.dispatch(priya, hers, (admitted) =>
        send(sam, { ...message("Ship Monday.", on), messageId: hers.messageId }).pipe(
          Effect.flip,
          Effect.tap(() => threads.dispatch(admitted)),
        ),
      );
      assert.strictEqual(samsRefusal.message, "This message was already sent.");
      const record = (yield* authorRecord(hers.messageId))!;
      assert.strictEqual(record.display_name, "Priya");
      assert.strictEqual(
        yield* storedText(on, hers.messageId),
        `${record.stored_prefix}Ship Friday.`,
      );

      // Upstream stores her next message, then the request fails: the message keeps its record.
      const late = message("Keep the migration step.", on);
      yield* conversation
        .dispatch(priya, late, (admitted) =>
          threads.dispatch(admitted).pipe(Effect.andThen(Effect.fail("lost after commit"))),
        )
        .pipe(Effect.flip);
      const kept = (yield* authorRecord(late.messageId))!;
      assert.strictEqual(kept.display_name, "Priya");
      assert.strictEqual(
        yield* storedText(on, late.messageId),
        `${kept.stored_prefix}Keep the migration step.`,
      );

      // Her client retries a send still on its way to upstream, and the retry fails first: it
      // releases nothing, so the first attempt's record stands once upstream takes it.
      const pending = message("Ship it.", on);
      yield* conversation.dispatch(priya, pending, (admitted) =>
        conversation
          .dispatch(priya, pending, () => Effect.fail("retry refused"))
          .pipe(Effect.flip, Effect.andThen(threads.dispatch(admitted))),
      );
      const survived = (yield* authorRecord(pending.messageId))!;
      assert.strictEqual(survived.display_name, "Priya");
      assert.strictEqual(
        yield* storedText(on, pending.messageId),
        `${survived.stored_prefix}Ship it.`,
      );
    }).pipe(Effect.provide(layerFor(harness)));
  },
);

it.effect("a launch upstream refuses leaves no author record for its first message", () => {
  const harness = makeHarness();
  const on = ThreadId.make("thread:shared-refused-launch");
  const gone = ProjectId.make("project:gone");
  return Effect.gen(function* () {
    const people = yield* PersonAccess.PersonAccess;
    const conversation = yield* SharedConversation.SharedConversation;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const owner = (yield* people.firstOwner).personId;
    yield* people.setName({ personId: owner, displayName: "Jackson" });
    const priya = yield* people.createPerson({ displayName: "Priya" });
    for (const scoped of [projectId, gone]) {
      yield* people.setLevel({
        personId: priya.personId,
        scope: { kind: "project", projectId: scoped },
        level: "collaborator",
      });
    }
    const launch = (into: ProjectId, commandId: string) => {
      const input = {
        commandId: CommandId.make(commandId),
        threadId: on,
        projectId: into,
        title: "Review the plan",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("message:refused-launch"),
          text: "Let us review the plan.",
          attachments: [],
        },
      } as const satisfies OrchestrationV2ThreadLaunchInput;
      return conversation.launch(owner, input, (admitted) =>
        launches.launch({
          ...input,
          initialMessage: { ...input.initialMessage, text: admitted.initialMessage!.text },
          createdBy: "user",
          creationSource: "web",
        }),
      );
    };

    // Upstream refuses a launch into a project it does not have.
    const refusal = yield* launch(gone, "command:refused-launch").pipe(Effect.flip);
    assert.strictEqual(refusal._tag, "ThreadLaunchError");
    assert.isNull(yield* authorRecord("message:refused-launch"));

    yield* people.setName({ personId: owner, displayName: "Jackson Miller" });
    yield* launch(projectId, "command:accepted-launch");
    const record = (yield* authorRecord("message:refused-launch"))!;
    assert.include(record.stored_prefix, "[Message from Jackson Miller (owner)]");
    assert.strictEqual(
      yield* storedText(on, "message:refused-launch"),
      `${record.stored_prefix}Let us review the plan.`,
    );
  }).pipe(Effect.provide(layerFor(harness)));
});
