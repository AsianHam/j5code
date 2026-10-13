import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentAuthorizationError,
  type MessageId,
  type OrchestrationV2Command,
  type RunId,
  type ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import type { SharingMessageAuthor, SharingPromptAnswer } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import { ensureLocalOperatorHumanPerson } from "../a2a/HumanPersonRegistry.ts";
import { authorLabel } from "./authorLabel.ts";
import { guestCommand } from "./GuestCommands.ts";
import {
  GUEST_SESSION_SUBJECT,
  PersonAccess,
  type PersonAccessShape,
  type PersonKind,
  type SessionIdentity,
  isCrewSeatThread,
  guestWritesTo,
  isSharedConversation,
  writesVia,
} from "./PersonAccess.ts";
import {
  Writer,
  approvalsLine,
  changeNote,
  firstNote,
  withApprovals,
} from "./sharedConversationNotes.ts";

/**
 * A shared conversation: a thread a guest holds Collaborate on
 * (docs/j5/product/features/shared-conversations.md). In one, every message a person sends
 * reaches the agent under its author's name, and a guest's commands are held to what a guest may
 * do. A thread only one person can write to passes through here untouched.
 */

export { authorLabel } from "./authorLabel.ts";

/** A person as the agent and other people are told of them: a name and where they stand. */
export interface Author {
  readonly personId: ParticipantId;
  readonly kind: PersonKind;
  /** `null` for the server's owner while no name has been set for them. */
  readonly displayName: string | null;
}

/**
 * The line the platform puts first on a person's message in a shared conversation, in the shape
 * J5 gives a person's reply to an agent (`envelopes.v1.json`, `humanReplyEnvelope`). It is always
 * the message's first line and the person's own text always follows it, so text a person types
 * to look like this line, or like a platform note, sits below their real one.
 */
export const authorLine = (author: Pick<Author, "kind" | "displayName">, editedBy?: Author) =>
  editedBy === undefined
    ? `[Message from ${authorLabel(author)}]`
    : `[Message from ${authorLabel(author)}, edited by ${authorLabel(editedBy)}]`;

/**
 * What the platform puts first on a person's answer to a question the agent asked, in a shared
 * conversation. An answer does not pass through a message of the person's own: on some
 * providers upstream writes it into a message itself, on others it goes back as the result of
 * the agent's tool call. Either way the agent reads the answer's words, so its author goes on
 * the words. Everything after this in the answer was typed or chosen by that person.
 */
export const answerLine = (author: Pick<Author, "kind" | "displayName">) =>
  `[Answer from ${authorLabel(author)}]`;

/** A question's answers with their author on each: on the text, or first among chosen options. */
const answersFrom = (
  answers: Readonly<Record<string, unknown>>,
  author: Pick<Author, "kind" | "displayName">,
) =>
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

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A queued message's text without the line the platform put first on it: exactly the line for
 * its recorded author, or that line's "edited by" form. A client that sends the stored text
 * back on an edit has it taken off before it is written again. A first line that only looks
 * like an author line was typed by the person and stays (AC7: no message is altered on account
 * of its content).
 */
export const withoutAuthorLine = (text: string, author: Pick<Author, "kind" | "displayName">) =>
  text.replace(
    new RegExp(
      `^\\[Message from ${escaped(authorLabel(author))}(?:, edited by [^\\]\\n]*)?\\]\\n\\n`,
    ),
    "",
  );

const withAuthorLine = (text: string, author: Author, editedBy?: Author) =>
  `${authorLine(author, editedBy)}\n\n${text}`;

const refused = (message: string) =>
  new EnvironmentAuthorizationError({
    message,
    ...authScopeRequiredResponse(AuthOrchestrationOperateScope),
  });

const notAdmitted = refused("This could not be sent. Try again.");

interface AuthorRow {
  readonly message_id: string;
  readonly person_id: string;
  readonly person_kind: PersonKind;
  readonly display_name: string | null;
  readonly note: string | null;
}

const toAuthor = (row: AuthorRow): Author & { readonly note: string | null } => ({
  personId: row.person_id as ParticipantId,
  kind: row.person_kind,
  displayName: row.display_name,
  note: row.note,
});

const ToldWriters = Schema.fromJsonString(Schema.Array(Writer));
const decodeTold = Schema.decodeEffect(ToldWriters);
const encodeTold = Schema.encodeEffect(ToldWriters);

const NEAREST = { thread: 0, ancestor: 1, project: 2 } as const;

const make = <E>(
  sql: SqlClient.SqlClient,
  access: PersonAccessShape,
  /** Hands upstream a command of the platform's own: the withdrawal of a queued message. */
  dispatch: (command: OrchestrationV2Command) => Effect.Effect<unknown, E>,
) => {
  /**
   * Withdraws the messages a guest still has queued on threads they can no longer write to,
   * after their access changed: a grant removed or lowered, the person removed, or their leaving.
   * It is upstream's own cancelling of a queued run, as the guest could have done themselves.
   * Messages already delivered stay under their name. A withdrawal that fails is logged and does
   * not undo the change to their access.
   */
  const withdrawQueued = Effect.fn("j5.sharing.sharedConversation.withdrawQueued")(
    function* (personId: string) {
      // Upstream's own record of what is queued, read by SQL: a run's `status` and the
      // `userMessageId` in its payload (`SharedConversation.integration.test.ts` fails if
      // upstream reshapes either).
      const queued = yield* sql<{ readonly run_id: string; readonly thread_id: string }>`
        SELECT run.run_id, run.thread_id
        FROM j5_a2a_message_author AS author
        JOIN orchestration_v2_projection_runs AS run
          ON run.thread_id = author.thread_id
         AND run.status = 'queued'
         AND json_extract(run.payload_json, '$.userMessageId') = author.message_id
        WHERE author.person_id = ${personId} AND author.person_kind = 'guest'
      `;
      // Where they may still write is asked of the one rule for it, thread by thread.
      const stranded = yield* Effect.filter(queued, (run) =>
        guestWritesTo(sql, personId, run.thread_id as ThreadId).pipe(
          Effect.map((writes) => !writes),
        ),
      );
      yield* Effect.forEach(
        stranded,
        (run) =>
          dispatch({
            type: "queued-run.cancel",
            // One withdrawal per run, however many times the change is told.
            commandId: CommandId.make(`command:j5:shared-conversation-withdraw:${run.run_id}`),
            threadId: run.thread_id as ThreadId,
            runId: run.run_id as RunId,
          }).pipe(
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

  /**
   * Everyone who can write to a thread, members first; none when no guest holds Collaborate on
   * it, which is a thread that is not a shared conversation.
   */
  const writers = Effect.fn("j5.sharing.sharedConversation.writers")(function* (
    threadId: ThreadId,
  ) {
    // The owner is recorded before they are first needed as a member of the thread.
    yield* ensureLocalOperatorHumanPerson(sql);
    const people = yield* access.threadPeople(threadId);
    const guests = people.guests.filter((guest) =>
      guest.grants.some((grant) => grant.level === "collaborate" && writesVia(grant.via)),
    );
    if (guests.length === 0) return [];
    return [
      ...people.members.map((member): Writer => ({
        personId: member.personId,
        kind: "member",
        label: authorLabel(member),
        purpose: null,
      })),
      ...guests
        .toSorted(
          (left, right) =>
            authorLabel(left.person).localeCompare(authorLabel(right.person)) ||
            left.person.personId.localeCompare(right.person.personId),
        )
        .map((guest): Writer => ({
          personId: guest.person.personId,
          kind: "guest",
          label: authorLabel(guest.person),
          // The line on the grant nearest the thread that carries one.
          purpose:
            guest.grants
              .filter((grant) => grant.note !== null)
              .toSorted((left, right) => NEAREST[left.via] - NEAREST[right.via])[0]?.note ?? null,
        })),
    ];
  });

  /**
   * Whether the note a message carried ever reached the agent. It did not if upstream never
   * took the message in, or if the message was queued and then withdrawn before it ran. Read
   * from upstream's own records by SQL: a message's `run_id`, a run's `status` and the
   * `startedAt` in its payload (`SharedConversation.integration.test.ts` fails if upstream
   * reshapes them).
   */
  const carrierState = (messageId: string) =>
    sql<{ readonly status: string | null; readonly started_at: string | null }>`
      SELECT run.status AS status, json_extract(run.payload_json, '$.startedAt') AS started_at
      FROM orchestration_v2_projection_messages AS message
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
      WHERE message.message_id = ${messageId}
    `.pipe(
      Effect.map((rows): "lost" | "pending" | "delivered" =>
        rows[0] === undefined || (rows[0].status === "cancelled" && rows[0].started_at === null)
          ? "lost"
          : rows[0].status === "queued"
            ? "pending"
            : "delivered",
      ),
    );
  const carrierLost = (messageId: string) =>
    carrierState(messageId).pipe(Effect.map((state) => state === "lost"));

  /**
   * The approvals answered on a thread that its agent has not been told of (AC9), marked as
   * told by the message now being taken in. A telling whose message was withdrawn before it
   * ran is undone first, so those approvals are told again; one whose message is known to have
   * reached the agent is closed and not looked at again. An approval answered while the thread
   * was not shared is never waiting: it was closed when it was recorded.
   */
  const untoldApprovals = Effect.fn("j5.sharing.sharedConversation.untoldApprovals")(function* (
    threadId: ThreadId,
    carrier: MessageId,
  ) {
    const open = yield* sql<{ readonly told_message_id: string }>`
      SELECT DISTINCT told_message_id FROM j5_a2a_prompt_answer
      WHERE thread_id = ${threadId} AND told_message_id IS NOT NULL AND told_delivered = 0
    `;
    for (const { told_message_id } of open) {
      const state = yield* carrierState(told_message_id);
      if (state === "lost") {
        yield* sql`
          UPDATE j5_a2a_prompt_answer SET told_message_id = NULL
          WHERE thread_id = ${threadId} AND told_message_id = ${told_message_id}
        `;
      } else if (state === "delivered") {
        yield* sql`
          UPDATE j5_a2a_prompt_answer SET told_delivered = 1
          WHERE thread_id = ${threadId} AND told_message_id = ${told_message_id}
        `;
      }
    }
    const waiting = yield* sql<{
      readonly person_kind: PersonKind;
      readonly display_name: string | null;
      readonly decision: string;
    }>`
      SELECT person_kind, display_name, decision FROM j5_a2a_prompt_answer
      WHERE thread_id = ${threadId} AND settled = 1 AND decision IS NOT NULL
        AND told_message_id IS NULL AND told_delivered = 0
      ORDER BY answered_at, request_id
    `;
    if (waiting.length === 0) return null;
    yield* sql`
      UPDATE j5_a2a_prompt_answer
      SET told_message_id = ${carrier}
      WHERE thread_id = ${threadId} AND settled = 1 AND decision IS NOT NULL
        AND told_message_id IS NULL AND told_delivered = 0
    `;
    return approvalsLine(
      waiting.map((row) => ({
        label: authorLabel({ kind: row.person_kind, displayName: row.display_name }),
        decision: row.decision,
      })),
    );
  });

  /**
   * Works out what the agent must be told about who can write to its thread (AC3, AC4), as a
   * person's message is taken in, and reports whether the thread is a shared conversation. When
   * that differs from what the agent was last told, the note is returned to go at the top of
   * this message, and this message is recorded as its carrier. A change to a grant therefore
   * wakes no agent and costs no turn of its own.
   *
   * What the agent "was last told" is only what reached it: if the last carrier was withdrawn
   * before it ran, the record falls back to what came before, and this message carries the
   * note instead. That is checked here, when the next message arrives, so every way a queued
   * message can be withdrawn is covered without a hook on any of them.
   *
   * A thread that was never shared costs one lookup by key and one for any Collaborate grant on
   * the server.
   */
  const announce = Effect.fn("j5.sharing.sharedConversation.announce")(function* (
    threadId: ThreadId,
    carrier: MessageId,
  ) {
    const rows = yield* sql<{
      readonly writers_json: string;
      readonly previous_json: string | null;
      readonly carrier_message_id: string;
    }>`
      SELECT writers_json, previous_json, carrier_message_id
      FROM j5_a2a_shared_thread_told WHERE thread_id = ${threadId}
    `;
    const row = rows[0];
    const shared = yield* isSharedConversation(sql, threadId);
    if (row === undefined && !shared) return { shared, note: null };
    const told =
      row === undefined
        ? null
        : (yield* carrierLost(row.carrier_message_id))
          ? row.previous_json === null
            ? null
            : yield* decodeTold(row.previous_json)
          : yield* decodeTold(row.writers_json);
    const now = shared ? yield* writers(threadId) : [];
    // A thread shared again after it stopped being one is told as a thread newly shared.
    const wasShared = told !== null && told.some((writer) => writer.kind === "guest");
    const note = wasShared ? changeNote(told, now) : shared ? firstNote(now) : null;
    // The agent is told who answered its approval prompts while its thread was shared, on the
    // same block: the first note carries any answered before a person's first message, and
    // the last note of a thread that has stopped being shared carries what is left.
    const approvals = wasShared || shared ? yield* untoldApprovals(threadId, carrier) : null;
    if (note === null) {
      // Never told and nothing to tell: shared and unshared with no message in between.
      if (told === null && row !== undefined) {
        yield* sql`DELETE FROM j5_a2a_shared_thread_told WHERE thread_id = ${threadId}`;
      }
      return { shared, note: withApprovals(null, approvals) };
    }
    const toldAt = DateTime.formatIso(yield* DateTime.now);
    const previous = told === null ? null : yield* encodeTold(told);
    yield* sql`
      INSERT INTO j5_a2a_shared_thread_told (
        thread_id, writers_json, previous_json, carrier_message_id, told_at
      ) VALUES (${threadId}, ${yield* encodeTold(now)}, ${previous}, ${carrier}, ${toldAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        writers_json = excluded.writers_json,
        previous_json = excluded.previous_json,
        carrier_message_id = excluded.carrier_message_id,
        told_at = excluded.told_at
    `;
    return { shared, note: withApprovals(note, approvals) };
  });

  /** The person a connection writes as: its guest, or the server's owner for any other. */
  const sessionAuthor = Effect.fn("j5.sharing.sharedConversation.sessionAuthor")(function* (
    session: SessionIdentity,
  ) {
    const guest = yield* access.sessionPerson(session);
    if (guest !== null) return guest.personId === null ? null : guest;
    const owner = yield* access.readPerson(yield* ensureLocalOperatorHumanPerson(sql));
    return owner;
  });

  const messageAuthor = (threadId: ThreadId, messageId: string) =>
    sql<AuthorRow>`
      SELECT message_id, person_id, person_kind, display_name, note
      FROM j5_a2a_message_author
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toAuthor(rows[0]))));

  /** The message a queued run would deliver, by upstream's own record of the run. */
  const queuedMessageId = (threadId: ThreadId, runId: RunId) =>
    sql<{ readonly message_id: string | null }>`
      SELECT json_extract(payload_json, '$.userMessageId') AS message_id
      FROM orchestration_v2_projection_runs
      WHERE run_id = ${runId} AND thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.message_id ?? null));

  const recordAuthor = Effect.fn("j5.sharing.sharedConversation.recordAuthor")(function* (
    threadId: ThreadId,
    messageId: MessageId,
    author: Author,
    note: string | null,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // The first record of a message stands: a later send cannot take a message over.
    yield* sql`
      INSERT INTO j5_a2a_message_author (
        thread_id, message_id, person_id, person_kind, display_name, note, created_at
      ) VALUES (
        ${threadId}, ${messageId}, ${author.personId}, ${author.kind}, ${author.displayName},
        ${note}, ${createdAt}
      )
      ON CONFLICT (thread_id, message_id) DO NOTHING
    `;
  });

  /**
   * A person's message as it is stored and as the agent reads it: the platform's note when this
   * message carries one, then the author line, then what the person typed.
   */
  const stamped = (text: string, author: Author, note: string | null, editedBy?: Author) =>
    `${note === null ? "" : `${note}\n`}${withAuthorLine(text, author, editedBy)}`;

  /**
   * A queued edit's text under its message's author, and its editor when that is someone else.
   * A note the message carries stays on it. What the platform wrote is taken off the text a
   * client sent back before it is written again.
   */
  const stampEdit = (
    text: string,
    original: Author & { readonly note: string | null },
    editor: Author,
  ) => {
    const typed =
      original.note !== null && text.startsWith(`${original.note}\n`)
        ? text.slice(original.note.length + 1)
        : text;
    return stamped(
      withoutAuthorLine(typed, original),
      original,
      original.note,
      editor.personId === original.personId ? undefined : editor,
    );
  };

  const admitMember = Effect.fn("j5.sharing.sharedConversation.admitMember")(function* (
    session: SessionIdentity,
    command: OrchestrationV2Command,
  ) {
    if (command.type === "runtime-request.respond") {
      // An answer in words says whose it is, as a message does; an approval carries no words.
      if (command.answers === undefined) return command;
      if (!(yield* isSharedConversation(sql, command.threadId))) return command;
      const answerer = yield* sessionAuthor(session);
      return answerer === null
        ? command
        : { ...command, answers: answersFrom(command.answers, answerer) };
    }
    if (command.type !== "message.dispatch" && command.type !== "queued-run.edit") return command;
    if (command.type === "message.dispatch") {
      const { shared, note } = yield* announce(command.threadId, command.messageId);
      // A thread that has just stopped being shared says so on this one message more.
      if (!shared && note === null) return command;
      const author = yield* sessionAuthor(session);
      if (author === null) return command;
      yield* recordAuthor(command.threadId, command.messageId, author, note);
      return { ...command, text: stamped(command.text, author, note) };
    }
    // An edit matters here only on a thread that is, or has been, a shared conversation: a
    // message queued while it was one keeps its author line and any note it carries.
    if (!(yield* everShared(command.threadId))) return command;
    const author = yield* sessionAuthor(session);
    if (author === null) return command;
    // A queued message no person is recorded for (one sent before the thread was shared, or a
    // delivery from an agent or the platform) is edited as upstream has it.
    const messageId = yield* queuedMessageId(command.threadId, command.runId);
    const original = messageId === null ? null : yield* messageAuthor(command.threadId, messageId);
    return original === null
      ? command
      : { ...command, text: stampEdit(command.text, original, author) };
  });

  const admitGuest = Effect.fn("j5.sharing.sharedConversation.admitGuest")(function* (
    session: SessionIdentity,
    received: OrchestrationV2Command,
  ) {
    const decision = guestCommand(received);
    if (!decision.allowed) return yield* refused(decision.reason);
    const command = decision.command;
    // The gate asked the same before this ran; this holds for any other caller.
    if ((yield* access.threadAccess(session, command.threadId)) !== "collaborate") {
      return yield* refused("This is not shared with you to write to.");
    }
    const author = yield* sessionAuthor(session);
    // A name no member has confirmed never reaches an agent (AC1).
    if (author === null || author.kind !== "guest" || author.nameSelfGiven) {
      return yield* refused("A member has to confirm your name before you can write here.");
    }
    // A seat's request for approval reaches members only (AC12), whatever grant covers its thread.
    if (
      (command.type === "runtime-request.respond" ||
        command.type === "thread.user-input.dismiss") &&
      (yield* isCrewSeatThread(sql, command.threadId))
    ) {
      return yield* refused("A Crew seat's prompts are answered by a member.");
    }
    switch (command.type) {
      case "message.dispatch": {
        // Upstream keys a message by its id alone, across threads: a send that named an
        // existing one would write over it.
        const existing = yield* sql<{ readonly found: number }>`
          SELECT 1 AS found FROM orchestration_v2_projection_messages
          WHERE message_id = ${command.messageId}
        `;
        if (existing.length > 0) return yield* refused("This message was already sent.");
        const { note } = yield* announce(command.threadId, command.messageId);
        yield* recordAuthor(command.threadId, command.messageId, author, note);
        return { ...command, text: stamped(command.text, author, note) };
      }
      case "queued-run.edit":
      case "queued-run.cancel": {
        const messageId = yield* queuedMessageId(command.threadId, command.runId);
        const original =
          messageId === null ? null : yield* messageAuthor(command.threadId, messageId);
        if (original === null || original.personId !== author.personId) {
          return yield* refused("A guest can change or withdraw only their own queued messages.");
        }
        return command.type === "queued-run.cancel"
          ? command
          : { ...command, text: stampEdit(command.text, original, author) };
      }
      case "runtime-request.respond":
        return command.answers === undefined
          ? command
          : { ...command, answers: answersFrom(command.answers, author) };
      default:
        return command;
    }
  });

  const isAnswer = (
    command: OrchestrationV2Command,
  ): command is Extract<
    OrchestrationV2Command,
    { readonly type: "runtime-request.respond" | "thread.user-input.dismiss" }
  > => command.type === "runtime-request.respond" || command.type === "thread.user-input.dismiss";

  /**
   * Whether upstream's own log shows that this command settled this prompt. Upstream answers
   * "accepted" again for any command id it has already taken on the thread, whatever the
   * command was, so its saying so is not proof: a replayed id settles nothing. The event that
   * settles a prompt carries the id of the command that did it.
   */
  const settledBy = (
    command: Extract<
      OrchestrationV2Command,
      { readonly type: "runtime-request.respond" | "thread.user-input.dismiss" }
    >,
  ) =>
    // Upstream's event log is `orchestration_events`: a thread's events are its stream, the
    // payload of this event is the request itself, and `command_id` is the command that caused
    // it (`SharedConversation.integration.test.ts` fails if upstream stops writing these).
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_events
      WHERE command_id = ${command.commandId}
        AND aggregate_kind = 'thread'
        AND stream_id = ${command.threadId}
        AND event_type = 'runtime-request.updated'
        AND json_extract(payload_json, '$.id') = ${command.requestId}
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));

  /** A thread that is a shared conversation now, or was one: its prompts say who answered them. */
  const everShared = Effect.fn("j5.sharing.sharedConversation.everShared")(function* (
    threadId: ThreadId,
  ) {
    if (yield* isSharedConversation(sql, threadId)) return true;
    const told = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM j5_a2a_shared_thread_told WHERE thread_id = ${threadId}
    `;
    return told.length > 0;
  });

  /**
   * Records who answered a prompt (AC9), on a thread that is or has been a shared conversation,
   * so that a prompt a member answers after the last guest has gone still says who answered.
   *
   * It is written as the answer is taken in (`claimed`), before upstream settles the prompt, so
   * that every client that sees the prompt settle on the thread's own feed finds who answered
   * already there. A claim never replaces a record. When upstream has finished (`accepted`),
   * the claim is kept only if upstream's log shows this very command settled the prompt, and
   * then it stands for good, over a claim another person wrote first; otherwise it is taken
   * back, as it is when upstream refuses the answer or it is interrupted. So a command id
   * replayed against a prompt, pending or settled, records no one and changes no record. A
   * failure to record is logged and does not stop the answer.
   */
  const recordAnswer = (
    session: SessionIdentity,
    command: OrchestrationV2Command,
    when: "claimed" | "accepted",
  ) =>
    !isAnswer(command)
      ? Effect.void
      : Effect.gen(function* () {
          if (!(yield* everShared(command.threadId))) return;
          if (when === "accepted" && !(yield* settledBy(command))) {
            yield* sql`
              DELETE FROM j5_a2a_prompt_answer
              WHERE thread_id = ${command.threadId}
                AND request_id = ${command.requestId}
                AND command_id = ${command.commandId}
            `;
            return;
          }
          const author = yield* sessionAuthor(session);
          if (author === null) return;
          const answeredAt = DateTime.formatIso(yield* DateTime.now);
          const keepFirst = when === "claimed" ? 1 : 0;
          // What an approval was answered with; a question's answer and a dismissal have none.
          const decision =
            command.type === "runtime-request.respond" ? (command.decision ?? null) : null;
          // The agent is told only of what was answered while its thread was shared.
          const untold = (yield* isSharedConversation(sql, command.threadId)) ? 0 : 1;
          yield* sql`
            INSERT INTO j5_a2a_prompt_answer (
              thread_id, request_id, person_id, person_kind, display_name, command_id,
              answered_at, decision, settled, told_delivered
            ) VALUES (
              ${command.threadId}, ${command.requestId}, ${author.personId}, ${author.kind},
              ${author.displayName}, ${command.commandId}, ${answeredAt}, ${decision},
              ${keepFirst === 1 ? 0 : 1}, ${untold}
            )
            ON CONFLICT (thread_id, request_id) DO UPDATE SET
              person_id = excluded.person_id,
              person_kind = excluded.person_kind,
              display_name = excluded.display_name,
              command_id = excluded.command_id,
              answered_at = excluded.answered_at,
              decision = excluded.decision,
              settled = 1,
              told_delivered = excluded.told_delivered
            WHERE ${keepFirst} = 0
          `;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("J5 shared conversation could not record who answered a prompt", {
              cause,
            }),
          ),
        );

  const conversation = {
    withdrawQueued,
    /** The same for the guest on a connection, who has just left something. */
    withdrawQueuedOf: (session: SessionIdentity) =>
      access.sessionPerson(session).pipe(
        Effect.flatMap((person) =>
          person === null || person.personId === null
            ? Effect.void
            : withdrawQueued(person.personId),
        ),
        Effect.catch((cause) =>
          Effect.logError("J5 shared conversation could not read who left", { cause }),
        ),
      ),
    /**
     * After upstream has accepted a client's command: the person whose answer upstream took is
     * the one recorded for the prompt, whoever was written down first.
     */
    accepted: (session: SessionIdentity, command: OrchestrationV2Command) =>
      recordAnswer(session, command, "accepted"),
    /** After upstream has refused a client's command, or it was interrupted: what was written for that answer is taken back. */
    refused: (command: OrchestrationV2Command) =>
      !isAnswer(command)
        ? Effect.void
        : sql`
            DELETE FROM j5_a2a_prompt_answer
            WHERE thread_id = ${command.threadId}
              AND request_id = ${command.requestId}
              AND command_id = ${command.commandId}
          `.pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.logError("J5 shared conversation could not take back a refused answer", {
                cause,
              }),
            ),
          ),
    /**
     * How the person on a connection is named to a Captain whose roster they are answering, when
     * the Captain's thread is a shared conversation; `null` anywhere else, where the Captain is
     * told what it always was.
     */
    rosterDecider: (session: SessionIdentity, proposalId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly captain_thread_id: string }>`
          SELECT captain_thread_id FROM j5_agent_crew_proposal WHERE id = ${proposalId}
        `;
        const threadId = rows[0]?.captain_thread_id;
        if (threadId === undefined) return null;
        if (!(yield* isSharedConversation(sql, threadId as ThreadId))) return null;
        const author = yield* sessionAuthor(session);
        return author === null ? null : authorLabel(author);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("J5 shared conversation could not name who answered a roster", {
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
    /** Who answered each approval and question while the thread was shared; as `threadAuthors`. */
    threadAnswers: Effect.fn("j5.sharing.sharedConversation.threadAnswers")(function* (
      session: SessionIdentity,
      threadId: ThreadId,
    ) {
      const guest = yield* access.sessionPerson(session);
      if (guest !== null && (yield* access.threadAccess(session, threadId)) === "none") return [];
      const rows = yield* sql<{
        readonly request_id: string;
        readonly person_id: string;
        readonly person_kind: PersonKind;
        readonly display_name: string | null;
      }>`
        SELECT request_id, person_id, person_kind, display_name
        FROM j5_a2a_prompt_answer
        WHERE thread_id = ${threadId}
        ORDER BY answered_at, request_id
      `;
      return rows.map((row): SharingPromptAnswer => ({
        requestId: row.request_id,
        displayName: row.display_name,
        kind: row.person_kind,
        you: guest === null ? row.person_kind === "member" : row.person_id === guest.personId,
      }));
    }),
    /**
     * A client's command as it goes on to upstream. A member's is returned as received unless
     * it is a message for a shared conversation, which gains its author's line. A guest's is
     * refused unless it is one a Collaborate guest may send on that thread, and is rebuilt from
     * the fields a guest may set.
     */
    admit: (
      session: SessionIdentity,
      command: OrchestrationV2Command,
    ): Effect.Effect<OrchestrationV2Command, EnvironmentAuthorizationError> =>
      (session.subject === GUEST_SESSION_SUBJECT
        ? admitGuest(session, command).pipe(
            Effect.map((admitted): OrchestrationV2Command => admitted),
            // A guest's command goes nowhere when J5 cannot check it.
            Effect.catch((cause) =>
              cause._tag === "EnvironmentAuthorizationError"
                ? Effect.fail(cause)
                : Effect.logError("J5 shared conversation could not admit a command; refusing", {
                    cause,
                  }).pipe(Effect.andThen(Effect.fail(notAdmitted))),
            ),
          )
        : admitMember(session, command).pipe(
            Effect.map((admitted): OrchestrationV2Command => admitted),
            // A fault of J5's own does not stop a member's command where no guest can write:
            // it goes on as upstream has it. In a shared conversation it is refused, since a
            // message sent on without its author's line would tell the agent the wrong thing
            // about who is speaking. If even that cannot be read, the thread is taken as
            // unshared, which nearly every thread is.
            Effect.catch((cause) =>
              ("threadId" in command
                ? isSharedConversation(sql, command.threadId).pipe(
                    Effect.orElseSucceed(() => false),
                  )
                : Effect.succeed(false)
              ).pipe(
                Effect.tap((shared) =>
                  Effect.logError(
                    shared
                      ? "J5 shared conversation could not admit a member's command; refusing"
                      : "J5 shared conversation failed on a member's command; sending it on as upstream does",
                    { cause },
                  ),
                ),
                Effect.flatMap((shared) =>
                  shared ? Effect.fail(notAdmitted) : Effect.succeed(command),
                ),
              ),
            ),
          )
      ).pipe(Effect.tap((admitted) => recordAnswer(session, admitted, "claimed"))),
    /**
     * Who wrote each message a person sent while the thread was shared, for a connection that
     * can read the thread. It says a name and whether they are a member or a guest, no more.
     */
    threadAuthors: Effect.fn("j5.sharing.sharedConversation.threadAuthors")(function* (
      session: SessionIdentity,
      threadId: ThreadId,
    ) {
      const guest = yield* access.sessionPerson(session);
      // The gate asks the same of a guest's request; this holds for any other caller.
      if (guest !== null && (yield* access.threadAccess(session, threadId)) === "none") return [];
      const rows = yield* sql<AuthorRow>`
        SELECT message_id, person_id, person_kind, display_name, note
        FROM j5_a2a_message_author
        WHERE thread_id = ${threadId}
        ORDER BY created_at, message_id
      `;
      return rows.map((row): SharingMessageAuthor => ({
        messageId: row.message_id,
        displayName: row.display_name,
        kind: row.person_kind,
        // Every device that is not a guest's is the one member's.
        you: guest === null ? row.person_kind === "member" : row.person_id === guest.personId,
        note: row.note,
      }));
    }),
  };
  return {
    ...conversation,
    /**
     * When upstream has finished with a client's command, however it ended. Accepted, the
     * person whose answer upstream took is the one recorded; refused or interrupted, what was
     * written for that answer is taken back, so a prompt later settled some other way never
     * reads as answered by someone whose answer did not land.
     */
    settled: (
      session: SessionIdentity,
      command: OrchestrationV2Command,
      exit: Exit.Exit<unknown, unknown>,
    ) =>
      Exit.isSuccess(exit)
        ? conversation.accepted(session, command)
        : conversation.refused(command),
  };
};

export type SharedConversation = ReturnType<typeof make<unknown>>;

/**
 * Built over the database, `PersonAccess` and upstream's thread service, which every socket's
 * handlers already have. The thread service is used for one thing: withdrawing a queued message.
 */
export const sharedConversation = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  return make(yield* SqlClient.SqlClient, yield* PersonAccess, (command) =>
    threads.dispatch(command),
  );
});
