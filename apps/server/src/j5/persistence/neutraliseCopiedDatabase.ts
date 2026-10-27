import * as NodeOS from "node:os";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What a server would otherwise do by itself with J5 state copied from a real home, and how many
 * rows of each were stood down. History stays: closed Exchanges, delivered messages, the ledger,
 * participants, retired Crews, finished playbook runs.
 */
export interface NeutralisedJ5State {
  /** Peer servers with the credential to reach them (`PeerPoller`, peer delivery). Deleted. */
  readonly peers: number;
  /** Sessions that let a peer poll this server. Deleted. */
  readonly peerStoreGrants: number;
  /** Machine-sender tokens and peer credentials this server issued. Deleted. */
  readonly a2aSessions: number;
  /** Deliveries waiting, retrying, or handed out and unacknowledged (`DeliveryWorker`). Cancelled. */
  readonly deliveries: number;
  /** Open agent Exchanges, which the silence detector reconciles at start. Dropped. */
  readonly exchanges: number;
  /** Live Crews, which the seat-finish sweep and Captain cascade act on at start. Retired. */
  readonly crews: number;
  /** Approved proposals whose launch report is still owed (`CrewLaunchReporter`). Marked reported. */
  readonly crewLaunchReports: number;
  /** Proposals awaiting the person, whose approval would launch seats. Declined. */
  readonly crewProposals: number;
  /** Active playbook runs, which relay steps to Crew seats. Cancelled. */
  readonly playbookRuns: number;
  /** Playbook steps a Crew seat has not taken yet. Skipped. */
  readonly playbookStepDeliveries: number;
}

const REASON = "Stood down in a development copy of this database.";

/**
 * Stands down every J5 row that makes a server act on start. Only for a copy: it deletes
 * credentials and ends live work without ledger events, so the result is a test set, not a
 * ledger. Human-inbox Exchanges stay open, since nothing acts on them until the person answers.
 */
export const neutraliseJ5State = Effect.fn("j5.neutraliseJ5State")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const tables = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map(
      (row) => row.name,
    ),
  );
  /** A source that never ran J5's migrations has none of these tables, and one from an older build has some. */
  const count = <E>(table: string, statement: Effect.Effect<ReadonlyArray<unknown>, E>) =>
    tables.has(table) ? Effect.map(statement, (rows) => rows.length) : Effect.succeed(0);

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const a2aSessions = yield* count(
        "auth_sessions",
        tables.has("j5_a2a_peer_store_grant")
          ? sql`DELETE FROM auth_sessions
              WHERE subject LIKE 'machine:%' OR scopes LIKE '%"a2a:%'
                OR session_id IN (SELECT session_id FROM j5_a2a_peer_store_grant)
              RETURNING session_id`
          : sql`DELETE FROM auth_sessions
              WHERE subject LIKE 'machine:%' OR scopes LIKE '%"a2a:%'
              RETURNING session_id`,
      );
      const peerStoreGrants = yield* count(
        "j5_a2a_peer_store_grant",
        sql`DELETE FROM j5_a2a_peer_store_grant RETURNING session_id`,
      );
      const peers = yield* count(
        "j5_a2a_peer",
        sql`DELETE FROM j5_a2a_peer RETURNING environment_id`,
      );

      // The same projection an archive's `message.cancelled` writes (LedgerService).
      const deliveries = yield* count(
        "j5_a2a_delivery",
        sql`UPDATE j5_a2a_delivery
          SET status = 'cancelled', next_attempt_at = NULL, last_error = ${REASON}, updated_at = ${now}
          WHERE status IN ('pending', 'retry_scheduled')
          RETURNING message_id`,
      );
      // Closed at the ledger's latest position in its project, as `exchange.dropped` would be.
      const exchanges = yield* count(
        "j5_a2a_exchange",
        sql`UPDATE j5_a2a_exchange
          SET status = 'dropped', updated_at = ${now}, closed_seq = COALESCE(
            (SELECT MAX(seq) FROM j5_a2a_comm_event event
              WHERE event.project_id = j5_a2a_exchange.project_id),
            opened_seq)
          WHERE status = 'open' AND receiver_id NOT LIKE 'human:%'
          RETURNING exchange_id`,
      );

      // Not retired with its Captain, so unarchiving that thread brings nothing back.
      const crews = yield* count(
        "j5_agent_crew_instance",
        sql`UPDATE j5_agent_crew_instance SET archived_at = ${now}, retired_with_captain = 0
          WHERE archived_at IS NULL
          RETURNING id`,
      );
      const crewLaunchReports = yield* count(
        "j5_agent_crew_proposal",
        sql`UPDATE j5_agent_crew_proposal SET reported_at = ${now}
          WHERE status = 'approved' AND reported_at IS NULL
          RETURNING id`,
      );
      const crewProposals = yield* count(
        "j5_agent_crew_proposal",
        sql`UPDATE j5_agent_crew_proposal SET status = 'declined', resolved_at = ${now}
          WHERE status NOT IN ('approved', 'declined')
          RETURNING id`,
      );

      const playbookStepDeliveries = yield* count(
        "j5_playbook_step_delivery",
        sql`UPDATE j5_playbook_step_delivery SET outcome = 'skipped', resolved_at = ${now}
          WHERE resolved_at IS NULL
          RETURNING run_id`,
      );
      const playbookRuns = yield* count(
        "j5_playbook_run",
        sql`UPDATE j5_playbook_run SET status = 'cancelled', updated_at = ${now}
          WHERE status = 'active'
          RETURNING run_id`,
      );

      return {
        peers,
        peerStoreGrants,
        a2aSessions,
        deliveries,
        exchanges,
        crews,
        crewLaunchReports,
        crewProposals,
        playbookRuns,
        playbookStepDeliveries,
      } satisfies NeutralisedJ5State;
    }),
  );
});

export class NeutraliseCopiedDatabaseRefusedError extends Schema.TaggedError<NeutraliseCopiedDatabaseRefusedError>()(
  "NeutraliseCopiedDatabaseRefusedError",
  {
    copyPath: Schema.String,
    reason: Schema.Literals(["is-the-source", "in-a-shared-home"]),
  },
) {
  override get message(): string {
    return this.reason === "is-the-source"
      ? `Refusing to stand down J5 state in '${this.copyPath}': it is the database being copied from.`
      : `Refusing to stand down J5 state in '${this.copyPath}': it is inside the shared ~/.t3 or ~/.j5code home.`;
  }
}

/**
 * Runs `neutraliseJ5State` on a copied database file. Refuses the file the copy was taken from
 * and any database in an installed home's `userdata`, so a wrong argument can only fail.
 */
export const neutraliseCopiedDatabase = Effect.fn("j5.neutraliseCopiedDatabase")(function* (input: {
  readonly copyPath: string;
  readonly sourcePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  const copyPath = yield* canonical(input.copyPath);
  if (copyPath === (yield* canonical(input.sourcePath))) {
    return yield* new NeutraliseCopiedDatabaseRefusedError({ copyPath, reason: "is-the-source" });
  }
  // The directory rather than the file, so a copy that does not exist yet still resolves.
  const copyDir = yield* canonical(path.dirname(input.copyPath));
  for (const home of [".t3", ".j5code"]) {
    const sharedStateDir = yield* canonical(path.join(NodeOS.homedir(), home, "userdata"));
    const inside = path.relative(sharedStateDir, copyDir);
    if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) {
      return yield* new NeutraliseCopiedDatabaseRefusedError({
        copyPath,
        reason: "in-a-shared-home",
      });
    }
  }
  return yield* neutraliseJ5State().pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: input.copyPath })),
  );
});
