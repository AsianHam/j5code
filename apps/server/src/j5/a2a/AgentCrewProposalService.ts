import { ModelSelection, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { CrewPersonaSwap, PLAYBOOK_MAX_STEPS } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { CREW_NAME_MAX_CHARS, CREW_REASON_MAX_CHARS, CREW_TEXT_MAX_CHARS } from "./crewLimits.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";
import { ReadChanges } from "./ReadChanges.ts";
import { SpawnWorkspaceChoice } from "./spawnWorkspace.ts";

// The same bounds as the MCP verbs: the human's card edits arrive over HTTP and must not be the
// one way to store an unbounded or empty seat (Sentry S-3, 2026-09-14).
const bounded = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

/** One requested or approved seat. Reasons and instructions are the Captain's content, verbatim. */
export const CrewProposalSeat = Schema.Struct({
  seat: bounded(CREW_NAME_MAX_CHARS),
  agentId: Schema.NullOr(bounded(CREW_NAME_MAX_CHARS)),
  reason: bounded(CREW_REASON_MAX_CHARS),
  instructions: Schema.optional(bounded(CREW_TEXT_MAX_CHARS)),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  /**
   * Ids of the playbook steps the seat owns, checked against the live definition. Ids follow the
   * playbook's own rule (non-empty, no length cap); only the count is bounded.
   */
  steps: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
      Schema.isMaxLength(PLAYBOOK_MAX_STEPS),
    ),
  ),
  /**
   * Where the seat works, as the Captain or the person chose it. Required at every door that
   * files or approves a seat. A stored one this version can't read, such as one written by another
   * version, reads as none: the seat stays listed and is refused at preview until one is chosen,
   * rather than one seat failing every read of the table.
   */
  workspace: Schema.optionalKey(
    SpawnWorkspaceChoice.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  ),
  /** Recomputed by the server whenever the seats are validated; never taken from a client. */
  personaSwaps: Schema.optionalKey(Schema.Array(CrewPersonaSwap)),
});
export type CrewProposalSeat = typeof CrewProposalSeat.Type;

/** The playbook a Crew follows. The definition path is its identity; the name is for display. */
export interface CrewPlaybookRef {
  readonly name: string;
  readonly definitionPath: string;
}

const Seats = Schema.Array(CrewProposalSeat);
const decodeSeats = Schema.decodeUnknownSync(Schema.fromJsonString(Seats));
const encodeSeats = Schema.encodeSync(Schema.fromJsonString(Seats));

export type CrewProposalKind = "roster" | "addition";
/**
 * A proposal resolves once, open to approved or declined, and never goes back: an approval is
 * recorded before any seat spawns, and whatever fails at launch is reported rather than retried.
 */
export type CrewProposalStatus = "open" | "approved" | "declined";
export type CrewProposalDecision = "approve" | "decline";
export const CREW_PROPOSAL_STATUSES: ReadonlyArray<CrewProposalStatus> = [
  "open",
  "approved",
  "declined",
];
const finalStatus = (decision: CrewProposalDecision) =>
  decision === "approve" ? ("approved" as const) : ("declined" as const);

export interface CrewProposal {
  readonly id: string;
  readonly projectId: LedgerProjectId;
  readonly captainParticipantId: ParticipantId;
  readonly captainThreadId: ThreadId;
  readonly crewInstanceId: string | null;
  readonly kind: CrewProposalKind;
  readonly status: CrewProposalStatus;
  readonly brief: string;
  readonly displayName: string;
  readonly requestedSeats: ReadonlyArray<CrewProposalSeat>;
  readonly approvedSeats: ReadonlyArray<CrewProposalSeat> | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  /** Who approved or declined it, named only when the Captain's thread is a shared conversation. */
  readonly decidedBy?: string | null | undefined;
  /** When the Captain received the launch report for an approval; null until it posts. */
  readonly reportedAt: string | null;
  /** The store always sets it; null when the proposal follows no playbook. */
  readonly playbook?: CrewPlaybookRef | null | undefined;
}

export interface CreateCrewProposalInput {
  readonly id: string;
  readonly projectId: LedgerProjectId;
  readonly captainParticipantId: ParticipantId;
  readonly captainThreadId: ThreadId;
  readonly crewInstanceId: string | null;
  readonly kind: CrewProposalKind;
  readonly brief: string;
  readonly displayName: string;
  readonly requestedSeats: ReadonlyArray<CrewProposalSeat>;
  readonly createdAt: string;
  readonly playbook?: CrewPlaybookRef | null | undefined;
}

export type AdmitCrewProposalOutcome =
  | { readonly status: "created"; readonly proposal: CrewProposal }
  /** A request with this id already exists; returned before any counting. */
  | { readonly status: "existing"; readonly proposal: CrewProposal }
  /** Wrote nothing: the seats would pass the cap counting rows and open requests. */
  | { readonly status: "cap-exceeded"; readonly held: number; readonly adding: number };

export interface AgentCrewProposalServiceShape {
  /** Idempotent by proposal id; a retried tool call finds its earlier proposal. */
  readonly create: (input: CreateCrewProposalInput) => Effect.Effect<CrewProposal, SqlError>;
  /**
   * Files an addition only if the Crew can seat it: its member rows plus the unreserved seats of
   * every open request, plus this one, must fit under `maxSeats`. The existence check (a replay finds its row
   * before anything is counted), the count, and the insert run in one transaction, so two
   * requests racing for the last seat cannot both be filed.
   */
  readonly admit: (
    input: CreateCrewProposalInput,
    options: { readonly maxSeats: number },
  ) => Effect.Effect<AdmitCrewProposalOutcome, SqlError>;
  readonly read: (id: string) => Effect.Effect<CrewProposal | null, SqlError>;
  readonly listOpen: () => Effect.Effect<ReadonlyArray<CrewProposal>, SqlError>;
  readonly listForCaptain: (
    captainParticipantId: ParticipantId,
  ) => Effect.Effect<ReadonlyArray<CrewProposal>, SqlError>;
  /**
   * Resolves an open proposal once, compare-and-set from `open`. Returns the resolved proposal,
   * or null when it was no longer open, so a second resolution can never follow the first. An
   * approval records the seats the person approved; a decline drops them.
   */
  readonly resolve: (input: {
    readonly id: string;
    readonly decision: CrewProposalDecision;
    readonly approvedSeats: ReadonlyArray<CrewProposalSeat> | null;
    readonly resolvedAt: string;
    readonly decidedBy?: string | null | undefined;
  }) => Effect.Effect<CrewProposal | null, SqlError>;
  /** Approved proposals whose launch report has not reached the Captain yet. */
  readonly listUnreported: () => Effect.Effect<ReadonlyArray<CrewProposal>, SqlError>;
  readonly markReported: (id: string, reportedAt: string) => Effect.Effect<void, SqlError>;
  /** Records the crew a roster proposal produces, before the approval that launches it. */
  readonly attachInstance: (
    id: string,
    crewInstanceId: string,
  ) => Effect.Effect<CrewProposal | null, SqlError>;
}

export class AgentCrewProposalService extends Context.Service<
  AgentCrewProposalService,
  AgentCrewProposalServiceShape
>()("t3/j5/a2a/AgentCrewProposalService") {}

interface Row {
  readonly id: string;
  readonly project_id: string;
  readonly captain_participant_id: string;
  readonly captain_thread_id: string;
  readonly crew_instance_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly brief: string;
  readonly display_name: string;
  readonly requested_seats: string;
  readonly approved_seats: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
  readonly reported_at: string | null;
  readonly decided_by: string | null;
  readonly playbook_name: string | null;
  readonly playbook_definition_path: string | null;
}

const fromRow = (row: Row): CrewProposal => ({
  id: row.id,
  projectId: LedgerProjectId.make(row.project_id),
  captainParticipantId: ParticipantId.make(row.captain_participant_id),
  captainThreadId: ThreadId.make(row.captain_thread_id),
  crewInstanceId: row.crew_instance_id,
  kind: row.kind === "addition" ? "addition" : "roster",
  status: CREW_PROPOSAL_STATUSES.find((status) => status === row.status) ?? "open",
  brief: row.brief,
  displayName: row.display_name,
  requestedSeats: decodeSeats(row.requested_seats),
  approvedSeats: row.approved_seats === null ? null : decodeSeats(row.approved_seats),
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
  reportedAt: row.reported_at,
  decidedBy: row.decided_by,
  playbook:
    row.playbook_name === null || row.playbook_definition_path === null
      ? null
      : { name: row.playbook_name, definitionPath: row.playbook_definition_path },
});

export const layer: Layer.Layer<AgentCrewProposalService, never, SqlClient.SqlClient> =
  Layer.effect(
    AgentCrewProposalService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const read = Effect.fn("j5.a2a.agentCrewProposals.read")(function* (id: string) {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal WHERE id = ${id} LIMIT 1
        `;
        return rows[0] === undefined ? null : fromRow(rows[0]);
      });

      const create = Effect.fn("j5.a2a.agentCrewProposals.create")(function* (
        input: CreateCrewProposalInput,
      ) {
        yield* sql`
          INSERT OR IGNORE INTO j5_agent_crew_proposal (
            id, project_id, captain_participant_id, captain_thread_id, crew_instance_id, kind,
            status, brief, display_name, requested_seats, approved_seats, created_at, resolved_at,
            reported_at, playbook_name, playbook_definition_path
          ) VALUES (
            ${input.id}, ${input.projectId}, ${input.captainParticipantId},
            ${input.captainThreadId}, ${input.crewInstanceId}, ${input.kind}, 'open',
            ${input.brief}, ${input.displayName}, ${encodeSeats(input.requestedSeats)}, NULL,
            ${input.createdAt}, NULL, NULL, ${input.playbook?.name ?? null},
            ${input.playbook?.definitionPath ?? null}
          )
        `;
        return (yield* read(input.id))!;
      });

      // An addition's rows are reserved only once it is approved, so an open request is counted by
      // the seats it asks for and a reserved row only as a member.
      const countHeldSeats = Effect.fn("j5.a2a.agentCrewProposals.countHeldSeats")(function* (
        crewInstanceId: string,
      ) {
        const members = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_agent_crew_member
          WHERE crew_instance_id = ${crewInstanceId}
        `;
        const open = (yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal
          WHERE crew_instance_id = ${crewInstanceId} AND status = 'open'
        `).map(fromRow);
        return open.reduce(
          (held, proposal) => held + proposal.requestedSeats.length,
          Number(members[0]?.count ?? 0),
        );
      });

      const admit = Effect.fn("j5.a2a.agentCrewProposals.admit")(function* (
        input: CreateCrewProposalInput,
        options: { readonly maxSeats: number },
      ) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* read(input.id);
            if (existing !== null) return { status: "existing", proposal: existing } as const;
            if (input.crewInstanceId !== null) {
              const held = yield* countHeldSeats(input.crewInstanceId);
              const adding = input.requestedSeats.length;
              if (held + adding > options.maxSeats)
                return { status: "cap-exceeded", held, adding } as const;
            }
            return { status: "created", proposal: yield* create(input) } as const;
          }),
        );
      });

      const listOpen = Effect.fn("j5.a2a.agentCrewProposals.listOpen")(function* () {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal WHERE status = 'open' ORDER BY created_at, id
        `;
        return rows.map(fromRow);
      });

      const listForCaptain = Effect.fn("j5.a2a.agentCrewProposals.listForCaptain")(function* (
        captainParticipantId: ParticipantId,
      ) {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal
          WHERE captain_participant_id = ${captainParticipantId}
          ORDER BY created_at, id
        `;
        return rows.map(fromRow);
      });

      const resolve = Effect.fn("j5.a2a.agentCrewProposals.resolve")(function* (input: {
        readonly id: string;
        readonly decision: CrewProposalDecision;
        readonly approvedSeats: ReadonlyArray<CrewProposalSeat> | null;
        readonly resolvedAt: string;
        readonly decidedBy?: string | null | undefined;
      }) {
        const approvedSeats =
          input.decision === "approve" && input.approvedSeats !== null
            ? encodeSeats(input.approvedSeats)
            : null;
        const resolved = yield* sql<{ readonly id: string }>`
          UPDATE j5_agent_crew_proposal
          SET status = ${finalStatus(input.decision)},
              approved_seats = ${approvedSeats},
              resolved_at = ${input.resolvedAt},
              decided_by = ${input.decidedBy ?? null}
          WHERE id = ${input.id} AND status = 'open'
          RETURNING id
        `;
        return resolved.length === 0 ? null : yield* read(input.id);
      });

      const listUnreported = Effect.fn("j5.a2a.agentCrewProposals.listUnreported")(function* () {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal
          WHERE status = 'approved' AND reported_at IS NULL
          ORDER BY created_at, id
        `;
        return rows.map(fromRow);
      });

      const markReported = Effect.fn("j5.a2a.agentCrewProposals.markReported")(function* (
        id: string,
        reportedAt: string,
      ) {
        yield* sql`
          UPDATE j5_agent_crew_proposal SET reported_at = ${reportedAt}
          WHERE id = ${id} AND reported_at IS NULL
        `;
      });

      const attachInstance = Effect.fn("j5.a2a.agentCrewProposals.attachInstance")(function* (
        id: string,
        crewInstanceId: string,
      ) {
        yield* sql`
          UPDATE j5_agent_crew_proposal SET crew_instance_id = ${crewInstanceId} WHERE id = ${id}
        `;
        return yield* read(id);
      });

      return AgentCrewProposalService.of({
        create,
        admit,
        read,
        listOpen,
        listForCaptain,
        resolve,
        listUnreported,
        markReported,
        attachInstance,
      });
    }),
  );

/**
 * The layer the server runs: the store above, with every write that changed a proposal moving
 * the `crew` revision clients re-read on. Each write commits before its method returns.
 */
export const layerNotifying = Layer.effect(
  AgentCrewProposalService,
  Effect.gen(function* () {
    const store = yield* AgentCrewProposalService;
    const changes = yield* ReadChanges;
    const changed = changes.notify("crew");
    return AgentCrewProposalService.of({
      ...store,
      create: (input) => store.create(input).pipe(Effect.tap(() => changed)),
      admit: (input, options) =>
        store
          .admit(input, options)
          .pipe(Effect.tap((outcome) => (outcome.status === "created" ? changed : Effect.void))),
      resolve: (input) =>
        store
          .resolve(input)
          .pipe(Effect.tap((proposal) => (proposal === null ? Effect.void : changed))),
      attachInstance: (id, crewInstanceId) =>
        store.attachInstance(id, crewInstanceId).pipe(Effect.tap(() => changed)),
    });
  }),
).pipe(Layer.provide(layer));
