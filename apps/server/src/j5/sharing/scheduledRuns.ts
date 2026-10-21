// @effect-diagnostics nodeBuiltinImport:off - a thread id derived from a run's command id.
import * as NodeCrypto from "node:crypto";

import {
  type CommandId,
  MessageId,
  type ProjectId,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorDispatchError } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import { authorLabel } from "./authorLabel.ts";
import { type Author, makeMessageStamps, prefixOf } from "./messageStamps.ts";
import { PersonAccess, layer as personAccessLayer } from "./PersonAccess.ts";
import { SharedThreads, layer as sharedThreadsLayer } from "./SharedThreads.ts";

/**
 * A scheduled task's runs in a shared conversation (Shared conversations AC20). Each run reaches
 * the agent beginning with a line the platform writes naming who scheduled the task: the person
 * who created it, or who last changed its prompt. A task no person is recorded for, one an agent
 * scheduled over MCP or one from before this, runs with no line, as it always did.
 */

/** The line a scheduled run carries in place of an author's line. */
export const scheduledLine = (author: Author, editedBy: Author | null = null) =>
  editedBy === null
    ? `[Scheduled by ${authorLabel(author)}]`
    : `[Scheduled by ${authorLabel(author)}, edited by ${authorLabel(editedBy)}]`;

/**
 * Records who scheduled a task as a person saves it: whoever creates it, and whoever changes its
 * prompt. `before` is its prompt before the save, `null` for a new task. An agent's change over
 * MCP is not recorded, so the person recorded no longer set the prompt that runs and the task's
 * runs name no one (`schedulerOf`).
 */
export const recordScheduler = Effect.fn("j5.sharing.scheduledRuns.recordScheduler")(function* (
  personId: ParticipantId,
  task: Pick<ScheduledTask, "id" | "prompt">,
  before: string | null,
) {
  if (before === task.prompt) return;
  const sql = yield* SqlClient.SqlClient;
  const recordedAt = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO j5_a2a_task_scheduler (task_id, person_id, prompt, recorded_at)
    VALUES (${task.id}, ${personId}, ${task.prompt}, ${recordedAt})
    ON CONFLICT (task_id) DO UPDATE SET
      person_id = excluded.person_id,
      prompt = excluded.prompt,
      recorded_at = excluded.recorded_at
  `;
});

/** A task's prompt as it is stored, before a save changes it; `null` for a task not yet made. */
export const storedPrompt = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly prompt: string }>`
      SELECT prompt FROM scheduled_tasks WHERE task_id = ${taskId}
    `;
    return rows[0]?.prompt ?? null;
  });

/**
 * A run not sent because the person it would name can no longer write where it goes. Its message
 * is the run's error in the task list. The task stays as it is, so each run fails the same way
 * until someone who can write changes its prompt, which makes it theirs.
 */
const TAKE_OVER = "Someone who can write takes it over by changing its prompt.";

export class J5ScheduledRunNotSentError extends OrchestratorDispatchError.extend<J5ScheduledRunNotSentError>(
  "J5ScheduledRunNotSentError",
)({
  scheduler: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    return this.scheduler === null
      ? `Not sent: whoever scheduled this task can no longer write here. ${TAKE_OVER}`
      : `Not sent: ${this.scheduler} scheduled this task and can no longer write here. ${TAKE_OVER}`;
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* PersonAccess;
  const shared = yield* SharedThreads;
  // A client reads a run's author when its message arrives with none read yet, and the author is
  // written before the message is, so there is nothing to move here.
  const { authorOn, announce, recordAuthor } = yield* makeMessageStamps(() => Effect.void);

  /** Who scheduled a task, while its prompt is still the one they left; else `null`. */
  const schedulerOf = (taskId: string) =>
    sql<{ readonly person_id: string }>`
      SELECT scheduler.person_id
      FROM j5_a2a_task_scheduler AS scheduler
      JOIN scheduled_tasks AS task
        ON task.task_id = scheduler.task_id AND task.prompt = scheduler.prompt
      WHERE scheduler.task_id = ${taskId}
    `.pipe(Effect.map((rows) => (rows[0]?.person_id ?? null) as ParticipantId | null));

  /**
   * A run's text as the agent reads it, on a thread that is a shared conversation: its
   * scheduler's line, and any note due. Unchanged where no person is recorded for it. When its
   * scheduler can no longer write there, the run is not sent.
   */
  const stamp = Effect.fn("j5.sharing.scheduledRuns.stamp")(function* (input: {
    readonly taskId: string;
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly launchingIn: ProjectId | null;
  }) {
    const personId = yield* schedulerOf(input.taskId);
    if (personId === null) return input.text;
    const author = yield* authorOn(personId, input.threadId, input.launchingIn);
    if (author === null) {
      const person = yield* people.readPerson(personId);
      return yield* new J5ScheduledRunNotSentError({
        commandId: input.commandId,
        commandType: "message.dispatch",
        scheduler: person?.displayName ?? null,
      });
    }
    const carried = yield* announce(input.threadId, input.launchingIn);
    const prefix = prefixOf(carried.note, scheduledLine(author));
    yield* recordAuthor(input.threadId, input.messageId, author, carried, prefix);
    return `${prefix}${input.text}`;
  });

  const inner = {
    threads: yield* ThreadManagementService,
    launch: yield* ThreadLaunchService,
  };

  const threads = ThreadManagementService.of({
    ...inner.threads,
    sendToThread: (input) =>
      Effect.gen(function* () {
        const taskId = input.scheduledTaskId;
        if (taskId === undefined) return yield* inner.threads.sendToThread(input);
        const text = yield* Effect.gen(function* () {
          if (!(yield* shared.isShared(input.threadId))) return input.text;
          return yield* stamp({
            taskId,
            commandId: input.commandId,
            threadId: input.threadId,
            messageId: input.messageId ?? MessageId.make(`message:j5:scheduled:${input.commandId}`),
            text: input.text,
            launchingIn: null,
          });
        }).pipe(Effect.catch(failRun(input.commandId)));
        return yield* inner.threads.sendToThread({ ...input, text });
      }),
  });

  const launch = ThreadLaunchService.of({
    ...inner.launch,
    launch: (input) =>
      Effect.gen(function* () {
        const first = input.initialMessage;
        const taskId = first?.scheduledTaskId;
        if (first === undefined || taskId === undefined || input.threadId !== undefined) {
          return yield* inner.launch.launch(input);
        }
        const stamped = yield* Effect.gen(function* () {
          // A shared conversation's messages are recorded under their thread, so the run's thread
          // is named before it is made, the same for each retry of the run's command.
          const threadId = ThreadId.make(
            `thread:j5:scheduled:${NodeCrypto.createHash("sha256").update(input.commandId).digest("hex").slice(0, 32)}`,
          );
          if (!(yield* shared.isShared(threadId, input.projectId))) return input;
          const messageId =
            first.messageId ?? MessageId.make(`message:j5:scheduled:${input.commandId}`);
          const text = yield* stamp({
            taskId,
            commandId: input.commandId,
            threadId,
            messageId,
            text: first.text,
            launchingIn: input.projectId,
          });
          return { ...input, threadId, initialMessage: { ...first, messageId, text } };
        }).pipe(Effect.catch(failRun(input.commandId)), Effect.orDie);
        return yield* inner.launch.launch(stamped);
      }),
  });

  return { threads, launch };
});

/**
 * A run that could not be taken in fails, and upstream records the failure as the run's error: a
 * run its scheduler can no longer send as itself, anything else as not sent, never sent without its
 * line.
 */
const isNotSent = Schema.is(J5ScheduledRunNotSentError);
const failRun = (commandId: CommandId) => (cause: unknown) =>
  isNotSent(cause)
    ? Effect.fail(cause)
    : Effect.logError("J5 could not name who scheduled a run; not sending it", { cause }).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestratorDispatchError({
              commandId,
              commandType: "message.dispatch",
              cause,
            }),
          ),
        ),
      );

/**
 * Upstream's thread management and launch as its scheduled-task service sees them: a run on a
 * shared conversation names who scheduled it (FORK.md case 81). Over the server's one
 * `PersonAccess` and `SharedThreads` (the same layer objects, so the same instances).
 */
export const layer: Layer.Layer<
  ThreadManagementService | ThreadLaunchService,
  never,
  ThreadManagementService | ThreadLaunchService | SqlClient.SqlClient
> = Layer.effectContext(
  make.pipe(
    Effect.map(({ threads, launch }) =>
      Context.make(ThreadManagementService, threads).pipe(Context.add(ThreadLaunchService, launch)),
    ),
  ),
).pipe(Layer.provide(sharedThreadsLayer), Layer.provide(personAccessLayer));
