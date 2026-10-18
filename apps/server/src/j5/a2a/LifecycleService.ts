import { type OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker, type A2ADeliveryWorkerError } from "./DeliveryWorker.ts";
import {
  type ArchiveParticipantInput,
  CommCommandId,
  type CommEvent,
  CorrelationId,
  LedgerProjectId,
  ExchangeId,
  type ExchangeDropDisposition,
  isHumanParticipantId,
  LIFECYCLE_PARTICIPANT_ID,
  LedgerMessageId,
  type LifecycleArchiveResult,
  Participant,
  ParticipantId,
} from "./contracts.ts";
import { type A2AHomeRegistrationError, resolveThreadHome } from "./HomeRegistrar.ts";
import {
  selfContainedLayer as threadRegistrationLayer,
  ThreadRegistration,
} from "./ThreadRegistration.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import { findPeerCounterparty } from "./peerCounterparty.ts";

export class A2ALifecycleParticipantNotFoundError extends Schema.TaggedError<A2ALifecycleParticipantNotFoundError>()(
  "A2ALifecycleParticipantNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} does not exist and cannot be archived.`;
  }
}

export class A2ALifecycleHumanArchiveNotAllowedError extends Schema.TaggedError<A2ALifecycleHumanArchiveNotAllowedError>()(
  "A2ALifecycleHumanArchiveNotAllowedError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is a person. This operation archives agents only.`;
  }
}

export class A2ALifecycleCounterpartyStateError extends Schema.TaggedError<A2ALifecycleCounterpartyStateError>()(
  "A2ALifecycleCounterpartyStateError",
  {
    participantId: Schema.String,
    exchangeId: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot close exchange ${this.exchangeId}: affected participant ${this.participantId} has no readable membership.`;
  }
}

export class A2ALifecycleParticipantHomeStateError extends Schema.TaggedError<A2ALifecycleParticipantHomeStateError>()(
  "A2ALifecycleParticipantHomeStateError",
  {
    participantId: Schema.String,
    projectIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Participant ${this.participantId} is registered in more than one project (${this.projectIds.join(", ")}). Repair its history before lifecycle retirement resumes.`;
  }
}

export class A2ALifecycleBridgeError extends Schema.TaggedError<A2ALifecycleBridgeError>()(
  "A2ALifecycleBridgeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export type A2ALifecycleError =
  | A2ADeliveryWorkerError
  | A2ALedgerError
  | A2AHomeRegistrationError
  | Schema.SchemaError
  | SqlError
  | A2ALifecycleParticipantNotFoundError
  | A2ALifecycleHumanArchiveNotAllowedError
  | A2ALifecycleCounterpartyStateError
  | A2ALifecycleParticipantHomeStateError;

export interface A2ALifecycleServiceShape {
  /** Platform lifecycle authority only. This service is deliberately absent from the agent MCP toolkit. */
  readonly archiveParticipant: (
    input: ArchiveParticipantInput,
  ) => Effect.Effect<LifecycleArchiveResult, A2ALifecycleError>;
  readonly handleStoredEvent: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<boolean, A2ALifecycleBridgeError>;
  readonly replayCommittedEvents: Effect.Effect<void, A2ALifecycleBridgeError>;
  /**
   * Registers every thread that should be a participant and is not one yet, and returns how many
   * it registered. The daemon runs it at start, which is how threads from before every thread
   * registered at creation (mobile, imported, system-started) become participants.
   */
  readonly registerExistingThreads: Effect.Effect<number, A2ALifecycleBridgeError>;
  /**
   * Ends every open ask to one person that they can no longer answer, as their access changed:
   * `mayAnswer` says, per asking agent, whether they can still write to its thread. Each asking
   * agent is told its ask was dropped, so it does not wait for a reply that cannot come. Asks to
   * everyone here are not one person's and are left. Returns the asks it ended.
   */
  readonly endAsksOf: <E>(input: {
    readonly personId: ParticipantId;
    readonly mayAnswer: (asker: {
      readonly threadId: string | null;
      readonly projectId: string;
    }) => Effect.Effect<boolean, E>;
    readonly endedAt: string;
  }) => Effect.Effect<ReadonlyArray<ExchangeId>, E | A2ALifecycleError>;
}

export class A2ALifecycleService extends Context.Service<
  A2ALifecycleService,
  A2ALifecycleServiceShape
>()("t3/j5/a2a/LifecycleService/A2ALifecycleService") {}

interface MembershipRow {
  readonly project_id: string;
  readonly participant_id: string;
  readonly participant_kind: "agent" | "human";
  readonly payload: string;
}

interface HistoricalParticipantRow {
  readonly project_id: string;
  readonly payload: string;
  readonly retired: number;
}

interface ExchangeRow {
  readonly project_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

interface CursorRow {
  readonly after_sequence: number;
}

const stablePart = (value: string) => encodeURIComponent(value);

const lifecycleKey = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  `${stablePart(exchange.project_id)}:${stablePart(exchange.exchange_id)}:${disposition}`;

const dropCommandId = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  CommCommandId.make(`command:j5:a2a:lifecycle:drop:${lifecycleKey(exchange, disposition)}`);

const noticeMessageId = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  LedgerMessageId.make(`message:j5:a2a:lifecycle:drop:${lifecycleKey(exchange, disposition)}`);

const noticeCorrelationId = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  CorrelationId.make(`correlation:j5:a2a:lifecycle:drop:${lifecycleKey(exchange, disposition)}`);

const participantArchiveCommandId = (projectId: LedgerProjectId, participantId: ParticipantId) =>
  CommCommandId.make(
    `command:j5:a2a:lifecycle:participant:${stablePart(projectId)}:${stablePart(participantId)}`,
  );

/** What an agent is told when the person it asked can no longer write to its thread. */
export const formatAccessEndedNotice = (input: {
  readonly exchangeId: ExchangeId;
  readonly personId: ParticipantId;
}): string =>
  [
    `[Cross-agent messaging system notice: exchange dropped]`,
    `Exchange ${input.exchangeId} ended because ${input.personId} can no longer write to your thread, so they will not answer it (receiver-retired).`,
    "If you still need an answer, ask someone who can write to your thread, or everyone here; call j5_list_participants to see who.",
    "Facts: replyRequired=false; retryAllowed=false; replacementRequired=false.",
    "This is a platform-authored terminal notice, not a peer reply.",
  ].join("\n\n");

export const formatLifecycleNotice = (input: {
  readonly exchangeId: ExchangeId;
  readonly retiredParticipantId: ParticipantId;
  readonly disposition: ExchangeDropDisposition;
  readonly operation?: "archived" | "deleted";
}): string => {
  const consequence =
    input.disposition === "receiver-retired"
      ? "The receiver will not answer this Exchange. Do not retry it."
      : "The asker is gone. Your reply obligation has ended; do not send a replacement reply.";
  return [
    `[Cross-agent messaging system notice: exchange dropped]`,
    `Exchange ${input.exchangeId} ended because ${input.retiredParticipantId} was ${input.operation ?? "archived"} (${input.disposition}).`,
    consequence,
    "Facts: replyRequired=false; retryAllowed=false; replacementRequired=false.",
    "This is a platform-authored terminal notice, not a peer reply.",
  ].join("\n\n");
};

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const bridgeError = (operation: string) => (cause: unknown) =>
  new A2ALifecycleBridgeError({ operation, cause });

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    A2ALifecycleService,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const worker = yield* A2ADeliveryWorker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const registration = yield* ThreadRegistration;
      const sql = yield* SqlClient.SqlClient;
      const lifecyclePermit = yield* Semaphore.make(1);

      const membershipRows = Effect.fn("j5.a2a.lifecycle.membershipRows")(function* (
        participantId: ParticipantId,
      ) {
        return yield* sql<MembershipRow>`
          SELECT project_id, participant_id, participant_kind, payload
          FROM j5_a2a_membership
          WHERE participant_id = ${participantId}
          ORDER BY project_id
        `;
      });

      const historicalParticipantRows = Effect.fn("j5.a2a.lifecycle.historicalParticipantRows")(
        function* (participantId: ParticipantId) {
          return yield* sql<HistoricalParticipantRow>`
          SELECT
            joined.project_id,
            json_extract(joined.payload, '$.participant') AS payload,
            EXISTS (
              SELECT 1
              FROM j5_a2a_comm_event AS retirement
              WHERE retirement.project_id = joined.project_id
                AND retirement.seq > joined.seq
                AND retirement.kind IN ('participant.left', 'participant.deleted')
                AND json_extract(retirement.payload, '$.participant.kind') = 'agent'
                AND json_extract(retirement.payload, '$.participant.id') = ${participantId}
                AND json_extract(retirement.payload, '$.participant.threadId') =
                  json_extract(joined.payload, '$.participant.threadId')
            ) AS retired
          FROM j5_a2a_comm_event AS joined
          WHERE joined.kind = 'participant.joined'
            AND json_extract(joined.payload, '$.participant.id') = ${participantId}
          ORDER BY joined.seq
          LIMIT 2
        `;
        },
      );

      /** Where the notice about a dropped Exchange goes: a project here, or one on a peer server. */
      const counterparty = Effect.fn("j5.a2a.lifecycle.counterparty")(function* (
        participantId: ParticipantId,
        exchange: ExchangeRow,
      ): Effect.fn.Return<
        { readonly projectId: LedgerProjectId; readonly environmentId: string | null },
        SqlError | A2ALifecycleCounterpartyStateError
      > {
        if (isHumanParticipantId(participantId)) {
          return { projectId: LedgerProjectId.make(exchange.project_id), environmentId: null };
        }
        const rows = yield* membershipRows(participantId);
        const row =
          rows.find((candidate) => candidate.project_id === exchange.project_id) ?? rows[0];
        if (row !== undefined) {
          return { projectId: LedgerProjectId.make(row.project_id), environmentId: null };
        }
        const remote = yield* findPeerCounterparty(sql, {
          projectId: LedgerProjectId.make(exchange.project_id),
          exchangeId: ExchangeId.make(exchange.exchange_id),
          participantId,
        });
        if (remote !== null) return remote;
        const historical = yield* historicalParticipantRows(participantId);
        const historicalRow =
          historical.find((candidate) => candidate.project_id === exchange.project_id) ??
          historical[0];
        if (historicalRow === undefined) {
          return yield* new A2ALifecycleCounterpartyStateError({
            participantId,
            exchangeId: exchange.exchange_id,
          });
        }
        return { projectId: LedgerProjectId.make(historicalRow.project_id), environmentId: null };
      });

      const dropParticipantExchanges = Effect.fn("j5.a2a.lifecycle.dropParticipantExchanges")(
        function* (input: {
          readonly participantId: ParticipantId;
          readonly projectId: LedgerProjectId;
          readonly archivedAt: string;
          readonly operation: "archived" | "deleted";
        }) {
          const exchanges = yield* sql<ExchangeRow>`
          SELECT project_id, exchange_id, sender_id, receiver_id
          FROM j5_a2a_exchange
          WHERE status = 'open'
            AND (sender_id = ${input.participantId} OR receiver_id = ${input.participantId})
          ORDER BY project_id, opened_seq, exchange_id
        `;
          const dropped: Array<ExchangeId> = [];
          for (const exchange of exchanges) {
            const disposition: ExchangeDropDisposition =
              exchange.receiver_id === input.participantId ? "receiver-retired" : "sender-retired";
            const affectedParticipantId = ParticipantId.make(
              disposition === "receiver-retired" ? exchange.sender_id : exchange.receiver_id,
            );
            const exchangeId = ExchangeId.make(exchange.exchange_id);
            const messageId = noticeMessageId(exchange, disposition);
            const correlationId = noticeCorrelationId(exchange, disposition);
            const receiver = yield* counterparty(affectedParticipantId, exchange);
            // The sender's waiting deliveries were cancelled before this runs, and
            // the cancel waited out any attempt in flight. So a peer server never
            // held an Exchange only when its ask ended cancelled; one delivered, or
            // handed out to it when it polls, gets the notice closing it.
            const peerNeverHeldIt =
              receiver.environmentId !== null &&
              disposition === "sender-retired" &&
              (yield* sql`
                SELECT 1 FROM j5_a2a_delivery
                WHERE project_id = ${exchange.project_id}
                  AND exchange_id = ${exchange.exchange_id}
                  AND receiver_id = ${affectedParticipantId}
                  AND receiver_environment_id = ${receiver.environmentId}
                  AND exchange_role = 'ask'
                  AND status = 'cancelled'
                LIMIT 1
              `).length > 0;
            const noticeEvent: CommEvent = {
              kind: "message.sent",
              sender: LIFECYCLE_PARTICIPANT_ID,
              receiver: affectedParticipantId,
              exchangeId,
              correlationId,
              payload: {
                messageId,
                text: formatLifecycleNotice({
                  exchangeId,
                  retiredParticipantId: input.participantId,
                  operation: input.operation,
                  disposition,
                }),
                originProjectId: LedgerProjectId.make(exchange.project_id),
                receiverProjectId: receiver.projectId,
                ...(receiver.environmentId === null
                  ? {}
                  : {
                      receiverEnvironmentId: receiver.environmentId,
                      terminal: {
                        kind: "dropped" as const,
                        cause: {
                          kind:
                            input.operation === "deleted"
                              ? ("participant-deleted" as const)
                              : ("participant-archived" as const),
                          participantId: input.participantId,
                          projectId: input.projectId,
                        },
                      },
                    }),
                exchangeRole: "terminal_notice",
                envelopeChannel: "lifecycle_notice",
              },
              createdAt: input.archivedAt,
            };
            yield* ledger.appendEvents({
              commandId: dropCommandId(exchange, disposition),
              projectId: LedgerProjectId.make(exchange.project_id),
              acceptedAt: input.archivedAt,
              events: [
                {
                  kind: "exchange.dropped",
                  sender: ParticipantId.make(exchange.sender_id),
                  receiver: ParticipantId.make(exchange.receiver_id),
                  exchangeId,
                  correlationId,
                  payload: {
                    disposition,
                    cause: {
                      kind:
                        input.operation === "deleted"
                          ? "participant-deleted"
                          : "participant-archived",
                      participantId: input.participantId,
                      projectId: input.projectId,
                    },
                    facts: {
                      replyRequired: false,
                      retryAllowed: false,
                      replacementRequired: false,
                    },
                    noticeMessageId: messageId,
                  },
                  createdAt: input.archivedAt,
                },
                ...(peerNeverHeldIt ? [] : [noticeEvent]),
              ],
            });
            dropped.push(exchangeId);
          }
          return dropped;
        },
      );

      const archiveParticipantInternal = Effect.fn("j5.a2a.lifecycle.archiveParticipantInternal")(
        function* (
          input: ArchiveParticipantInput,
          operation: "archived" | "unarchived" | "deleted" = "archived",
        ) {
          const rows = yield* historicalParticipantRows(input.participantId);
          if (rows.length === 0) {
            return yield* new A2ALifecycleParticipantNotFoundError({
              participantId: input.participantId,
            });
          }
          if (rows.length !== 1) {
            return yield* new A2ALifecycleParticipantHomeStateError({
              participantId: input.participantId,
              projectIds: rows.map((row) => row.project_id),
            });
          }
          const row = rows[0]!;
          const projectId = LedgerProjectId.make(row.project_id);
          const participant = yield* decodeParticipant(row.payload);
          if (participant.kind !== "agent") {
            return yield* new A2ALifecycleHumanArchiveNotAllowedError({
              participantId: input.participantId,
            });
          }
          const memberships = yield* sql<{
            readonly archived_at: string | null;
            readonly updated_seq: number;
          }>`
            SELECT archived_at, updated_seq FROM j5_a2a_membership
            WHERE project_id = ${projectId} AND participant_id = ${input.participantId}
          `;
          const membership = memberships[0];
          // A historical departure is permanent. Unarchive must never recreate a
          // retired identity, including when old thread events are replayed.
          if (operation !== "deleted" && row.retired !== 0) {
            return { archived: false, droppedExchangeIds: [] };
          }
          const archived = operation === "archived" && membership?.archived_at === null;
          const hasPlacement =
            operation === "deleted" &&
            (yield* sql`SELECT 1 FROM j5_a2a_participant_placement WHERE participant_id = ${input.participantId}`)
              .length !== 0;
          const changesState =
            (operation === "deleted" && (membership !== undefined || hasPlacement)) ||
            (membership !== undefined &&
              (operation === "archived"
                ? membership.archived_at === null
                : membership.archived_at !== null));
          if (changesState) {
            yield* ledger.append({
              commandId: CommCommandId.make(
                `${participantArchiveCommandId(projectId, input.participantId)}:${operation}:${membership?.updated_seq ?? "absent"}`,
              ),
              projectId,
              acceptedAt: input.archivedAt,
              event: {
                kind:
                  operation === "deleted"
                    ? "participant.deleted"
                    : operation === "unarchived"
                      ? "participant.unarchived"
                      : "participant.archived",
                sender: null,
                receiver: input.participantId,
                exchangeId: null,
                correlationId: null,
                payload: { participant },
                createdAt: input.archivedAt,
              },
            });
          }
          if (operation === "unarchived") return { archived: false, droppedExchangeIds: [] };
          // Cancel first: whether a peer server is told an Exchange closed depends
          // on whether its ask ended cancelled, which only the cancel settles.
          yield* worker.cancelParticipantDeliveries(input.participantId);
          const droppedExchangeIds = yield* dropParticipantExchanges({
            participantId: input.participantId,
            projectId,
            archivedAt: input.archivedAt,
            operation,
          });
          return { archived, droppedExchangeIds } satisfies LifecycleArchiveResult;
        },
      );

      const archiveParticipantRaw = Effect.fn("j5.a2a.lifecycle.archiveParticipant")(function* (
        input: ArchiveParticipantInput,
      ) {
        const result = yield* archiveParticipantInternal(input);
        yield* worker.notify;
        return result;
      });
      const archiveParticipant: A2ALifecycleServiceShape["archiveParticipant"] = (input) =>
        lifecyclePermit.withPermit(archiveParticipantRaw(input));

      /**
       * Registers one thread in its project. Registration records a thread that is already
       * archived as archived, so the result does not depend on whether its archive event was seen
       * first.
       */
      const registerThread = Effect.fn("j5.a2a.lifecycle.registerThread")(function* (
        threadId: OrchestrationV2StoredEvent["event"]["threadId"],
      ) {
        return (yield* registration.ensureRegistered(threadId)) !== null;
      });

      const registerExistingThreadsRaw = Effect.fn("j5.a2a.lifecycle.registerExistingThreads")(
        function* () {
          const unregistered = yield* sql<{ readonly thread_id: string }>`
            SELECT thread.thread_id
            FROM orchestration_v2_projection_threads AS thread
            WHERE thread.deleted_at IS NULL
              AND COALESCE(
                json_extract(thread.payload_json, '$.lineage.relationshipToParent'), ''
              ) <> 'subagent'
              AND NOT EXISTS (
                SELECT 1 FROM j5_a2a_comm_event AS joined
                WHERE joined.kind = 'participant.joined'
                  AND json_extract(joined.payload, '$.participant.kind') = 'agent'
                  AND json_extract(joined.payload, '$.participant.threadId') = thread.thread_id
              )
            ORDER BY thread.created_at, thread.thread_id
          `;
          let registered = 0;
          for (const row of unregistered) {
            if (yield* lifecyclePermit.withPermit(registerThread(ThreadId.make(row.thread_id)))) {
              registered += 1;
            }
          }
          return registered;
        },
      );

      const handleStoredEventInternal = Effect.fn("j5.a2a.lifecycle.handleStoredEvent")(function* (
        stored: OrchestrationV2StoredEvent,
      ) {
        // Every way a thread comes to exist writes this event, including the importers that
        // bypass the thread.create command.
        if (stored.event.type === "thread.created") {
          return yield* registerThread(stored.event.threadId);
        }
        if (
          stored.event.type !== "thread.archived" &&
          stored.event.type !== "thread.deleted" &&
          stored.event.type !== "thread.unarchived"
        ) {
          return false;
        }
        const processed =
          yield* sql`SELECT 1 FROM j5_a2a_lifecycle_processed WHERE event_id = ${stored.event.id}`;
        if (processed.length !== 0) return true;
        const resolution = yield* resolveThreadHome(sql, stored.event.threadId).pipe(
          Effect.catchTags({ A2AHomeNotFoundError: () => Effect.succeed(null) }),
        );
        if (resolution === null) return false;
        yield* archiveParticipantInternal(
          {
            participantId: resolution.home.participantId,
            archivedAt: DateTime.formatIso(stored.event.occurredAt),
          },
          stored.event.type === "thread.deleted"
            ? "deleted"
            : stored.event.type === "thread.unarchived"
              ? "unarchived"
              : "archived",
        );
        yield* sql`INSERT INTO j5_a2a_lifecycle_processed (event_id) VALUES (${stored.event.id}) ON CONFLICT DO NOTHING`;
        yield* worker.notify;
        return true;
      });

      const handleStoredEventRaw = (stored: OrchestrationV2StoredEvent) =>
        lifecyclePermit.withPermit(handleStoredEventInternal(stored));

      const readCursor = Effect.fn("j5.a2a.lifecycle.readCursor")(function* () {
        const rows = yield* sql<CursorRow>`
          SELECT after_sequence
          FROM j5_a2a_lifecycle_cursor
          WHERE singleton = 1
        `;
        return rows[0]?.after_sequence ?? 0;
      });

      const writeCursor = Effect.fn("j5.a2a.lifecycle.writeCursor")(function* (sequence: number) {
        const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* sql`
          UPDATE j5_a2a_lifecycle_cursor
          SET after_sequence = ${sequence}, updated_at = ${updatedAt}
          WHERE singleton = 1 AND after_sequence < ${sequence}
        `;
      });

      const replayCommittedEventsRaw = Effect.fn("j5.a2a.lifecycle.replayCommittedEvents")(
        function* () {
          let checkpoint = yield* readCursor();
          let lastSeen = checkpoint;
          yield* threads.streamStoredEventsFrom({ afterSequence: checkpoint }).pipe(
            Stream.runForEach((event) =>
              handleStoredEventRaw(event).pipe(
                Effect.andThen((archived) =>
                  Effect.gen(function* () {
                    lastSeen = event.sequence;
                    if (archived || event.sequence - checkpoint >= 128) {
                      yield* writeCursor(event.sequence);
                      checkpoint = event.sequence;
                    }
                  }),
                ),
              ),
            ),
          );
          if (lastSeen > checkpoint) yield* writeCursor(lastSeen);
        },
      );

      const handleStoredEvent: A2ALifecycleServiceShape["handleStoredEvent"] = (event) =>
        handleStoredEventRaw(event).pipe(Effect.mapError(bridgeError("handle thread retirement")));
      const replayCommittedEvents: A2ALifecycleServiceShape["replayCommittedEvents"] =
        replayCommittedEventsRaw().pipe(Effect.mapError(bridgeError("replay thread retirements")));
      const registerExistingThreads: A2ALifecycleServiceShape["registerExistingThreads"] =
        registerExistingThreadsRaw().pipe(
          Effect.mapError(bridgeError("register existing threads")),
        );

      if (daemon) {
        let retryDelayMs = 250;
        const run = Effect.forever(
          registerExistingThreadsRaw().pipe(
            Effect.tap((registered) =>
              registered === 0
                ? Effect.void
                : Effect.logInfo("J5 A2A registered existing threads in their projects", {
                    registered,
                  }),
            ),
            Effect.andThen(replayCommittedEventsRaw()),
            Effect.andThen(Effect.die("J5 A2A lifecycle retirement stream ended")),
            Effect.catchCause((cause) => {
              const delayMs = retryDelayMs;
              retryDelayMs = Math.min(delayMs * 2, 30_000);
              return Effect.logWarning(
                "J5 A2A lifecycle retirement stream failed; resuming from cursor",
                { cause, retryDelayMs: delayMs },
              ).pipe(Effect.andThen(Effect.sleep(Duration.millis(delayMs))));
            }),
          ),
        );
        yield* Effect.forkScoped(run);
      }

      const endAsksOf: A2ALifecycleServiceShape["endAsksOf"] = (input) =>
        lifecyclePermit.withPermit(
          Effect.gen(function* () {
            const asks = yield* sql<ExchangeRow & { readonly sender_thread_id: string | null }>`
              SELECT exchange.project_id, exchange.exchange_id, exchange.sender_id,
                exchange.receiver_id, membership.thread_id AS sender_thread_id
              FROM j5_a2a_exchange AS exchange
              LEFT JOIN j5_a2a_membership AS membership
                ON membership.project_id = exchange.project_id
               AND membership.participant_id = exchange.sender_id
              WHERE exchange.status = 'open' AND exchange.receiver_id = ${input.personId}
              ORDER BY exchange.project_id, exchange.opened_seq, exchange.exchange_id
            `;
            const ended: Array<ExchangeId> = [];
            for (const exchange of asks) {
              const answerable = yield* input.mayAnswer({
                threadId: exchange.sender_thread_id,
                projectId: exchange.project_id,
              });
              if (answerable) continue;
              const disposition = "receiver-retired" as const;
              const exchangeId = ExchangeId.make(exchange.exchange_id);
              const projectId = LedgerProjectId.make(exchange.project_id);
              const messageId = noticeMessageId(exchange, disposition);
              const correlationId = noticeCorrelationId(exchange, disposition);
              const asker = ParticipantId.make(exchange.sender_id);
              yield* ledger.appendEvents({
                commandId: dropCommandId(exchange, disposition),
                projectId,
                acceptedAt: input.endedAt,
                events: [
                  {
                    kind: "exchange.dropped",
                    sender: asker,
                    receiver: input.personId,
                    exchangeId,
                    correlationId,
                    payload: {
                      disposition,
                      cause: { kind: "access-ended", participantId: input.personId, projectId },
                      facts: {
                        replyRequired: false,
                        retryAllowed: false,
                        replacementRequired: false,
                      },
                      noticeMessageId: messageId,
                    },
                    createdAt: input.endedAt,
                  },
                  {
                    kind: "message.sent",
                    sender: LIFECYCLE_PARTICIPANT_ID,
                    receiver: asker,
                    exchangeId,
                    correlationId,
                    payload: {
                      messageId,
                      text: formatAccessEndedNotice({ exchangeId, personId: input.personId }),
                      originProjectId: projectId,
                      receiverProjectId: projectId,
                      exchangeRole: "terminal_notice",
                      envelopeChannel: "lifecycle_notice",
                    },
                    createdAt: input.endedAt,
                  },
                ],
              });
              ended.push(exchangeId);
            }
            if (ended.length > 0) yield* worker.notify;
            return ended;
          }),
        );

      return A2ALifecycleService.of({
        archiveParticipant,
        handleStoredEvent,
        replayCommittedEvents,
        registerExistingThreads,
        endAsksOf,
      });
    }),
  );

export const manualLayer = makeLayer(false).pipe(Layer.provide(threadRegistrationLayer));
export const layer = makeLayer(true).pipe(Layer.provide(threadRegistrationLayer));
