import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { sharedConversation } from "./SharedConversation.ts";

/**
 * A shared conversation over upstream's real orchestrator and its real projections, with no
 * provider running: a run that starts stays active, so what is sent after it queues. The other
 * tests of this module stand in for upstream's dispatch and write its rows by hand; this one is
 * what fails if upstream reshapes what J5 reads from it by SQL: a run's `status` and the
 * `userMessageId` in its payload.
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
const message = (text: string) => {
  counter += 1;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`command:live:${counter}`),
    threadId,
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

      // A second message while the carrier still waits says nothing more: the agent will be told.
      const second = message("And what does it cost?");
      yield* send(MEMBER, second);
      assert.strictEqual(
        (yield* stored).text(second.messageId),
        "[Message from Jackson (member)]\n\nAnd what does it cost?",
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

      // The guest withdraws the carrier before it runs, so the agent was never told. The next
      // message a person sends carries the note instead.
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
      // And the one after it does not.
      const queuedByGuest = message("One more question.");
      yield* send(GUEST, queuedByGuest);
      assert.strictEqual(
        (yield* stored).text(queuedByGuest.messageId),
        "[Message from Priya (guest)]\n\nOne more question.",
      );

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

      // With no guest left who can write, the member's next message says so, once, and is the
      // last to carry an author line.
      const closing = message("Just me now.");
      yield* send(MEMBER, closing);
      const closingText = (yield* stored).text(closing.messageId)!;
      assert.isTrue(
        closingText.startsWith("<j5_shared_conversation>\nPriya (guest) can no longer"),
      );
      assert.isTrue(closingText.endsWith("\n[Message from Jackson (member)]\n\nJust me now."));
      const plain = message("And on.");
      assert.strictEqual(yield* send(MEMBER, plain), plain);
    }).pipe(Effect.provide(layerFor(harness)));
  },
);
