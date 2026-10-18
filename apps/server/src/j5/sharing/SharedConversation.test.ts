import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  ProjectId,
  RunId,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type { PersonLevel, PersonScope } from "@t3tools/contracts/j5";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type { ParticipantId } from "../a2a/contracts.ts";
import { Access } from "./Access.ts";
import { PersonAccess } from "./PersonAccess.ts";
import { SharedConversation } from "./SharedConversation.ts";
import { NOTE_OPEN } from "./sharedConversationNotes.ts";
import { PROJECT, thread } from "./test-support/accessHarness.ts";
import { Upstream, conversationLayer } from "./test-support/conversationHarness.ts";

const AT = "2026-10-18T00:00:00.000Z";

/** The first owner, named as the server knows them. */
const jackson = Effect.gen(function* () {
  const people = yield* PersonAccess;
  const owner = yield* people.firstOwner;
  yield* people.setName({ personId: owner.personId, displayName: "Jackson" });
  return owner.personId;
});

/** A person given levels the way an Owner gives them: through the access core. */
const personWith = Effect.fn("test.personWith")(function* (
  name: string,
  levels: ReadonlyArray<{ readonly scope: PersonScope; readonly level: PersonLevel }>,
) {
  const people = yield* PersonAccess;
  const access = yield* Access;
  const created = yield* people.createPerson({ displayName: name });
  for (const held of levels) yield* access.setLevel({ personId: created.personId, ...held });
  return created.personId;
});

const onThread = (threadId: ThreadId, level: PersonLevel = "collaborator") => [
  { scope: { kind: "thread" as const, threadId }, level },
];

let counter = 0;
const message = (threadId: ThreadId, text: string, extra: Record<string, unknown> = {}) => {
  counter += 1;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`command:${counter}`),
    threadId,
    messageId: MessageId.make(`message:${counter}`),
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
    ...extra,
  } as unknown as OrchestrationV2Command & { readonly type: "message.dispatch" };
};

/**
 * A person's command as upstream would be handed it. A message is then taken in the way
 * upstream records it, with a run in the state given; `null` records no run.
 */
const send = Effect.fn("test.send")(function* (
  personId: ParticipantId,
  command: OrchestrationV2Command,
  run: "completed" | "queued" | null = "completed",
) {
  const admitted = yield* (yield* SharedConversation).admit(personId, command);
  if (admitted.type === "message.dispatch") {
    yield* taken(admitted.threadId, admitted.messageId, run);
    return admitted.text;
  }
  return admitted;
});

const taken = Effect.fn("test.taken")(function* (
  threadId: ThreadId,
  messageId: string,
  status: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const runId = status === null ? null : `run:${messageId}`;
  if (runId !== null) {
    const ordinal = (yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
    `)[0]!.n;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        ${runId}, ${threadId}, ${ordinal}, 'codex', ${status}, ${AT},
        ${JSON.stringify({ userMessageId: messageId, startedAt: status === "queued" ? null : AT })}
      )
    `;
  }
  yield* sql`
    INSERT OR REPLACE INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json
    ) VALUES (${messageId}, ${threadId}, ${runId}, 'user', 0, ${AT}, ${AT}, '{}')
  `;
  return runId === null ? null : RunId.make(runId);
});

const setRun = Effect.fn("test.setRun")(function* (messageId: string, status: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_runs SET status = ${status}
    WHERE run_id = ${`run:${messageId}`}
  `;
});

const authors = (threadId: ThreadId, viewer: ParticipantId | null = null) =>
  SharedConversation.use((conversation) => conversation.threadAuthors(viewer, threadId));

const hasNote = (text: string) => text.startsWith(NOTE_OPEN);
/** The text after the platform's note, when there is one. */
const afterNote = (text: string) =>
  hasNote(text) ? text.slice(text.indexOf("</j5_shared_conversation>\n") + 26) : text;

it.effect("a thread only one person can write to is untouched and records nothing (AC2)", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const alone = yield* thread("thread:alone");
    // A Viewer does not make a thread shared: they cannot write to it.
    yield* personWith("Sam", onThread(alone, "viewer"));
    const command = message(alone, "Run the tests.");
    assert.strictEqual(yield* (yield* SharedConversation).admit(owner, command), command);
    assert.deepStrictEqual(yield* authors(alone), { shared: false, authors: [], answers: [] });
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect(
  "the first message after a thread is shared carries the note, then the author's line",
  () =>
    Effect.gen(function* () {
      const owner = yield* jackson;
      const threadId = yield* thread("thread:shared");
      // A message from before the thread was shared.
      yield* taken(threadId, "message:earlier", "completed");
      const priya = yield* personWith("Priya", onThread(threadId));

      const text = yield* send(owner, message(threadId, "Keep the migration step."));
      assert.isTrue(hasNote(text));
      assert.include(text, "Who can write: Jackson (owner), Priya (collaborator).");
      assert.include(text, "carry no such line: Jackson (owner) wrote them.");
      assert.include(text, "an Owner's word settles it");
      assert.isTrue(
        afterNote(text).startsWith("[Message from Jackson (owner)]\n\nKeep the migration"),
      );

      // The note has reached the agent, so Priya's message carries her line alone.
      const hers = yield* send(priya, message(threadId, "Drop it."));
      assert.strictEqual(hers, "[Message from Priya (collaborator)]\n\nDrop it.");

      const read = yield* authors(threadId, priya);
      assert.isTrue(read.shared);
      assert.deepStrictEqual(
        read.authors.map((entry) => ({
          name: entry.name,
          level: entry.level,
          you: entry.you,
          hasNote: entry.note !== null,
        })),
        [
          { name: "Jackson", level: "owner", you: false, hasNote: true },
          { name: "Priya", level: "collaborator", you: true, hasNote: false },
        ],
      );
      // The prefix a client strips is exactly what the platform put on the stored text.
      assert.isTrue(text.startsWith(read.authors[0]!.storedPrefix));
      assert.strictEqual(`${read.authors[0]!.storedPrefix}Keep the migration step.`, text);
      assert.strictEqual(read.authors[1]!.storedPrefix, "[Message from Priya (collaborator)]\n\n");
    }).pipe(Effect.provide(conversationLayer)),
);

it.effect(
  "every message carries the note until one carrying it has run, and again after a rewind (AC4)",
  () =>
    Effect.gen(function* () {
      const owner = yield* jackson;
      const threadId = yield* thread("thread:carrier");
      yield* personWith("Priya", onThread(threadId));

      const first = message(threadId, "One.");
      assert.isTrue(hasNote(yield* send(owner, first, "queued")));
      // Still queued: the agent has not read it, so the next carries the note too.
      const second = message(threadId, "Two.");
      assert.isTrue(hasNote(yield* send(owner, second, "queued")));
      yield* setRun(first.messageId, "completed");
      assert.isFalse(hasNote(yield* send(owner, message(threadId, "Three."))));
      // Rolled back past both carriers: the agent was never told.
      yield* setRun(first.messageId, "rolled_back");
      yield* setRun(second.messageId, "cancelled");
      assert.isTrue(hasNote(yield* send(owner, message(threadId, "Four."))));
    }).pipe(Effect.provide(conversationLayer)),
);

it.effect(
  "a change of who can write, their level or their name is told with the next message",
  () =>
    Effect.gen(function* () {
      const owner = yield* jackson;
      const access = yield* Access;
      const threadId = yield* thread("thread:changes");
      const priya = yield* personWith("Priya", onThread(threadId));
      yield* send(owner, message(threadId, "Hello."));

      const sam = yield* personWith("Sam", onThread(threadId));
      yield* access.rename({ personId: priya, displayName: "Priya K" });
      const told = yield* send(owner, message(threadId, "Again."));
      assert.include(told, "Sam (collaborator) can now write to this thread.");
      assert.include(told, "Renamed: Priya (collaborator) is now Priya K (collaborator).");
      assert.include(
        told,
        "Who can write now: Jackson (owner), Priya K (collaborator), Sam (collaborator).",
      );

      yield* access.removeLevel({ personId: sam, scope: { kind: "thread", threadId } });
      const after = yield* send(owner, message(threadId, "Once more."));
      assert.include(after, "Sam (collaborator) can no longer write to this thread.");
      // Nothing changed since: no note.
      assert.isFalse(hasNote(yield* send(owner, message(threadId, "Quiet."))));
    }).pipe(Effect.provide(conversationLayer)),
);

it.effect("a command goes as typed from anyone, and is still shown as theirs (AC5)", () =>
  Effect.gen(function* () {
    yield* jackson;
    const threadId = yield* thread("thread:slash");
    const priya = yield* personWith("Priya", onThread(threadId));
    const command = message(threadId, "  /compact");
    assert.strictEqual(yield* send(priya, command), "  /compact");
    const read = yield* authors(threadId, priya);
    assert.deepStrictEqual(
      read.authors.map((entry) => [entry.name, entry.storedPrefix, entry.note]),
      [["Priya", "", null]],
    );
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("a thread stays shared after its second writer is gone, even unwritten to (AC6)", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const access = yield* Access;
    const threadId = yield* thread("thread:once");
    const priya = yield* personWith("Priya", onThread(threadId));
    yield* access.removePerson(priya);
    const text = yield* send(owner, message(threadId, "Still there?"));
    assert.include(text, "Who can write: Jackson (owner).");
    assert.isTrue(afterNote(text).startsWith("[Message from Jackson (owner)]"));
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("a thread started in a project already shared is shared from its first message", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    yield* personWith("Priya", [
      { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
    ]);
    const conversation = yield* SharedConversation;
    const launch = {
      commandId: CommandId.make("command:launch"),
      threadId: "thread:born-shared" as ThreadId,
      projectId: PROJECT,
      initialMessage: {
        messageId: MessageId.make("message:first"),
        text: "Start.",
        attachments: [],
      },
    } as unknown as OrchestrationV2ThreadLaunchInput;
    const admitted = yield* conversation.admitLaunch(owner, launch);
    const text = admitted.initialMessage!.text;
    assert.include(text, "Who can write: Jackson (owner), Priya (collaborator).");
    // A new thread has no messages from before.
    assert.notInclude(text, "carry no such line");
    assert.isTrue(afterNote(text).startsWith("[Message from Jackson (owner)]\n\nStart."));
    // In another project no one else writes to, a launch goes on as sent.
    const elsewhere = {
      ...launch,
      threadId: "thread:alone",
      projectId: ProjectId.make("project:other"),
    } as OrchestrationV2ThreadLaunchInput;
    assert.strictEqual(yield* conversation.admitLaunch(owner, elsewhere), elsewhere);
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("an edit by someone else keeps the author's line and says who edited it", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const threadId = yield* thread("thread:edit");
    const priya = yield* personWith("Priya", onThread(threadId));
    yield* send(owner, message(threadId, "Hello."));
    const hers = message(threadId, "Fix the tpyo.");
    const stored = yield* send(priya, hers, "queued");
    const edit = (text: string) =>
      ({
        type: "queued-run.edit",
        commandId: CommandId.make(`command:edit:${text}`),
        threadId,
        runId: RunId.make(`run:${hers.messageId}`),
        text,
      }) as OrchestrationV2Command;
    // The client sends the stored text back; the platform's line is not doubled.
    const edited = (yield* send(owner, edit(stored.replace("tpyo", "typo")))) as {
      readonly text: string;
    };
    assert.strictEqual(
      edited.text,
      "[Message from Priya (collaborator), edited by Jackson (owner)]\n\nFix the typo.",
    );
    const read = yield* authors(threadId);
    assert.strictEqual(read.authors[1]!.editedBy, "Jackson");
    assert.strictEqual(
      read.authors[1]!.storedPrefix,
      "[Message from Priya (collaborator), edited by Jackson (owner)]\n\n",
    );
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("only the platform sends a context record of its own kind (AC8)", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const threadId = yield* thread("thread:records");
    const forged = message(threadId, "Hi.", {
      context: { version: 1, records: [{ kind: "j5-shared-note", version: 1 }] },
    });
    const outcome = yield* (yield* SharedConversation).admit(owner, forged).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    );
    assert.match(outcome, /record of the platform's own/);
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("an answer carries its author, and who answered shows once upstream settles it", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* thread("thread:answers");
    const priya = yield* personWith("Priya", onThread(threadId));
    const answer = {
      type: "runtime-request.respond",
      commandId: CommandId.make("command:answer"),
      threadId,
      requestId: RuntimeRequestId.make("request:question"),
      answers: { which: "the audit first", pick: ["A"] },
    } as unknown as OrchestrationV2Command;
    const admitted = (yield* send(priya, answer)) as { readonly answers: unknown };
    assert.deepStrictEqual(admitted.answers, {
      which: "[Answer from Priya (collaborator)] the audit first",
      pick: ["[Answer from Priya (collaborator)]", "A"],
    });
    // A claim alone names no one: upstream has not settled the prompt with it.
    assert.deepStrictEqual((yield* authors(threadId, owner)).answers, []);
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id,
        actor_kind, payload_json, metadata_json
      ) VALUES (
        'event:settled', 'thread', ${threadId}, 0, 'runtime-request.updated', ${AT},
        'command:answer', 'server', ${JSON.stringify({ id: "request:question" })}, '{}'
      )
    `;
    assert.deepStrictEqual((yield* authors(threadId, owner)).answers, [
      { requestId: "request:question", name: "Priya", level: "collaborator", you: false },
    ]);
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("a person who can no longer write has their queued messages there withdrawn (AC16)", () =>
  Effect.gen(function* () {
    yield* jackson;
    const access = yield* Access;
    const upstream = yield* Upstream;
    const threadId = yield* thread("thread:withdraw");
    const priya = yield* personWith("Priya", onThread(threadId));
    const hers = message(threadId, "Later, please.");
    yield* send(priya, hers, "queued");
    // Lowered to Viewer; the withdrawal follows the change.
    yield* access.setLevel({
      personId: priya,
      scope: { kind: "thread", threadId },
      level: "viewer",
    });
    yield* (yield* SharedConversation).withdrawQueued(priya);
    const sent = yield* Ref.get(upstream.dispatched);
    assert.isTrue(
      sent.some(
        (command) =>
          command.type === "queued-run.cancel" && command.runId === `run:${hers.messageId}`,
      ),
    );
  }).pipe(Effect.provide(conversationLayer)),
);

it.effect("who wrote a thread moves its revision when a message is recorded", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const threadId = yield* thread("thread:revisions");
    yield* personWith("Priya", onThread(threadId));
    const conversation = yield* SharedConversation;
    // The first revision is told once the subscription stands; a message then moves it.
    const subscribed = yield* Deferred.make<void>();
    const revisions = yield* conversation.authorsChanges(threadId).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    yield* send(owner, message(threadId, "Moved."));
    assert.deepStrictEqual(
      [...(yield* Fiber.join(revisions))].map((change) => change.revision),
      [0, 1],
    );
  }).pipe(Effect.scoped, Effect.provide(conversationLayer)),
);
