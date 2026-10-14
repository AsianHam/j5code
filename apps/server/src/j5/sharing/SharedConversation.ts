// @effect-diagnostics nodeBuiltinImport:off - a random id for a command of the platform's own.
import {
  AuthOrchestrationOperateScope,
  CommandId,
  MessageId,
  EnvironmentAuthorizationError,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectId,
  type RunId,
  ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import type { SharingMessageAuthor, SharingPromptAnswer } from "@t3tools/contracts/j5";
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import { ensureLocalOperatorHumanPerson } from "../a2a/HumanPersonRegistry.ts";
import { authorLabel, beginsWithSlash } from "./authorLabel.ts";
import { guestCommand, planThreadOf, threadsNamedBy } from "./GuestCommands.ts";
import {
  GUEST_SESSION_SUBJECT,
  PersonAccess,
  type PersonAccessShape,
  type PersonKind,
  type SessionIdentity,
  guestWritesTo,
  isCrewSeatThread,
  isSharedConversation,
  writesVia,
} from "./PersonAccess.ts";
import { Writer, changeNote, firstNote } from "./sharedConversationNotes.ts";

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

/** Who a message that carries a note told the agent can write. */
const Told = Schema.fromJsonString(Schema.Array(Writer));
const decodeTold = Schema.decodeEffect(Told);
const encodeTold = Schema.encodeEffect(Told);

/**
 * The id a guest's command goes on to upstream under: the client's own, inside a space that is
 * that one person's. Upstream answers "accepted" for any command id it already has a receipt
 * for on the thread and does nothing more, which is how an honest retry works. A guest who
 * could name any id could therefore name one the platform, a member or upstream's own recovery
 * has used or will use: its command would be taken as already done, or theirs would. Under
 * this id a guest's retry still finds its own receipt, and no one else's id can be named.
 */
export const guestCommandId = (personId: string, commandId: CommandId) =>
  CommandId.make(`command:j5:guest:${personId}:${commandId}`);

/**
 * The event upstream logs when a prompt is answered. Typed against upstream's own event union,
 * so a rename there fails to compile here.
 */
const PROMPT_SETTLED_EVENT =
  "runtime-request.updated" satisfies OrchestrationV2StoredEvent["event"]["type"];

/** The kind of prompt that is a question, answered in words; typed against upstream's kinds. */
const QUESTION_KIND = "user_input" satisfies OrchestrationV2RuntimeRequest["kind"];
const PENDING = "pending" satisfies OrchestrationV2RuntimeRequest["status"];

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
            // An id no one can have used before: upstream takes a command whose id it has
            // seen as already done.
            commandId: CommandId.make(
              `command:j5:shared-conversation-withdraw:${run.run_id}:${NodeCrypto.randomUUID()}`,
            ),
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
      // Upstream said it was done; its own record of each run is what counts.
      if (stranded.length > 0) {
        const left = yield* sql<{ readonly run_id: string }>`
          SELECT run_id FROM orchestration_v2_projection_runs
          WHERE status = 'queued' AND run_id IN ${sql.in(stranded.map((run) => run.run_id))}
        `;
        if (left.length > 0) {
          yield* Effect.logError(
            "J5 shared conversation withdrew a guest's queued messages and they are still queued",
            { personId, runIds: left.map((run) => run.run_id) },
          );
        }
      }
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
    launchingIn: ProjectId | null,
  ) {
    // The owner is recorded before they are first needed as a member of the thread.
    yield* ensureLocalOperatorHumanPerson(sql);
    const people = yield* access.threadPeople(threadId, launchingIn);
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
   * Whether upstream's own log shows that the command an answer was written for settled its
   * prompt, as a condition on `j5_a2a_prompt_answer AS answer`. Upstream answers "accepted"
   * again for any command id it has already taken on the thread, whatever the command was, so
   * its saying so is not proof. The event that settles a prompt carries the id of the command
   * that did it: `orchestration_events` is upstream's log, a thread's events are its stream,
   * and this event's payload is the request itself.
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
   * may never: its author can withdraw it. So until one is known to have run, every message
   * carries the note, and the agent may read it more than once. That way no person's message
   * reaches an agent that has not been told the thread is shared and where guests stand.
   *
   * Read from upstream's own records by SQL: a message's `run_id`, a run's `status` and the
   * `startedAt` in its payload (`SharedConversation.integration.test.ts` fails if upstream
   * reshapes them). It is asked when the next message arrives, so every way a message can be
   * lost is covered without a hook on any of them. A thread has one row here for each message
   * that carried a note.
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
    const reached = rows.find((row) => !lost(row) && row.status !== "queued");
    return reached === undefined ? null : yield* decodeTold(reached.told_json);
  });

  /**
   * Works out what the agent must be told about who can write to its thread (AC3, AC4), as a
   * person's message is taken in, and reports whether the thread is a shared conversation. When
   * that differs from what the agent was last told, the note is returned to go at the top of
   * this message, with `told` to keep on the message's author record: this message is now the
   * note's carrier. A change to a grant therefore wakes no agent and costs no turn of its own.
   *
   * A thread that was never shared costs one lookup for any Collaborate grant on the server and
   * one by key for a carrier.
   */
  const announce = Effect.fn("j5.sharing.sharedConversation.announce")(function* (
    threadId: ThreadId,
    carrier: MessageId,
    /** The project of a thread this message is creating, which has no record yet. */
    launchingIn: ProjectId | null = null,
  ) {
    const shared = yield* isSharedConversation(sql, threadId, launchingIn);
    const last = yield* lastTold(threadId);
    if (last === null && !shared) return { shared, note: null, told: null };
    const now = shared ? yield* writers(threadId, launchingIn) : [];
    // A thread shared again after it stopped being one is told as a thread newly shared.
    const wasShared = last !== null && last.some((writer) => writer.kind === "guest");
    const note = wasShared ? changeNote(last, now) : shared ? firstNote(now) : null;
    return {
      shared,
      note,
      told: note === null ? null : yield* encodeTold(now),
    };
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
    carried: { readonly note: string | null; readonly told: string | null },
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // The first record of a message stands: a later send cannot take a message over.
    yield* sql`
      INSERT INTO j5_a2a_message_author (
        thread_id, message_id, person_id, person_kind, display_name, note, told_json,
        created_at
      ) VALUES (
        ${threadId}, ${messageId}, ${author.personId}, ${author.kind}, ${author.displayName},
        ${carried.note}, ${carried.told}, ${createdAt}
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
  const typedIn = (text: string, original: Author & { readonly note: string | null }) =>
    withoutAuthorLine(
      original.note !== null && text.startsWith(`${original.note}\n`)
        ? text.slice(original.note.length + 1)
        : text,
      original,
    );
  const stampEdit = (
    text: string,
    original: Author & { readonly note: string | null },
    editor: Author,
  ) =>
    stamped(
      typedIn(text, original),
      original,
      original.note,
      editor.personId === original.personId ? undefined : editor,
    );

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
      // A member's slash command goes on as typed, so that it is still a command. It carries
      // no note and is no one's recorded message: a note that is due rides on the next message
      // that is stamped.
      if (beginsWithSlash(command.text)) return command;
      const carried = yield* announce(command.threadId, command.messageId);
      // A thread that has just stopped being shared says so on this one message more.
      if (!carried.shared && carried.note === null) return command;
      const author = yield* sessionAuthor(session);
      if (author === null) return command;
      yield* recordAuthor(command.threadId, command.messageId, author, carried);
      return { ...command, text: stamped(command.text, author, carried.note) };
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
    if (original === null) return command;
    // A member's own queued message edited into a slash command goes on as typed, and stops
    // being a recorded message: what it carried was never read, so the next stamped message
    // carries it. A guest's message stays the guest's and stays stamped, whoever edits it and
    // whatever the edit begins with.
    const typed = typedIn(command.text, original);
    if (original.kind === "member" && beginsWithSlash(typed)) {
      yield* sql`
        DELETE FROM j5_a2a_message_author
        WHERE thread_id = ${command.threadId} AND message_id = ${messageId}
      `;
      return { ...command, text: typed };
    }
    return { ...command, text: stampEdit(command.text, original, author) };
  });

  const admitGuest = Effect.fn("j5.sharing.sharedConversation.admitGuest")(function* (
    session: SessionIdentity,
    received: OrchestrationV2Command,
  ) {
    const decision = guestCommand(received);
    if (!decision.allowed) return yield* refused(decision.reason);
    // The gate asked the same before this ran; this holds for any other caller.
    if ((yield* access.threadAccess(session, decision.command.threadId)) !== "collaborate") {
      return yield* refused("This is not shared with you to write to.");
    }
    const author = yield* sessionAuthor(session);
    // A name no member has confirmed never reaches an agent (AC1).
    if (author === null || author.kind !== "guest" || author.nameSelfGiven) {
      return yield* refused("A member has to confirm your name before you can write here.");
    }
    // Another thread a guest's message attaches for the agent to read is one the guest can
    // read. A thread whose plan it builds from is one the guest can write to, since upstream
    // marks that plan completed there.
    for (const named of threadsNamedBy(decision.command)) {
      if ((yield* access.threadAccess(session, ThreadId.make(named))) === "none") {
        return yield* refused("This is not shared with you on this server.");
      }
    }
    const planThread = planThreadOf(decision.command);
    if (
      planThread !== undefined &&
      (yield* access.threadAccess(session, ThreadId.make(planThread))) !== "collaborate"
    ) {
      return yield* refused("This is not shared with you to write to.");
    }
    const command = {
      ...decision.command,
      commandId: guestCommandId(author.personId, decision.command.commandId),
    };
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
        const carried = yield* announce(command.threadId, command.messageId);
        yield* recordAuthor(command.threadId, command.messageId, author, carried);
        return { ...command, text: stamped(command.text, author, carried.note) };
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
      case "thread.user-input.dismiss": {
        // A guest answers only a prompt that is waiting for an answer. Upstream refuses any
        // other too; refusing here means nothing is written down for an answer that cannot
        // land, so a guest cannot fill the record of who answered.
        const requests = yield* sql<{ readonly kind: string; readonly status: string }>`
          SELECT kind, status FROM orchestration_v2_projection_runtime_requests
          WHERE runtime_request_id = ${command.requestId} AND thread_id = ${command.threadId}
        `;
        const request = requests[0];
        if (request === undefined || request.status !== PENDING) {
          return yield* refused("This prompt is not waiting for an answer.");
        }
        if (command.type === "thread.user-input.dismiss") return command;
        // Upstream marks a prompt resolved by whatever it is sent, and an approval resolved by
        // words is one the provider never hears of: its tool call waits for good. So a
        // question is answered in words and anything else by a decision.
        if ((request.kind === QUESTION_KIND) !== (command.answers !== undefined)) {
          return yield* refused(
            request.kind === QUESTION_KIND
              ? "A question is answered in words."
              : "This prompt is answered by approving or declining it.",
          );
        }
        return command.answers === undefined
          ? command
          : { ...command, answers: answersFrom(command.answers, author) };
      }
      default:
        return command;
    }
  });

  /** Whether a person's message was taken in on a thread while it was a shared conversation. */
  const writtenWhileShared = (threadId: ThreadId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM j5_a2a_message_author WHERE thread_id = ${threadId} LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));

  /** A thread that is a shared conversation now, or was one: what was queued then keeps its lines. */
  const everShared = Effect.fn("j5.sharing.sharedConversation.everShared")(function* (
    threadId: ThreadId,
  ) {
    return (yield* isSharedConversation(sql, threadId)) || (yield* writtenWhileShared(threadId));
  });

  /**
   * Writes down who is answering a prompt (AC9), on a thread that is or has been a shared
   * conversation, so that a prompt a member answers after the last guest has gone still says
   * who answered.
   *
   * It is written as the answer is taken in, before upstream settles the prompt, so that every
   * client that sees the prompt settle on the thread's own feed finds who answered already
   * there. It is a claim, kept for each command that answers: who answered is read as the claim
   * whose command upstream's log shows settled the prompt (`settledItsPrompt`). So an answer
   * upstream refuses, one that loses to an earlier answer, and a command id replayed against a
   * prompt all name no one, and nothing is done when upstream has finished. The first claim
   * for a command stands. A failure to record is logged and does not stop the answer.
   */
  const recordAnswer = (session: SessionIdentity, command: OrchestrationV2Command) =>
    command.type !== "runtime-request.respond" && command.type !== "thread.user-input.dismiss"
      ? Effect.void
      : Effect.gen(function* () {
          if (!(yield* everShared(command.threadId))) return;
          const author = yield* sessionAuthor(session);
          if (author === null) return;
          const answeredAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO j5_a2a_prompt_answer (
              thread_id, request_id, command_id, person_id, person_kind, display_name,
              answered_at
            ) VALUES (
              ${command.threadId}, ${command.requestId}, ${command.commandId},
              ${author.personId}, ${author.kind}, ${author.displayName}, ${answeredAt}
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
        SELECT answer.request_id, answer.person_id, answer.person_kind, answer.display_name
        FROM j5_a2a_prompt_answer AS answer
        WHERE answer.thread_id = ${threadId} AND ${settledItsPrompt}
        ORDER BY answer.answered_at, answer.request_id
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
      ).pipe(Effect.tap((admitted) => recordAnswer(session, admitted))),
    /**
     * A client's request to start a thread as it goes on to upstream. A new thread's first
     * message does not come as a command: upstream's launch creates the thread and sends the
     * message itself, so it is taken in here, as `admit` takes in a message. A thread born in a
     * project a guest holds Collaborate on is a shared conversation from its first message,
     * which carries the first note and its author's line. Any other launch is returned as
     * received. Starting a thread is a member's to do; a guest's request is refused before
     * this by the gate, and here for any other caller.
     */
    admitLaunch: (
      session: SessionIdentity,
      input: OrchestrationV2ThreadLaunchInput,
    ): Effect.Effect<OrchestrationV2ThreadLaunchInput, EnvironmentAuthorizationError> =>
      Effect.gen(function* () {
        if (session.subject === GUEST_SESSION_SUBJECT) {
          return yield* refused("A guest cannot start a thread.");
        }
        const first = input.initialMessage;
        // A member's slash command starts a thread as typed, as it is sent to one.
        if (first === undefined || beginsWithSlash(first.text)) return input;
        const shared =
          input.threadId === undefined
            ? // No thread can be named, so only the project says whether it will be shared.
              yield* isSharedConversation(
                sql,
                ThreadId.make(`thread:j5:unborn:${NodeCrypto.randomUUID()}`),
                input.projectId,
              )
            : yield* isSharedConversation(sql, input.threadId, input.projectId);
        if (!shared && (input.threadId === undefined || !(yield* everShared(input.threadId)))) {
          return input;
        }
        // The message is recorded under its thread, which upstream would otherwise name.
        if (input.threadId === undefined) {
          return yield* refused("A thread in a shared project is started with its id.");
        }
        const author = yield* sessionAuthor(session);
        if (author === null) return input;
        const messageId =
          first.messageId ?? MessageId.make(`message:j5:launch:${NodeCrypto.randomUUID()}`);
        const carried = yield* announce(input.threadId, messageId, input.projectId);
        if (!carried.shared && carried.note === null) return input;
        yield* recordAuthor(input.threadId, messageId, author, carried);
        return {
          ...input,
          initialMessage: {
            ...first,
            messageId,
            text: stamped(first.text, author, carried.note),
          },
        };
      }).pipe(
        // As for a member's command: a fault of J5's own stops a launch only where a guest
        // can write, and if even that cannot be read the launch goes on as upstream has it.
        Effect.catch((cause) =>
          cause._tag === "EnvironmentAuthorizationError"
            ? Effect.fail(cause)
            : (input.threadId === undefined
                ? Effect.succeed(false)
                : isSharedConversation(sql, input.threadId, input.projectId).pipe(
                    Effect.orElseSucceed(() => false),
                  )
              ).pipe(
                Effect.tap((shared) =>
                  Effect.logError(
                    shared
                      ? "J5 shared conversation could not admit a launch; refusing"
                      : "J5 shared conversation failed on a launch; sending it on as upstream does",
                    { cause },
                  ),
                ),
                Effect.flatMap((shared) =>
                  shared ? Effect.fail(notAdmitted) : Effect.succeed(input),
                ),
              ),
        ),
      ),
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
  return conversation;
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
