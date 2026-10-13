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
      const priya = yield* access.createGuest({ displayName: "Priya" });
      yield* access.bindSession({ sessionId: GUEST.sessionId, personId: priya.personId });
      const target = { kind: "thread" as const, threadId };
      yield* access.putGrant({ personId: priya.personId, target, level: "collaborate" });

      // The member writes first, then the guest, then the member again.
      const fromMember = message("Let us review the plan.");
      const fromGuest = message("What does the plan change?");
      const later = message("And what does it cost?");
      yield* send(MEMBER, fromMember);
      yield* send(GUEST, fromGuest);
      yield* send(MEMBER, later);

      // Upstream's stored thread: the note first, then each person's message under their name.
      const projection = yield* threads.getThreadProjection(threadId);
      const stored = projection.messages
        .filter((stored) => stored.role === "user")
        .toSorted(
          (left, right) => left.createdAt.epochMilliseconds - right.createdAt.epochMilliseconds,
        );
      assert.deepStrictEqual(
        stored.map((stored) => [stored.createdBy, stored.text.split("\n")[0]]),
        [
          ["system", "<j5_shared_conversation>"],
          ["user", "[Message from Jackson (member)]"],
          ["user", "[Message from Priya (guest)]"],
          ["user", "[Message from Jackson (member)]"],
        ],
      );
      assert.strictEqual(
        stored[2]?.text,
        "[Message from Priya (guest)]\n\nWhat does the plan change?",
      );
      const note = stored[0]!;

      // No provider is running, so the note's run stays active and everything after it queues,
      // in the order it was sent. These are the two fields J5 reads from upstream by SQL.
      const before = yield* runs;
      assert.deepStrictEqual(
        before.map((run) => [run.message_id, run.status === "queued"]),
        [
          [note.id, false],
          [fromMember.messageId, true],
          [fromGuest.messageId, true],
          [later.messageId, true],
        ],
      );

      // The guest changes its own queued message and not the member's.
      const guestRun = projection.runs.find((run) => run.userMessageId === fromGuest.messageId)!;
      const memberRun = projection.runs.find((run) => run.userMessageId === fromMember.messageId)!;
      const edit = (runId: typeof guestRun.id, text: string) =>
        send(GUEST, {
          type: "queued-run.edit",
          commandId: CommandId.make(`command:live:edit:${runId}`),
          threadId,
          runId,
          text,
        });
      yield* edit(guestRun.id, "What does the plan change, and when?");
      assert.strictEqual(
        (yield* Effect.flip(edit(memberRun.id, "Mine now.")))._tag,
        "EnvironmentAuthorizationError",
      );
      const edited = (yield* threads.getThreadProjection(threadId)).messages.find(
        (stored) => stored.id === fromGuest.messageId,
      );
      assert.strictEqual(
        edited?.text,
        "[Message from Priya (guest)]\n\nWhat does the plan change, and when?",
      );

      // Lowered to View: the guest's queued run is withdrawn through upstream's own cancel, and
      // never started. The member's stay queued.
      yield* access.putGrant({ personId: priya.personId, target, level: "view" });
      yield* conversation.withdrawQueued(priya.personId);
      const after = yield* runs;
      const withdrawn = after.find((run) => run.message_id === fromGuest.messageId)!;
      assert.notStrictEqual(withdrawn.status, "queued");
      assert.isNull(withdrawn.started_at);
      assert.deepStrictEqual(
        after.filter((run) => run.status === "queued").map((run) => run.message_id),
        [fromMember.messageId, later.messageId],
      );
      // Told again, nothing more is withdrawn, and the guest can no longer send.
      yield* conversation.withdrawQueued(priya.personId);
      assert.deepStrictEqual(yield* runs, after);
      assert.strictEqual(
        (yield* Effect.flip(send(GUEST, message("Still here?"))))._tag,
        "EnvironmentAuthorizationError",
      );
    }).pipe(Effect.provide(layerFor(harness)));
  },
);
