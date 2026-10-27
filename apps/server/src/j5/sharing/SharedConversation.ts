// @effect-diagnostics nodeBuiltinImport:off - a random id for a command of the platform's own.
import * as NodeCrypto from "node:crypto";

import {
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
import type { LedgerMessageId, ParticipantId } from "../a2a/contracts.ts";
import { deliveryMessageId } from "../a2a/DeliveryTransport.ts";
import { A2ALifecycleService } from "../a2a/LifecycleService.ts";
import { Access } from "./Access.ts";
import { authorLabel, beginsWithSlash, personNameInLine } from "./authorLabel.ts";
import {
  PersonAccess,
  PersonAccessStorageError,
  layer as personAccessLayer,
} from "./PersonAccess.ts";
import { SharedThreads } from "./SharedThreads.ts";
import { type Author, makeMessageStamps, prefixOf, refused } from "./messageStamps.ts";
import { scheduledLine } from "./scheduledRuns.ts";

/**
 * A shared conversation: a thread more than one person can write to, which stays one. Each
 * person's message reaches the agent with its author's line, and a note tells the agent who can
 * write when that changes. A thread only one person could ever write to passes untouched (AC2).
 */

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
 * What the platform puts first on a person's answer to a question the agent asked (AC10). An
 * answer does not pass through a message of the person's own: on some providers upstream writes
 * it into a message, on others it goes back as the result of the agent's tool call. Either way
 * the agent reads the answer's words, so its author goes on the words.
 */
export const answerLine = (author: Author) => `[Answer from ${authorLabel(author)}]`;

/**
 * A question's answers with their author on each: at the start of the text, or of the first
 * chosen option's text. The mark goes on the option's text rather than in an option of its own,
 * so an answer still holds only the options the person chose.
 */
const answersFrom = (answers: Readonly<Record<string, unknown>>, author: Author) => {
  const mark = (text: string) => `${answerLine(author)} ${text}`;
  return Object.fromEntries(
    Object.entries(answers).map(([question, answer]) => [
      question,
      typeof answer === "string"
        ? mark(answer)
        : Array.isArray(answer) && typeof answer[0] === "string"
          ? [mark(answer[0]), ...answer.slice(1)]
          : answer,
    ]),
  );
};

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

/**
 * The event upstream logs when a prompt is answered. Typed against upstream's own event union, so
 * a rename there fails to compile here.
 */
export const PROMPT_SETTLED_EVENT =
  "runtime-request.updated" satisfies OrchestrationV2StoredEvent["event"]["type"];

const QUEUED = "queued" satisfies OrchestrationV2Run["status"];

/** A command as it goes on to upstream, and what is written once upstream takes it. */
interface Admitted {
  readonly command: OrchestrationV2Command;
  readonly accepted: Effect.Effect<void, SqlError.SqlError>;
}

const admitted = (command: OrchestrationV2Command): Admitted => ({
  command,
  accepted: Effect.void,
});

export interface SharedConversationShape {
  /**
   * A client command, already admitted by `CommandAdmission`, handed to upstream's `dispatch`.
   * `personId` is null for a service session. In a shared conversation a message gains its
   * author's line and any note due, an edit keeps its author, and answers record who gave them. A
   * command carrying a platform-kind context record is refused (AC8).
   */
  readonly dispatch: <A, E, R>(
    personId: ParticipantId | null,
    command: OrchestrationV2Command,
    dispatch: (command: OrchestrationV2Command) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  /**
   * A client's request to start a thread, as it goes on to upstream. A new thread's first message
   * does not come as a command: upstream's launch sends it itself, so it is taken in here as
   * `dispatch` takes in a message. A thread born under a scope that is already shared is a shared
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
   * Writes down who is answering a prompt on a shared thread, for an answer that does not come as
   * a client's command: a Crew seat's approval answered from the inbox (AC10, Crews AC23).
   */
  readonly claimAnswer: (
    personId: ParticipantId,
    answer: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly commandId: CommandId;
    },
  ) => Effect.Effect<void>;
  /**
   * Records a person's reply from the inbox to an agent on a shared thread, as it is accepted: who
   * sent it, by the name and level they have now (People and access AC47), and any note due
   * (AC4), which the reply then carries at its top when it is delivered. Elsewhere, nothing.
   */
  readonly recordReply: (
    personId: ParticipantId,
    reply: { readonly threadId: ThreadId; readonly messageId: LedgerMessageId },
  ) => Effect.Effect<void, PersonAccessStorageError>;
  /**
   * Withdraws the messages a person still has queued on threads they can no longer write to
   * (AC15). Run after every change of access; also here for a test to call.
   */
  readonly withdrawQueued: (personId: ParticipantId) => Effect.Effect<void>;
  /**
   * Ends the open asks to a person that they can no longer answer, because they can no longer
   * write to the asking agent's thread, so no agent waits for a reply that cannot come (Inbox
   * AC14). Run after every change of access, with `withdrawQueued`; also here for a test.
   */
  readonly endUnanswerableAsks: (personId: ParticipantId) => Effect.Effect<void>;
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
  const lifecycle = yield* A2ALifecycleService;
  const changed = yield* Effect.acquireRelease(PubSub.unbounded<ThreadId>(), PubSub.shutdown);
  const touch = (threadId: ThreadId) => PubSub.publish(changed, threadId);
  const { authorOn, announce, recordAuthor } = yield* makeMessageStamps(touch);

  /**
   * Whether upstream's own log shows the answer's command settled its prompt, as a condition on
   * `j5_a2a_prompt_answer AS answer`. Upstream re-accepts any command id it already took, so its
   * "accepted" is no proof; the settling event carries the command id (pinned by
   * `SharedConversation.integration.test.ts`).
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

  const isScheduledRun = (messageId: string) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_messages
      WHERE message_id = ${messageId}
        AND json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL
    `.pipe(Effect.map((rows) => rows.length > 0));

  /**
   * A message upstream holds that no person here is recorded for: one from before the thread was
   * shared, an agent's delivery, a scheduled task's or the platform's. One a person typed before
   * the thread was shared is the first owner's, the only person who could write to it then
   * (AC3); anything else was typed by no one here.
   */
  const unrecordedAuthor = Effect.fn("j5.sharing.sharedConversation.unrecordedAuthor")(function* (
    messageId: string,
  ) {
    const rows = yield* sql<{
      readonly created_by: string | null;
      readonly creation_source: string | null;
      readonly scheduled_task_id: string | null;
      readonly sender_thread_id: string | null;
    }>`
      SELECT json_extract(payload_json, '$.createdBy') AS created_by,
        json_extract(payload_json, '$.creationSource') AS creation_source,
        json_extract(payload_json, '$.scheduledTaskId') AS scheduled_task_id,
        json_extract(payload_json, '$.senderThreadId') AS sender_thread_id
      FROM orchestration_v2_projection_messages WHERE message_id = ${messageId}
    `;
    const row = rows[0];
    // An inbox reply is the person's too, but comes as a delivery ("mcp") and carries its header.
    const typedByOwner =
      row !== undefined &&
      row.created_by === "user" &&
      row.creation_source !== "mcp" &&
      row.scheduled_task_id === null &&
      row.sender_thread_id === null;
    if (!typedByOwner) return null;
    const owner = yield* people.firstOwner;
    return { personId: owner.personId, displayName: owner.displayName, level: "owner" } as Author;
  });

  /**
   * A queued message edited (AC14) stays its author's, with "edited by" for someone else, and keeps
   * its note; returned stored text is stripped first. As a command it carries nothing; out of one,
   * or unrecorded, it is stamped anew. The record is written only once upstream takes the edit and
   * only while the stored text is still this edit's, since upstream may refuse, replay or reorder.
   */
  const stampEdit = Effect.fn("j5.sharing.sharedConversation.stampEdit")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
    editor: Author,
  ) {
    const messageId = yield* queuedMessageId(command.threadId, command.runId);
    // Not a queued run of this thread: upstream refuses the edit.
    if (messageId === null) return admitted(command);
    const recorded = yield* messageAuthor(command.threadId, messageId);
    const original =
      recorded !== null
        ? {
            author: {
              personId: recorded.person_id as ParticipantId,
              displayName: recorded.display_name,
              level: recorded.level,
            } satisfies Author,
            storedPrefix: recorded.stored_prefix,
            note: recorded.note,
            told: recorded.told_json,
          }
        : {
            author: (yield* unrecordedAuthor(messageId)) ?? editor,
            storedPrefix: "",
            note: null,
            told: null,
          };
    const typed =
      original.storedPrefix.length > 0 && command.text.startsWith(original.storedPrefix)
        ? command.text.slice(original.storedPrefix.length)
        : command.text;
    const author = original.author;
    const editedBy = editor.personId === author.personId ? null : editor;
    const carried = beginsWithSlash(typed)
      ? { note: null, told: null }
      : original.told !== null
        ? { note: original.note, told: original.told }
        : yield* announce(command.threadId, null);
    // A scheduled task's run keeps saying it was scheduled, by whom, and who edited it.
    const line =
      recorded !== null && (yield* isScheduledRun(messageId)) ? scheduledLine : authorLine;
    const prefix = beginsWithSlash(typed) ? "" : prefixOf(carried.note, line(author, editedBy));
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const text = `${prefix}${typed}`;
    // Checked in the same statement as the write, so no edit can land between the check and it.
    const record = sql`
      INSERT INTO j5_a2a_message_author (
        thread_id, message_id, person_id, display_name, level, edited_by, note, told_json,
        stored_prefix, created_at
      )
      SELECT ${command.threadId}, ${messageId}, ${author.personId}, ${author.displayName},
        ${author.level}, ${editedBy === null ? null : editorName(editedBy)}, ${carried.note},
        ${carried.told}, ${prefix}, ${createdAt}
      FROM orchestration_v2_projection_messages
      WHERE message_id = ${messageId} AND thread_id = ${command.threadId}
        AND json_extract(payload_json, '$.text') = ${text}
      ON CONFLICT (thread_id, message_id) DO UPDATE SET
        stored_prefix = excluded.stored_prefix,
        note = excluded.note,
        told_json = excluded.told_json,
        edited_by = excluded.edited_by
    `.pipe(Effect.andThen(touch(command.threadId)), Effect.asVoid);
    return { command: { ...command, text }, accepted: record };
  });

  /**
   * Records who is answering a prompt (AC10) as a claim per command; the answerer is the claim
   * whose command upstream's log shows settled it (`settledItsPrompt`), so refused or losing
   * answers name no one. A command's first claim stands; a failed record never stops the answer.
   */
  const recordAnswer = Effect.fn("j5.sharing.sharedConversation.recordAnswer")(
    function* (
      personId: ParticipantId,
      answer: Parameters<SharedConversationShape["claimAnswer"]>[1],
      /** Whether the answer is in words, which carry the answer line. */
      marked: boolean,
    ) {
      if (!(yield* shared.isShared(answer.threadId))) return;
      // A command upstream already took settled nothing now: its prompt, if it settled one, was
      // settled before this, by whoever sent it first. Only a claim made before its command is
      // taken can name who settles a prompt. Upstream's receipt says it took one
      // (`SharedConversation.integration.test.ts` pins the table).
      const taken = yield* sql<{ readonly found: number }>`
        SELECT 1 AS found FROM orchestration_command_receipts
        WHERE command_id = ${answer.commandId}
      `;
      if (taken.length > 0) return;
      const author = yield* authorOn(personId, answer.threadId);
      if (author === null) return;
      const answeredAt = DateTime.formatIso(yield* DateTime.now);
      const storedPrefix = marked ? `${answerLine(author)} ` : "";
      yield* sql`
        INSERT INTO j5_a2a_prompt_answer (
          thread_id, request_id, command_id, person_id, display_name, level, stored_prefix,
          answered_at
        ) VALUES (
          ${answer.threadId}, ${answer.requestId}, ${answer.commandId},
          ${author.personId}, ${author.displayName}, ${author.level}, ${storedPrefix},
          ${answeredAt}
        )
        ON CONFLICT (thread_id, request_id, command_id) DO NOTHING
      `;
    },
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
      case "thread.create": {
        // A thread started under a scope already shared is shared from its start (AC6).
        yield* shared.isShared(command.threadId, command.projectId);
        return admitted(command);
      }
      case "message.dispatch": {
        if (!(yield* shared.isShared(command.threadId))) return admitted(command);
        const author = yield* authorOn(personId, command.threadId);
        if (author === null) return admitted(command);
        const text = yield* stampMessage(
          command.threadId,
          command.messageId,
          command.text,
          author,
          null,
        );
        return admitted({ ...command, text });
      }
      case "queued-run.edit": {
        if (!(yield* shared.isShared(command.threadId))) return admitted(command);
        const editor = yield* authorOn(personId, command.threadId);
        return editor === null ? admitted(command) : yield* stampEdit(command, editor);
      }
      case "runtime-request.respond": {
        // An answer in words says whose it is, as a message does; an approval carries no words.
        if (command.answers === undefined) return admitted(command);
        if (!(yield* shared.isShared(command.threadId))) return admitted(command);
        const author = yield* authorOn(personId, command.threadId);
        return admitted(
          author === null ? command : { ...command, answers: answersFrom(command.answers, author) },
        );
      }
      default:
        return admitted(command);
    }
  });

  const isRefusal = Schema.is(EnvironmentAuthorizationError);
  const failClosed = (cause: unknown) =>
    isRefusal(cause)
      ? Effect.fail(cause)
      : Effect.logError("J5 shared conversation could not take in a command; refusing it", {
          cause,
        }).pipe(Effect.andThen(Effect.fail(notAdmitted)));

  // Upstream has already taken the edit, so a failure to record it is logged and does not undo it.
  const notRecorded = (cause: unknown) =>
    Effect.logError("J5 shared conversation could not record a queued message's edit", { cause });

  const dispatch: SharedConversationShape["dispatch"] = Effect.fn(
    "j5.sharing.sharedConversation.dispatch",
  )(function* <A, E, R>(
    personId: ParticipantId | null,
    command: OrchestrationV2Command,
    dispatchUpstream: (command: OrchestrationV2Command) => Effect.Effect<A, E, R>,
  ) {
    if (
      (command.type === "message.dispatch" || command.type === "queued-run.edit") &&
      carriesPlatformRecord(command.context)
    ) {
      return yield* refused("A message cannot carry a record of the platform's own.");
    }
    if (personId === null) return yield* dispatchUpstream(command);
    const stamp = yield* stampCommand(personId, command).pipe(Effect.catch(failClosed));
    const stamped = stamp.command;
    if (
      stamped.type === "runtime-request.respond" ||
      stamped.type === "thread.user-input.dismiss"
    ) {
      // An answer in words had its mark put on it above; a decision or a dismissal has none.
      const marked = stamped.type === "runtime-request.respond" && stamped.answers !== undefined;
      yield* recordAnswer(personId, stamped, marked);
    }
    const result = yield* dispatchUpstream(stamped);
    yield* stamp.accepted.pipe(Effect.catch(notRecorded));
    return result;
  });

  const admitLaunch: SharedConversationShape["admitLaunch"] = Effect.fn(
    "j5.sharing.sharedConversation.admitLaunch",
  )(function* (personId, input) {
    const first = input.initialMessage;
    if (first !== undefined && carriesPlatformRecord(first.context)) {
      return yield* refused("A message cannot carry a record of the platform's own.");
    }
    // A launch into a thread that exists writes to it; otherwise its project's writers write.
    const launchingIn =
      input.reuseExistingThread === true && input.threadId !== undefined ? null : input.projectId;
    if (first === undefined || personId === null) {
      // A thread started under a scope already shared is shared from its start (AC6), with or
      // without a first message.
      if (input.threadId !== undefined) {
        yield* shared.isShared(input.threadId, launchingIn).pipe(Effect.catch(failClosed));
      }
      return input;
    }
    if (input.threadId === undefined) {
      // No thread is named, so the message cannot be recorded under one; on a project more
      // than one person writes to, that is a launch J5 cannot take in.
      const writers = yield* shared.projectWriters(input.projectId).pipe(Effect.catch(failClosed));
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
    // A fork shows its source's messages up to the fork point (and their sources' before them), as
    // upstream's `buildVisibleTurnItems` does; those keep their authors, and nothing past the fork
    // point is named. A reader need not reach the source, so an inherited record applies only where
    // the shown text begins with its prefix, restating what they already receive.
    const authors = yield* sql<
      AuthorRow & { readonly created_at: string; readonly inherited: 0 | 1 }
    >`
      WITH RECURSIVE source (thread_id, run_id) AS (
        SELECT json_extract(payload_json, '$.forkedFrom.threadId'),
          json_extract(payload_json, '$.forkedFrom.runId')
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.forkedFrom.type') = 'run'
        UNION
        SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId'),
          json_extract(thread.payload_json, '$.forkedFrom.runId')
        FROM source
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = source.thread_id
        WHERE json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
      )
      SELECT message_id, person_id, display_name, level, edited_by, note, told_json,
        stored_prefix, created_at, 0 AS inherited
      FROM j5_a2a_message_author
      WHERE thread_id = ${threadId}
      UNION ALL
      SELECT author.message_id, author.person_id, author.display_name, author.level,
        author.edited_by, author.note, author.told_json, author.stored_prefix, author.created_at,
        1 AS inherited
      FROM source
      JOIN orchestration_v2_projection_runs AS forked_at ON forked_at.run_id = source.run_id
      JOIN j5_a2a_message_author AS author ON author.thread_id = source.thread_id
      JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = author.message_id
      JOIN orchestration_v2_projection_runs AS run
        ON run.run_id = message.run_id AND run.ordinal <= forked_at.ordinal
      WHERE ${viewer === null ? 1 : 0} = 1 OR (
        author.stored_prefix <> ''
        AND substr(json_extract(message.payload_json, '$.text'), 1, length(author.stored_prefix))
          = author.stored_prefix
      )
      ORDER BY created_at, message_id
    `;
    const answers = yield* sql<{
      readonly request_id: string;
      readonly person_id: string;
      readonly display_name: string | null;
      readonly level: WriterLevel;
      readonly stored_prefix: string;
    }>`
      SELECT answer.request_id, answer.person_id, answer.display_name, answer.level,
        answer.stored_prefix
      FROM j5_a2a_prompt_answer AS answer
      WHERE answer.thread_id = ${threadId} AND ${settledItsPrompt}
      ORDER BY answer.answered_at, answer.request_id
    `;
    // An inherited message's writer is named when the reader may know them (`participantVisible`,
    // AC26); otherwise it is told with only its prefix, to take it off.
    const known = new Map<string, boolean>();
    const mayKnow = Effect.fn("j5.sharing.sharedConversation.mayKnowWriter")(function* (
      personId: string,
    ) {
      if (viewer === null) return true;
      const cached = known.get(personId);
      if (cached !== undefined) return cached;
      const visible = yield* people.participantVisible(viewer, {
        participantId: personId,
        threadId: null,
      });
      known.set(personId, visible);
      return visible;
    });
    const told = yield* Effect.forEach(authors, (row) =>
      Effect.gen(function* () {
        const author: MessageAuthor = {
          messageId: row.message_id,
          name: row.display_name,
          level: row.level,
          editedBy: row.edited_by,
          you: row.person_id === viewer,
          note: row.note,
          storedPrefix: row.stored_prefix,
        };
        if (row.inherited === 0 || (yield* mayKnow(row.person_id))) return author;
        return { ...author, name: null, editedBy: null, note: null };
      }),
    );
    return {
      shared: recorded.length > 0,
      authors: told,
      answers: answers.map((row): PromptAnswer => ({
        requestId: row.request_id,
        name: row.display_name,
        level: row.level,
        you: row.person_id === viewer,
        storedPrefix: row.stored_prefix,
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

  const endUnanswerableAsks: SharedConversationShape["endUnanswerableAsks"] = Effect.fn(
    "j5.sharing.sharedConversation.endUnanswerableAsks",
  )(
    function* (personId) {
      const endedAt = DateTime.formatIso(yield* DateTime.now);
      yield* lifecycle.endAsksOf({
        personId,
        endedAt,
        mayAnswer: (asker) =>
          shared.writesTo(personId, {
            threadId: asker.threadId === null ? null : (asker.threadId as ThreadId),
            projectId: asker.projectId,
          }),
      });
    },
    Effect.catch((cause) =>
      Effect.logError(
        "J5 shared conversation could not end the asks a person can no longer answer",
        {
          cause,
        },
      ),
    ),
  );

  // A person who can no longer write to a thread loses what they had queued there (AC15), and
  // the asks to them from its agents end (Inbox AC14).
  const accessChanges = yield* (yield* Access).subscribe;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(accessChanges).pipe(
        Effect.flatMap((change) =>
          change.kind === "name"
            ? Effect.void
            : withdrawQueued(change.personId).pipe(
                Effect.andThen(endUnanswerableAsks(change.personId)),
              ),
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
          }),
        ),
        // A pause before each resumption, whether the stream failed or ended, so it never spins.
        Effect.andThen(Effect.sleep(Duration.seconds(1))),
      ),
    ),
  );

  return SharedConversation.of({
    dispatch,
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
    rosterDecider: Effect.fn("j5.sharing.sharedConversation.rosterDecider")(
      function* (personId, proposalId) {
        if (personId === null) return null;
        const rows = yield* sql<{ readonly captain_thread_id: string }>`
          SELECT captain_thread_id FROM j5_agent_crew_proposal WHERE id = ${proposalId}
        `;
        const threadId = rows[0]?.captain_thread_id as ThreadId | undefined;
        if (threadId === undefined || !(yield* shared.isShared(threadId))) return null;
        const author = yield* authorOn(personId, threadId);
        return author === null ? null : authorLabel(author);
      },
      Effect.catch((cause) =>
        Effect.logError("J5 shared conversation could not name who answered a roster", {
          cause,
        }).pipe(Effect.as(null)),
      ),
    ),
    withdrawQueued,
    endUnanswerableAsks,
    recordReply: Effect.fn("j5.sharing.sharedConversation.recordReply")(
      function* (personId, reply) {
        if (!(yield* shared.isShared(reply.threadId))) return;
        const author = yield* authorOn(personId, reply.threadId);
        if (author === null) return;
        const carried = yield* announce(reply.threadId, null);
        // A client strips the note alone: the reply's own header and closing sentence are its
        // envelope, which the client draws as an inbox reply.
        yield* recordAuthor(
          reply.threadId,
          deliveryMessageId(reply.messageId),
          author,
          carried,
          carried.note === null ? "" : `${carried.note}\n`,
        );
      },
      Effect.mapError((cause) =>
        cause._tag === "PersonAccessStorageError"
          ? cause
          : new PersonAccessStorageError({ operation: "record a reply's author", cause }),
      ),
    ),
    claimAnswer: Effect.fn("SharedConversation.claimAnswer")(function (personId, answer) {
      return recordAnswer(personId, answer, false);
    }),
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
  SqlClient.SqlClient | SharedThreads | ThreadManagementService | Access | A2ALifecycleService
> = Layer.effect(SharedConversation, make).pipe(Layer.provide(personAccessLayer));
