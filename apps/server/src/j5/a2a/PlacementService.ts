import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import {
  LedgerProjectId,
  Participant,
  ParticipantId,
  isHumanParticipantId,
  isOutsideAgentParticipantId,
  participantId as participantIdOf,
} from "./contracts.ts";
import {
  ParticipantPlacement,
  type ParticipantPlacementView,
  PlacementEvent,
  type PlacementMutationResult,
  type RecordParticipantPlacementInput,
} from "./placementContracts.ts";

export class PlacementStorageError extends Schema.TaggedError<PlacementStorageError>()(
  "PlacementStorageError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PlacementProjectNotFoundError extends Schema.TaggedError<PlacementProjectNotFoundError>()(
  "PlacementProjectNotFoundError",
  { projectId: LedgerProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} has no agent-to-agent ledger yet, so nothing can be placed in it.`;
  }
}

export class PlacementParticipantNotFoundError extends Schema.TaggedError<PlacementParticipantNotFoundError>()(
  "PlacementParticipantNotFoundError",
  { projectId: LedgerProjectId, participantId: ParticipantId },
) {
  override get message(): string {
    return `Placement participant state is missing for ${this.participantId} in project ${this.projectId}. Join the participant before changing placement.`;
  }
}

export class PlacementParentNotFoundError extends Schema.TaggedError<PlacementParentNotFoundError>()(
  "PlacementParentNotFoundError",
  { projectId: LedgerProjectId, parentParticipantId: ParticipantId },
) {
  override get message(): string {
    return `Placement parent state is missing for ${this.parentParticipantId} in project ${this.projectId}. Choose an active participant or root.`;
  }
}

export class PlacementParentIneligibleError extends Schema.TaggedError<PlacementParentIneligibleError>()(
  "PlacementParentIneligibleError",
  { projectId: LedgerProjectId, parentParticipantId: ParticipantId },
) {
  override get message(): string {
    return `Placement parent state is ineligible-non-agent for ${this.parentParticipantId} in project ${this.projectId}. Placement parents are agent-only; choose an agent participant or root.`;
  }
}

export class PlacementAlreadyExistsError extends Schema.TaggedError<PlacementAlreadyExistsError>()(
  "PlacementAlreadyExistsError",
  { projectId: LedgerProjectId, participantId: ParticipantId },
) {
  override get message(): string {
    return `Placement state already exists for ${this.participantId} in project ${this.projectId}; creation cannot rewrite immutable provenance.`;
  }
}

export class PlacementHumanTargetError extends Schema.TaggedError<PlacementHumanTargetError>()(
  "PlacementHumanTargetError",
  {
    operation: Schema.Literal("record-creation"),
    projectId: LedgerProjectId,
    participantId: ParticipantId,
  },
) {
  override get message(): string {
    return `Placement participant state is immutable-human for ${this.participantId} in project ${this.projectId}; ${this.operation} only accepts agent participants.`;
  }
}

export class PlacementCycleError extends Schema.TaggedError<PlacementCycleError>()(
  "PlacementCycleError",
  {
    participantId: ParticipantId,
    requestedParentId: ParticipantId,
    path: Schema.Array(ParticipantId),
  },
) {
  override get message(): string {
    return `Placement cycle state: placing ${this.participantId} under ${this.requestedParentId} would make it its own ancestor through ${this.path.join(" -> ")}. Choose root or a participant outside that subtree.`;
  }
}

export class PlacementGraphCorruptError extends Schema.TaggedError<PlacementGraphCorruptError>()(
  "PlacementGraphCorruptError",
  { projectId: LedgerProjectId, path: Schema.Array(ParticipantId) },
) {
  override get message(): string {
    return `Placement graph state is already cyclic or exceeds its placement bound in project ${this.projectId}: ${this.path.join(" -> ")}. Repair the placement projection before retrying.`;
  }
}

export class PlacementCommandConflictError extends Schema.TaggedError<PlacementCommandConflictError>()(
  "PlacementCommandConflictError",
  { commandId: Schema.String, existingParticipantId: ParticipantId },
) {
  override get message(): string {
    return `Placement command state conflicts for ${this.commandId}; it already belongs to participant ${this.existingParticipantId}. Retry with a new command id.`;
  }
}

export type PlacementError =
  | PlacementStorageError
  | PlacementProjectNotFoundError
  | PlacementParticipantNotFoundError
  | PlacementParentNotFoundError
  | PlacementParentIneligibleError
  | PlacementAlreadyExistsError
  | PlacementHumanTargetError
  | PlacementCycleError
  | PlacementGraphCorruptError
  | PlacementCommandConflictError;

const PlacementErrorSchema = Schema.Union([
  PlacementStorageError,
  PlacementProjectNotFoundError,
  PlacementParticipantNotFoundError,
  PlacementParentNotFoundError,
  PlacementParentIneligibleError,
  PlacementAlreadyExistsError,
  PlacementHumanTargetError,
  PlacementCycleError,
  PlacementGraphCorruptError,
  PlacementCommandConflictError,
]);
const isPlacementError = Schema.is(PlacementErrorSchema);

export interface ParticipantPlacementServiceShape {
  /** Imminent A2 spawn/verb slice records placement at agent creation. */
  readonly recordCreation: (
    input: RecordParticipantPlacementInput,
  ) => Effect.Effect<PlacementMutationResult, PlacementError>;
  /** Imminent A2 spawn/verb slice reads the newly recorded placement. */
  readonly readPlacement: (input: {
    readonly projectId: LedgerProjectId;
    readonly participantId: ParticipantId;
  }) => Effect.Effect<ParticipantPlacement | null, PlacementError>;
  /** Live `j5_list_participants` enrichment read surface. */
  readonly listParticipants: (
    projectId: LedgerProjectId,
  ) => Effect.Effect<ReadonlyArray<ParticipantPlacementView>, PlacementError>;
  /**
   * Placement descendants in leaves-first order, including the requested root.
   * The in-flight A9 AR2 pre-archive provider is the named consumer.
   */
  readonly listSubtree: (input: {
    readonly projectId: LedgerProjectId;
    readonly participantId: ParticipantId;
  }) => Effect.Effect<ReadonlyArray<ParticipantPlacementView>, PlacementError>;
}

export class ParticipantPlacementService extends Context.Service<
  ParticipantPlacementService,
  ParticipantPlacementServiceShape
>()("t3/j5/a2a/PlacementService/ParticipantPlacementService") {}

/**
 * Internal write seam for multi-service transactions. drainPermit and
 * lifecyclePermit are independent peers that both precede appendPermit; callers
 * must then preserve appendPermit ≺ mutationPermit ≺ DB. This Semaphore(1)
 * permit is non-reentrant: acquire it before BEGIN and use the provided raw
 * in-transaction API instead of re-acquiring it through the public mutation.
 */
export interface ParticipantPlacementTransactionWriterShape {
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly recordCreationInTransaction: (
    input: RecordParticipantPlacementInput,
  ) => Effect.Effect<PlacementMutationResult, PlacementError>;
}

export class ParticipantPlacementTransactionWriter extends Context.Service<
  ParticipantPlacementTransactionWriter,
  ParticipantPlacementTransactionWriterShape
>()("t3/j5/a2a/PlacementService/ParticipantPlacementTransactionWriter") {}

interface EventRow {
  readonly seq: number;
  readonly command_id: string;
  readonly request_fingerprint: string;
  readonly project_id: string;
  readonly participant_id: string;
  readonly kind: "participant.placement_created" | "participant.reparented";
  readonly actor: "human" | "agent" | "platform";
  readonly actor_session_id: string | null;
  readonly actor_subject: string | null;
  readonly auth_method: "browser-session-cookie" | null;
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown" | null;
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
  readonly previous_parent_id: string | null;
  readonly placement_parent_id: string | null;
  readonly created_at: string;
}

interface PlacementRow {
  readonly project_id: string;
  readonly participant_id: string;
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown";
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
  readonly placement_parent_id: string | null;
  readonly created_event_seq: number;
  readonly updated_event_seq: number;
}

interface ParticipantRow {
  readonly payload: string;
  readonly project_id: string;
  readonly participant_id: string;
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown" | null;
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
  readonly placement_parent_id: string | null;
  readonly archived_at: string | null;
}

const decodeEvent = Schema.decodeUnknownEffect(PlacementEvent);
const decodePlacement = Schema.decodeUnknownEffect(ParticipantPlacement);
const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const provenanceFromRow = (row: {
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown";
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
}) => {
  // The migration CHECKs make the non-null provenance fields exhaustive for
  // each stored kind. Projection decoding intentionally relies on that invariant.
  switch (row.provenance_kind) {
    case "unknown":
      return { kind: "unknown", source: "native_or_unobserved" } as const;
    case "spawned-by":
      return {
        kind: "spawned-by",
        spawnedByParticipantId: ParticipantId.make(row.provenance_participant_id!),
        source: row.provenance_source!,
      } as const;
    case "forked-from":
      return {
        kind: "forked-from",
        sourceParticipantId: ParticipantId.make(row.provenance_participant_id!),
        source: "upstream_lineage",
      } as const;
  }
};

const placementFromRow = (row: PlacementRow) =>
  decodePlacement({
    projectId: row.project_id,
    participantId: row.participant_id,
    provenance: provenanceFromRow(row),
    placementParentId: row.placement_parent_id,
    createdEventSeq: row.created_event_seq,
    updatedEventSeq: row.updated_event_seq,
  });

/**
 * Decodes current creation events and reserved historical reparent vocabulary.
 * No reparent producer ships; recovery belongs to the future human-reparent
 * surface under R21 and the A6 ticket recovery note, from frozen chain
 * 8fb7139d161aed2f7f9bb8d9d31e4130a3dd604a.
 */
const eventFromRow = (row: EventRow) =>
  decodeEvent(
    row.kind === "participant.placement_created"
      ? {
          seq: row.seq,
          commandId: row.command_id,
          projectId: row.project_id,
          participantId: row.participant_id,
          kind: row.kind,
          actor: row.actor,
          provenance: provenanceFromRow({
            provenance_kind: row.provenance_kind!,
            provenance_participant_id: row.provenance_participant_id,
            provenance_source: row.provenance_source,
          }),
          previousParentId: null,
          placementParentId: row.placement_parent_id,
          createdAt: row.created_at,
        }
      : {
          // Reparent identity fields are non-null by the event-table CHECK.
          seq: row.seq,
          commandId: row.command_id,
          projectId: row.project_id,
          participantId: row.participant_id,
          kind: row.kind,
          actor: "human",
          actorSessionId: row.actor_session_id!,
          actorSubject: row.actor_subject!,
          authMethod: row.auth_method!,
          provenance: null,
          previousParentId: row.previous_parent_id,
          placementParentId: row.placement_parent_id,
          createdAt: row.created_at,
        },
  );

const preserveDomainError =
  (operation: string) =>
  (cause: unknown): PlacementError =>
    isPlacementError(cause) ? cause : new PlacementStorageError({ operation, cause });

const creationFingerprint = (input: RecordParticipantPlacementInput): string => {
  const provenanceFields =
    input.provenance.kind === "unknown"
      ? {
          provenanceKind: "unknown" as const,
          provenanceParticipantId: null,
          provenanceSource: "native_or_unobserved" as const,
        }
      : input.provenance.kind === "spawned-by"
        ? {
            provenanceKind: "spawned-by" as const,
            provenanceParticipantId: input.provenance.spawnedByParticipantId,
            provenanceSource: input.provenance.source,
          }
        : {
            provenanceKind: "forked-from" as const,
            provenanceParticipantId: input.provenance.sourceParticipantId,
            provenanceSource: input.provenance.source,
          };
  return JSON.stringify({
    type: "record_creation",
    // Stored and compared as text on replay, so this key and its position are fixed; migration
    // 031 rewrote older rows to match.
    projectId: input.projectId,
    participantId: input.participantId,
    actor: input.actor,
    ...provenanceFields,
    createdAt: input.createdAt,
  });
};

export const layer: Layer.Layer<
  ParticipantPlacementService | ParticipantPlacementTransactionWriter,
  never,
  SqlClient.SqlClient
> = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mutationPermit = yield* Semaphore.make(1);

    const ensureProjectLedger = Effect.fn("j5.a2a.placement.ensureProjectLedger")(function* (
      projectId: LedgerProjectId,
    ) {
      const rows = yield* sql<{ readonly id: string }>`
          SELECT project_id AS id FROM j5_a2a_project_ledger WHERE project_id = ${projectId} LIMIT 1
        `;
      if (rows[0] === undefined) return yield* new PlacementProjectNotFoundError({ projectId });
    });

    const ensureParticipant = Effect.fn("j5.a2a.placement.ensureParticipant")(function* (
      projectId: LedgerProjectId,
      participantId: ParticipantId,
    ) {
      const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT participant_id
          FROM j5_a2a_membership
          WHERE project_id = ${projectId} AND participant_id = ${participantId}
          LIMIT 1
        `;
      if (rows[0] === undefined) {
        return yield* new PlacementParticipantNotFoundError({ projectId, participantId });
      }
    });

    const ensureProvenanceParticipant = Effect.fn("j5.a2a.placement.ensureProvenanceParticipant")(
      function* (
        projectId: LedgerProjectId,
        participantId: ParticipantId,
        /** A spawner may live in another project on this server; a fork's source may not. */
        anyProject: boolean,
      ) {
        // An outside agent joins no ledger, so there is no join to find. The spawn records its
        // label in this same transaction.
        if (anyProject && isOutsideAgentParticipantId(participantId)) return;
        const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT json_extract(payload, '$.participant.id') AS participant_id
          FROM j5_a2a_comm_event
          WHERE (${anyProject ? 1 : 0} = 1 OR project_id = ${projectId})
            AND kind = 'participant.joined'
            AND json_extract(payload, '$.participant.id') = ${participantId}
          LIMIT 1
        `;
        if (rows[0] === undefined) {
          return yield* new PlacementParticipantNotFoundError({ projectId, participantId });
        }
      },
    );

    const ensureParent = Effect.fn("j5.a2a.placement.ensureParent")(function* (
      projectId: LedgerProjectId,
      parentParticipantId: ParticipantId | null,
    ) {
      if (parentParticipantId === null) return;
      if (isHumanParticipantId(parentParticipantId)) {
        return yield* new PlacementParentIneligibleError({
          projectId,
          parentParticipantId,
        });
      }
      const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT participant_id
          FROM j5_a2a_membership
          WHERE project_id = ${projectId} AND participant_id = ${parentParticipantId}
          LIMIT 1
        `;
      if (rows[0] === undefined) {
        return yield* new PlacementParentNotFoundError({ projectId, parentParticipantId });
      }
    });

    const isCurrentParticipant = Effect.fn("j5.a2a.placement.isCurrentParticipant")(function* (
      projectId: LedgerProjectId,
      participantId: ParticipantId,
    ) {
      const rows = yield* sql<{ readonly participant_id: string }>`
            SELECT participant_id
            FROM j5_a2a_membership
            WHERE project_id = ${projectId} AND participant_id = ${participantId}
            LIMIT 1
          `;
      return rows[0] !== undefined;
    });

    /** An agent that is a participant of some project on this server now. */
    const isParticipantSomewhere = Effect.fn("j5.a2a.placement.isParticipantSomewhere")(function* (
      participantId: ParticipantId,
    ) {
      const rows = yield* sql<{ readonly participant_id: string }>`
            SELECT participant_id
            FROM j5_a2a_membership
            WHERE participant_id = ${participantId}
            LIMIT 1
          `;
      return rows[0] !== undefined;
    });

    const selectPlacement = Effect.fn("j5.a2a.placement.selectPlacement")(function* (
      projectId: LedgerProjectId,
      participantId: ParticipantId,
    ) {
      const rows = yield* sql<PlacementRow>`
          SELECT
            project_id,
            participant_id,
            provenance_kind,
            provenance_participant_id,
            provenance_source,
            placement_parent_id,
            created_event_seq,
            updated_event_seq
          FROM j5_a2a_participant_placement
          WHERE project_id = ${projectId} AND participant_id = ${participantId}
          LIMIT 1
        `;
      return rows[0] === undefined ? null : yield* placementFromRow(rows[0]);
    });

    const selectEventByCommand = Effect.fn("j5.a2a.placement.selectEventByCommand")(function* (
      commandId: string,
    ) {
      const rows = yield* sql<EventRow>`
            SELECT
              seq,
              command_id,
              request_fingerprint,
              project_id,
              participant_id,
              kind,
              actor,
              actor_session_id,
              actor_subject,
              auth_method,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              previous_parent_id,
              placement_parent_id,
              created_at
            FROM j5_a2a_placement_event
            WHERE command_id = ${commandId}
            LIMIT 1
          `;
      return rows[0] ?? null;
    });

    const replay = Effect.fn("j5.a2a.placement.replay")(function* (
      commandId: string,
      fingerprint: string,
    ) {
      const row = yield* selectEventByCommand(commandId);
      if (row === null) return null;
      if (row.request_fingerprint !== fingerprint) {
        return yield* new PlacementCommandConflictError({
          commandId,
          existingParticipantId: ParticipantId.make(row.participant_id),
        });
      }
      const placement = yield* selectPlacement(
        LedgerProjectId.make(row.project_id),
        ParticipantId.make(row.participant_id),
      );
      if (placement === null) {
        return yield* new PlacementStorageError({ operation: "read replayed placement" });
      }
      return {
        event: yield* eventFromRow(row),
        placement,
        committed: false as const,
      };
    });

    const allocateSeq = Effect.fn("j5.a2a.placement.allocateSeq")(function* (
      projectId: LedgerProjectId,
    ) {
      const rows = yield* sql<{ readonly next_seq: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
          FROM j5_a2a_placement_event
          WHERE project_id = ${projectId}
        `;
      const seq = rows[0]?.next_seq;
      if (seq === undefined) {
        return yield* new PlacementStorageError({ operation: "allocate placement sequence" });
      }
      return seq;
    });

    const resolveProvenanceDefaultParent = Effect.fn(
      "j5.a2a.placement.resolveProvenanceDefaultParent",
    )(function* (input: RecordParticipantPlacementInput) {
      switch (input.provenance.kind) {
        case "spawned-by":
          if (
            input.provenance.source === "j5_spawn" &&
            !(yield* isCurrentParticipant(input.projectId, input.provenance.spawnedByParticipantId))
          ) {
            // A spawner may spawn into another project. It is recorded as provenance and is no
            // parent there: the placement tree is one project's, so the agent is a root in its
            // own. An outside agent is in no project, so what it spawns is always a root. Any
            // other spawner that is in no project at all is returned for `ensureParent` to refuse.
            return isOutsideAgentParticipantId(input.provenance.spawnedByParticipantId) ||
              (yield* isParticipantSomewhere(input.provenance.spawnedByParticipantId))
              ? null
              : input.provenance.spawnedByParticipantId;
          }
          return (yield* isCurrentParticipant(
            input.projectId,
            input.provenance.spawnedByParticipantId,
          ))
            ? input.provenance.spawnedByParticipantId
            : null;
        case "forked-from": {
          const source = yield* selectPlacement(
            input.projectId,
            input.provenance.sourceParticipantId,
          );
          return source?.placementParentId ?? null;
        }
        case "unknown":
          return null;
      }
    });

    const assertAcyclic = Effect.fn("j5.a2a.placement.assertAcyclic")(function* (input: {
      readonly projectId: LedgerProjectId;
      readonly participantId: ParticipantId;
      readonly requestedParentId: ParticipantId | null;
    }) {
      if (input.requestedParentId === null) return;
      const countRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_participant_placement WHERE project_id = ${input.projectId}
        `;
      const placementBound = (countRows[0]?.count ?? 0) + 1;
      const visited = new Set<ParticipantId>();
      const path: Array<ParticipantId> = [];
      let current: ParticipantId | null = input.requestedParentId;
      while (current !== null) {
        path.push(current);
        if (current === input.participantId) {
          return yield* new PlacementCycleError({
            participantId: input.participantId,
            requestedParentId: input.requestedParentId,
            path,
          });
        }
        if (visited.has(current) || path.length > placementBound) {
          return yield* new PlacementGraphCorruptError({ projectId: input.projectId, path });
        }
        visited.add(current);
        const placement: ParticipantPlacement | null = yield* selectPlacement(
          input.projectId,
          current,
        );
        current = placement?.placementParentId ?? null;
      }
    });

    const recordCreationInTransactionRaw = Effect.fn("j5.a2a.placement.recordCreation")(function* (
      input: RecordParticipantPlacementInput,
    ) {
      if (isHumanParticipantId(input.participantId)) {
        return yield* new PlacementHumanTargetError({
          operation: "record-creation",
          projectId: input.projectId,
          participantId: input.participantId,
        });
      }
      const fingerprint = creationFingerprint(input);
      const replayed = yield* replay(input.commandId, fingerprint);
      if (replayed !== null) return replayed;
      yield* ensureProjectLedger(input.projectId);
      yield* ensureParticipant(input.projectId, input.participantId);
      if ((yield* selectPlacement(input.projectId, input.participantId)) !== null) {
        return yield* new PlacementAlreadyExistsError({
          projectId: input.projectId,
          participantId: input.participantId,
        });
      }
      const provenanceParticipantId =
        input.provenance.kind === "spawned-by"
          ? input.provenance.spawnedByParticipantId
          : input.provenance.kind === "forked-from"
            ? input.provenance.sourceParticipantId
            : null;
      if (provenanceParticipantId !== null) {
        // Immutable provenance may retain a departed source, but it must name
        // an identity that actually joined at least once: this project for a fork's source,
        // any project on this server for a spawner, which may spawn into another project.
        // An outside agent spawner joins none.
        yield* ensureProvenanceParticipant(
          input.projectId,
          provenanceParticipantId,
          input.provenance.kind === "spawned-by" && input.provenance.source === "j5_spawn",
        );
      }
      if (provenanceParticipantId === input.participantId) {
        return yield* new PlacementCycleError({
          participantId: input.participantId,
          requestedParentId: input.participantId,
          path: [input.participantId],
        });
      }
      const placementParentId = yield* resolveProvenanceDefaultParent(input);
      yield* ensureParent(input.projectId, placementParentId);
      yield* assertAcyclic({
        projectId: input.projectId,
        participantId: input.participantId,
        requestedParentId: placementParentId,
      });
      const seq = yield* allocateSeq(input.projectId);
      const provenanceKind = input.provenance.kind;
      const provenanceSource = input.provenance.kind === "unknown" ? null : input.provenance.source;
      yield* sql`
            INSERT INTO j5_a2a_placement_event (
              seq,
              command_id,
              request_fingerprint,
              project_id,
              participant_id,
              kind,
              actor,
              actor_session_id,
              actor_subject,
              auth_method,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              previous_parent_id,
              placement_parent_id,
              created_at
            ) VALUES (
              ${seq},
              ${input.commandId},
              ${fingerprint},
              ${input.projectId},
              ${input.participantId},
              'participant.placement_created',
              ${input.actor},
              NULL,
              NULL,
              NULL,
              ${provenanceKind},
              ${provenanceParticipantId},
              ${provenanceSource},
              NULL,
              ${placementParentId},
              ${input.createdAt}
            )
          `;
      yield* sql`
            INSERT INTO j5_a2a_participant_placement (
              project_id,
              participant_id,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              placement_parent_id,
              created_event_seq,
              updated_event_seq
            ) VALUES (
              ${input.projectId},
              ${input.participantId},
              ${provenanceKind},
              ${provenanceParticipantId},
              ${provenanceSource},
              ${placementParentId},
              ${seq},
              ${seq}
            )
          `;
      const event = yield* eventFromRow({
        seq,
        command_id: input.commandId,
        request_fingerprint: fingerprint,
        project_id: input.projectId,
        participant_id: input.participantId,
        kind: "participant.placement_created",
        actor: input.actor,
        actor_session_id: null,
        actor_subject: null,
        auth_method: null,
        provenance_kind: provenanceKind,
        provenance_participant_id: provenanceParticipantId,
        provenance_source: provenanceSource,
        previous_parent_id: null,
        placement_parent_id: placementParentId,
        created_at: input.createdAt,
      });
      const placement = yield* selectPlacement(input.projectId, input.participantId);
      if (placement === null) {
        return yield* new PlacementStorageError({ operation: "read created placement" });
      }
      return { event, placement, committed: true as const };
    });

    const recordCreationInTransaction: ParticipantPlacementTransactionWriterShape["recordCreationInTransaction"] =
      (input) =>
        recordCreationInTransactionRaw(input).pipe(
          Effect.mapError(preserveDomainError("record participant placement in transaction")),
        );

    const listParticipantsEffect = Effect.fn("j5.a2a.placement.listParticipants")(function* (
      projectId: LedgerProjectId,
    ) {
      yield* ensureProjectLedger(projectId);
      const rows = yield* sql<ParticipantRow>`
            SELECT
              m.payload,
              m.project_id,
              m.participant_id,
              m.archived_at,
              p.provenance_kind,
              p.provenance_participant_id,
              p.provenance_source,
              CASE WHEN EXISTS (SELECT 1 FROM j5_a2a_membership parent
                WHERE parent.project_id = m.project_id AND parent.participant_id = p.placement_parent_id)
                THEN p.placement_parent_id ELSE NULL END AS placement_parent_id
            FROM j5_a2a_membership m
            LEFT JOIN j5_a2a_participant_placement p
              ON p.project_id = m.project_id AND p.participant_id = m.participant_id
            WHERE m.project_id = ${projectId}
            ORDER BY m.participant_id
          `;
      return yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            const participant = yield* decodeParticipant(row.payload);
            const id = participantIdOf(participant);
            return {
              projectId,
              participant,
              participantId: id,
              threadId: participant.kind === "agent" ? participant.threadId : null,
              provenance:
                participant.kind === "human"
                  ? ({ kind: "not-applicable" } as const)
                  : row.provenance_kind === null
                    ? ({ kind: "unrecorded" } as const)
                    : provenanceFromRow({
                        provenance_kind: row.provenance_kind,
                        provenance_participant_id: row.provenance_participant_id,
                        provenance_source: row.provenance_source,
                      }),
              placementParentId:
                participant.kind === "human"
                  ? null
                  : row.placement_parent_id === null
                    ? null
                    : ParticipantId.make(row.placement_parent_id),
              archivedAt: row.archived_at,
            } satisfies ParticipantPlacementView;
          }),
        { concurrency: 1 },
      );
    });

    const service = ParticipantPlacementService.of({
      recordCreation: (input) =>
        mutationPermit
          .withPermit(sql.withTransaction(recordCreationInTransaction(input)))
          .pipe(Effect.mapError(preserveDomainError("record participant placement"))),
      readPlacement: ({ projectId, participantId }) =>
        Effect.gen(function* () {
          yield* ensureProjectLedger(projectId);
          return yield* selectPlacement(projectId, participantId);
        }).pipe(Effect.mapError(preserveDomainError("read participant placement"))),
      listParticipants: (projectId) =>
        listParticipantsEffect(projectId).pipe(
          Effect.mapError(preserveDomainError("list participant placements")),
        ),
      listSubtree: ({ projectId, participantId }) =>
        Effect.gen(function* () {
          yield* ensureProjectLedger(projectId);
          yield* ensureParticipant(projectId, participantId);
          const participants = yield* listParticipantsEffect(projectId);
          const byId = new Map(
            participants.map((participant) => [participant.participantId, participant]),
          );
          const children = new Map<ParticipantId, Array<ParticipantId>>();
          for (const participant of participants) {
            if (participant.placementParentId === null) continue;
            const siblings = children.get(participant.placementParentId) ?? [];
            siblings.push(participant.participantId);
            children.set(participant.placementParentId, siblings);
          }
          for (const siblings of children.values()) siblings.sort();
          const visiting = new Set<ParticipantId>();
          const visited = new Set<ParticipantId>();
          const path: Array<ParticipantId> = [];
          const ordered: Array<ParticipantPlacementView> = [];
          const visit = (id: ParticipantId): Effect.Effect<void, PlacementGraphCorruptError> =>
            Effect.gen(function* () {
              if (visiting.has(id)) {
                return yield* new PlacementGraphCorruptError({ projectId, path: [...path, id] });
              }
              if (visited.has(id)) return;
              visiting.add(id);
              path.push(id);
              for (const childId of children.get(id) ?? []) yield* visit(childId);
              path.pop();
              visiting.delete(id);
              visited.add(id);
              const participant = byId.get(id);
              if (participant !== undefined) ordered.push(participant);
            });
          yield* visit(participantId);
          return ordered;
        }).pipe(Effect.mapError(preserveDomainError("list placement subtree"))),
    });
    const transactionWriter = ParticipantPlacementTransactionWriter.of({
      withPermit: (effect) => mutationPermit.withPermit(effect),
      recordCreationInTransaction,
    });
    return Context.make(ParticipantPlacementService, service).pipe(
      Context.add(ParticipantPlacementTransactionWriter, transactionWriter),
    );
  }),
);
