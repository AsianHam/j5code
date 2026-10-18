import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { ThreadId } from "@t3tools/contracts";

import {
  type AnswerHumanExchangeInput,
  CommCommandId,
  type CommEvent,
  CorrelationId,
  EVERYONE_HERE_PERSON_ID,
  LedgerProjectId,
  ExchangeId,
  type HumanInboxItem,
  type HumanInboxListStatus,
  isDurableHumanParticipantId,
  LedgerMessageId,
  ParticipantId,
  type SendMessageResult,
} from "./contracts.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import {
  type A2ALocalOperatorNotFoundError,
  getLocalOperatorHumanPersonId,
  isHumanPerson,
  writesEveryThread,
} from "./HumanPersonRegistry.ts";
import type { PersonAccessStorageError } from "../sharing/PersonAccess.ts";
import { SharedThreads, layer as sharedThreadsLayer } from "../sharing/SharedThreads.ts";
import {
  A2AExchangeAlreadyAnsweredError,
  A2AExchangeNotOpenError,
  A2AParticipantNotFoundError,
} from "./SendService.ts";

export class A2AHumanPersonIdError extends Schema.TaggedError<A2AHumanPersonIdError>()(
  "A2AHumanPersonIdError",
  { personId: Schema.String },
) {
  override get message(): string {
    return `Person ${this.personId} is not a durable human:<person-id>. Select an explicit person-scoped inbox.`;
  }
}

/** A later reply to an ask to everyone here, which the first reply closed (Inbox AC16). */
export class A2AAskAnsweredError extends Schema.TaggedError<A2AAskAnsweredError>()(
  "A2AAskAnsweredError",
  { answeredBy: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.answeredBy === null
      ? "Someone already answered this."
      : `${this.answeredBy} already answered this.`;
  }
}

/** An answer from someone who can no longer write to the asking agent's thread (Inbox AC14). */
export class A2AAskNotYoursError extends Schema.TaggedError<A2AAskNotYoursError>()(
  "A2AAskNotYoursError",
  {},
) {
  override get message(): string {
    return "You can no longer write to the agent that asked this, so it is not yours to answer.";
  }
}

export type A2AHumanInboxError =
  | A2ALedgerError
  | SqlError
  | PersonAccessStorageError
  | A2ALocalOperatorNotFoundError
  | A2AHumanPersonIdError
  | A2AParticipantNotFoundError
  | A2AExchangeNotOpenError
  | A2AExchangeAlreadyAnsweredError
  | A2AAskAnsweredError
  | A2AAskNotYoursError;

interface InboxRow {
  readonly person_id: string;
  readonly project_id: string;
  readonly project_title: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly sender_thread_id: string | null;
  readonly intent: string;
  readonly urgency: "blocking" | "soon" | "fyi";
  readonly message: string;
  readonly opened_at: string;
  readonly status: "open" | "answered";
  readonly terminal_at: string | null;
  readonly answered_by: string | null;
}

interface ExchangeRow {
  readonly project_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
}

interface ExistingReplyRow {
  readonly project_id: string;
  readonly sent_seq: number;
}

const messageIdFor = (commandId: CommCommandId) =>
  LedgerMessageId.make(`message:j5:a2a:${encodeURIComponent(commandId)}`);

const correlationIdFor = (commandId: CommCommandId) =>
  CorrelationId.make(`correlation:j5:a2a:${encodeURIComponent(commandId)}`);

const assertPersonId = (personId: ParticipantId) =>
  isDurableHumanParticipantId(personId)
    ? Effect.void
    : Effect.fail(new A2AHumanPersonIdError({ personId }));

export interface A2AHumanInboxShape {
  readonly resolvePersonId: (
    personId?: ParticipantId,
  ) => Effect.Effect<ParticipantId, A2AHumanInboxError>;
  readonly list: (
    personId: ParticipantId,
    status?: HumanInboxListStatus,
  ) => Effect.Effect<ReadonlyArray<HumanInboxItem>, A2AHumanInboxError>;
  readonly answer: (
    input: AnswerHumanExchangeInput,
    /**
     * Runs once the reply is known to be one this person may give, before it is recorded, with
     * the asking agent's thread and the reply's message id: a shared conversation records who
     * is replying, and any note due, as they stand now.
     */
    beforeReply?: (reply: {
      readonly threadId: ThreadId;
      readonly messageId: LedgerMessageId;
    }) => Effect.Effect<void, PersonAccessStorageError>,
  ) => Effect.Effect<SendMessageResult, A2AHumanInboxError>;
}

export class A2AHumanInbox extends Context.Service<A2AHumanInbox, A2AHumanInboxShape>()(
  "t3/j5/a2a/HumanInboxService/A2AHumanInbox",
) {}

/**
 * A person's inbox holds the asks addressed to them and the asks to everyone here, and of those
 * only the ones whose asking agent's thread they can write to when it is read (Inbox AC14,
 * AC15). Someone who writes to every thread sees them all; a Viewer sees none.
 */
export const layer: Layer.Layer<A2AHumanInbox, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    A2AHumanInbox,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;
      const shared = yield* SharedThreads;

      const resolvePersonId: A2AHumanInboxShape["resolvePersonId"] = (personId) =>
        Effect.gen(function* () {
          if (personId === undefined) return yield* getLocalOperatorHumanPersonId(sql);
          yield* assertPersonId(personId);
          if (!(yield* isHumanPerson(sql, personId))) {
            return yield* new A2AParticipantNotFoundError({ participantId: personId });
          }
          return personId;
        });

      /**
       * Whether a person may answer what an agent asks: they can write to its thread. Built once
       * per person, so a list reads whether they write to every thread once, not row by row.
       */
      const writerOfAskers = (personId: ParticipantId) =>
        writesEveryThread(sql, personId).pipe(
          Effect.map(
            (everywhere) =>
              (asker: { readonly threadId: string | null; readonly projectId: string }) =>
                everywhere
                  ? Effect.succeed(true)
                  : shared.writesTo(personId, {
                      threadId: asker.threadId === null ? null : ThreadId.make(asker.threadId),
                      projectId: asker.projectId,
                    }),
          ),
        );

      const list: A2AHumanInboxShape["list"] = (personId, status = "open") =>
        Effect.gen(function* () {
          yield* resolvePersonId(personId);
          const rows = yield* sql<InboxRow>`
            SELECT
              exchange.receiver_id AS person_id,
              exchange.project_id,
              COALESCE(project.title, ledger.project_id) AS project_title,
              exchange.exchange_id,
              exchange.sender_id,
              membership.thread_id AS sender_thread_id,
              exchange.intent,
              exchange.urgency,
              inbox.latest_message AS message,
              inbox.opened_at,
              inbox.status,
              inbox.terminal_at,
              everyone.display_name AS answered_by
            FROM j5_a2a_human_inbox AS inbox
            JOIN j5_a2a_project_ledger AS ledger ON ledger.project_id = inbox.project_id
            LEFT JOIN projection_projects AS project ON project.project_id = inbox.project_id
            JOIN j5_a2a_exchange AS exchange
              ON exchange.project_id = inbox.project_id
             AND exchange.exchange_id = inbox.exchange_id
            LEFT JOIN j5_a2a_membership AS membership
              ON membership.project_id = inbox.project_id
             AND membership.participant_id = inbox.sender_id
            LEFT JOIN j5_a2a_everyone_answer AS everyone
              ON everyone.project_id = inbox.project_id
             AND everyone.exchange_id = inbox.exchange_id
            WHERE (
                (${status} = 'open' AND inbox.status = 'open' AND exchange.status = 'open')
                OR
                (${status} = 'answered' AND inbox.status = 'answered'
                  AND inbox.terminal_disposition = 'answered')
              )
              AND inbox.person_id IN (${personId}, ${EVERYONE_HERE_PERSON_ID})
            ORDER BY
              CASE WHEN ${status} = 'open' THEN
                CASE inbox.urgency
                  WHEN 'blocking' THEN 0
                  WHEN 'soon' THEN 1
                  WHEN 'fyi' THEN 2
                END
              END,
              CASE WHEN ${status} = 'open' THEN inbox.opened_at END,
              CASE WHEN ${status} = 'answered' THEN inbox.terminal_at END DESC,
              inbox.project_id,
              inbox.exchange_id
          `;
          const writesToAsker = yield* writerOfAskers(personId);
          const visible = yield* Effect.filter(rows, (row) =>
            writesToAsker({
              threadId: row.sender_thread_id,
              projectId: row.project_id,
            }),
          );
          return visible.map(
            (row) =>
              ({
                personId,
                projectId: LedgerProjectId.make(row.project_id),
                projectTitle: row.project_title,
                exchangeId: ExchangeId.make(row.exchange_id),
                senderId: ParticipantId.make(row.sender_id),
                senderThreadId:
                  row.sender_thread_id === null ? null : ThreadId.make(row.sender_thread_id),
                intent: row.intent,
                urgency: row.urgency,
                message: row.message,
                openedAt: row.opened_at,
                status: row.status,
                terminalAt: row.terminal_at,
                ...(row.person_id === EVERYONE_HERE_PERSON_ID
                  ? { forEveryone: true, answeredBy: row.answered_by }
                  : {}),
              }) satisfies HumanInboxItem,
          );
        });

      const answer: A2AHumanInboxShape["answer"] = (input, beforeReply) =>
        Effect.gen(function* () {
          yield* assertPersonId(input.personId);
          if (!(yield* isHumanPerson(sql, input.personId))) {
            return yield* new A2AParticipantNotFoundError({ participantId: input.personId });
          }
          const messageId = messageIdFor(input.commandId);
          const replay = yield* sql<ExistingReplyRow>`
            SELECT project_id, sent_seq
            FROM j5_a2a_delivery
            WHERE message_id = ${messageId}
              AND sender_id = ${input.personId}
              AND exchange_id = ${input.exchangeId}
              AND exchange_role = 'reply'
            LIMIT 2
          `;
          if (replay.length === 1) {
            return {
              messageId,
              exchangeId: input.exchangeId,
              exchangeState: "closed",
              joinedExistingExchange: false,
              durableAtSeq: replay[0]!.sent_seq,
            } satisfies SendMessageResult;
          }

          const exchanges = yield* sql<ExchangeRow & { readonly sender_thread_id: string | null }>`
            SELECT exchange.project_id, exchange.exchange_id, exchange.sender_id,
              exchange.receiver_id, exchange.status, membership.thread_id AS sender_thread_id
            FROM j5_a2a_exchange AS exchange
            LEFT JOIN j5_a2a_membership AS membership
              ON membership.project_id = exchange.project_id
             AND membership.participant_id = exchange.sender_id
            WHERE exchange.exchange_id = ${input.exchangeId}
              AND exchange.receiver_id IN (${input.personId}, ${EVERYONE_HERE_PERSON_ID})
            LIMIT 2
          `;
          const exchange = exchanges.length === 1 ? exchanges[0] : undefined;
          if (exchange === undefined) {
            return yield* new A2AParticipantNotFoundError({ participantId: input.personId });
          }
          if (
            !(yield* (yield* writerOfAskers(input.personId))({
              threadId: exchange.sender_thread_id,
              projectId: exchange.project_id,
            }))
          ) {
            return yield* new A2AAskNotYoursError({});
          }
          const forEveryone = exchange.receiver_id === EVERYONE_HERE_PERSON_ID;
          const firstAnswer = sql<{ readonly display_name: string | null }>`
            SELECT display_name FROM j5_a2a_everyone_answer
            WHERE project_id = ${exchange.project_id} AND exchange_id = ${exchange.exchange_id}
          `.pipe(Effect.map((rows) => rows[0]));
          const alreadyAnswered = firstAnswer.pipe(
            Effect.flatMap((row) =>
              Effect.fail(new A2AAskAnsweredError({ answeredBy: row?.display_name ?? null })),
            ),
          );
          if (exchange.status !== "open") {
            if (forEveryone && (yield* firstAnswer) !== undefined) return yield* alreadyAnswered;
            return yield* new A2AExchangeNotOpenError({ exchangeId: input.exchangeId });
          }
          const acceptedReplies = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_delivery
            WHERE exchange_id = ${input.exchangeId} AND exchange_role = 'reply'
          `;
          if ((acceptedReplies[0]?.count ?? 0) > 0) {
            if (forEveryone) return yield* alreadyAnswered;
            return yield* new A2AExchangeAlreadyAnsweredError({ exchangeId: input.exchangeId });
          }
          if (beforeReply !== undefined && exchange.sender_thread_id !== null) {
            yield* beforeReply({
              threadId: ThreadId.make(exchange.sender_thread_id),
              messageId,
            });
          }
          if (forEveryone) {
            // The first reply to an ask to everyone closes it for all of them: two people
            // answering at once both get here, and the key lets only one claim it.
            const claimed = yield* sql<{ readonly person_id: string }>`
              INSERT INTO j5_a2a_everyone_answer (
                project_id, exchange_id, person_id, display_name, answered_at
              )
              SELECT ${exchange.project_id}, ${exchange.exchange_id}, person_id, display_name,
                ${input.acceptedAt}
              FROM j5_a2a_human_person WHERE person_id = ${input.personId}
              ON CONFLICT (project_id, exchange_id) DO NOTHING
              RETURNING person_id
            `;
            if (claimed.length === 0) return yield* alreadyAnswered;
          }
          const releaseClaim = sql`
            DELETE FROM j5_a2a_everyone_answer
            WHERE project_id = ${exchange.project_id} AND exchange_id = ${exchange.exchange_id}
              AND person_id = ${input.personId}
          `.pipe(Effect.ignore);

          const projectId = LedgerProjectId.make(exchange.project_id);
          const senderId = ParticipantId.make(exchange.sender_id);
          const correlationId = correlationIdFor(input.commandId);
          const events: ReadonlyArray<CommEvent> = [
            {
              kind: "message.sent",
              sender: input.personId,
              receiver: senderId,
              exchangeId: input.exchangeId,
              correlationId,
              payload: {
                messageId,
                text: input.message,
                originProjectId: projectId,
                receiverProjectId: projectId,
                exchangeRole: "reply",
                envelopeChannel: "peer",
              },
              createdAt: input.acceptedAt,
            },
            {
              kind: "exchange.closed",
              sender: input.personId,
              receiver: senderId,
              exchangeId: input.exchangeId,
              correlationId,
              payload: { replyMessageId: messageId },
              createdAt: input.acceptedAt,
            },
          ];
          // A reply that is not recorded leaves the ask open for someone else to answer.
          const result = yield* ledger
            .appendEvents({
              commandId: input.commandId,
              projectId,
              acceptedAt: input.acceptedAt,
              events,
            })
            .pipe(Effect.onError(() => (forEveryone ? releaseClaim : Effect.void)));
          const sent = result.events.find((event) => event.kind === "message.sent");
          if (sent === undefined) {
            return yield* new A2AParticipantNotFoundError({ participantId: input.personId });
          }
          return {
            messageId,
            exchangeId: input.exchangeId,
            exchangeState: "closed",
            joinedExistingExchange: false,
            durableAtSeq: sent.seq,
          } satisfies SendMessageResult;
        });

      return A2AHumanInbox.of({ resolvePersonId, list, answer });
    }),
  ).pipe(Layer.provide(sharedThreadsLayer));
