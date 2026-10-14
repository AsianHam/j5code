import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { isNativeMaintenanceCommand } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { guestCommandId, sharedConversation } from "./SharedConversation.ts";

/**
 * A shared conversation over upstream's real orchestrator and its real projections, with no
 * provider running: a run that starts stays active, so what is sent after it queues. The other
 * tests of this module stand in for upstream's dispatch and write its rows by hand; this one is
 * what fails if upstream reshapes what J5 reads from it by SQL: a run's `status` and the
 * `userMessageId` and `startedAt` in its payload, a message's `run_id`, and the event log's
 * `command_id`, `aggregate_kind`, `stream_id`, `event_type` and the `id` in its payload.
 */

const SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
const MEMBER = {
  sessionId: AuthSessionId.make("session:member"),
  subject: "one-time-token",
  scopes: SCOPES,
};
const GUEST = {
  sessionId: AuthSessionId.make("session:priya"),
  subject: PersonAccess.GUEST_SESSION_SUBJECT,
  scopes: SCOPES,
};
const threadId = ThreadId.make("thread:shared-live");

const layerFor = (harness: ReturnType<typeof makeHarness>) =>
  PersonAccess.layer.pipe(Layer.provideMerge(harness.layer));

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
  who: PersonAccess.SessionIdentity,
  command: OrchestrationV2Command,
) {
  const conversation = yield* sharedConversation;
  const threads = yield* ThreadManagementService;
  const admitted = yield* conversation.admit(who, command);
  yield* threads.dispatch(admitted);
  return admitted;
});

const runs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly status: string;
    readonly message_id: string | null;
    readonly started_at: string | null;
  }>`
    SELECT status, json_extract(payload_json, '$.userMessageId') AS message_id,
      json_extract(payload_json, '$.startedAt') AS started_at
    FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId}
    ORDER BY ordinal
  `;
});

it.effect(
  "a guest's message is named, noted, queued and withdrawn on upstream's own records",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const conversation = yield* sharedConversation;
      const threads = yield* ThreadManagementService;
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
      yield* access.setOperatorName("Jackson");
      const stored = Effect.gen(function* () {
        const projection = yield* threads.getThreadProjection(threadId);
        return {
          projection,
          text: (messageId: string) =>
            projection.messages.find((message) => message.id === messageId)?.text,
        };
      });

      // Before anyone is brought in, the member's message is stored exactly as typed. No provider
      // is running, so its run stays active and everything sent after it queues.
      const before = message("Let us review the plan.");
      assert.strictEqual(yield* send(MEMBER, before), before);
      assert.strictEqual((yield* stored).text(before.messageId), "Let us review the plan.");

      // Who answered a prompt is kept only when upstream's log shows the command settled it.
      // No prompt can be raised here without a provider, so this pins what that check reads, on
      // an event upstream does write for this command: the log is `orchestration_events`, a
      // thread's events are its stream, the payload is the changed thing itself with its `id`,
      // and `command_id` is the command that caused it.
      const sql = yield* SqlClient.SqlClient;
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

      const priya = yield* access.createGuest({ displayName: "Priya" });
      yield* access.bindSession({ sessionId: GUEST.sessionId, personId: priya.personId });
      const target = { kind: "thread" as const, threadId };
      yield* access.putGrant({ personId: priya.personId, target, level: "collaborate" });

      // The guest's first message carries the note, at the top, ahead of its author line. It is
      // one message: no turn is spent on the note alone, and the platform sends nothing itself.
      const carrier = message("What does the plan change?");
      yield* send(GUEST, carrier);
      const authors = yield* conversation.threadAuthors(MEMBER, threadId);
      const note = authors.find((author) => author.messageId === carrier.messageId)?.note;
      assert.isTrue(note?.startsWith("<j5_shared_conversation>\nThis thread is now a shared"));
      assert.isTrue(note?.endsWith("\n</j5_shared_conversation>"));
      assert.strictEqual(
        (yield* stored).text(carrier.messageId),
        `${note}\n[Message from Priya (guest)]\n\nWhat does the plan change?`,
      );
      assert.isFalse(
        (yield* stored).projection.messages.some((message) => message.createdBy === "system"),
      );
      // It queued behind the member's run. These are the fields J5 reads from upstream by SQL.
      assert.deepStrictEqual(
        (yield* runs).map((run) => [run.message_id, run.status === "queued"]),
        [
          [before.messageId, false],
          [carrier.messageId, true],
        ],
      );

      // Edited while it waits, by its author and with or without the platform's text sent back,
      // it keeps the note and its author line.
      const carrierRun = (yield* stored).projection.runs.find(
        (run) => run.userMessageId === carrier.messageId,
      )!;
      const edit = (who: PersonAccess.SessionIdentity, key: string, text: string) =>
        send(who, {
          type: "queued-run.edit",
          commandId: CommandId.make(`command:live:edit:${key}`),
          threadId,
          runId: carrierRun.id,
          text,
        });
      yield* edit(GUEST, "plain", "What does the plan change, and when?");
      assert.strictEqual(
        (yield* stored).text(carrier.messageId),
        `${note}\n[Message from Priya (guest)]\n\nWhat does the plan change, and when?`,
      );
      yield* edit(GUEST, "resent", `${(yield* stored).text(carrier.messageId)} Exactly.`);
      assert.strictEqual(
        (yield* stored).text(carrier.messageId),
        `${note}\n[Message from Priya (guest)]\n\nWhat does the plan change, and when? Exactly.`,
      );
      yield* edit(MEMBER, "member", "What does the plan change?");
      assert.strictEqual(
        (yield* stored).text(carrier.messageId),
        `${note}\n[Message from Priya (guest), edited by Jackson (member)]\n\nWhat does the plan change?`,
      );

      // The carrier still waits, so the agent has been told nothing yet and the guest could
      // withdraw it: a second message carries the note too.
      const second = message("And what does it cost?");
      yield* send(MEMBER, second);
      assert.strictEqual(
        (yield* stored).text(second.messageId),
        `${note}\n[Message from Jackson (member)]\n\nAnd what does it cost?`,
      );
      // The guest cannot change the member's queued message.
      const secondRun = (yield* stored).projection.runs.find(
        (run) => run.userMessageId === second.messageId,
      )!;
      assert.strictEqual(
        (yield* Effect.flip(
          send(GUEST, {
            type: "queued-run.edit",
            commandId: CommandId.make("command:live:edit:not-mine"),
            threadId,
            runId: secondRun.id,
            text: "Mine now.",
          }),
        ))._tag,
        "EnvironmentAuthorizationError",
      );

      // The guest withdraws the carrier before it runs. Nothing has reached the agent yet, so
      // the next message a person sends carries the note as well.
      yield* send(GUEST, {
        type: "queued-run.cancel",
        commandId: CommandId.make("command:live:cancel"),
        threadId,
        runId: carrierRun.id,
      });
      const next = message("Still reviewing.");
      yield* send(MEMBER, next);
      assert.strictEqual(
        (yield* stored).text(next.messageId),
        `${note}\n[Message from Jackson (member)]\n\nStill reviewing.`,
      );
      const queuedByGuest = message("One more question.");
      yield* send(GUEST, queuedByGuest);
      assert.strictEqual(
        (yield* stored).text(queuedByGuest.messageId),
        `${note}\n[Message from Priya (guest)]\n\nOne more question.`,
      );
      // A guest's command goes on to upstream under an id that is the guest's own.
      assert.deepStrictEqual(
        yield* sql<{ readonly command_id: string }>`
          SELECT DISTINCT command_id FROM orchestration_events
          WHERE event_type = 'message.updated' AND stream_id = ${threadId}
            AND json_extract(payload_json, '$.id') = ${queuedByGuest.messageId}
        `,
        [{ command_id: guestCommandId(priya.personId, queuedByGuest.commandId) }],
      );

      // The guest names, as its own command's id, the id the platform once used to withdraw
      // this run, so that upstream holds a receipt for it. Upstream answers "accepted" for an
      // id it has a receipt for and does nothing more, so a withdrawal under that id would
      // leave the message queued, to run under the guest's name after their access is gone.
      const guestRun = (yield* stored).projection.runs.find(
        (run) => run.userMessageId === queuedByGuest.messageId,
      )!;
      yield* send(GUEST, {
        type: "queued-run.edit",
        commandId: CommandId.make(`command:j5:shared-conversation-withdraw:${guestRun.id}`),
        threadId,
        runId: guestRun.id,
        text: "One more question, please.",
      });

      // Lowered to View: the guest's queued run is withdrawn through upstream's own cancel, and
      // never started. The member's stay queued.
      yield* access.putGrant({ personId: priya.personId, target, level: "view" });
      yield* conversation.withdrawQueued(priya.personId);
      const after = yield* runs;
      const withdrawn = after.find((run) => run.message_id === queuedByGuest.messageId)!;
      assert.strictEqual(withdrawn.status, "cancelled");
      assert.isNull(withdrawn.started_at);
      assert.deepStrictEqual(
        after.filter((run) => run.status === "queued").map((run) => run.message_id),
        [second.messageId, next.messageId],
      );
      // Told again, nothing more is withdrawn, and the guest can no longer send.
      yield* conversation.withdrawQueued(priya.personId);
      assert.deepStrictEqual(yield* runs, after);
      assert.strictEqual(
        (yield* Effect.flip(send(GUEST, message("Still here?"))))._tag,
        "EnvironmentAuthorizationError",
      );

      // No guest can write any more, and no note is known to have reached the agent, so there
      // is nothing to take back: the member's next message is sent as typed.
      const closing = message("Just me now.");
      assert.strictEqual(yield* send(MEMBER, closing), closing);
    }).pipe(Effect.provide(layerFor(harness)));
  },
);

it.effect(
  "every message carries the first note until one is known to have reached the agent",
  () => {
    const harness = makeHarness();
    const on = ThreadId.make("thread:shared-withdrawn");
    return Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const conversation = yield* sharedConversation;
      const threads = yield* ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:live:create-withdrawn"),
        threadId: on,
        projectId,
        title: "Shared",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* access.setOperatorName("Jackson");
      const note = (messageId: string) =>
        conversation
          .threadAuthors(MEMBER, on)
          .pipe(
            Effect.map(
              (authors) => authors.find((author) => author.messageId === messageId)?.note ?? null,
            ),
          );
      // The member's run stays active, so what follows queues.
      yield* send(MEMBER, message("Let us review the plan.", on));
      const priya = yield* access.createGuest({ displayName: "Priya" });
      yield* access.bindSession({ sessionId: GUEST.sessionId, personId: priya.personId });
      const target = { kind: "thread" as const, threadId: on };
      yield* access.putGrant({ personId: priya.personId, target, level: "collaborate" });

      // The first note waits in the queue on the guest's message.
      const first = message("What does the plan change?", on);
      yield* send(GUEST, first);
      assert.isTrue((yield* note(first.messageId))?.includes("This thread is now a shared"));
      // A second guest is added. The agent has not read the first note and may never, so the
      // member's next message carries the whole of it, not just what changed.
      const sam = yield* access.createGuest({ displayName: "Sam" });
      yield* access.putGrant({ personId: sam.personId, target, level: "collaborate" });
      const second = message("Welcome, Sam.", on);
      yield* send(MEMBER, second);
      const told = yield* note(second.messageId);
      assert.isTrue(told?.includes("This thread is now a shared"));
      assert.isTrue(told?.includes("Who can write: Jackson (member), Priya (guest), Sam (guest)."));

      // The guest withdraws the first before it runs. Whichever message reaches the agent
      // first, it has the note.
      const projection = yield* threads.getThreadProjection(on);
      yield* send(GUEST, {
        type: "queued-run.cancel",
        commandId: CommandId.make("command:live:cancel-withdrawn"),
        threadId: on,
        runId: projection.runs.find((run) => run.userMessageId === first.messageId)!.id,
      });
      const third = message("Where were we?", on);
      yield* send(MEMBER, third);
      assert.strictEqual(yield* note(third.messageId), told);
    }).pipe(Effect.provide(layerFor(harness)));
  },
);

it.effect(
  "a thread started in a shared project is a shared conversation from its first message",
  () => {
    const harness = makeHarness();
    const on = ThreadId.make("thread:shared-born");
    return Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const conversation = yield* sharedConversation;
      const threads = yield* ThreadManagementService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* access.setOperatorName("Jackson");
      const priya = yield* access.createGuest({ displayName: "Priya" });
      yield* access.bindSession({ sessionId: GUEST.sessionId, personId: priya.personId });
      yield* access.putGrant({
        personId: priya.personId,
        target: { kind: "project", projectId },
        level: "collaborate",
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
      const admitted = yield* conversation.admitLaunch(MEMBER, launch);
      yield* launches.launch({
        ...launch,
        initialMessage: { ...launch.initialMessage, text: admitted.initialMessage!.text },
        createdBy: "user",
        creationSource: "web",
      });
      const text = (messageId: string) =>
        threads
          .getThreadProjection(on)
          .pipe(
            Effect.map(
              (projection) => projection.messages.find((message) => message.id === messageId)?.text,
            ),
          );
      const first = yield* text(launch.initialMessage.messageId);
      assert.isTrue(
        first?.startsWith("<j5_shared_conversation>\nThis thread is now a shared"),
        first,
      );
      assert.isTrue(first?.includes("Who can write: Jackson (member), Priya (guest)."));
      assert.isTrue(
        first?.endsWith("\n[Message from Jackson (member)]\n\nLet us review the plan."),
      );
      // A member's `/compact` goes on as typed, so upstream takes it for the command it is; a
      // guest's is sent as words under their name, which upstream does not.
      const compact = message("/compact", on);
      yield* send(MEMBER, compact);
      const compactText = yield* text(compact.messageId);
      assert.strictEqual(compactText, "/compact");
      assert.isTrue(isNativeMaintenanceCommand({ text: compactText!, attachments: [] }));
      const guestCompact = message("/compact", on);
      yield* send(GUEST, guestCompact);
      const guestText = yield* text(guestCompact.messageId);
      assert.strictEqual(guestText, "[Message from Priya (guest)]\n\n/compact");
      assert.isFalse(isNativeMaintenanceCommand({ text: guestText!, attachments: [] }));
      // The guest's own message on the thread is named, and a guest cannot start a thread.
      const reply = message("What does the plan change?", on);
      yield* send(GUEST, reply);
      assert.isTrue(
        (yield* text(reply.messageId))?.endsWith(
          "[Message from Priya (guest)]\n\nWhat does the plan change?",
        ),
      );
      assert.strictEqual(
        (yield* Effect.flip(conversation.admitLaunch(GUEST, launch)))._tag,
        "EnvironmentAuthorizationError",
      );

      // In a project no guest can write to, a launch goes on exactly as it was sent.
      yield* access.putGrant({
        personId: priya.personId,
        target: { kind: "project", projectId },
        level: "view",
      });
      const alone = { ...launch, threadId: ThreadId.make("thread:born-alone") };
      assert.strictEqual(yield* conversation.admitLaunch(MEMBER, alone), alone);
    }).pipe(Effect.provide(layerFor(harness)));
  },
);
