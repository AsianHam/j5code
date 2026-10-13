import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type { CrewPlaybookRef } from "./AgentCrewProposalService.ts";
import { ParticipantId, type LedgerProjectId } from "./contracts.ts";
import { ReadChanges } from "./ReadChanges.ts";

export interface AgentCrewMember {
  readonly seatName: string;
  /** The saved agent the seat runs as; null for a custom seat that runs as the Captain. */
  readonly agentId: string | null;
  readonly participantId: ParticipantId;
  readonly threadId: ThreadId;
  /** The instance version this seat joined at; 1 for the approved roster. */
  readonly addedVersion: number;
  readonly reason: string | null;
  /** Ids of the playbook steps the seat owns; the store always sets it, [] when none. */
  readonly playbookStepIds?: ReadonlyArray<string> | undefined;
}

export type NewAgentCrewMember = Omit<AgentCrewMember, "addedVersion">;

/** Wrote nothing: a new seat claims a playbook step another seat of the Crew already owns. */
export class CrewStepAlreadyOwnedError extends Data.TaggedError("CrewStepAlreadyOwnedError")<{
  readonly crewInstanceId: string;
  readonly stepId: string;
  readonly ownerSeat: string;
  readonly seat: string;
}> {
  override get message(): string {
    return `Step ${this.stepId} is already owned by seat ${this.ownerSeat}, so seat ${this.seat} cannot own it.`;
  }
}

export interface AgentCrewInstance {
  readonly id: string;
  readonly projectId: LedgerProjectId;
  readonly captainParticipantId: ParticipantId;
  readonly captainThreadId: ThreadId;
  readonly displayName: string;
  readonly brief: string;
  readonly version: number;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  /** Set at approval and never changed afterwards; the store always sets it, null when none. */
  readonly playbook?: CrewPlaybookRef | null | undefined;
  readonly members: ReadonlyArray<AgentCrewMember>;
}

export interface RecordAgentCrewInput {
  readonly id: string;
  readonly projectId: LedgerProjectId;
  readonly captainParticipantId: ParticipantId;
  readonly captainThreadId: ThreadId;
  readonly displayName: string;
  readonly brief: string;
  readonly createdAt: string;
  readonly playbook?: CrewPlaybookRef | null | undefined;
  readonly members: ReadonlyArray<NewAgentCrewMember>;
}

export interface AgentCrewMembership {
  readonly crewInstanceId: string;
  readonly seatName: string;
}

export type AddMembersOutcome =
  | { readonly status: "added"; readonly instance: AgentCrewInstance }
  /** Wrote nothing: the seats would pass the cap. */
  | { readonly status: "cap-exceeded"; readonly instance: AgentCrewInstance }
  /** Wrote nothing: a requested seat name is already held by a different participant. */
  | {
      readonly status: "conflict";
      readonly instance: AgentCrewInstance;
      readonly conflicts: ReadonlyArray<string>;
    }
  /** Wrote nothing: the Crew is retired, so nothing joins it. */
  | { readonly status: "archived"; readonly instance: AgentCrewInstance }
  | { readonly status: "missing"; readonly instance: null };

export interface AgentCrewInstanceServiceShape {
  /**
   * Idempotent by instance id: a launch retry with the same request key records nothing new. A
   * roster that gives one playbook step to two seats is refused and nothing is written.
   */
  readonly record: (
    input: RecordAgentCrewInput,
  ) => Effect.Effect<AgentCrewInstance, SqlError | CrewStepAlreadyOwnedError>;
  /**
   * Append approved seats and bump the version; idempotent per seat identity, so a replay of the
   * same seats reports `added` and writes nothing. The count, the cap, a same-name clash with a
   * different participant, the retired stamp, the version bump, and the ordinal base are all
   * decided inside one transaction with an optimistic version check, so two additions approved
   * at once cannot both slip under the cap, both take one name, or both own one playbook step.
   */
  readonly addMembers: (
    id: string,
    members: ReadonlyArray<NewAgentCrewMember>,
    options?: { readonly maxSeats?: number | undefined },
  ) => Effect.Effect<AddMembersOutcome, SqlError | CrewStepAlreadyOwnedError>;
  readonly read: (id: string) => Effect.Effect<AgentCrewInstance | null, SqlError>;
  /**
   * Drop seats from the roster by name, whether or not a thread was ever created for them. The
   * caller has already archived any thread behind them: a failed launch or addition that the
   * person declines, or a seat renamed on the card before a retry, leaves rows a Crew must not
   * keep, and the store does not know which of them got as far as a home.
   */
  readonly removeMembers: (
    id: string,
    seatNames: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, SqlError>;
  /** Which live Crew a participant sits in, if any; a retired Crew's seat is a plain agent again. */
  readonly findMembership: (
    participantId: ParticipantId,
  ) => Effect.Effect<AgentCrewMembership | null, SqlError>;
  readonly listForCaptain: (input: {
    readonly projectId: LedgerProjectId;
    readonly captainParticipantId: ParticipantId;
  }) => Effect.Effect<ReadonlyArray<AgentCrewInstance>, SqlError>;
  readonly listForProject: (
    projectId: LedgerProjectId,
  ) => Effect.Effect<ReadonlyArray<AgentCrewInstance>, SqlError>;
  /** Every Crew not yet retired, across projects; the boot reconciliation walks this. */
  readonly listLive: () => Effect.Effect<ReadonlyArray<AgentCrewInstance>, SqlError>;
  /** Every Crew that any of these threads sits in or that any of these participants commands. */
  readonly listInvolving: (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly participantIds: ReadonlyArray<ParticipantId>;
  }) => Effect.Effect<ReadonlyArray<AgentCrewInstance>, SqlError>;
  /**
   * Idempotent: the first archive timestamp wins. `withCaptain` records that the Crew retired
   * because its Captain was archived, so unarchiving the Captain brings it back.
   */
  readonly markArchived: (
    id: string,
    archivedAt: string,
    options?: { readonly withCaptain?: boolean },
  ) => Effect.Effect<void, SqlError>;
  /** The retired Crews that retired with the Captain on this thread. */
  readonly listRetiredWithCaptain: (
    captainThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<AgentCrewInstance>, SqlError>;
  /** Makes a Crew that retired with its Captain live again; false when it was not one. */
  readonly restoreWithCaptain: (id: string) => Effect.Effect<boolean, SqlError>;
  /**
   * Run one unit step on a Crew with no other unit step on it: a launch or addition from its
   * record or reservation through its briefs, and a unit archive from its roster read through
   * the retired stamp. A seat is therefore either created before an archive reads the roster, so
   * the archive retires it, or its reservation runs after the stamp and is refused. Held in this
   * process only; a restart drops the steps it interrupted along with the lock, and an archive
   * cut short never reached the stamp, so the Crew it leaves is still live.
   */
  readonly serialize: <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class AgentCrewInstanceService extends Context.Service<
  AgentCrewInstanceService,
  AgentCrewInstanceServiceShape
>()("t3/j5/a2a/AgentCrewInstanceService") {}

interface InstanceRow {
  readonly id: string;
  readonly project_id: string;
  readonly captain_participant_id: string;
  readonly captain_thread_id: string;
  readonly display_name: string;
  readonly brief: string;
  readonly version: number;
  readonly created_at: string;
  readonly archived_at: string | null;
  readonly playbook_name: string | null;
  readonly playbook_definition_path: string | null;
}

interface MemberRow {
  readonly crew_instance_id: string;
  readonly seat_name: string;
  readonly agent_id: string | null;
  readonly participant_id: string;
  readonly thread_id: string;
  readonly ordinal: number;
  readonly added_version: number;
  readonly reason: string | null;
  readonly playbook_step_ids: string | null;
}

const StepIds = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStepIds = Schema.decodeUnknownSync(StepIds);
const encodeStepIds = Schema.encodeSync(StepIds);

/**
 * The first step two seats would both own once the write lands. The roster after the write is the
 * rows no incoming seat replaces plus every incoming seat with its incoming steps, because the
 * write stores an incoming seat's steps even over its existing row: ownership is always the plan
 * the person approved last.
 */
const stepOwnershipConflict = (
  crewInstanceId: string,
  existing: ReadonlyArray<AgentCrewMember>,
  incoming: ReadonlyArray<NewAgentCrewMember>,
) => {
  const kept = existing.filter(
    (member) => !incoming.some((seat) => seat.seatName === member.seatName),
  );
  const owners = new Map<string, string>();
  for (const seat of [...kept, ...incoming])
    for (const stepId of seat.playbookStepIds ?? []) {
      const ownerSeat = owners.get(stepId);
      if (ownerSeat !== undefined && ownerSeat !== seat.seatName)
        return new CrewStepAlreadyOwnedError({
          crewInstanceId,
          stepId,
          ownerSeat,
          seat: seat.seatName,
        });
      owners.set(stepId, seat.seatName);
    }
  return null;
};

const memberFromRow = (row: MemberRow): AgentCrewMember => ({
  seatName: row.seat_name,
  agentId: row.agent_id,
  participantId: ParticipantId.make(row.participant_id),
  threadId: ThreadId.make(row.thread_id),
  addedVersion: row.added_version,
  reason: row.reason,
  playbookStepIds: row.playbook_step_ids === null ? [] : decodeStepIds(row.playbook_step_ids),
});

const instanceFromRows = (
  row: InstanceRow,
  members: ReadonlyArray<MemberRow>,
): AgentCrewInstance => ({
  id: row.id,
  projectId: row.project_id as LedgerProjectId,
  captainParticipantId: ParticipantId.make(row.captain_participant_id),
  captainThreadId: ThreadId.make(row.captain_thread_id),
  displayName: row.display_name,
  brief: row.brief,
  version: row.version,
  createdAt: row.created_at,
  archivedAt: row.archived_at,
  playbook:
    row.playbook_name === null || row.playbook_definition_path === null
      ? null
      : { name: row.playbook_name, definitionPath: row.playbook_definition_path },
  members: members
    .filter((member) => member.crew_instance_id === row.id)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map(memberFromRow),
});

export const layer: Layer.Layer<AgentCrewInstanceService, never, SqlClient.SqlClient> =
  Layer.effect(
    AgentCrewInstanceService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const readMany = Effect.fn("j5.a2a.agentCrewInstances.readMany")(function* (
        rows: ReadonlyArray<InstanceRow>,
      ) {
        if (rows.length === 0) return [];
        const members = yield* sql<MemberRow>`
          SELECT * FROM j5_agent_crew_member
          WHERE crew_instance_id IN ${sql.in(rows.map(({ id }) => id))}
        `;
        return rows.map((row) => instanceFromRows(row, members));
      });

      const read = Effect.fn("j5.a2a.agentCrewInstances.read")(function* (id: string) {
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM j5_agent_crew_instance WHERE id = ${id} LIMIT 1
        `;
        return (yield* readMany(rows))[0] ?? null;
      });

      const insertMembers = Effect.fn("j5.a2a.agentCrewInstances.insertMembers")(function* (
        id: string,
        members: ReadonlyArray<NewAgentCrewMember>,
        version: number,
        firstOrdinal: number,
      ) {
        for (const [index, member] of members.entries()) {
          yield* sql`
            INSERT OR IGNORE INTO j5_agent_crew_member (
              crew_instance_id, seat_name, agent_id, participant_id, thread_id, ordinal,
              added_version, reason, playbook_step_ids
            ) VALUES (
              ${id}, ${member.seatName}, ${member.agentId}, ${member.participantId},
              ${member.threadId}, ${firstOrdinal + index}, ${version}, ${member.reason},
              ${
                member.playbookStepIds === undefined || member.playbookStepIds.length === 0
                  ? null
                  : encodeStepIds(member.playbookStepIds)
              }
            )
            ON CONFLICT (crew_instance_id, seat_name)
            DO UPDATE SET playbook_step_ids = excluded.playbook_step_ids
          `;
        }
      });

      const record = Effect.fn("j5.a2a.agentCrewInstances.record")(function* (
        input: RecordAgentCrewInput,
      ) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // A re-approval keeps a same-named seat's row but takes its newly approved steps;
            // checked over the roster as it will stand, before anything is written.
            const conflict = stepOwnershipConflict(
              input.id,
              (yield* read(input.id))?.members ?? [],
              input.members,
            );
            if (conflict !== null) return yield* conflict;
            yield* sql`
              INSERT OR IGNORE INTO j5_agent_crew_instance (
                id, project_id, captain_participant_id, captain_thread_id, display_name, brief,
                version, created_at, archived_at, playbook_name, playbook_definition_path
              ) VALUES (
                ${input.id}, ${input.projectId}, ${input.captainParticipantId},
                ${input.captainThreadId}, ${input.displayName}, ${input.brief}, 1,
                ${input.createdAt}, NULL, ${input.playbook?.name ?? null},
                ${input.playbook?.definitionPath ?? null}
              )
            `;
            yield* insertMembers(input.id, input.members, 1, 0);
          }),
        );
        return (yield* read(input.id))!;
      });

      const addMembers = Effect.fn("j5.a2a.agentCrewInstances.addMembers")(function* (
        id: string,
        members: ReadonlyArray<NewAgentCrewMember>,
        options: { readonly maxSeats?: number | undefined } = {},
      ) {
        // Everything that decides the outcome is read and written inside the transaction; the
        // version predicate catches a writer that slipped between a read and its bump anyway.
        const attempt = sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* read(id);
            if (current === null) return { status: "missing", instance: null } as const;
            if (current.archivedAt !== null)
              return { status: "archived", instance: current } as const;
            const conflicts = members
              .filter((member) =>
                current.members.some(
                  (existing) =>
                    existing.seatName === member.seatName &&
                    existing.participantId !== member.participantId,
                ),
              )
              .map((member) => member.seatName);
            if (conflicts.length > 0)
              return { status: "conflict", instance: current, conflicts } as const;
            const fresh = members.filter(
              (member) =>
                !current.members.some((existing) => existing.seatName === member.seatName),
            );
            if (fresh.length === 0) return { status: "added", instance: current } as const;
            // The live members' steps decide it here, under the Crew's serialized reservation,
            // so two additions that both passed their preview cannot both own one step.
            const owned = stepOwnershipConflict(id, current.members, fresh);
            if (owned !== null) return yield* owned;
            if (
              options.maxSeats !== undefined &&
              current.members.length + fresh.length > options.maxSeats
            )
              return { status: "cap-exceeded", instance: current } as const;
            const version = current.version + 1;
            const bumped = yield* sql<{ readonly id: string }>`
              UPDATE j5_agent_crew_instance SET version = ${version}
              WHERE id = ${id} AND version = ${current.version}
              RETURNING id
            `;
            if (bumped.length === 0) return null;
            const ordinals = yield* sql<{ readonly next: number }>`
              SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM j5_agent_crew_member
              WHERE crew_instance_id = ${id}
            `;
            yield* insertMembers(id, fresh, version, Number(ordinals[0]?.next ?? 0));
            return { status: "added", instance: (yield* read(id))! } as const;
          }),
        );
        for (let tries = 0; tries < 4; tries += 1) {
          const outcome = yield* attempt;
          if (outcome !== null) return outcome;
        }
        return yield* Effect.die(new Error(`crew ${id} version kept moving during addMembers`));
      });

      const findMembership = Effect.fn("j5.a2a.agentCrewInstances.findMembership")(function* (
        participantId: ParticipantId,
      ) {
        const rows = yield* sql<{ readonly crew_instance_id: string; readonly seat_name: string }>`
          SELECT member.crew_instance_id, member.seat_name
          FROM j5_agent_crew_member member
          JOIN j5_agent_crew_instance instance ON instance.id = member.crew_instance_id
          WHERE member.participant_id = ${participantId} AND instance.archived_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row === undefined
          ? null
          : { crewInstanceId: row.crew_instance_id, seatName: row.seat_name };
      });

      const listForCaptain = Effect.fn("j5.a2a.agentCrewInstances.listForCaptain")(
        function* (input: {
          readonly projectId: LedgerProjectId;
          readonly captainParticipantId: ParticipantId;
        }) {
          const rows = yield* sql<InstanceRow>`
          SELECT * FROM j5_agent_crew_instance
          WHERE project_id = ${input.projectId}
            AND captain_participant_id = ${input.captainParticipantId}
          ORDER BY created_at, id
        `;
          return yield* readMany(rows);
        },
      );

      const listForProject = Effect.fn("j5.a2a.agentCrewInstances.listForProject")(function* (
        projectId: LedgerProjectId,
      ) {
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM j5_agent_crew_instance WHERE project_id = ${projectId}
          ORDER BY created_at, id
        `;
        return yield* readMany(rows);
      });

      const listLive = Effect.fn("j5.a2a.agentCrewInstances.listLive")(function* () {
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM j5_agent_crew_instance WHERE archived_at IS NULL
          ORDER BY created_at, id
        `;
        return yield* readMany(rows);
      });

      const listInvolving = Effect.fn("j5.a2a.agentCrewInstances.listInvolving")(function* (input: {
        readonly threadIds: ReadonlyArray<ThreadId>;
        readonly participantIds: ReadonlyArray<ParticipantId>;
      }) {
        if (input.threadIds.length === 0 && input.participantIds.length === 0) return [];
        const ids = new Set<string>();
        if (input.threadIds.length > 0) {
          const memberRows = yield* sql<{ readonly crew_instance_id: string }>`
            SELECT DISTINCT crew_instance_id FROM j5_agent_crew_member
            WHERE thread_id IN ${sql.in([...input.threadIds])}
          `;
          for (const row of memberRows) ids.add(row.crew_instance_id);
        }
        if (input.participantIds.length > 0) {
          const captainRows = yield* sql<{ readonly id: string }>`
            SELECT id FROM j5_agent_crew_instance
            WHERE captain_participant_id IN ${sql.in([...input.participantIds])}
          `;
          for (const row of captainRows) ids.add(row.id);
        }
        if (ids.size === 0) return [];
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM j5_agent_crew_instance WHERE id IN ${sql.in([...ids])}
          ORDER BY created_at, id
        `;
        return yield* readMany(rows);
      });

      const markArchived = Effect.fn("j5.a2a.agentCrewInstances.markArchived")(function* (
        id: string,
        archivedAt: string,
        options?: { readonly withCaptain?: boolean },
      ) {
        yield* sql`
          UPDATE j5_agent_crew_instance
          SET archived_at = ${archivedAt},
            retired_with_captain = ${options?.withCaptain === true ? 1 : 0}
          WHERE id = ${id} AND archived_at IS NULL
        `;
      });

      const listRetiredWithCaptain = Effect.fn("j5.a2a.agentCrewInstances.listRetiredWithCaptain")(
        function* (captainThreadId: ThreadId) {
          const rows = yield* sql<InstanceRow>`
            SELECT * FROM j5_agent_crew_instance
            WHERE archived_at IS NOT NULL AND retired_with_captain = 1
              AND captain_thread_id = ${captainThreadId}
            ORDER BY created_at, id
          `;
          return yield* readMany(rows);
        },
      );

      const restoreWithCaptain = Effect.fn("j5.a2a.agentCrewInstances.restoreWithCaptain")(
        function* (id: string) {
          const rows = yield* sql<{ readonly id: string }>`
            UPDATE j5_agent_crew_instance SET archived_at = NULL, retired_with_captain = 0
            WHERE id = ${id} AND archived_at IS NOT NULL AND retired_with_captain = 1
            RETURNING id
          `;
          return rows.length > 0;
        },
      );

      const removeMembers = Effect.fn("j5.a2a.agentCrewInstances.removeMembers")(function* (
        id: string,
        seatNames: ReadonlyArray<string>,
      ) {
        if (seatNames.length === 0) return [];
        const rows = yield* sql<{ readonly seat_name: string }>`
          DELETE FROM j5_agent_crew_member
          WHERE crew_instance_id = ${id} AND seat_name IN ${sql.in([...seatNames])}
          RETURNING seat_name
        `;
        return rows.map((row) => row.seat_name);
      });

      // Keyed and reference-counted, so a Crew's lock is gone once no step holds or awaits it.
      const units = yield* KeyedLock.make<string>();
      const serialize: AgentCrewInstanceServiceShape["serialize"] = (id, effect) =>
        units.withLock(id, effect);

      return AgentCrewInstanceService.of({
        serialize,
        record,
        addMembers,
        read,
        findMembership,
        removeMembers,
        listForCaptain,
        listForProject,
        listLive,
        listInvolving,
        markArchived,
        listRetiredWithCaptain,
        restoreWithCaptain,
      });
    }),
  );

/**
 * The layer the server runs: the store above, with every write that changed a Crew or its seats
 * moving the `crew` revision clients re-read on. Each write commits before its method returns.
 */
export const layerNotifying = Layer.effect(
  AgentCrewInstanceService,
  Effect.gen(function* () {
    const store = yield* AgentCrewInstanceService;
    const changes = yield* ReadChanges;
    const changed = changes.notify("crew");
    return AgentCrewInstanceService.of({
      ...store,
      record: (input) => store.record(input).pipe(Effect.tap(() => changed)),
      addMembers: (id, members, options) =>
        store
          .addMembers(id, members, options)
          .pipe(Effect.tap((outcome) => (outcome.status === "added" ? changed : Effect.void))),
      removeMembers: (id, seatNames) =>
        store
          .removeMembers(id, seatNames)
          .pipe(Effect.tap((removed) => (removed.length > 0 ? changed : Effect.void))),
      markArchived: (id, archivedAt, options) =>
        store.markArchived(id, archivedAt, options).pipe(Effect.tap(() => changed)),
      restoreWithCaptain: (id) =>
        store
          .restoreWithCaptain(id)
          .pipe(Effect.tap((restored) => (restored ? changed : Effect.void))),
    });
  }),
).pipe(Layer.provide(layer));
