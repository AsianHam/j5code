import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type MessageId,
  type OrchestrationV2Command,
  type RunId,
  type ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import type { SharingMessageAuthor } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { ParticipantId } from "../a2a/contracts.ts";
import { ensureLocalOperatorHumanPerson } from "../a2a/HumanPersonRegistry.ts";
import { guestCommand } from "./GuestCommands.ts";
import {
  GUEST_SESSION_SUBJECT,
  PersonAccess,
  type PersonAccessShape,
  type PersonKind,
  type SessionIdentity,
  isCrewSeatThread,
  isSharedConversation,
} from "./PersonAccess.ts";

/**
 * A shared conversation: a thread a guest holds Collaborate on
 * (docs/j5/product/features/shared-conversations.md). In one, every message a person sends
 * reaches the agent under its author's name, and a guest's commands are held to what a guest may
 * do. A thread only one person can write to passes through here untouched.
 */

/** A person as the agent and other people are told of them: a name and where they stand. */
export interface Author {
  readonly personId: ParticipantId;
  readonly kind: PersonKind;
  /** `null` for the server's owner while no name has been set for them. */
  readonly displayName: string | null;
}

// The name rule already refuses brackets and line breaks (`isPersonName`). They are taken out
// here as well, so that a name which reached the record some other way cannot close the line
// early or open what looks like a second one. A parenthesised "member" or "guest" in a name is
// taken out too, so the only such word on the line is the platform's, at the end: a guest named
// "Jackson (member)" is written `Jackson (guest)`.
const nameInLine = (name: string) =>
  name
    .replace(/\(\s*(?:member|guest)\s*\)/gi, " ")
    .replace(/[[\]\s]+/g, " ")
    .trim();

/** How an author is named to the agent: `Priya (guest)`, `Jackson (member)`, `a member`. */
export const authorLabel = (author: Pick<Author, "kind" | "displayName">) => {
  const name = author.displayName === null ? "" : nameInLine(author.displayName);
  return name.length === 0 ? `a ${author.kind}` : `${name} (${author.kind})`;
};

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
}

const toAuthor = (row: AuthorRow): Author => ({
  personId: row.person_id as ParticipantId,
  kind: row.person_kind,
  displayName: row.display_name,
});

const make = (sql: SqlClient.SqlClient, access: PersonAccessShape) => {
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
      SELECT message_id, person_id, person_kind, display_name
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
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // The first record of a message stands: a later send cannot take a message over.
    yield* sql`
      INSERT INTO j5_a2a_message_author (
        thread_id, message_id, person_id, person_kind, display_name, created_at
      ) VALUES (
        ${threadId}, ${messageId}, ${author.personId}, ${author.kind}, ${author.displayName},
        ${createdAt}
      )
      ON CONFLICT (thread_id, message_id) DO NOTHING
    `;
  });

  /** A queued edit's text under its message's author, and its editor when that is someone else. */
  const stampEdit = (text: string, original: Author, editor: Author) =>
    withAuthorLine(
      withoutAuthorLine(text, original),
      original,
      editor.personId === original.personId ? undefined : editor,
    );

  const admitMember = Effect.fn("j5.sharing.sharedConversation.admitMember")(function* (
    session: SessionIdentity,
    command: OrchestrationV2Command,
  ) {
    if (command.type !== "message.dispatch" && command.type !== "queued-run.edit") return command;
    if (!(yield* isSharedConversation(sql, command.threadId))) return command;
    const author = yield* sessionAuthor(session);
    if (author === null) return command;
    if (command.type === "message.dispatch") {
      yield* recordAuthor(command.threadId, command.messageId, author);
      return { ...command, text: withAuthorLine(command.text, author) };
    }
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
        yield* recordAuthor(command.threadId, command.messageId, author);
        return { ...command, text: withAuthorLine(command.text, author) };
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
      default:
        return command;
    }
  });

  return {
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
      session.subject === GUEST_SESSION_SUBJECT
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
        SELECT message_id, person_id, person_kind, display_name
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
      }));
    }),
  };
};

export type SharedConversation = ReturnType<typeof make>;

/** Built over the database and `PersonAccess`, which every socket's handlers already have. */
export const sharedConversation = Effect.gen(function* () {
  return make(yield* SqlClient.SqlClient, yield* PersonAccess);
});
