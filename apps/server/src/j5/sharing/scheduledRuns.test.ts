import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  RunId,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ThreadId,
} from "@t3tools/contracts";
import { LEVEL_PERMISSIONS, type PersonLevel, type PersonScope } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type ThreadLaunchInput,
  ThreadLaunchService,
} from "../../orchestration-v2/ThreadLaunchService.ts";
import {
  type ThreadManagementSendInput,
  ThreadManagementService,
} from "../../orchestration-v2/ThreadManagementService.ts";
import { Access } from "./Access.ts";
import { makeCommandAdmission } from "./CommandAdmission.ts";
import { PersonAccess } from "./PersonAccess.ts";
import { layer as scheduledRunsLayer } from "./scheduledRuns.ts";
import { SharedConversation } from "./SharedConversation.ts";
import { NOTE_CLOSE } from "./sharedConversationNotes.ts";
import { PROJECT, device, thread } from "./test-support/accessHarness.ts";
import { conversationLayer } from "./test-support/conversationHarness.ts";

/**
 * A scheduled task's runs in a shared conversation (Shared conversations AC20): upstream's
 * scheduled-task service hands its runs to the decorated thread services, which hand on to these
 * stand-ins what upstream would be sent.
 */

const AT = "2026-10-19T00:00:00.000Z";
const TASK = "scheduled-task:nightly";

interface Sent {
  readonly threadId: string;
  readonly text: string;
}
interface Launched {
  readonly threadId: string | undefined;
  readonly text: string | undefined;
}

class Handed extends Context.Service<
  Handed,
  {
    readonly sent: Ref.Ref<ReadonlyArray<Sent>>;
    readonly launched: Ref.Ref<ReadonlyArray<Launched>>;
  }
>()("t3/j5/sharing/scheduledRuns.test/Handed") {}

const handedLayer = Layer.effect(
  Handed,
  Effect.gen(function* () {
    return Handed.of({
      sent: yield* Ref.make<ReadonlyArray<Sent>>([]),
      launched: yield* Ref.make<ReadonlyArray<Launched>>([]),
    });
  }),
);

const upstreamThreadsLayer = Layer.effectContext(
  Effect.gen(function* () {
    const handed = yield* Handed;
    return Context.make(
      ThreadManagementService,
      ThreadManagementService.of({
        sendToThread: (input: ThreadManagementSendInput) =>
          Ref.update(handed.sent, (sent) => [
            ...sent,
            { threadId: input.threadId, text: input.text },
          ]).pipe(Effect.as({} as never)),
      } as unknown as ThreadManagementService["Service"]),
    ).pipe(
      Context.add(
        ThreadLaunchService,
        ThreadLaunchService.of({
          launch: (input: ThreadLaunchInput) =>
            Ref.update(handed.launched, (launched) => [
              ...launched,
              { threadId: input.threadId, text: input.initialMessage?.text },
            ]).pipe(Effect.as({} as never)),
        } as unknown as ThreadLaunchService["Service"]),
      ),
    );
  }),
);

const testLayer = scheduledRunsLayer.pipe(
  Layer.provide(upstreamThreadsLayer),
  Layer.provideMerge(handedLayer),
  Layer.provideMerge(conversationLayer),
);

const jackson = Effect.gen(function* () {
  const people = yield* PersonAccess;
  const owner = yield* people.firstOwner;
  yield* people.setName({ personId: owner.personId, displayName: "Jackson" });
  return owner.personId;
});

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

/** A task as upstream stores it, bound to a thread or, with `null`, starting one each run. */
const task = Effect.fn("test.task")(function* (threadId: ThreadId | null, prompt: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO scheduled_tasks (
      task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
      workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by,
      creation_source, created_at, updated_at, next_run_at, last_run_at, last_run_status,
      last_run_error, run_count
    ) VALUES (
      ${TASK}, 'Nightly', ${prompt}, 1, '{}', ${PROJECT}, ${threadId}, '{}', '{}', 'full-access',
      'default', 'user', 'web', ${AT}, ${AT}, ${AT}, NULL, 'never', NULL, 0
    )
  `;
});

/** A person's save of the task, through the admission their socket is given. */
const save = Effect.fn("test.save")(function* (personId: string, prompt: string) {
  const session = (yield* device(personId as never, LEVEL_PERMISSIONS.collaborator)).identity;
  const admission = yield* makeCommandAdmission(() => Effect.void, session);
  const sql = yield* SqlClient.SqlClient;
  return yield* admission.upsertScheduledTask(
    { id: ScheduledTaskId.make(TASK), prompt } as ScheduledTaskUpsertInput,
    (input) =>
      Effect.gen(function* () {
        const exists = yield* sql`SELECT 1 FROM scheduled_tasks WHERE task_id = ${TASK}`;
        if (exists.length === 0) yield* task(null, input.prompt);
        else
          yield* sql`UPDATE scheduled_tasks SET prompt = ${input.prompt} WHERE task_id = ${TASK}`;
        return { task: { id: TASK, prompt: input.prompt } as never };
      }).pipe(Effect.orDie),
  );
});

let fired = 0;
/** A run of the task, as upstream's service sends it to a thread. */
const run = Effect.fn("test.run")(function* (threadId: ThreadId, prompt: string) {
  fired += 1;
  const threads = yield* ThreadManagementService;
  return yield* threads.sendToThread({
    projectId: PROJECT,
    commandId: CommandId.make(`scheduled-task:${TASK}:${fired}:scheduled`),
    threadId,
    messageId: MessageId.make(`message:scheduled:${fired}`),
    scheduledTaskId: ScheduledTaskId.make(TASK),
    text: prompt,
    attachments: [],
    mode: "queue",
    createdBy: "user",
    creationSource: "web",
  } as never);
});

const lastSent = Effect.gen(function* () {
  const sent = yield* Ref.get((yield* Handed).sent);
  return sent.at(-1)?.text;
});

const afterNote = (text: string) =>
  text.includes(NOTE_CLOSE) ? text.slice(text.indexOf(NOTE_CLOSE) + NOTE_CLOSE.length + 1) : text;

it.effect("a run names who set its prompt, by their name and level as it runs", () =>
  Effect.gen(function* () {
    yield* jackson;
    const threadId = yield* thread("thread:nightly");
    const priya = yield* personWith("Priya", [
      { scope: { kind: "thread", threadId }, level: "collaborator" },
    ]);
    yield* task(threadId, "Check CI.");
    // Saved by an Owner with the prompt unchanged, the task stays Priya's once she sets it.
    yield* save(priya, "Check CI and report.");
    yield* save(yield* jackson, "Check CI and report.");
    yield* (yield* PersonAccess).setName({ personId: priya, displayName: "Priya R" });

    yield* run(threadId, "Check CI and report.");
    const text = (yield* lastSent)!;
    assert.isTrue(text.startsWith("<j5_shared_conversation>"));
    assert.strictEqual(
      afterNote(text),
      "[Scheduled by Priya R (collaborator)]\n\nCheck CI and report.",
    );

    // Recorded as a person's message is, so a client shows the prompt alone, under her name.
    const authors = yield* (yield* SharedConversation).threadAuthors(priya, threadId);
    const author = authors.authors.find((row) => row.messageId === `message:scheduled:${fired}`)!;
    assert.isTrue(author.you);
    assert.strictEqual(text.slice(author.storedPrefix.length), "Check CI and report.");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a run no person set the prompt of goes as it always did", () =>
  Effect.gen(function* () {
    yield* jackson;
    const threadId = yield* thread("thread:nightly");
    const priya = yield* personWith("Priya", [
      { scope: { kind: "thread", threadId }, level: "collaborator" },
    ]);
    // A task from before, or one an agent scheduled: no one is recorded.
    yield* task(threadId, "Check CI.");
    yield* run(threadId, "Check CI.");
    assert.strictEqual(yield* lastSent, "Check CI.");

    // Priya's prompt, since changed by an agent over MCP, which records no one.
    yield* save(priya, "Check CI and report.");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE scheduled_tasks SET prompt = 'Delete the branch.' WHERE task_id = ${TASK}`;
    yield* run(threadId, "Delete the branch.");
    assert.strictEqual(yield* lastSent, "Delete the branch.");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a run whose scheduler can no longer write fails each time, until it is taken over", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const threadId = yield* thread("thread:nightly");
    const priya = yield* personWith("Priya", [
      { scope: { kind: "thread", threadId }, level: "collaborator" },
    ]);
    yield* task(threadId, "Check CI.");
    yield* save(priya, "Check CI and report.");
    yield* (yield* Access).setLevel({
      personId: priya,
      scope: { kind: "thread", threadId },
      level: "viewer",
    });

    const reason =
      "Not sent: Priya scheduled this task and can no longer write here. Someone who can write takes it over by changing its prompt.";
    assert.strictEqual((yield* Effect.flip(run(threadId, "Check CI and report."))).message, reason);
    // The task is left enabled, so the next run due fails the same way.
    const sql = yield* SqlClient.SqlClient;
    const enabled = yield* sql<{ readonly enabled: number }>`
      SELECT enabled FROM scheduled_tasks WHERE task_id = ${TASK}
    `;
    assert.strictEqual(enabled[0]?.enabled, 1);
    assert.strictEqual((yield* Effect.flip(run(threadId, "Check CI and report."))).message, reason);
    assert.deepStrictEqual(yield* Ref.get((yield* Handed).sent), []);

    // Taken over by changing its prompt, it runs under the person who did.
    yield* save(owner, "Check CI and tell me.");
    yield* run(threadId, "Check CI and tell me.");
    assert.strictEqual(
      afterNote((yield* lastSent)!),
      "[Scheduled by Jackson (owner)]\n\nCheck CI and tell me.",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a run that starts a thread in a shared project is named on that thread", () =>
  Effect.gen(function* () {
    yield* jackson;
    const priya = yield* personWith("Priya", [
      { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
    ]);
    yield* save(priya, "Summarise the day.");
    const launch = yield* ThreadLaunchService;
    const input = (projectId: ProjectId) =>
      ({
        commandId: CommandId.make(`scheduled-task:${TASK}:launch:${projectId}`),
        projectId,
        title: "Nightly",
        initialMessage: {
          messageId: MessageId.make(`message:scheduled:launch:${projectId}`),
          scheduledTaskId: ScheduledTaskId.make(TASK),
          text: "Summarise the day.",
          attachments: [],
        },
      }) as never;
    yield* launch.launch(input(PROJECT));
    // A project only its owner writes to starts a thread as upstream would.
    yield* launch.launch(input(ProjectId.make("project:alone")));

    const [shared, alone] = yield* Ref.get((yield* Handed).launched);
    assert.match(shared!.threadId!, /^thread:j5:scheduled:[0-9a-f]{32}$/);
    assert.strictEqual(
      afterNote(shared!.text!),
      "[Scheduled by Priya (collaborator)]\n\nSummarise the day.",
    );
    assert.deepStrictEqual(alone, { threadId: undefined, text: "Summarise the day." });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("someone else's edit of a queued run keeps it scheduled and says who edited it", () =>
  Effect.gen(function* () {
    const owner = yield* jackson;
    const threadId = yield* thread("thread:nightly");
    const priya = yield* personWith("Priya", [
      { scope: { kind: "thread", threadId }, level: "collaborator" },
    ]);
    yield* task(threadId, "Check CI.");
    yield* save(priya, "Check CI and report.");
    yield* run(threadId, "Check CI and report.");
    const messageId = `message:scheduled:${fired}`;
    // Queued as upstream records a scheduled run.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        ${`run:${messageId}`}, ${threadId}, 0, 'codex', 'queued', ${AT},
        ${JSON.stringify({ userMessageId: messageId, startedAt: null })}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json
      ) VALUES (
        ${messageId}, ${threadId}, ${`run:${messageId}`}, 'user', 0, ${AT}, ${AT},
        ${JSON.stringify({ createdBy: "user", creationSource: "web", scheduledTaskId: TASK })}
      )
    `;
    const edited = yield* (yield* SharedConversation).dispatch(
      owner,
      {
        type: "queued-run.edit",
        commandId: CommandId.make("command:edit"),
        threadId,
        runId: RunId.make(`run:${messageId}`),
        text: "Check CI only.",
      } as unknown as OrchestrationV2Command,
      Effect.succeed,
    );
    assert.strictEqual(
      afterNote((edited as { readonly text: string }).text),
      "[Scheduled by Priya (collaborator), edited by Jackson (owner)]\n\nCheck CI only.",
    );
  }).pipe(Effect.provide(testLayer)),
);
