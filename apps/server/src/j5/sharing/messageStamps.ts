import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type MessageId,
  type OrchestrationV2Run,
  type ProjectId,
  type ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import type { WriterLevel } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ParticipantId } from "../a2a/contracts.ts";
import { authorLabel } from "./authorLabel.ts";
import { PersonAccess } from "./PersonAccess.ts";
import { SharedThreads, type ThreadWriter } from "./SharedThreads.ts";
import { Writer, changeNote, firstNote } from "./sharedConversationNotes.ts";

/**
 * What a message on a shared conversation carries to the agent and how it is recorded: whose it
 * is, as the agent is told, and the note that goes on it when the agent must be told who can
 * write. A person's message (`SharedConversation`) and a scheduled task's run (`scheduledRuns`)
 * are both stamped here.
 */

/** A person as the agent is told of them: a name and their level where they wrote. */
export interface Author {
  readonly personId: ParticipantId;
  readonly displayName: string | null;
  readonly level: WriterLevel;
}

/** The platform's text a stored message begins with: the note it carries, then the line naming
 * whose it is. */
export const prefixOf = (note: string | null, line: string) =>
  `${note === null ? "" : `${note}\n`}${line}\n\n`;

export const refused = (message: string) =>
  new EnvironmentAuthorizationError({
    message,
    ...authScopeRequiredResponse(AuthOrchestrationOperateScope),
  });

/** Who a message that carries a note told the agent can write. */
const Told = Schema.fromJsonString(Schema.Array(Writer));
const decodeTold = Schema.decodeEffect(Told);
const encodeTold = Schema.encodeEffect(Told);

/** A message's run as upstream records it, read beside a message that carried a note. */
interface CarrierRun {
  /** `null` when upstream has no such message. */
  readonly carried: string | null;
  readonly status: string | null;
  readonly started_at: string | null;
  /** The message the run was started for, its `userMessageId`. */
  readonly run_message: string | null;
}

/**
 * Whether a message's note reached the agent: its run was started for it, has started, and was not
 * rolled back. Queued, preparing or run-less messages told nothing yet; nor did one steered into
 * another run, since nothing says the provider took it. A note told twice beats one never told.
 */
const reachedAgent = (run: CarrierRun) =>
  run.carried !== null &&
  run.run_message === run.carried &&
  run.started_at !== null &&
  run.status !== ("rolled_back" satisfies OrchestrationV2Run["status"]);

/**
 * Over the server's records. `touch` moves a thread's authors for the clients that read them.
 */
export const makeMessageStamps = Effect.fn("j5.sharing.sharedConversation.makeMessageStamps")(
  function* (touch: (threadId: ThreadId) => Effect.Effect<unknown>) {
    const sql = yield* SqlClient.SqlClient;
    const people = yield* PersonAccess;
    const shared = yield* SharedThreads;

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
     * Who the agent was last told can write: the note on the message whose run started last, or
     * `null`. Until a note is known to have run, every message carries it (AC4). Read by SQL from
     * upstream's `run_id`, run `status` and `startedAt` (pinned by the integration test) when the
     * next message arrives, so every way a message is lost, a rewind included, is covered.
     */
    const lastTold = Effect.fn("j5.sharing.sharedConversation.lastTold")(function* (
      threadId: ThreadId,
    ) {
      const rows = yield* sql<CarrierRun & { readonly told_json: string }>`
        SELECT author.told_json, message.message_id AS carried,
          run.status AS status, json_extract(run.payload_json, '$.startedAt') AS started_at,
          json_extract(run.payload_json, '$.userMessageId') AS run_message
        FROM j5_a2a_message_author AS author
        LEFT JOIN orchestration_v2_projection_messages AS message
          ON message.message_id = author.message_id
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
        WHERE author.thread_id = ${threadId} AND author.told_json IS NOT NULL
        ORDER BY author.rowid DESC
      `;
      // The agent last read the carrier whose run started last, which is not always the one sent
      // last: a queue can be reordered.
      const reached = rows
        .filter(reachedAgent)
        .reduce<(typeof rows)[number] | undefined>(
          (latest, row) =>
            latest === undefined || row.started_at! > latest.started_at! ? row : latest,
          undefined,
        );
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
      // Upstream keys a message by id alone and overwrites on a repeat, so an id is its sender's:
      // one recorded for someone else, or held by upstream for no one here, is refused. A retry
      // goes on only if its send was recorded here; one sent just before sharing is refused.
      const recorded = yield* sql<{ readonly person_id: string }>`
        SELECT person_id FROM j5_a2a_message_author WHERE message_id = ${messageId}
      `;
      const held =
        recorded.length > 0
          ? []
          : yield* sql<{ readonly found: number }>`
              SELECT 1 AS found FROM orchestration_v2_projection_messages
              WHERE message_id = ${messageId}
            `;
      if (recorded.some((row) => row.person_id !== author.personId) || held.length > 0) {
        return yield* refused("This message was already sent.");
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);
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

    return { writerLabel, authorOn, announce, recordAuthor };
  },
);
