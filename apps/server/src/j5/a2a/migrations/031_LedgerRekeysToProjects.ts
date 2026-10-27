import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Squadrons are retired: each ledger moves to its one project's id, no row added or renumbered.
// The Squadron table is re-keyed and renamed, never dropped: with foreign keys on, a drop would
// cascade through nine child tables (`defer_foreign_keys` does not hold a cascade back), and a
// rename lets SQLite rewrite every child's foreign key itself.

class SharedProjectError extends Schema.TaggedError<SharedProjectError>()("SharedProjectError", {
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      projectTitle: Schema.NullOr(Schema.String),
      squadrons: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    }),
  ),
}) {
  override get message(): string {
    const details = this.projects
      .map(({ projectId, projectTitle, squadrons }) => {
        const project = projectTitle === null ? projectId : `"${projectTitle}" (${projectId})`;
        const names = squadrons.map(({ id, name }) => `"${name}" (${id})`).join(" and ");
        return `project ${project} is shared by Squadrons ${names}`;
      })
      .join("; ");
    return `Cannot retire Squadrons: ${details}. Nothing was changed. Follow "A project shared by several Squadrons" in docs/j5/runbooks/dogfood-runtime.md, then start this version again.`;
  }
}

class LedgerRekeyCheckError extends Schema.TaggedError<LedgerRekeyCheckError>()(
  "LedgerRekeyCheckError",
  {
    table: Schema.String,
    rowsBefore: Schema.Number,
    rowsAfter: Schema.Number,
    rowsWithoutProject: Schema.Number,
  },
) {
  override get message(): string {
    return `Re-keying the J5 ledger to projects would have damaged ${this.table}: ${this.rowsBefore} rows before, ${this.rowsAfter} after, ${this.rowsWithoutProject} left without a project. Nothing was changed.`;
  }
}

/** The tables keyed by `squadron_id`, each renamed to `project_id`. */
const KEYED_TABLES = [
  "j5_a2a_comm_event",
  "j5_a2a_comm_command_receipt",
  "j5_a2a_delivery",
  "j5_a2a_exchange",
  "j5_a2a_human_inbox",
  "j5_a2a_machine_participant",
  "j5_a2a_participant_placement",
  "j5_a2a_placement_event",
  "j5_a2a_squadron_membership",
  "j5_agent_crew_instance",
  "j5_agent_crew_proposal",
] as const;

/** Every re-keyed table as (name before, name after, its ledger key after). */
const CHECKED_TABLES = [
  ...KEYED_TABLES.map(
    (table) =>
      [
        table,
        table === "j5_a2a_squadron_membership" ? "j5_a2a_membership" : table,
        "project_id",
      ] as const,
  ),
  ["j5_a2a_human_inbox_data", "j5_a2a_human_inbox_data", "origin_project_id"] as const,
];

// A peer server's ids are never rewritten. This prefix marks an event this server wrote on a
// peer's behalf (`PeerInboundService`).
const PEER_RECEIVE_COMMAND = "command:j5:a2a:peer:receive:%";

// A drop this server decided for itself names a local participant only when one was archived or
// deleted. The other causes (a peer refused the delivery, a peer was removed) name the
// participant on the peer server, with that server's id.
const DROP_NAMES_LOCAL_PARTICIPANT =
  "json_extract(payload, '$.cause.kind') IN ('participant-archived', 'participant-deleted')";

// The record table is always aliased: several ledger tables have their own `squadron_id`, and an
// unqualified lookup would compare the record's column with itself.
const projectOf = (squadronId: string) =>
  `(SELECT retired.project_id FROM j5_a2a_retired_squadron retired WHERE retired.squadron_id = ${squadronId})`;
const isLocal = (squadronId: string) =>
  `${squadronId} IN (
    SELECT retired.squadron_id FROM j5_a2a_retired_squadron retired
    WHERE retired.project_id IS NOT NULL
  )`;

/**
 * Renames one JSON key. The value becomes the project id only where `local` holds and the value
 * is one of this server's Squadrons; anything else is kept as it was.
 */
const renameJsonKey = (
  document: string,
  [path, from, to, local]: readonly [path: string, from: string, to: string, local: string],
) => {
  const value = `json_extract(${document}, '${path}.${from}')`;
  return `CASE WHEN json_type(${document}, '${path}.${from}') IS NULL THEN ${document} ELSE
    json_remove(
      json_set(
        ${document},
        '${path}.${to}',
        CASE WHEN (${local}) AND ${isLocal(value)} THEN ${projectOf(value)} ELSE ${value} END
      ),
      '${path}.${from}'
    )
  END`;
};
const renameJsonKeys = (
  document: string,
  keys: ReadonlyArray<readonly [path: string, from: string, to: string, local: string]>,
) => keys.reduce(renameJsonKey, document);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const shared = yield* sql<{
    readonly project_id: string;
    readonly squadron_id: string;
    readonly squadron_name: string;
  }>`
    SELECT reference.project_id, squadron.id AS squadron_id, squadron.name AS squadron_name
    FROM j5_a2a_squadron_project_reference reference
    JOIN j5_a2a_squadron squadron ON squadron.id = reference.squadron_id
    WHERE reference.project_id IN (
      SELECT project_id
      FROM j5_a2a_squadron_project_reference
      GROUP BY project_id
      HAVING COUNT(*) > 1
    )
    ORDER BY reference.project_id, squadron.created_at, squadron.id
  `;
  if (shared.length > 0) {
    // Upstream's project table is read only to name the project; a ledger without it still migrates.
    const hasProjects = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_projects'
    `;
    const titles =
      hasProjects.length === 0
        ? []
        : yield* sql<{ readonly project_id: string; readonly title: string }>`
            SELECT project_id, title FROM projection_projects
          `;
    const titleOf = new Map(titles.map((row) => [row.project_id, row.title]));
    const byProject = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of shared) {
      const squadrons = byProject.get(row.project_id) ?? [];
      squadrons.push({ id: row.squadron_id, name: row.squadron_name });
      byProject.set(row.project_id, squadrons);
    }
    return yield* new SharedProjectError({
      projects: Array.from(byProject, ([projectId, squadrons]) => ({
        projectId,
        projectTitle: titleOf.get(projectId) ?? null,
        squadrons,
      })),
    });
  }

  yield* sql`PRAGMA defer_foreign_keys = ON`;

  yield* sql.unsafe(
    `CREATE TEMP TABLE j5_a2a_rekey_rows_before AS ${CHECKED_TABLES.map(
      ([before]) => `SELECT '${before}' AS name, COUNT(*) AS row_count FROM ${before}`,
    ).join(" UNION ALL ")}`,
  );

  // The record of the Squadrons this server had: the only place their ids and names remain.
  yield* sql`
    CREATE TABLE j5_a2a_retired_squadron (
      squadron_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      project_id TEXT UNIQUE
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_retired_squadron (squadron_id, name, created_at, project_id)
    SELECT squadron.id, squadron.name, squadron.created_at, reference.project_id
    FROM j5_a2a_squadron squadron
    LEFT JOIN j5_a2a_squadron_project_reference reference ON reference.squadron_id = squadron.id
  `;

  // Stored JSON first, while the tests for "local" still read the old column names.
  yield* sql.unsafe(`
    UPDATE j5_a2a_comm_event
    SET payload = ${renameJsonKeys("payload", [
      ["$", "originSquadronId", "originProjectId", "1"],
      [
        "$",
        "receiverSquadronId",
        "receiverProjectId",
        "json_type(payload, '$.receiverEnvironmentId') IS NULL",
      ],
      // Only this server's lifecycle writes a terminal fact into a sent message.
      ["$.terminal.cause", "squadronId", "projectId", "1"],
    ])}
    WHERE kind = 'message.sent'
  `);
  const receivedLocally = "json_type(payload, '$.originEnvironmentId') IS NULL";
  yield* sql.unsafe(`
    UPDATE j5_a2a_comm_event
    SET payload = ${renameJsonKeys("payload", [
      ["$", "originSquadronId", "originProjectId", receivedLocally],
      ["$.message", "originSquadronId", "originProjectId", receivedLocally],
      // A received message's receiver is always on this server, whoever sent it.
      ["$.message", "receiverSquadronId", "receiverProjectId", "1"],
      ["$.message.terminal.cause", "squadronId", "projectId", receivedLocally],
    ])}
    WHERE kind = 'message.received'
  `);
  yield* sql.unsafe(`
    UPDATE j5_a2a_comm_event
    SET payload = ${renameJsonKeys("payload", [
      [
        "$.cause",
        "squadronId",
        "projectId",
        `${DROP_NAMES_LOCAL_PARTICIPANT}
          AND (command_id IS NULL OR command_id NOT LIKE '${PEER_RECEIVE_COMMAND}')`,
      ],
    ])}
    WHERE kind = 'exchange.dropped'
  `);
  yield* sql.unsafe(`
    UPDATE j5_a2a_human_inbox
    SET terminal_cause = ${renameJsonKeys("terminal_cause", [
      [
        "$",
        "squadronId",
        "projectId",
        `NOT EXISTS (
          SELECT 1 FROM j5_a2a_comm_event dropped
          WHERE dropped.squadron_id = j5_a2a_human_inbox.squadron_id
            AND dropped.seq = j5_a2a_human_inbox.terminal_seq
            AND dropped.command_id LIKE '${PEER_RECEIVE_COMMAND}'
        ) AND json_extract(terminal_cause, '$.kind') IN ('participant-archived', 'participant-deleted')`,
      ],
    ])}
    WHERE terminal_cause IS NOT NULL
  `);
  // A replayed placement command is compared with its stored fingerprint as text
  // (`PlacementService`), so the key is renamed where it stands and the property order is kept.
  yield* sql.unsafe(`
    UPDATE j5_a2a_placement_event
    SET request_fingerprint = replace(
      request_fingerprint,
      '"squadronId":' || json_quote(squadron_id),
      '"projectId":' || json_quote(${projectOf("j5_a2a_placement_event.squadron_id")})
    )
    WHERE ${isLocal("j5_a2a_placement_event.squadron_id")}
  `);

  // A delivery's receiver or origin on a peer server keeps the id that server gave it.
  yield* sql.unsafe(`
    UPDATE j5_a2a_delivery
    SET receiver_squadron_id = ${projectOf("j5_a2a_delivery.receiver_squadron_id")}
    WHERE receiver_environment_id IS NULL AND ${isLocal("j5_a2a_delivery.receiver_squadron_id")}
  `);
  yield* sql.unsafe(`
    UPDATE j5_a2a_delivery
    SET origin_squadron_id = ${projectOf("j5_a2a_delivery.origin_squadron_id")}
    WHERE origin_environment_id IS NULL AND ${isLocal("j5_a2a_delivery.origin_squadron_id")}
  `);
  yield* sql.unsafe(`
    UPDATE j5_a2a_human_inbox_data
    SET origin_squadron_id = ${projectOf("j5_a2a_human_inbox_data.origin_squadron_id")}
    WHERE ${isLocal("j5_a2a_human_inbox_data.origin_squadron_id")}
  `);
  yield* sql.unsafe(`
    UPDATE j5_a2a_squadron
    SET id = ${projectOf("j5_a2a_squadron.id")}
    WHERE ${isLocal("j5_a2a_squadron.id")}
  `);
  for (const table of KEYED_TABLES) {
    yield* sql.unsafe(`
      UPDATE ${table}
      SET squadron_id = ${projectOf(`${table}.squadron_id`)}
      WHERE ${isLocal(`${table}.squadron_id`)}
    `);
  }

  yield* sql`DROP TABLE j5_a2a_squadron_project_reference`;
  // One row per project that has ever had a participant. It has no foreign key into upstream's
  // tables, so a ledger outlives upstream's soft project delete.
  yield* sql`ALTER TABLE j5_a2a_squadron RENAME TO j5_a2a_project_ledger`;
  yield* sql`ALTER TABLE j5_a2a_project_ledger RENAME COLUMN id TO project_id`;
  yield* sql`ALTER TABLE j5_a2a_project_ledger DROP COLUMN name`;
  yield* sql`ALTER TABLE j5_a2a_delivery RENAME COLUMN receiver_squadron_id TO receiver_project_id`;
  yield* sql`ALTER TABLE j5_a2a_delivery RENAME COLUMN origin_squadron_id TO origin_project_id`;
  yield* sql`
    ALTER TABLE j5_a2a_human_inbox_data RENAME COLUMN origin_squadron_id TO origin_project_id
  `;
  for (const table of KEYED_TABLES) {
    yield* sql.unsafe(`ALTER TABLE ${table} RENAME COLUMN squadron_id TO project_id`);
  }
  yield* sql`ALTER TABLE j5_a2a_squadron_membership RENAME TO j5_a2a_membership`;
  yield* sql`DROP INDEX j5_a2a_comm_command_receipt_squadron_seq_idx`;
  yield* sql`
    CREATE INDEX j5_a2a_comm_command_receipt_project_seq_idx
    ON j5_a2a_comm_command_receipt(project_id, result_seq)
  `;
  yield* sql`DROP INDEX j5_a2a_machine_participant_squadron_idx`;
  yield* sql`
    CREATE INDEX j5_a2a_machine_participant_project_idx
    ON j5_a2a_machine_participant(project_id, participant_id)
  `;

  // One check for every shape the product could not build (a Squadron with no project or with
  // several, a ledger row under an unknown Squadron): each table keeps exactly its rows, and every
  // row now sits under a project this migration moved a Squadron to.
  for (const [before, after, key] of CHECKED_TABLES) {
    const rows = yield* sql.unsafe<{
      readonly rows_before: number;
      readonly rows_after: number;
      readonly rows_without_project: number;
    }>(`
      SELECT
        (SELECT row_count FROM j5_a2a_rekey_rows_before WHERE name = '${before}') AS rows_before,
        (SELECT COUNT(*) FROM ${after}) AS rows_after,
        (
          SELECT COUNT(*) FROM ${after}
          WHERE ${key} NOT IN (
            SELECT retired.project_id FROM j5_a2a_retired_squadron retired
            WHERE retired.project_id IS NOT NULL
          )
        ) AS rows_without_project
    `);
    const row = rows[0];
    if (row === undefined || row.rows_before !== row.rows_after || row.rows_without_project !== 0) {
      return yield* new LedgerRekeyCheckError({
        table: before,
        rowsBefore: row?.rows_before ?? 0,
        rowsAfter: row?.rows_after ?? 0,
        rowsWithoutProject: row?.rows_without_project ?? 0,
      });
    }
  }
  yield* sql`DROP TABLE j5_a2a_rekey_rows_before`;
  // A Squadron that referenced no project owns no ledger rows (checked above), so only its
  // record remains.
  yield* sql`
    DELETE FROM j5_a2a_project_ledger
    WHERE project_id NOT IN (
      SELECT retired.project_id FROM j5_a2a_retired_squadron retired
      WHERE retired.project_id IS NOT NULL
    )
  `;
});
