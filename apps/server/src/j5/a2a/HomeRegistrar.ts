import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  type AppendCommEventsCommand,
  type CommCommandId,
  ParticipantId,
  LedgerProjectId,
  type StoredCommEvent,
} from "./contracts.ts";
import {
  A2ALedger,
  type A2ALedgerError,
  A2ALedgerTransactionWriter,
  type AppendEventsResult,
} from "./LedgerService.ts";

export interface RegisteredThreadHome {
  readonly projectId: LedgerProjectId;
  readonly participantId: ParticipantId;
}

export interface RegisterAtCreationInput {
  readonly projectId: LedgerProjectId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly commandId: CommCommandId;
  /**
   * Set for a thread that was archived before it was ever registered. It joins as archived: the
   * join and the archive are one command, so neither is recorded without the other.
   */
  readonly archivedAt?: string;
}

export class A2AHomeNotFoundError extends Schema.TaggedError<A2AHomeNotFoundError>()(
  "A2AHomeNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not an agent-to-agent participant. Provider Subagents and deleted threads never are.`;
  }
}

export class A2AHomeConflictError extends Schema.TaggedError<A2AHomeConflictError>()(
  "A2AHomeConflictError",
  {
    threadId: Schema.String,
    existingProjectId: Schema.String,
    requestedProjectId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is already registered in project ${this.existingProjectId}; registration requested ${this.requestedProjectId}. A thread's project never changes.`;
  }
}

export class A2AHomeCommandConflictError extends Schema.TaggedError<A2AHomeCommandConflictError>()(
  "A2AHomeCommandConflictError",
  {
    commandId: Schema.String,
    requestedThreadId: Schema.String,
    requestedProjectId: Schema.String,
  },
) {
  override get message(): string {
    return `Creation command ${this.commandId} is already bound to a different ledger event than thread ${this.requestedThreadId} in project ${this.requestedProjectId}. Reuse the original creation inputs or issue a new command id.`;
  }
}

export type A2AHomeLookupError = SqlError | A2AHomeNotFoundError;

export type A2AHomeRegistrationError =
  | A2ALedgerError
  | SqlError
  | A2AHomeConflictError
  | A2AHomeCommandConflictError;

export interface A2AHomeRegistrarShape {
  readonly registerAtCreation: (
    input: RegisterAtCreationInput,
  ) => Effect.Effect<RegisteredThreadHome, A2AHomeRegistrationError>;
  readonly getHomeForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<RegisteredThreadHome, A2AHomeLookupError>;
}

export class A2AHomeRegistrar extends Context.Service<A2AHomeRegistrar, A2AHomeRegistrarShape>()(
  "t3/j5/a2a/HomeRegistrar/A2AHomeRegistrar",
) {}

export interface RegisteredThreadHomeInTransaction {
  readonly home: RegisteredThreadHome;
  readonly committedEvents: ReadonlyArray<StoredCommEvent>;
}

/** Internal registration seam used only while the ledger write permit is already held. */
export interface A2AHomeRegistrationTransactionShape {
  readonly registerAtCreationInTransaction: (
    input: RegisterAtCreationInput,
  ) => Effect.Effect<RegisteredThreadHomeInTransaction, A2AHomeRegistrationError>;
}

export class A2AHomeRegistrationTransaction extends Context.Service<
  A2AHomeRegistrationTransaction,
  A2AHomeRegistrationTransactionShape
>()("t3/j5/a2a/HomeRegistrar/A2AHomeRegistrationTransaction") {}

interface HistoricalHomeRow {
  readonly home_project_id: string;
  readonly home_participant_id: string;
  readonly active_project_id: string | null;
  readonly active_participant_id: string | null;
  readonly is_retired: number;
}

interface ThreadHomeResolution {
  readonly home: RegisteredThreadHome;
  readonly activeMemberships: ReadonlyArray<RegisteredThreadHome>;
  readonly retired: boolean;
}

const AGENT_PARTICIPANT_PREFIX = "agent:j5:a2a:";

export const participantIdForThread = (threadId: ThreadId) =>
  ParticipantId.make(`${AGENT_PARTICIPANT_PREFIX}${threadId}`);

/**
 * The inverse, for an agent on a peer server, whose thread this server has no record of. Every
 * J5 server mints agent ids above; anything else (a person, an automation) has no thread.
 */
export const threadIdForParticipant = (participantId: string) =>
  participantId.startsWith(AGENT_PARTICIPANT_PREFIX) &&
  participantId.length > AGENT_PARTICIPANT_PREFIX.length
    ? ThreadId.make(participantId.slice(AGENT_PARTICIPANT_PREFIX.length))
    : null;

export const resolveThreadHome = Effect.fn("j5.a2a.resolveThreadHome")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.fn.Return<ThreadHomeResolution, A2AHomeLookupError> {
  const rows = yield* sql<HistoricalHomeRow>`
    SELECT
      event.project_id AS home_project_id,
      json_extract(event.payload, '$.participant.id') AS home_participant_id,
      membership.project_id AS active_project_id,
      membership.participant_id AS active_participant_id,
      EXISTS (
        SELECT 1
        FROM j5_a2a_comm_event AS retirement
        WHERE retirement.project_id = event.project_id
          AND retirement.seq > event.seq
          AND retirement.kind IN ('participant.left', 'participant.deleted')
          AND json_extract(retirement.payload, '$.participant.kind') = 'agent'
          AND json_extract(retirement.payload, '$.participant.id') =
            json_extract(event.payload, '$.participant.id')
          AND json_extract(retirement.payload, '$.participant.threadId') = ${threadId}
      ) AS is_retired
    FROM j5_a2a_comm_event AS event
    LEFT JOIN j5_a2a_membership AS membership
      ON membership.thread_id = ${threadId}
    WHERE event.kind = 'participant.joined'
      AND json_extract(event.payload, '$.participant.kind') = 'agent'
      AND json_extract(event.payload, '$.participant.threadId') = ${threadId}
    ORDER BY membership.project_id, membership.participant_id
  `;
  const first = rows[0];
  if (first === undefined) return yield* new A2AHomeNotFoundError({ threadId });
  const activeMemberships = Array.from(
    new Map(
      rows.flatMap((row) =>
        row.active_project_id === null || row.active_participant_id === null
          ? []
          : [
              [
                `${row.active_project_id}\u0000${row.active_participant_id}`,
                {
                  projectId: row.active_project_id as LedgerProjectId,
                  participantId: ParticipantId.make(row.active_participant_id),
                },
              ] as const,
            ],
      ),
    ).values(),
  );
  return {
    home: {
      projectId: first.home_project_id as LedgerProjectId,
      participantId: ParticipantId.make(first.home_participant_id),
    },
    activeMemberships,
    retired: first.is_retired === 1,
  };
});

const makeRegisterAtCreation = (input: {
  readonly getHomeForThread: A2AHomeRegistrarShape["getHomeForThread"];
  readonly ensureProject: A2ALedger["Service"]["ensureProject"];
  readonly appendEvents: (
    command: AppendCommEventsCommand,
  ) => Effect.Effect<AppendEventsResult, A2ALedgerError>;
}) =>
  Effect.fn("j5.a2a.registerAtCreation")(function* (registration: RegisterAtCreationInput) {
    const existing = yield* input
      .getHomeForThread(registration.threadId)
      .pipe(Effect.catchTags({ A2AHomeNotFoundError: () => Effect.succeed(null) }));
    if (existing !== null && existing.projectId !== registration.projectId) {
      return yield* new A2AHomeConflictError({
        threadId: registration.threadId,
        existingProjectId: existing.projectId,
        requestedProjectId: registration.projectId,
      });
    }

    // Registration reaches a thread from several paths (the creation daemon, a spawn's own
    // transaction, the caller's first tool call); whichever arrives second changes nothing.
    if (existing !== null) return { home: existing, committedEvents: [] };

    // The first participant in a project makes it a ledger.
    yield* input.ensureProject({
      projectId: registration.projectId,
      createdAt: registration.createdAt,
    });
    const participantId = participantIdForThread(registration.threadId);
    const membershipFact = (kind: "participant.joined" | "participant.archived", at: string) => ({
      kind,
      sender: null,
      receiver: participantId,
      exchangeId: null,
      correlationId: null,
      payload: {
        participant: { kind: "agent" as const, id: participantId, threadId: registration.threadId },
      },
      createdAt: at,
    });
    const appendResult = yield* Effect.result(
      input.appendEvents({
        commandId: registration.commandId,
        projectId: registration.projectId,
        acceptedAt: registration.createdAt,
        events: [
          membershipFact("participant.joined", registration.createdAt),
          ...(registration.archivedAt === undefined
            ? []
            : [membershipFact("participant.archived", registration.archivedAt)]),
        ],
      }),
    );
    if (appendResult._tag === "Failure") {
      const racedHome = yield* input
        .getHomeForThread(registration.threadId)
        .pipe(Effect.catchTags({ A2AHomeNotFoundError: () => Effect.succeed(null) }));
      if (racedHome === null) return yield* appendResult.failure;
      if (racedHome.projectId !== registration.projectId) {
        return yield* new A2AHomeConflictError({
          threadId: registration.threadId,
          existingProjectId: racedHome.projectId,
          requestedProjectId: registration.projectId,
        });
      }
      return { home: racedHome, committedEvents: [] };
    }

    const event = appendResult.success.events[0];
    if (
      event === undefined ||
      event.kind !== "participant.joined" ||
      event.projectId !== registration.projectId ||
      event.createdAt !== registration.createdAt ||
      event.payload.participant.kind !== "agent" ||
      event.payload.participant.threadId !== registration.threadId ||
      event.payload.participant.id !== participantId
    ) {
      return yield* new A2AHomeCommandConflictError({
        commandId: registration.commandId,
        requestedThreadId: registration.threadId,
        requestedProjectId: registration.projectId,
      });
    }
    return {
      home: { projectId: registration.projectId, participantId },
      committedEvents: appendResult.success.committed ? appendResult.success.events : [],
    };
  });

export const layer: Layer.Layer<A2AHomeRegistrar, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    A2AHomeRegistrar,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;
      const getHomeForThread: A2AHomeRegistrarShape["getHomeForThread"] = (threadId) =>
        resolveThreadHome(sql, threadId).pipe(Effect.map((resolution) => resolution.home));
      const register = makeRegisterAtCreation({
        getHomeForThread,
        ensureProject: ledger.ensureProject,
        appendEvents: ledger.appendEvents,
      });
      return A2AHomeRegistrar.of({
        getHomeForThread,
        registerAtCreation: (input) => register(input).pipe(Effect.map((result) => result.home)),
      });
    }),
  );

export const transactionLayer: Layer.Layer<
  A2AHomeRegistrationTransaction,
  never,
  A2ALedger | A2ALedgerTransactionWriter | SqlClient.SqlClient
> = Layer.effect(
  A2AHomeRegistrationTransaction,
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const ledgerWriter = yield* A2ALedgerTransactionWriter;
    const sql = yield* SqlClient.SqlClient;
    const getHomeForThread: A2AHomeRegistrarShape["getHomeForThread"] = (threadId) =>
      resolveThreadHome(sql, threadId).pipe(Effect.map((resolution) => resolution.home));
    return A2AHomeRegistrationTransaction.of({
      registerAtCreationInTransaction: makeRegisterAtCreation({
        getHomeForThread,
        ensureProject: ledger.ensureProject,
        appendEvents: ledgerWriter.appendEventsInTransaction,
      }),
    });
  }),
);
