// @effect-diagnostics nodeBuiltinImport:off - a random id for a command of the platform's own.
import * as NodeCrypto from "node:crypto";

import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentAuthorizationError,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectId,
  type RunId,
  type ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import type {
  MessageAuthor,
  PromptAnswer,
  ThreadAuthors,
  ThreadAuthorsChange,
  WriterLevel,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import { Access } from "./Access.ts";
import { authorLabel, beginsWithSlash, personNameInLine } from "./authorLabel.ts";
import {
  PersonAccess,
  type PersonAccessStorageError,
  layer as personAccessLayer,
} from "./PersonAccess.ts";
import { SharedThreads, type ThreadWriter } from "./SharedThreads.ts";
import { Writer, changeNote, firstNote } from "./sharedConversationNotes.ts";

/**
 * A shared conversation: a thread more than one person can write to, which stays one
 * (docs/j5/product/features/shared-conversations.md). In one, every message a person sends
 * reaches the agent beginning with its author's line, and the platform's note tells the agent who
 * can write when that changes. A thread only one person has ever been able to write to passes
 * through here untouched (AC2).
 */

/** A person as the agent is told of them: a name and their level where they wrote. */
interface Author {
  readonly personId: ParticipantId;
  readonly displayName: string | null;
  readonly level: WriterLevel;
}

/**
 * The line the platform puts first on a person's message in a shared conversation (AC1), in the
 * shape J5 gives a person's reply to an agent (`envelopes.v1.json`). It is always the message's
 * first line of the person's own, and their text always follows it, so text a person types to
 * look like this line, or like a note, sits below their real one.
 */
export const authorLine = (author: Author, editedBy: Author | null = null) =>
  editedBy === null
    ? `[Message from ${authorLabel(author)}]`
    : `[Message from ${authorLabel(author)}, edited by ${authorLabel(editedBy)}]`;

/**
 * What the platform puts first on a person's answer to a question the agent asked (AC11). An
 * answer does not pass through a message of the person's own: on some providers upstream writes
 * it into a message, on others it goes back as the result of the agent's tool call. Either way
 * the agent reads the answer's words, so its author goes on the words.
 */
export const answerLine = (author: Author) => `[Answer from ${authorLabel(author)}]`;

/** A question's answers with their author on each: on the text, or first among chosen options. */
const answersFrom = (answers: Readonly<Record<string, unknown>>, author: Author) =>
  Object.fromEntries(
    Object.entries(answers).map(([question, answer]) => [
      question,
      typeof answer === "string"
        ? `${answerLine(author)} ${answer}`
        : Array.isArray(answer)
          ? [answerLine(author), ...answer]
          : answer,
    ]),
  );

/** The platform's text a stored message begins with: the note it carries, then the author's line. */
const prefixOf = (note: string | null, line: string) =>
  `${note === null ? "" : `${note}\n`}${line}\n\n`;

const refused = (message: string) =>
  new EnvironmentAuthorizationError({
    message,
    ...authScopeRequiredResponse(AuthOrchestrationOperateScope),
  });

const notAdmitted = refused("This could not be sent. Try again.");

/**
 * A context record of a kind the platform keeps for itself (AC8): only the platform sends one.
 * Nothing sends one today; the rule holds the namespace for when it does.
 */
const isPlatformRecord = (record: unknown) => {
  const kind =
    typeof record === "object" && record !== null && "kind" in record ? record.kind : undefined;
  return typeof kind === "string" && kind.trim().toLowerCase().startsWith("j5");
};
const carriesPlatformRecord = (context: { readonly records: ReadonlyArray<unknown> } | undefined) =>
  context?.records.some(isPlatformRecord) === true;

interface AuthorRow {
  readonly message_id: string;
  readonly person_id: string;
  readonly display_name: string | null;
  readonly level: WriterLevel;
  readonly edited_by: string | null;
  readonly note: string | null;
  readonly told_json: string | null;
  readonly stored_prefix: string;
}

/** Who a message that carries a note told the agent can write. */
const Told = Schema.fromJsonString(Schema.Array(Writer));
const decodeTold = Schema.decodeEffect(Told);
const encodeTold = Schema.encodeEffect(Told);

/**
 * The event upstream logs when a prompt is answered. Typed against upstream's own event union, so
 * a rename there fails to compile here.
 */
export const PROMPT_SETTLED_EVENT =
  "runtime-request.updated" satisfies OrchestrationV2StoredEvent["event"]["type"];

/** A message's run as upstream records it, read beside a message that carried a note. */
interface CarrierRun {
  /** `null` when upstream has no such message. */
  readonly carried: string | null;
  readonly status: string | null;
  readonly started_at: string | null;
}

/**
 * Whether what a message carried never reached the agent, or no longer counts as having: upstream
 * never took the message in; its run ended without ever starting (withdrawn or cancelled while
 * queued, failed while its workspace was prepared, or cut short by a crash); or its run was
 * rolled back, which takes the agent's conversation back to before it.
 */
const ENDED_UNFINISHED: ReadonlySet<string> = new Set([
  "cancelled",
  "failed",
  "interrupted",
] satisfies ReadonlyArray<OrchestrationV2Run["status"]>);
const lost = (run: CarrierRun) =>
  run.carried === null ||
  run.status === ("rolled_back" satisfies OrchestrationV2Run["status"]) ||
  (run.status !== null && ENDED_UNFINISHED.has(run.status) && run.started_at === null);

const QUEUED = "queued" satisfies OrchestrationV2Run["status"];

export interface SharedConversationShape {
  /**
   * A client's command as it goes on to upstream, after `CommandAdmission` has checked that its
   * sender may send it. `personId` is the person on the connection; `null` for a service session,
   * whose commands are not a person's. A message for a shared conversation gains its author's line
   * and any note due; an edit of one keeps its author's; an answer to a question carries who gave
   * it. Who is answering a prompt is written down. A command carrying a context record of the
   * platform's own kind is refused (AC8).
   */
  readonly admit: (
    personId: ParticipantId | null,
    command: OrchestrationV2Command,
  ) => Effect.Effect<OrchestrationV2Command, EnvironmentAuthorizationError>;
  /**
   * A client's request to start a thread, as it goes on to upstream. A new thread's first message
   * does not come as a command: upstream's launch sends it itself, so it is taken in here as
   * `admit` takes in a message. A thread born under a scope that is already shared is a shared
   * conversation from its first message.
   */
  readonly admitLaunch: (
    personId: ParticipantId | null,
    input: OrchestrationV2ThreadLaunchInput,
  ) => Effect.Effect<OrchestrationV2ThreadLaunchInput, EnvironmentAuthorizationError>;
  /** Who sent each message and answered each prompt in a thread, for anyone who reads it. */
  readonly threadAuthors: (
    viewer: ParticipantId | null,
    threadId: ThreadId,
  ) => Effect.Effect<ThreadAuthors, SqlError.SqlError | PersonAccessStorageError>;
  /** Moves each time `threadAuthors` would answer differently for the thread. */
  readonly authorsChanges: (threadId: ThreadId) => Stream.Stream<ThreadAuthorsChange>;
  /**
   * How the person answering a Crew roster is named to its Captain, when the Captain's thread is
   * a shared conversation; `null` anywhere else, where the Captain is told what it always was.
   */
  readonly rosterDecider: (
    personId: ParticipantId | null,
    proposalId: string,
  ) => Effect.Effect<string | null>;
  /**
   * Withdraws the messages a person still has queued on threads they can no longer write to
   * (AC16). Run after every change of access; also here for a test to call.
   */
  readonly withdrawQueued: (personId: ParticipantId) => Effect.Effect<void>;
}

export class SharedConversation extends Context.Service<
  SharedConversation,
  SharedConversationShape
>()("t3/j5/sharing/SharedConversation") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* PersonAccess;
  const shared = yield* SharedThreads;
  const threads = yield* ThreadManagementService;
  const changed = yield* Effect.acquireRelease(PubSub.unbounded<ThreadId>(), PubSub.shutdown);
  const touch = (threadId: ThreadId) => PubSub.publish(changed, threadId);

  const writerLabel = (writer: ThreadWriter): Writer => ({
    personId: writer.personId,
    level: writer.level,
    label: authorLabel(writer),
  });

  /** The person on a connection as an author on a thread; `null` for one who cannot write it. */
  const authorOn = Effect.fn("j5.sharing.sharedConversation.authorOn")(function* (
    personId: ParticipantId,
    threadId: ThreadId,
    launchingIn: ProjectId | null = null,
  ) {
    const person = yield* people.readPerson(personId);
    if (person === null) return null;
    const level =
      launchingIn === null
        ? yield* shared.writerLevel(personId, threadId)
        : ((yield* shared.writers(threadId, launchingIn)).find(
            (writer) => writer.personId === personId,
          )?.level ?? null);
    return level === null
      ? null
      : ({ personId, displayName: person.displayName, level } satisfies Author);
  });

  /**
   * Whether upstream's own log shows that the command an answer was written for settled its
   * prompt, as a condition on `j5_a2a_prompt_answer AS answer`. Upstream answers "accepted" again
   * for any command id it has already taken on the thread, so its saying so is not proof. The
   * event that settles a prompt carries the id of the command that did it:
   * `orchestration_events` is upstream's log, a thread's events are its stream, and this event's
   * payload is the request itself (`SharedConversation.integration.test.ts` pins these).
   */
  const settledItsPrompt = sql`EXISTS (
    SELECT 1 FROM orchestration_events AS event
    WHERE event.command_id = answer.command_id
      AND event.aggregate_kind = 'thread'
      AND event.stream_id = answer.thread_id
      AND event.event_type = ${PROMPT_SETTLED_EVENT}
      AND json_extract(event.payload_json, '$.id') = answer.request_id
  )`;

  /**
   * Who the agent was last told can write to a thread: what the newest message known to have
   * reached it with a note said. `null` for an agent that has been told nothing that still
   * stands. A note on a message still waiting in the queue has told the agent nothing yet, and
   * may never, since the message can be withdrawn. So until one is known to have run, every
   * message carries the note (AC4).
   *
   * Read from upstream's own records by SQL: a message's `run_id`, a run's `status` and the
   * `startedAt` in its payload (`SharedConversation.integration.test.ts` fails if upstream
   * reshapes them). It is asked when the next message arrives, so every way a message can be
   * lost, a rewind included, is covered without a hook on any of them.
   */
  const lastTold = Effect.fn("j5.sharing.sharedConversation.lastTold")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<CarrierRun & { readonly told_json: string }>`
      SELECT author.told_json, message.message_id AS carried,
        run.status AS status, json_extract(run.payload_json, '$.startedAt') AS started_at
      FROM j5_a2a_message_author AS author
      LEFT JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = author.message_id
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
      WHERE author.thread_id = ${threadId} AND author.told_json IS NOT NULL
      ORDER BY author.rowid DESC
    `;
    const reached = rows.find((row) => !lost(row) && row.status !== QUEUED);
    return reached === undefined ? null : yield* decodeTold(reached.told_json);
  });

  /** Who wrote a thread's messages from before it was shared, when it has any. */
  const earlierAuthor = Effect.fn("j5.sharing.sharedConversation.earlierAuthor")(function* (
    threadId: ThreadId,
  ) {
    const earlier = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND role = 'user'
      LIMIT 1
    `;
    if (earlier.length === 0) return null;
    // Only one person could write to the thread then, and the first owner writes to every one.
    const owner = yield* people.firstOwner;
    return authorLabel({ displayName: owner.displayName, level: "owner" });
  });

  /**
   * What the agent must be told about who can write to its thread (AC3, AC4) as a person's
   * message is taken in. When it differs from what the agent was last told, the note goes at the
   * top of this message, and `told` is kept on the message's author record: this message is now
   * the note's carrier. A change of access therefore wakes no agent and costs no turn of its own.
   */
  const announce = Effect.fn("j5.sharing.sharedConversation.announce")(function* (
    threadId: ThreadId,
    launchingIn: ProjectId | null,
  ) {
    const now = (yield* shared.writers(threadId, launchingIn)).map(writerLabel);
    const last = yield* lastTold(threadId);
    const note =
      last === null
        ? firstNote(now, launchingIn === null ? yield* earlierAuthor(threadId) : null)
        : changeNote(last, now);
    return { note, told: note === null ? null : yield* encodeTold(now) };
  });

  const recordAuthor = Effect.fn("j5.sharing.sharedConversation.recordAuthor")(function* (
    threadId: ThreadId,
    messageId: MessageId,
    author: Author,
    carried: { readonly note: string | null; readonly told: string | null },
    storedPrefix: string,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // The first record of a message stands: a later send cannot take a message over.
    yield* sql`
      INSERT INTO j5_a2a_message_author (
        thread_id, message_id, person_id, display_name, level, note, told_json, stored_prefix,
        created_at
      ) VALUES (
        ${threadId}, ${messageId}, ${author.personId}, ${author.displayName}, ${author.level},
        ${carried.note}, ${carried.told}, ${storedPrefix}, ${createdAt}
      )
      ON CONFLICT (thread_id, message_id) DO NOTHING
    `;
    yield* touch(threadId);
  });

  /**
   * A person's message taken in on a shared thread: recorded under its author, and returned as
   * the agent will read it. A command goes on as typed (AC5).
   */
  const stampMessage = Effect.fn("j5.sharing.sharedConversation.stampMessage")(function* (
    threadId: ThreadId,
    messageId: MessageId,
    text: string,
    author: Author,
    launchingIn: ProjectId | null,
  ) {
    if (beginsWithSlash(text)) {
      yield* recordAuthor(threadId, messageId, author, { note: null, told: null }, "");
      return text;
    }
    const carried = yield* announce(threadId, launchingIn);
    const prefix = prefixOf(carried.note, authorLine(author));
    yield* recordAuthor(threadId, messageId, author, carried, prefix);
    return `${prefix}${text}`;
  });

  /** The message a queued run would deliver, by upstream's own record of the run. */
  const queuedMessageId = (threadId: ThreadId, runId: RunId) =>
    sql<{ readonly message_id: string | null }>`
      SELECT json_extract(payload_json, '$.userMessageId') AS message_id
      FROM orchestration_v2_projection_runs
      WHERE run_id = ${runId} AND thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.message_id ?? null));

  const messageAuthor = (threadId: ThreadId, messageId: string) =>
    sql<AuthorRow>`
      SELECT message_id, person_id, display_name, level, edited_by, note, told_json,
        stored_prefix
      FROM j5_a2a_message_author
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  /**
   * A queued message edited (AC15): it stays under its author, with "edited by" when someone else
   * edited it, and keeps the note it carries. A client that sends the stored text back has the
   * platform's text taken off it before it is written again. Edited into a command, it goes on as
   * typed and carries nothing; edited out of one, it is stamped as a new message would be.
   */
  const stampEdit = Effect.fn("j5.sharing.sharedConversation.stampEdit")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
    editor: Author,
  ) {
    const messageId = yield* queuedMessageId(command.threadId, command.runId);
    const original = messageId === null ? null : yield* messageAuthor(command.threadId, messageId);
    // A queued message no person is recorded for (one from before the thread was shared, or an
    // agent's or the platform's) is edited as upstream has it.
    if (messageId === null || original === null) return command;
    const typed =
      original.stored_prefix.length > 0 && command.text.startsWith(original.stored_prefix)
        ? command.text.slice(original.stored_prefix.length)
        : command.text;
    const author: Author = {
      personId: original.person_id as ParticipantId,
      displayName: original.display_name,
      level: original.level,
    };
    const editedBy = editor.personId === author.personId ? null : editor;
    const carried = beginsWithSlash(typed)
      ? { note: null, told: null }
      : original.told_json !== null
        ? { note: original.note, told: original.told_json }
        : yield* announce(command.threadId, null);
    const prefix = beginsWithSlash(typed)
      ? ""
      : prefixOf(carried.note, authorLine(author, editedBy));
    yield* sql`
      UPDATE j5_a2a_message_author
      SET stored_prefix = ${prefix}, note = ${carried.note}, told_json = ${carried.told},
        edited_by = ${editedBy === null ? null : editorName(editedBy)}
      WHERE thread_id = ${command.threadId} AND message_id = ${messageId}
    `;
    yield* touch(command.threadId);
    return { ...command, text: `${prefix}${typed}` };
  });

  /**
   * Writes down who is answering a prompt (AC11), on a shared thread. It is a claim, kept for each
   * command that answers: who answered is read as the claim whose command upstream's log shows
   * settled the prompt (`settledItsPrompt`), so an answer upstream refuses, one that loses to an
   * earlier answer, and a replayed command id all name no one. The first claim for a command
   * stands. A failure to record is logged and does not stop the answer.
   */
  const recordAnswer = (personId: ParticipantId, command: OrchestrationV2Command) =>
    command.type !== "runtime-request.respond" && command.type !== "thread.user-input.dismiss"
      ? Effect.void
      : Effect.gen(function* () {
          if (!(yield* shared.isShared(command.threadId))) return;
          const author = yield* authorOn(personId, command.threadId);
          if (author === null) return;
          const answeredAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO j5_a2a_prompt_answer (
              thread_id, request_id, command_id, person_id, display_name, level, answered_at
            ) VALUES (
              ${command.threadId}, ${command.requestId}, ${command.commandId},
              ${author.personId}, ${author.displayName}, ${author.level}, ${answeredAt}
            )
            ON CONFLICT (thread_id, request_id, command_id) DO NOTHING
          `;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("J5 shared conversation could not record who answered a prompt", {
              cause,
            }),
          ),
        );

  const stampCommand = Effect.fn("j5.sharing.sharedConversation.stampCommand")(function* (
    personId: ParticipantId,
    command: OrchestrationV2Command,
  ) {
    switch (command.type) {
      case "message.dispatch": {
        if (!(yield* shared.isShared(command.threadId))) return command;
        const author = yield* authorOn(personId, command.threadId);
        if (author === null) return command;
        const text = yield* stampMessage(
          command.threadId,
          command.messageId,
          command.text,
          author,
          null,
        );
        return { ...command, text };
      }
      case "queued-run.edit": {
        if (!(yield* shared.isShared(command.threadId))) return command;
        const editor = yield* authorOn(personId, command.threadId);
        return editor === null ? command : yield* stampEdit(command, editor);
      }
      case "runtime-request.respond": {
        // An answer in words says whose it is, as a message does; an approval carries no words.
        if (command.answers === undefined) return command;
        if (!(yield* shared.isShared(command.threadId))) return command;
        const author = yield* authorOn(personId, command.threadId);
        return author === null
          ? command
          : { ...command, answers: answersFrom(command.answers, author) };
      }
      default:
        return command;
    }
  });

  const failClosed = (cause: unknown) =>
    Effect.logError("J5 shared conversation could not take in a command; refusing it", {
      cause,
    }).pipe(Effect.andThen(Effect.fail(notAdmitted)));

  const admit: SharedConversationShape["admit"] = (personId, command) =>
    Effect.gen(function* () {
      if (
        (command.type === "message.dispatch" || command.type === "queued-run.edit") &&
        carriesPlatformRecord(command.context)
      ) {
        return yield* refused("A message cannot carry a record of the platform's own.");
      }
      if (personId === null) return command;
      const admitted = yield* stampCommand(personId, command).pipe(Effect.catch(failClosed));
      yield* recordAnswer(personId, admitted);
      return admitted;
    });

  const admitLaunch: SharedConversationShape["admitLaunch"] = (personId, input) =>
    Effect.gen(function* () {
      const first = input.initialMessage;
      if (first === undefined) return input;
      if (carriesPlatformRecord(first.context)) {
        return yield* refused("A message cannot carry a record of the platform's own.");
      }
      if (personId === null) return input;
      // A launch into a thread that exists writes to it; otherwise its project's writers write.
      const launchingIn =
        input.reuseExistingThread === true && input.threadId !== undefined ? null : input.projectId;
      if (input.threadId === undefined) {
        // No thread is named, so the message cannot be recorded under one; on a project more
        // than one person writes to, that is a launch J5 cannot take in.
        const writers = yield* shared
          .projectWriters(input.projectId)
          .pipe(Effect.catch(failClosed));
        if (writers.length < 2) return input;
        return yield* refused("A thread in a shared project is started with its id.");
      }
      const threadId = input.threadId;
      return yield* Effect.gen(function* () {
        if (!(yield* shared.isShared(threadId, launchingIn))) return input;
        const author = yield* authorOn(personId, threadId, launchingIn);
        if (author === null) return input;
        const messageId =
          first.messageId ?? MessageId.make(`message:j5:launch:${NodeCrypto.randomUUID()}`);
        const text = yield* stampMessage(threadId, messageId, first.text, author, launchingIn);
        return { ...input, initialMessage: { ...first, messageId, text } };
      }).pipe(Effect.catch(failClosed));
    });

  const threadAuthors: SharedConversationShape["threadAuthors"] = Effect.fn(
    "j5.sharing.sharedConversation.threadAuthors",
  )(function* (viewer, threadId) {
    const recorded = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM j5_a2a_shared_thread WHERE thread_id = ${threadId}
    `;
    const authors = yield* sql<AuthorRow & { readonly created_at: string }>`
      SELECT message_id, person_id, display_name, level, edited_by, note, told_json,
        stored_prefix, created_at
      FROM j5_a2a_message_author
      WHERE thread_id = ${threadId}
      ORDER BY created_at, message_id
    `;
    const answers = yield* sql<{
      readonly request_id: string;
      readonly person_id: string;
      readonly display_name: string | null;
      readonly level: WriterLevel;
    }>`
      SELECT answer.request_id, answer.person_id, answer.display_name, answer.level
      FROM j5_a2a_prompt_answer AS answer
      WHERE answer.thread_id = ${threadId} AND ${settledItsPrompt}
      ORDER BY answer.answered_at, answer.request_id
    `;
    return {
      shared: recorded.length > 0,
      authors: authors.map((row): MessageAuthor => ({
        messageId: row.message_id,
        name: row.display_name,
        level: row.level,
        editedBy: row.edited_by,
        you: row.person_id === viewer,
        note: row.note,
        storedPrefix: row.stored_prefix,
      })),
      answers: answers.map((row): PromptAnswer => ({
        requestId: row.request_id,
        name: row.display_name,
        level: row.level,
        you: row.person_id === viewer,
      })),
    } satisfies ThreadAuthors;
  });

  const withdrawQueued: SharedConversationShape["withdrawQueued"] = Effect.fn(
    "j5.sharing.sharedConversation.withdrawQueued",
  )(
    function* (personId) {
      // Upstream's own record of what is queued, read by SQL: a run's `status` and the
      // `userMessageId` in its payload (`SharedConversation.integration.test.ts` fails if
      // upstream reshapes either).
      const queued = yield* sql<{ readonly run_id: string; readonly thread_id: string }>`
        SELECT run.run_id, run.thread_id
        FROM j5_a2a_message_author AS author
        JOIN orchestration_v2_projection_runs AS run
          ON run.thread_id = author.thread_id
         AND run.status = ${QUEUED}
         AND json_extract(run.payload_json, '$.userMessageId') = author.message_id
        WHERE author.person_id = ${personId}
      `;
      const stranded = yield* Effect.filter(queued, (run) =>
        shared
          .writerLevel(personId, run.thread_id as ThreadId)
          .pipe(Effect.map((level) => level === null)),
      );
      yield* Effect.forEach(
        stranded,
        (run) =>
          threads
            .dispatch({
              type: "queued-run.cancel",
              // An id no one can have used before: upstream takes a command whose id it has seen
              // as already done.
              commandId: CommandId.make(
                `command:j5:shared-conversation-withdraw:${run.run_id}:${NodeCrypto.randomUUID()}`,
              ),
              threadId: run.thread_id as ThreadId,
              runId: run.run_id as RunId,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logError("J5 shared conversation could not withdraw a queued message", {
                  cause,
                  runId: run.run_id,
                }),
              ),
            ),
        { discard: true },
      );
    },
    Effect.catch((cause) =>
      Effect.logError("J5 shared conversation could not read a person's queued messages", {
        cause,
      }),
    ),
  );

  // A person who can no longer write to a thread loses what they had queued there (AC16).
  const accessChanges = yield* (yield* Access).subscribe;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(accessChanges).pipe(
        Effect.flatMap((change) =>
          change.kind === "name" ? Effect.void : withdrawQueued(change.personId),
        ),
      ),
    ),
  );

  // Who answered a prompt shows once upstream settles it; each settling moves its thread's
  // authors. Upstream's live tail, from now: a client reads the authors when it subscribes.
  yield* Effect.forkScoped(
    Effect.forever(
      threads.streamDomainEvents.pipe(
        Stream.filter((event) => event.type === PROMPT_SETTLED_EVENT),
        Stream.runForEach((event) => touch(event.threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 shared conversation's prompt stream failed; resuming", {
            cause,
          }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
        ),
      ),
    ),
  );

  return SharedConversation.of({
    admit,
    admitLaunch,
    threadAuthors,
    authorsChanges: (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribed before the first revision is told, so no change after it is missed.
          const moves = yield* PubSub.subscribe(changed);
          return Stream.fromSubscription(moves).pipe(
            Stream.filter((moved) => moved === threadId),
            Stream.mapAccum(
              () => 0,
              (revision) => [revision + 1, [{ revision: revision + 1 }]] as const,
            ),
            Stream.prepend([{ revision: 0 }]),
          );
        }),
      ),
    rosterDecider: (personId, proposalId) =>
      Effect.gen(function* () {
        if (personId === null) return null;
        const rows = yield* sql<{ readonly captain_thread_id: string }>`
          SELECT captain_thread_id FROM j5_agent_crew_proposal WHERE id = ${proposalId}
        `;
        const threadId = rows[0]?.captain_thread_id as ThreadId | undefined;
        if (threadId === undefined || !(yield* shared.isShared(threadId))) return null;
        const author = yield* authorOn(personId, threadId);
        return author === null ? null : authorLabel(author);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("J5 shared conversation could not name who answered a roster", {
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
    withdrawQueued,
  });
});

/** The name an edit is shown under, as the author's is: the name they had then. */
const editorName = (editor: Author) =>
  editor.displayName === null
    ? authorLabel(editor)
    : personNameInLine(editor.displayName) || authorLabel(editor);

/** Over the server's one `PersonAccess` (the same layer object, so the same instance). */
export const layer: Layer.Layer<
  SharedConversation,
  never,
  SqlClient.SqlClient | SharedThreads | ThreadManagementService | Access
> = Layer.effect(SharedConversation, make).pipe(Layer.provide(personAccessLayer));
