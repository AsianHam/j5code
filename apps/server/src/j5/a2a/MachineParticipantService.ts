import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { A2ALedger, A2AStorageError, type A2ALedgerError } from "./LedgerService.ts";
import {
  type CommCommandId,
  machineParticipantIdForName,
  ParticipantId,
  LedgerProjectId,
} from "./contracts.ts";

/**
 * Registered machine senders (cron jobs, watchdogs, scripts) that talk to the fleet from outside
 * any agent session. A machine has one immutable project home but no thread: it sends plain
 * messages and never receives. The table is the projection of its `participant.joined` ledger
 * event.
 */

/** Server-unique, shell-friendly: the part after `machine:`. */
export const MACHINE_PARTICIPANT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MachineParticipantRecord {
  readonly participantId: ParticipantId;
  readonly projectId: LedgerProjectId;
  readonly projectTitle: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface RegisterMachineParticipantInput {
  readonly commandId: CommCommandId;
  readonly projectId: LedgerProjectId;
  readonly name: string;
  readonly acceptedAt: string;
}

export class MachineParticipantInvalidNameError extends Schema.TaggedError<MachineParticipantInvalidNameError>()(
  "MachineParticipantInvalidNameError",
  { name: Schema.String },
) {
  override get message(): string {
    return `Machine participant name "${this.name}" is invalid. Use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit.`;
  }
}

export class MachineParticipantNameTakenError extends Schema.TaggedError<MachineParticipantNameTakenError>()(
  "MachineParticipantNameTakenError",
  {
    participantId: Schema.String,
    existingProjectId: Schema.String,
    requestedProjectId: Schema.String,
  },
) {
  override get message(): string {
    return `Machine participant ${this.participantId} is already registered in project ${this.existingProjectId}; registration requested ${this.requestedProjectId}. Choose another name, or reuse the existing participant.`;
  }
}

export class MachineParticipantProjectNotFoundError extends Schema.TaggedError<MachineParticipantProjectNotFoundError>()(
  "MachineParticipantProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} does not exist on this server. Pass the id of an existing project as --project.`;
  }
}

export class MachineParticipantNotFoundError extends Schema.TaggedError<MachineParticipantNotFoundError>()(
  "MachineParticipantNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Machine participant ${this.participantId} is not registered. Register it with \`j5 a2a participant create --project <id> --name <name>\`.`;
  }
}

export type MachineParticipantError =
  | A2ALedgerError
  | SqlError
  | MachineParticipantInvalidNameError
  | MachineParticipantNameTakenError
  | MachineParticipantProjectNotFoundError
  | MachineParticipantNotFoundError;

export interface MachineParticipantServiceShape {
  /** Idempotent: the same name in the same project returns the existing record with `created: false`. */
  readonly register: (
    input: RegisterMachineParticipantInput,
  ) => Effect.Effect<
    { readonly participant: MachineParticipantRecord; readonly created: boolean },
    MachineParticipantError
  >;
  readonly resolve: (
    participantId: ParticipantId,
  ) => Effect.Effect<MachineParticipantRecord, SqlError | MachineParticipantNotFoundError>;
  readonly list: () => Effect.Effect<ReadonlyArray<MachineParticipantRecord>, SqlError>;
}

export class MachineParticipantService extends Context.Service<
  MachineParticipantService,
  MachineParticipantServiceShape
>()("t3/j5/a2a/MachineParticipantService") {}

interface MachineRow {
  readonly participant_id: string;
  readonly project_id: string;
  readonly project_title: string;
  readonly name: string;
  readonly created_at: string;
}

const recordFromRow = (row: MachineRow): MachineParticipantRecord => ({
  participantId: ParticipantId.make(row.participant_id),
  projectId: LedgerProjectId.make(row.project_id),
  projectTitle: row.project_title,
  name: row.name,
  createdAt: row.created_at,
});

export const layer: Layer.Layer<MachineParticipantService, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    MachineParticipantService,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;

      const readRow = Effect.fn("j5.a2a.machine.readRow")(function* (participantId: ParticipantId) {
        const rows = yield* sql<MachineRow>`
          SELECT
            machine.participant_id,
            machine.project_id,
            COALESCE(project.title, ledger.project_id) AS project_title,
            machine.name,
            machine.created_at
          FROM j5_a2a_machine_participant AS machine
          JOIN j5_a2a_project_ledger AS ledger ON ledger.project_id = machine.project_id
          LEFT JOIN projection_projects AS project ON project.project_id = machine.project_id
          WHERE machine.participant_id = ${participantId}
          LIMIT 1
        `;
        return rows[0] === undefined ? null : recordFromRow(rows[0]);
      });

      const register: MachineParticipantServiceShape["register"] = Effect.fn(
        "j5.a2a.machine.register",
      )(function* (input) {
        if (!MACHINE_PARTICIPANT_NAME_PATTERN.test(input.name)) {
          return yield* new MachineParticipantInvalidNameError({ name: input.name });
        }
        const participantId = machineParticipantIdForName(input.name);
        const projects = yield* sql<{ readonly project_id: string }>`
            SELECT project_id FROM projection_projects
            WHERE project_id = ${input.projectId} AND deleted_at IS NULL
          `;
        if (projects.length === 0) {
          return yield* new MachineParticipantProjectNotFoundError({
            projectId: input.projectId,
          });
        }
        // A machine can be a project's first participant.
        yield* ledger.ensureProject({ projectId: input.projectId, createdAt: input.acceptedAt });
        const existing = yield* readRow(participantId);
        if (existing !== null && existing.projectId !== input.projectId) {
          return yield* new MachineParticipantNameTakenError({
            participantId,
            existingProjectId: existing.projectId,
            requestedProjectId: input.projectId,
          });
        }
        if (existing !== null) return { participant: existing, created: false };

        const appended = yield* ledger.append({
          commandId: input.commandId,
          projectId: input.projectId,
          acceptedAt: input.acceptedAt,
          event: {
            kind: "participant.joined",
            sender: null,
            receiver: participantId,
            exchangeId: null,
            correlationId: null,
            payload: { participant: { kind: "machine", id: participantId, name: input.name } },
            createdAt: input.acceptedAt,
          },
        });
        const registered = yield* readRow(participantId);
        if (registered === null) {
          return yield* new A2AStorageError({ operation: "project machine participant join" });
        }
        return { participant: registered, created: appended.committed };
      });

      const resolve: MachineParticipantServiceShape["resolve"] = Effect.fn(
        "j5.a2a.machine.resolve",
      )(function* (participantId) {
        const row = yield* readRow(participantId);
        if (row === null) return yield* new MachineParticipantNotFoundError({ participantId });
        return row;
      });

      const list: MachineParticipantServiceShape["list"] = () =>
        sql<MachineRow>`
          SELECT
            machine.participant_id,
            machine.project_id,
            COALESCE(project.title, ledger.project_id) AS project_title,
            machine.name,
            machine.created_at
          FROM j5_a2a_machine_participant AS machine
          JOIN j5_a2a_project_ledger AS ledger ON ledger.project_id = machine.project_id
          LEFT JOIN projection_projects AS project ON project.project_id = machine.project_id
          ORDER BY machine.project_id, machine.participant_id
        `.pipe(Effect.map((rows) => rows.map(recordFromRow)));

      return MachineParticipantService.of({ register, resolve, list });
    }),
  );
