import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import {
  migrationManifest as upstreamMigrationManifest,
  runMigrations,
} from "../../persistence/Migrations.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  layer as proposalStoreLayer,
} from "./AgentCrewProposalService.ts";
import { J5_A2A_MIGRATIONS_TABLE, migrationEntries, runJ5A2AMigrations } from "./Migrations.ts";
import Migration0005 from "./migrations/005_ImmutableThreadHome.ts";
import Migration0008 from "./migrations/008_LifecycleClosure.ts";

// These tests cover migrations 001 to 030, whose fixtures are Squadrons with no project. They
// stop short of 031, which re-keys the ledger to projects and has its own test file.
const BEFORE_REKEY = { toMigrationInclusive: 30 };

const enableAndAssertForeignKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  const rows = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
  assert.deepStrictEqual(rows, [{ foreign_keys: 1 }]);
});

it.effect("tracks J5 A2A migrations independently from upstream migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* enableAndAssertForeignKeys;
    yield* runMigrations();
    yield* runJ5A2AMigrations();

    const upstream = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id
      FROM effect_sql_migrations
      ORDER BY migration_id DESC
      LIMIT 1
    `;
    const j5 = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name
      FROM ${sql(J5_A2A_MIGRATIONS_TABLE)}
      ORDER BY migration_id
    `;

    assert.equal(upstream[0]?.migration_id, upstreamMigrationManifest.at(-1)?.[0]);
    assert.deepStrictEqual(j5, [
      { migration_id: 1, name: "EpicCommunicationLedger" },
      { migration_id: 2, name: "SendDeliverReply" },
      { migration_id: 3, name: "SquadronRename" },
      { migration_id: 4, name: "SilenceNoticeChannel" },
      { migration_id: 5, name: "ImmutableThreadHome" },
      { migration_id: 6, name: "HumanNode" },
      { migration_id: 7, name: "ParticipantPlacement" },
      { migration_id: 8, name: "LifecycleClosure" },
      { migration_id: 9, name: "SquadronProjectReferences" },
      { migration_id: 10, name: "OpenInboxCountIndex" },
      { migration_id: 11, name: "ReversibleLifecycle" },
      { migration_id: 12, name: "AgentHandoffs" },
      { migration_id: 13, name: "MachineParticipants" },
      { migration_id: 14, name: "AgentCrews" },
      { migration_id: 15, name: "CustomCrewSeats" },
      { migration_id: 16, name: "CrewProposalClaims" },
      { migration_id: 17, name: "EnsureCustomCrewSeats" },
      { migration_id: 18, name: "AgentLedPlaybooks" },
      { migration_id: 19, name: "PlaybookRunMaintenance" },
      { migration_id: 20, name: "CrewAlertExchanges" },
      { migration_id: 21, name: "CrewProposalsResolveOnce" },
      { migration_id: 22, name: "CrewRetiredWithCaptain" },
      { migration_id: 23, name: "Peers" },
      { migration_id: 24, name: "PeerDeliveryOrigin" },
      { migration_id: 25, name: "PeerDeliveryReceiver" },
      { migration_id: 26, name: "PeerRouteIndexes" },
      { migration_id: 27, name: "PeerSenderLabelRecency" },
      { migration_id: 28, name: "CrewPlaybooks" },
      { migration_id: 29, name: "CrewPlaybookRuns" },
      { migration_id: 30, name: "PeerPollMode" },
      { migration_id: 31, name: "LedgerRekeysToProjects" },
      { migration_id: 32, name: "PeerRosterSaysProject" },
      { migration_id: 33, name: "OutsideAgents" },
      { migration_id: 34, name: "PeopleAndGrants" },
      { migration_id: 35, name: "GuestLinks" },
      { migration_id: 37, name: "PersonNames" },
    ]);
    assert.deepStrictEqual(
      migrationEntries.map(([id, name]) => [id, name]),
      [
        [1, "EpicCommunicationLedger"],
        [2, "SendDeliverReply"],
        [3, "SquadronRename"],
        [4, "SilenceNoticeChannel"],
        [5, "ImmutableThreadHome"],
        [6, "HumanNode"],
        [7, "ParticipantPlacement"],
        [8, "LifecycleClosure"],
        [9, "SquadronProjectReferences"],
        [10, "OpenInboxCountIndex"],
        [11, "ReversibleLifecycle"],
        [12, "AgentHandoffs"],
        [13, "MachineParticipants"],
        [14, "AgentCrews"],
        [15, "CustomCrewSeats"],
        [16, "CrewProposalClaims"],
        [17, "EnsureCustomCrewSeats"],
        [18, "AgentLedPlaybooks"],
        [19, "PlaybookRunMaintenance"],
        [20, "CrewAlertExchanges"],
        [21, "CrewProposalsResolveOnce"],
        [22, "CrewRetiredWithCaptain"],
        [23, "Peers"],
        [24, "PeerDeliveryOrigin"],
        [25, "PeerDeliveryReceiver"],
        [26, "PeerRouteIndexes"],
        [27, "PeerSenderLabelRecency"],
        [28, "CrewPlaybooks"],
        [29, "CrewPlaybookRuns"],
        [30, "PeerPollMode"],
        [31, "LedgerRekeysToProjects"],
        [32, "PeerRosterSaysProject"],
        [33, "OutsideAgents"],
        [34, "PeopleAndGrants"],
        [35, "GuestLinks"],
        [37, "PersonNames"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds playbooks after an environment has applied the Crew migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 17 });
    const before = yield* sql`SELECT * FROM ${sql(J5_A2A_MIGRATIONS_TABLE)} ORDER BY migration_id`;
    yield* runJ5A2AMigrations(BEFORE_REKEY);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM ${sql(J5_A2A_MIGRATIONS_TABLE)} WHERE migration_id <= 17 ORDER BY migration_id`,
      before,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'j5_playbook_%' ORDER BY name`,
      [
        { name: "j5_playbook_request" },
        { name: "j5_playbook_run" },
        { name: "j5_playbook_step_delivery" },
      ],
    );
    yield* runJ5A2AMigrations(BEFORE_REKEY);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

const crewStores = Layer.mergeAll(crewInstanceLayer, proposalStoreLayer).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.effect("reads Crews recorded before playbooks as following none and owning no steps", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 27 });
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron', 'Crew', '2026-09-25T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_a2a_squadron_project_reference (squadron_id, project_id, ordinal, created_at)
      VALUES ('squadron', 'project-crew', 0, '2026-09-25T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_agent_crew_proposal (
        id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind,
        status, brief, display_name, requested_seats, approved_seats, created_at, resolved_at
      ) VALUES (
        'p-old', 'squadron', 'agent:captain', 'thread:captain', 'crew-old', 'roster', 'approved',
        'brief', 'Crew', '[{"seat":"helper","agentId":null,"reason":"Helps"}]', '[]',
        '2026-09-25T00:00:00.000Z', '2026-09-25T00:01:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO j5_agent_crew_instance (
        id, squadron_id, captain_participant_id, captain_thread_id, display_name, brief, version,
        created_at, archived_at
      ) VALUES (
        'crew-old', 'squadron', 'agent:captain', 'thread:captain', 'Crew', 'brief', 1,
        '2026-09-25T00:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO j5_agent_crew_member (
        crew_instance_id, seat_name, agent_id, participant_id, thread_id, ordinal, added_version,
        reason
      ) VALUES ('crew-old', 'helper', NULL, 'agent:helper', 'thread:helper', 0, 1, 'Helps')
    `;
    yield* runJ5A2AMigrations();
    // The Crew followed its Squadron to that Squadron's project.
    const proposal = yield* (yield* AgentCrewProposalService).read("p-old");
    assert.strictEqual(proposal?.projectId, "project-crew");
    assert.isNull(proposal?.playbook);
    assert.deepStrictEqual(proposal?.requestedSeats, [
      { seat: "helper", agentId: null, reason: "Helps" },
    ]);
    const instance = yield* (yield* AgentCrewInstanceService).read("crew-old");
    assert.isNull(instance?.playbook);
    assert.deepStrictEqual(instance?.members[0]?.playbookStepIds, []);
  }).pipe(Effect.provide(crewStores)),
);

it.effect("keeps existing playbook runs as thread runs when Crew links arrive", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 28 });
    yield* sql`
      INSERT INTO j5_playbook_run (
        run_id, owner_thread_id, definition_path, current_step_id, status, created_at, updated_at
      ) VALUES (
        'run-1', 'thread:owner', '/w/.j5/playbooks/review.yaml', 'inspect', 'active',
        '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z'
      )
    `;
    yield* runJ5A2AMigrations(BEFORE_REKEY);
    assert.deepStrictEqual(yield* sql`SELECT run_id, crew_instance_id FROM j5_playbook_run`, [
      { run_id: "run-1", crew_instance_id: null },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM j5_playbook_step_delivery`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reopens crew proposals a claimed launch left mid-flight and keeps resolved ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 19 });
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron', 'Crew', '2026-09-25T00:00:00.000Z')
    `;
    for (const [id, status] of [
      ["p-approving", "approving"],
      ["p-declining", "declining"],
      ["p-approved", "approved"],
      ["p-open", "open"],
    ] as const)
      yield* sql`
        INSERT INTO j5_agent_crew_proposal (
          id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind,
          status, brief, display_name, requested_seats, approved_seats, created_at, resolved_at
        ) VALUES (
          ${id}, 'squadron', 'agent:captain', 'thread:captain', NULL, 'roster', ${status}, 'brief',
          'Crew', '[]', ${status === "open" ? null : "[]"}, '2026-09-25T00:00:00.000Z',
          ${status === "open" ? null : "2026-09-25T00:01:00.000Z"}
        )
      `;
    yield* runJ5A2AMigrations(BEFORE_REKEY);
    assert.deepStrictEqual(
      yield* sql`SELECT id, status, approved_seats, resolved_at FROM j5_agent_crew_proposal ORDER BY id`,
      [
        {
          id: "p-approved",
          status: "approved",
          approved_seats: "[]",
          resolved_at: "2026-09-25T00:01:00.000Z",
        },
        { id: "p-approving", status: "open", approved_seats: null, resolved_at: null },
        { id: "p-declining", status: "open", approved_seats: null, resolved_at: null },
        { id: "p-open", status: "open", approved_seats: null, resolved_at: null },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("creates the exact namespaced ledger schema and receiver correlation constraint", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* enableAndAssertForeignKeys;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 3 });
    const deliveriesBeforeA3 = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_delivery
    `;
    assert.deepStrictEqual(deliveriesBeforeA3, [{ count: 0 }]);
    yield* runJ5A2AMigrations(BEFORE_REKEY);
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'j5_a2a_squadron',
          'j5_a2a_comm_event',
          'j5_a2a_comm_command_receipt',
          'j5_a2a_squadron_membership',
          'j5_a2a_exchange',
          'j5_a2a_delivery',
          'j5_a2a_human_person',
          'j5_a2a_human_inbox',
          'j5_a2a_human_inbox_data',
          'j5_a2a_silence_detector_cursor',
          'j5_a2a_placement_event',
          'j5_a2a_participant_placement',
          'j5_a2a_lifecycle_cursor',
          'j5_a2a_squadron_project_reference'
        )
      ORDER BY name
    `;
    const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'j5_a2a_comm_command_receipt_squadron_seq_idx',
          'j5_a2a_comm_event_received_correlation_idx',
          'j5_a2a_comm_event_command_idx',
          'j5_a2a_exchange_open_pair_idx',
          'j5_a2a_exchange_id_idx',
          'j5_a2a_delivery_drain_idx',
          'j5_a2a_delivery_message_sender_idx',
          'j5_a2a_delivery_one_reply_idx',
          'j5_a2a_comm_event_agent_home_thread_idx',
          'j5_a2a_human_person_local_operator_idx',
          'j5_a2a_placement_event_participant_idx',
          'j5_a2a_participant_placement_parent_idx',
          'j5_a2a_squadron_project_reference_project_idx',
          'j5_a2a_human_inbox_open_person_idx'
        )
      ORDER BY name
    `;
    const unprefixed = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name IN (
          'squadron',
          'comm_event',
          'comm_command_receipt',
          'squadron_membership',
          'comm_event_received_correlation_idx',
          'comm_command_receipt_squadron_seq_idx'
        )
    `;
    const deliveryColumns = yield* sql<{
      readonly dflt_value: string | null;
      readonly name: string;
      readonly notnull: number;
    }>`
      PRAGMA table_info(j5_a2a_delivery)
    `;
    const membershipSchema = yield* sql<{ readonly sql: string }>`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'j5_a2a_squadron_membership'
    `;

    assert.deepStrictEqual(tables, [
      { name: "j5_a2a_comm_command_receipt" },
      { name: "j5_a2a_comm_event" },
      { name: "j5_a2a_delivery" },
      { name: "j5_a2a_exchange" },
      { name: "j5_a2a_human_inbox" },
      { name: "j5_a2a_human_inbox_data" },
      { name: "j5_a2a_human_person" },
      { name: "j5_a2a_lifecycle_cursor" },
      { name: "j5_a2a_participant_placement" },
      { name: "j5_a2a_placement_event" },
      { name: "j5_a2a_silence_detector_cursor" },
      { name: "j5_a2a_squadron" },
      { name: "j5_a2a_squadron_membership" },
      { name: "j5_a2a_squadron_project_reference" },
    ]);
    const indexesByName = new Map(indexes.map((index) => [index.name, index.sql]));
    assert.include(
      indexesByName.get("j5_a2a_comm_command_receipt_squadron_seq_idx") ?? "",
      "ON j5_a2a_comm_command_receipt(squadron_id, result_seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_received_correlation_idx") ?? "",
      "WHERE kind = 'message.received'",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_command_idx") ?? "",
      "ON j5_a2a_comm_event(command_id, squadron_id, seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_exchange_open_pair_idx") ?? "",
      "WHERE status = 'open'",
    );
    assert.include(
      indexesByName.get("j5_a2a_exchange_id_idx") ?? "",
      "ON j5_a2a_exchange(exchange_id)",
    );
    assert.include(
      indexesByName.get("j5_a2a_delivery_drain_idx") ?? "",
      "ON j5_a2a_delivery(status, next_attempt_at, sent_seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_delivery_message_sender_idx") ?? "",
      "ON j5_a2a_delivery(message_id, sender_id)",
    );
    assert.include(
      indexesByName.get("j5_a2a_delivery_one_reply_idx") ?? "",
      "WHERE exchange_id IS NOT NULL AND exchange_role = 'reply'",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "json_extract(payload, '$.participant.threadId')",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "CREATE UNIQUE INDEX j5_a2a_comm_event_agent_home_thread_idx",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "WHERE kind = 'participant.joined'",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "json_extract(payload, '$.participant.kind') = 'agent'",
    );
    assert.include(
      indexesByName.get("j5_a2a_human_person_local_operator_idx") ?? "",
      "WHERE is_local_operator = 1",
    );
    assert.include(membershipSchema[0]?.sql ?? "", "participant_kind = 'agent'");
    assert.include(membershipSchema[0]?.sql ?? "", "participant_id NOT LIKE 'human:%'");
    assert.include(
      indexesByName.get("j5_a2a_participant_placement_parent_idx") ?? "",
      "ON j5_a2a_participant_placement(squadron_id, placement_parent_id)",
    );
    assert.include(
      indexesByName.get("j5_a2a_placement_event_participant_idx") ?? "",
      "ON j5_a2a_placement_event(squadron_id, participant_id, seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_squadron_project_reference_project_idx") ?? "",
      "ON j5_a2a_squadron_project_reference(project_id, squadron_id)",
    );
    assert.include(
      indexesByName.get("j5_a2a_human_inbox_open_person_idx") ?? "",
      "ON j5_a2a_human_inbox(person_id)",
    );
    assert.include(
      indexesByName.get("j5_a2a_human_inbox_open_person_idx") ?? "",
      "WHERE status = 'open'",
    );
    const envelopeChannel = deliveryColumns.find((column) => column.name === "envelope_channel");
    assert.equal(envelopeChannel?.notnull, 1);
    assert.isNull(envelopeChannel?.dflt_value);
    const cursor = yield* sql<{ readonly after_sequence: number | null }>`
      SELECT after_sequence FROM j5_a2a_silence_detector_cursor WHERE singleton = 1
    `;
    assert.deepStrictEqual(cursor, [{ after_sequence: null }]);
    const lifecycleCursor = yield* sql<{
      readonly after_sequence: number;
      readonly updated_at: string | null;
    }>`
      SELECT after_sequence, updated_at FROM j5_a2a_lifecycle_cursor WHERE singleton = 1
    `;
    assert.deepStrictEqual(lifecycleCursor, [{ after_sequence: 0, updated_at: null }]);
    assert.deepStrictEqual(unprefixed, []);
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:forbid-human-membership', 'Agent-only membership', '2026-08-20T00:00:00.000Z')
    `;
    const forbiddenMembership = yield* Effect.flip(sql`
      INSERT INTO j5_a2a_squadron_membership (
        squadron_id,
        participant_id,
        participant_kind,
        thread_id,
        joined_seq,
        updated_seq,
        payload
      ) VALUES (
        'squadron:forbid-human-membership',
        'human:forbidden-membership',
        'human',
        'thread:forbidden-human-membership',
        1,
        1,
        json_object('kind', 'human', 'id', 'human:forbidden-membership')
      )
    `);
    assert.equal(forbiddenMembership._tag, "SqlError");
    const forbiddenRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_squadron_membership
      WHERE participant_id = 'human:forbidden-membership'
    `;
    assert.deepStrictEqual(forbiddenRows, [{ count: 0 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("requires a non-null, non-blank reparent actor subject", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations(BEFORE_REKEY);
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:placement-actor-check', 'Placement actor check', '2026-08-28T00:00:00.000Z')
    `;

    const insertReparent = (seq: number, commandId: string, actorSubject: string | null) => sql`
      INSERT INTO j5_a2a_placement_event (
        seq,
        command_id,
        request_fingerprint,
        squadron_id,
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
        ${commandId},
        'fingerprint:placement-actor-check',
        'squadron:placement-actor-check',
        'agent:placement-actor-check',
        'participant.reparented',
        'human',
        'session:placement-actor-check',
        ${actorSubject},
        'browser-session-cookie',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        '2026-08-28T00:00:00.000Z'
      )
    `;

    yield* Effect.flip(insertReparent(1, "command:placement-actor-null", null));
    yield* Effect.flip(insertReparent(2, "command:placement-actor-empty", ""));
    yield* insertReparent(3, "command:placement-actor-valid", "human:placement-owner");

    const rows = yield* sql<{ readonly actor_subject: string; readonly command_id: string }>`
      SELECT command_id, actor_subject
      FROM j5_a2a_placement_event
      WHERE squadron_id = 'squadron:placement-actor-check'
      ORDER BY seq
    `;
    assert.deepStrictEqual(rows, [
      {
        command_id: "command:placement-actor-valid",
        actor_subject: "human:placement-owner",
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds lifecycle terminal state without mutating the A4 human inbox projection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 7 });
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:lifecycle-migration', 'Lifecycle migration', '2026-08-23T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
      VALUES ('human:person-lifecycle-migration', 1, '2026-08-23T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_a2a_exchange (
        squadron_id, exchange_id, sender_id, receiver_id, status, intent, urgency,
        opened_seq, closed_seq, created_at, updated_at
      ) VALUES
        (
          'squadron:lifecycle-migration', 'exchange:lifecycle:open',
          'agent:lifecycle-migration', 'human:person-lifecycle-migration', 'open',
          'Preserve open inbox state', 'soon', 1, NULL,
          '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
        ),
        (
          'squadron:lifecycle-migration', 'exchange:lifecycle:answered',
          'agent:lifecycle-migration', 'human:person-lifecycle-migration', 'closed',
          'Preserve answered inbox state', 'blocking', 2, 5,
          '2026-08-23T00:00:01.000Z', '2026-08-23T00:00:05.000Z'
        ),
        (
          'squadron:lifecycle-migration', 'exchange:lifecycle:dropped',
          'agent:lifecycle-migration', 'human:person-lifecycle-migration', 'closed',
          'Preserve dropped inbox state', 'fyi', 3, 6,
          '2026-08-23T00:00:02.000Z', '2026-08-23T00:00:06.000Z'
        )
    `;
    yield* sql`
      INSERT INTO j5_a2a_human_inbox_data (
        origin_squadron_id, message_id, exchange_id, sender_id, receiver_id, payload, created_at
      ) VALUES (
        'squadron:lifecycle-migration', 'message:raw-inbox', 'exchange:lifecycle:open',
        'agent:lifecycle-migration', 'human:person-lifecycle-migration',
        '{"opaque":"raw-inbox"}', '2026-08-23T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO j5_a2a_delivery (
        squadron_id, message_id, command_id, sent_seq, sender_id, receiver_id,
        receiver_squadron_id, exchange_id, exchange_role, correlation_id,
        message_text, status, attempts, last_error, next_attempt_at, delivered_seq,
        created_at, updated_at, envelope_channel
      ) VALUES (
        'squadron:lifecycle-migration', 'message:lifecycle-migration',
        'command:lifecycle-migration', 4, 'agent:lifecycle-migration',
        'human:person-lifecycle-migration', 'squadron:lifecycle-migration',
        'exchange:lifecycle:open', 'ask', 'correlation:lifecycle-migration',
        'Preserve this delivery', 'pending', 0, NULL, NULL, NULL,
        '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z', 'peer'
      )
    `;
    yield* sql`
      INSERT INTO j5_a2a_human_inbox (
        person_id, squadron_id, exchange_id, sender_id, intent, urgency,
        latest_message_id, latest_message, opened_seq, opened_at, status,
        terminal_seq, terminal_at, terminal_disposition, terminal_cause,
        terminal_facts, terminal_notice_message_id
      ) VALUES
        (
          'human:person-lifecycle-migration', 'squadron:lifecycle-migration',
          'exchange:lifecycle:open', 'agent:lifecycle-migration', 'Open intent', 'soon',
          'message:open', 'Open message', 1, '2026-08-23T00:00:00.000Z', 'open',
          NULL, NULL, NULL, NULL, NULL, NULL
        ),
        (
          'human:person-lifecycle-migration', 'squadron:lifecycle-migration',
          'exchange:lifecycle:answered', 'agent:lifecycle-migration', 'Answered intent',
          'blocking', 'message:answered', 'Answered message', 2,
          '2026-08-23T00:00:01.000Z', 'answered', 5, '2026-08-23T00:00:05.000Z',
          'reply-received', '{"kind":"reply"}', '{"replyRequired":false}', NULL
        ),
        (
          'human:person-lifecycle-migration', 'squadron:lifecycle-migration',
          'exchange:lifecycle:dropped', 'agent:lifecycle-migration', 'Dropped intent', 'fyi',
          'message:dropped', 'Dropped message', 3, '2026-08-23T00:00:02.000Z',
          'dropped', 6, '2026-08-23T00:00:06.000Z', 'sender-retired',
          '{"kind":"participant-archived"}',
          '{"replyRequired":false,"retryAllowed":false,"replacementRequired":false}',
          'message:terminal-notice'
        )
    `;
    const inboxSqlBefore = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'j5_a2a_human_inbox'
    `;
    const inboxRowsBefore = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT * FROM j5_a2a_human_inbox ORDER BY exchange_id
    `;
    const rawInboxRowsBefore = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT * FROM j5_a2a_human_inbox_data ORDER BY message_id
    `;

    yield* sql.withTransaction(Migration0008);

    const inboxSqlAfter = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'j5_a2a_human_inbox'
    `;
    const inboxRowsAfter = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT * FROM j5_a2a_human_inbox ORDER BY exchange_id
    `;
    const rawInboxRowsAfter = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT * FROM j5_a2a_human_inbox_data ORDER BY message_id
    `;
    const foreignKeyViolations = yield* sql<Readonly<Record<string, unknown>>>`
      PRAGMA foreign_key_check
    `;
    const exchangeColumns = yield* sql<{ readonly name: string; readonly pk: number }>`
      PRAGMA table_info(j5_a2a_exchange)
    `;
    const exchangeForeignKeys = yield* sql<{
      readonly table: string;
      readonly from: string;
      readonly to: string;
      readonly on_delete: string;
    }>`PRAGMA foreign_key_list(j5_a2a_exchange)`;
    const inboxForeignKeys = yield* sql<{
      readonly table: string;
      readonly from: string;
      readonly to: string;
      readonly on_delete: string;
    }>`PRAGMA foreign_key_list(j5_a2a_human_inbox)`;
    const squadronColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(j5_a2a_squadron)
    `;
    const exchangeSchema = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'j5_a2a_exchange'
    `;
    const openPairIndex = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'j5_a2a_exchange_open_pair_idx'
    `;
    const deliverySchema = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'j5_a2a_delivery'
    `;
    const eventSchema = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'j5_a2a_comm_event'
    `;
    const preservedDelivery = yield* sql<{
      readonly message_id: string;
      readonly exchange_role: string;
      readonly envelope_channel: string;
    }>`
      SELECT message_id, exchange_role, envelope_channel
      FROM j5_a2a_delivery
      WHERE message_id = 'message:lifecycle-migration'
    `;

    assert.deepStrictEqual(inboxSqlAfter, inboxSqlBefore);
    assert.include(
      inboxSqlAfter[0]?.sql ?? "",
      "REFERENCES j5_a2a_exchange(squadron_id, exchange_id) ON DELETE CASCADE",
    );
    assert.deepStrictEqual(inboxRowsAfter, inboxRowsBefore);
    assert.deepStrictEqual(rawInboxRowsAfter, rawInboxRowsBefore);
    assert.deepStrictEqual(foreignKeyViolations, []);
    assert.deepStrictEqual(
      exchangeColumns.filter((column) => column.pk > 0).map(({ name, pk }) => ({ name, pk })),
      [
        { name: "squadron_id", pk: 1 },
        { name: "exchange_id", pk: 2 },
      ],
    );
    assert.isTrue(
      exchangeForeignKeys.some(
        (foreignKey) =>
          foreignKey.table === "j5_a2a_squadron" &&
          foreignKey.from === "squadron_id" &&
          foreignKey.to === "id" &&
          foreignKey.on_delete === "CASCADE",
      ),
    );
    assert.isTrue(
      inboxForeignKeys.some(
        (foreignKey) =>
          foreignKey.table === "j5_a2a_exchange" &&
          foreignKey.from === "squadron_id" &&
          foreignKey.to === "squadron_id" &&
          foreignKey.on_delete === "CASCADE",
      ),
    );
    assert.isTrue(
      inboxForeignKeys.some(
        (foreignKey) =>
          foreignKey.table === "j5_a2a_exchange" &&
          foreignKey.from === "exchange_id" &&
          foreignKey.to === "exchange_id" &&
          foreignKey.on_delete === "CASCADE",
      ),
    );
    assert.notInclude(
      squadronColumns.map((column) => column.name),
      "archived_at",
    );
    assert.match(
      exchangeSchema[0]?.sql ?? "",
      /status TEXT NOT NULL CHECK \(status IN \('open', 'closed', 'dropped'\)\)/,
    );
    assert.match(
      openPairIndex[0]?.sql ?? "",
      /CREATE UNIQUE INDEX j5_a2a_exchange_open_pair_idx[\s\S]*WHERE status = 'open'/,
    );
    assert.include(deliverySchema[0]?.sql ?? "", "'terminal_notice'");
    assert.include(deliverySchema[0]?.sql ?? "", "'lifecycle_notice'");
    assert.include(eventSchema[0]?.sql ?? "", "'exchange.dropped'");
    assert.notInclude(eventSchema[0]?.sql ?? "", "'squadron.archived'");
    assert.deepStrictEqual(preservedDelivery, [
      {
        message_id: "message:lifecycle-migration",
        exchange_role: "ask",
        envelope_channel: "peer",
      },
    ]);

    yield* sql`
      UPDATE j5_a2a_exchange
      SET status = 'dropped', closed_seq = 7, updated_at = '2026-08-23T00:01:00.000Z'
      WHERE squadron_id = 'squadron:lifecycle-migration'
        AND exchange_id = 'exchange:lifecycle:dropped'
    `;
    const invalidStatusError = yield* Effect.flip(sql`
      UPDATE j5_a2a_exchange
      SET status = 'invalid-terminal-state'
      WHERE squadron_id = 'squadron:lifecycle-migration'
        AND exchange_id = 'exchange:lifecycle:open'
    `);
    assert.equal(invalidStatusError._tag, "SqlError");
    yield* sql`
      INSERT INTO j5_a2a_delivery (
        squadron_id, message_id, command_id, sent_seq, sender_id, receiver_id,
        receiver_squadron_id, exchange_id, exchange_role, correlation_id,
        message_text, status, attempts, last_error, next_attempt_at, delivered_seq,
        created_at, updated_at, envelope_channel
      ) VALUES (
        'squadron:lifecycle-migration', 'message:lifecycle-notice-migration',
        'command:lifecycle-notice-migration', 8, 'platform:lifecycle',
        'human:person-lifecycle-migration', 'squadron:lifecycle-migration',
        'exchange:lifecycle:dropped', 'terminal_notice',
        'correlation:lifecycle-notice-migration', 'Exchange dropped', 'pending', 0,
        NULL, NULL, NULL, '2026-08-23T00:01:00.000Z',
        '2026-08-23T00:01:00.000Z', 'lifecycle_notice'
      )
    `;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reports conflicting thread ids before creating the immutable-home index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* enableAndAssertForeignKeys;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 4 });
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at) VALUES
        ('squadron:migration-conflict:first', 'First conflict source', '2026-08-19T00:00:00.000Z'),
        ('squadron:migration-conflict:second', 'Second conflict source', '2026-08-19T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        squadron_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES
        (
          1,
          'squadron:migration-conflict:first',
          'participant.joined',
          NULL,
          'agent:migration-conflict:a:first',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:a:first',
              'threadId', 'thread:migration-conflict:a'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:a:first'
        ),
        (
          2,
          'squadron:migration-conflict:first',
          'participant.joined',
          NULL,
          'agent:migration-conflict:b:first',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:b:first',
              'threadId', 'thread:migration-conflict:b'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:b:first'
        ),
        (
          1,
          'squadron:migration-conflict:second',
          'participant.joined',
          NULL,
          'agent:migration-conflict:a:second',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:a:second',
              'threadId', 'thread:migration-conflict:a'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:a:second'
        ),
        (
          2,
          'squadron:migration-conflict:second',
          'participant.joined',
          NULL,
          'agent:migration-conflict:b:second',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:b:second',
              'threadId', 'thread:migration-conflict:b'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:b:second'
        )
    `;

    const error = yield* Effect.flip(Migration0005);

    assert.include(String(error), "thread:migration-conflict:a (2 joins)");
    assert.include(String(error), "thread:migration-conflict:b (2 joins)");
    assert.include(String(error), "Repair duplicate participant.joined history");
    const indexes = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index' AND name = 'j5_a2a_comm_event_agent_home_thread_idx'
    `;
    assert.deepStrictEqual(indexes, [{ count: 0 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "migrates the singleton human and preserves old delivered obligations as person history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* enableAndAssertForeignKeys;
      yield* runJ5A2AMigrations({ toMigrationInclusive: 5 });
      yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:legacy-human', 'Legacy human', '2026-08-20T00:00:00.000Z')
    `;
      yield* sql`
      INSERT INTO j5_a2a_squadron_membership (
        squadron_id,
        participant_id,
        participant_kind,
        thread_id,
        joined_seq,
        updated_seq,
        payload
      ) VALUES (
        'squadron:legacy-human',
        'human:global',
        'human',
        NULL,
        1,
        1,
        json_object('kind', 'human')
      )
    `;
      yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        squadron_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        1,
        'squadron:legacy-human',
        'participant.joined',
        NULL,
        'human:global',
        NULL,
        NULL,
        json_object('participant', json_object('kind', 'human')),
        '2026-08-20T00:00:00.000Z',
        'command:legacy-human:joined'
      )
    `;
      yield* sql`
      INSERT INTO j5_a2a_exchange (
        squadron_id,
        exchange_id,
        sender_id,
        receiver_id,
        status,
        intent,
        urgency,
        opened_seq,
        closed_seq,
        created_at,
        updated_at
      ) VALUES
        (
          'squadron:legacy-human',
          'exchange:legacy-human:open',
          'agent:legacy-asker',
          'human:global',
          'open',
          'Old unanswered request',
          'blocking',
          2,
          NULL,
          '2026-08-20T00:01:00.000Z',
          '2026-08-20T00:01:00.000Z'
        ),
        (
          'squadron:legacy-human',
          'exchange:legacy-human:closed',
          'agent:legacy-asker',
          'human:global',
          'closed',
          'Old answered request',
          'fyi',
          3,
          4,
          '2026-08-20T00:02:00.000Z',
          '2026-08-20T00:03:00.000Z'
        )
    `;
      yield* sql`
      INSERT INTO j5_a2a_delivery (
        squadron_id,
        message_id,
        command_id,
        sent_seq,
        sender_id,
        receiver_id,
        receiver_squadron_id,
        exchange_id,
        exchange_role,
        correlation_id,
        message_text,
        status,
        attempts,
        last_error,
        next_attempt_at,
        delivered_seq,
        created_at,
        updated_at,
        envelope_channel
      ) VALUES
        (
          'squadron:legacy-human',
          'message:legacy-human:open',
          'command:legacy-human:open',
          2,
          'agent:legacy-asker',
          'human:global',
          'squadron:legacy-human',
          'exchange:legacy-human:open',
          'ask',
          'correlation:legacy-human:open',
          'Please preserve this old unanswered request.',
          'delivered',
          1,
          NULL,
          NULL,
          5,
          '2026-08-20T00:01:00.000Z',
          '2026-08-20T00:01:01.000Z',
          'peer'
        ),
        (
          'squadron:legacy-human',
          'message:legacy-human:closed',
          'command:legacy-human:closed',
          3,
          'agent:legacy-asker',
          'human:global',
          'squadron:legacy-human',
          'exchange:legacy-human:closed',
          'ask',
          'correlation:legacy-human:closed',
          'Preserve this answered request too.',
          'delivered',
          1,
          NULL,
          NULL,
          6,
          '2026-08-20T00:02:00.000Z',
          '2026-08-20T00:02:01.000Z',
          'peer'
        )
    `;
      yield* sql`
      INSERT INTO j5_a2a_human_inbox_data (
        origin_squadron_id,
        message_id,
        exchange_id,
        sender_id,
        payload,
        created_at
      ) VALUES
        (
          'squadron:legacy-human',
          'message:legacy-human:open',
          'exchange:legacy-human:open',
          'agent:legacy-asker',
          'Please preserve this old unanswered request.',
          '2026-08-20T00:01:01.000Z'
        ),
        (
          'squadron:legacy-human',
          'message:legacy-human:closed',
          'exchange:legacy-human:closed',
          'agent:legacy-asker',
          'Preserve this answered request too.',
          '2026-08-20T00:02:01.000Z'
        )
    `;

      yield* runJ5A2AMigrations(BEFORE_REKEY);

      const memberships = yield* sql<{ readonly participant_id: string }>`
      SELECT participant_id
      FROM j5_a2a_squadron_membership
      WHERE squadron_id = 'squadron:legacy-human'
    `;
      assert.deepStrictEqual(memberships, []);
      const people = yield* sql<{
        readonly person_id: string;
        readonly is_local_operator: number;
      }>`
        SELECT person_id, is_local_operator
        FROM j5_a2a_human_person
      `;
      assert.deepStrictEqual(people, [{ person_id: "human:legacy-person", is_local_operator: 1 }]);
      const events = yield* sql<{ readonly receiver: string; readonly payload: string }>`
      SELECT receiver, payload
      FROM j5_a2a_comm_event
      WHERE squadron_id = 'squadron:legacy-human'
    `;
      assert.deepStrictEqual(
        events.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
        [
          {
            receiver: "human:legacy-person",
            payload: { participant: { kind: "human", id: "human:legacy-person" } },
          },
        ],
      );
      const durable = yield* sql<{
        readonly exchange_id: string;
        readonly person_id: string;
        readonly receiver_id: string;
        readonly status: string;
        readonly terminal_disposition: string | null;
      }>`
      SELECT
        inbox.exchange_id,
        inbox.person_id,
        raw.receiver_id,
        inbox.status,
        inbox.terminal_disposition
      FROM j5_a2a_human_inbox AS inbox
      JOIN j5_a2a_human_inbox_data AS raw
        ON raw.origin_squadron_id = inbox.squadron_id
       AND raw.message_id = inbox.latest_message_id
      ORDER BY inbox.exchange_id
    `;
      assert.deepStrictEqual(durable, [
        {
          exchange_id: "exchange:legacy-human:closed",
          person_id: "human:legacy-person",
          receiver_id: "human:legacy-person",
          status: "answered",
          terminal_disposition: "answered",
        },
        {
          exchange_id: "exchange:legacy-human:open",
          person_id: "human:legacy-person",
          receiver_id: "human:legacy-person",
          status: "open",
          terminal_disposition: null,
        },
      ]);
      const remainingGlobalReferences = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM (
        SELECT participant_id AS value FROM j5_a2a_squadron_membership
        UNION ALL SELECT sender FROM j5_a2a_comm_event
        UNION ALL SELECT receiver FROM j5_a2a_comm_event
        UNION ALL SELECT sender_id FROM j5_a2a_exchange
        UNION ALL SELECT receiver_id FROM j5_a2a_exchange
        UNION ALL SELECT sender_id FROM j5_a2a_delivery
        UNION ALL SELECT receiver_id FROM j5_a2a_delivery
        UNION ALL SELECT sender_id FROM j5_a2a_human_inbox_data
        UNION ALL SELECT receiver_id FROM j5_a2a_human_inbox_data
        UNION ALL SELECT person_id FROM j5_a2a_human_inbox
        UNION ALL SELECT person_id FROM j5_a2a_human_person
      )
      WHERE value = 'human:global'
    `;
      assert.deepStrictEqual(remainingGlobalReferences, [{ count: 0 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("renames existing Squadron data without changing ledger semantics", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* enableAndAssertForeignKeys;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 2 });
    yield* sql`
      INSERT INTO j5_a2a_epic (id, name, created_at)
      VALUES ('legacy-home', 'Legacy home', '2026-08-18T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        epic_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        1,
        'legacy-home',
        'message.sent',
        'agent:sender',
        'agent:receiver',
        NULL,
        'correlation:sent',
        json_object(
          'messageId', 'message:sent',
          'text', 'Preserve me',
          'originEpicId', 'legacy-home',
          'receiverEpicId', 'legacy-home',
          'exchangeRole', 'none',
          'envelopeChannel', 'peer'
        ),
        '2026-08-18T00:00:00.000Z',
        'command:sent'
      )
    `;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        epic_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        2,
        'legacy-home',
        'message.received',
        'agent:sender',
        'agent:receiver',
        NULL,
        'correlation:received',
        json_object(
          'originEpicId', 'legacy-home',
          'message', json_object('text', 'Preserve me')
        ),
        '2026-08-18T00:00:01.000Z',
        'command:received'
      )
    `;

    yield* runJ5A2AMigrations(BEFORE_REKEY);

    const events = yield* sql<{
      readonly squadron_id: string;
      readonly kind: string;
      readonly payload: string;
    }>`
      SELECT squadron_id, kind, payload
      FROM j5_a2a_comm_event
      ORDER BY seq
    `;
    assert.deepStrictEqual(
      events.map((event) => ({
        squadron_id: event.squadron_id,
        kind: event.kind,
        payload: JSON.parse(event.payload),
      })),
      [
        {
          squadron_id: "legacy-home",
          kind: "message.sent",
          payload: {
            messageId: "message:sent",
            text: "Preserve me",
            exchangeRole: "none",
            envelopeChannel: "peer",
            originSquadronId: "legacy-home",
            receiverSquadronId: "legacy-home",
          },
        },
        {
          squadron_id: "legacy-home",
          kind: "message.received",
          payload: {
            message: { text: "Preserve me" },
            originSquadronId: "legacy-home",
          },
        },
      ],
    );
    const legacySchema = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name IN (
          'j5_a2a_epic',
          'j5_a2a_epic_membership',
          'j5_a2a_comm_command_receipt_epic_seq_idx'
        )
    `;
    assert.deepStrictEqual(legacySchema, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("runs the J5 migration lane during normal SQLite setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* enableAndAssertForeignKeys;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'j5_a2a_comm_event'
    `;
    assert.deepStrictEqual(rows, [{ name: "j5_a2a_comm_event" }]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

// An earlier cut of the crews tables ran on one development database before id 13 went to
// machine participants; 14 drops those earlier-shaped tables and recreates them, so that database
// lands on the same schema as a fresh one.
it.effect("recreates earlier-shaped crews tables when 14 runs over them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 12 });
    yield* sql`
      CREATE TABLE j5_agent_crew_instance (
        id TEXT PRIMARY KEY, squadron_id TEXT NOT NULL, captain_participant_id TEXT NOT NULL,
        captain_thread_id TEXT NOT NULL, display_name TEXT NOT NULL, brief TEXT NOT NULL,
        version INTEGER NOT NULL, created_at TEXT NOT NULL, archived_at TEXT
      )
    `;
    yield* sql`
      CREATE TABLE j5_agent_crew_member (
        crew_instance_id TEXT NOT NULL, seat_name TEXT NOT NULL, agent_id TEXT NOT NULL,
        participant_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        added_version INTEGER NOT NULL,
        approved_by TEXT NOT NULL CHECK (approved_by IN ('human', 'runbook')), reason TEXT,
        PRIMARY KEY (crew_instance_id, seat_name)
      )
    `;
    yield* sql`
      CREATE TABLE j5_agent_crew_proposal (
        id TEXT PRIMARY KEY, squadron_id TEXT NOT NULL, captain_participant_id TEXT NOT NULL,
        captain_thread_id TEXT NOT NULL, crew_instance_id TEXT, kind TEXT NOT NULL,
        status TEXT NOT NULL, brief TEXT NOT NULL, display_name TEXT NOT NULL,
        requested_seats TEXT NOT NULL, approved_seats TEXT,
        runbook_declared INTEGER NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
      )
    `;
    yield* runJ5A2AMigrations();

    const applied = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM ${sql(J5_A2A_MIGRATIONS_TABLE)} WHERE migration_id >= 13
      ORDER BY migration_id
    `;
    assert.deepStrictEqual(
      applied.map((row) => row.migration_id),
      [
        13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
        37,
      ],
    );
    const memberColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('j5_agent_crew_member') ORDER BY cid
    `;
    assert.notInclude(
      memberColumns.map((column) => column.name),
      "approved_by",
    );
    const proposalColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('j5_agent_crew_proposal') ORDER BY cid
    `;
    assert.notInclude(
      proposalColumns.map((column) => column.name),
      "runbook_declared",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "16 rebuilds the proposal table with claim states and marks past approvals reported",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runJ5A2AMigrations({ toMigrationInclusive: 14 });
      yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:claims', 'Claims', '2026-09-17T00:00:00.000Z')
    `;
      const insert = (id: string, status: string, resolvedAt: string | null) => sql`
      INSERT INTO j5_agent_crew_proposal (
        id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind, status,
        brief, display_name, requested_seats, approved_seats, created_at, resolved_at
      ) VALUES (
        ${id}, 'squadron:claims', 'agent:captain', 'thread:captain', NULL, 'roster', ${status},
        'Build it.', 'Claims Crew', '[]', NULL, '2026-09-17T00:00:00.000Z', ${resolvedAt}
      )
    `;
      yield* insert("proposal:approved", "approved", "2026-09-17T00:01:00.000Z");
      yield* insert("proposal:open", "open", null);
      // Before the rebuild the claim states are refused.
      const refused = yield* Effect.result(insert("proposal:claimed", "approving", null));
      assert.isTrue(refused._tag === "Failure");

      yield* runJ5A2AMigrations(BEFORE_REKEY);
      const rows = yield* sql<{
        readonly id: string;
        readonly status: string;
        readonly reported_at: string | null;
      }>`SELECT id, status, reported_at FROM j5_agent_crew_proposal ORDER BY id`;
      // Rows survive; an approval from before the report existed counts as reported, so the boot
      // sweep does not re-announce it to its Captain.
      assert.deepStrictEqual(rows, [
        { id: "proposal:approved", status: "approved", reported_at: "2026-09-17T00:01:00.000Z" },
        { id: "proposal:open", status: "open", reported_at: null },
      ]);
      yield* insert("proposal:claimed", "approving", null);
      const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'j5_agent_crew_proposal'
    `;
      assert.include(
        indexes.map((row) => row.name),
        "j5_agent_crew_proposal_open_idx",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([
  { skipped15: false, label: "from an existing custom-seat database" },
  { skipped15: true, label: "through lower-stack 16 without 15" },
])("17 preserves seats when upgrading $label", ({ skipped15 }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const loader = Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries
          .filter(([id]) => (skipped15 ? id <= 16 && id !== 15 : id <= 15))
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    );
    yield* Migrator.make({})({ table: J5_A2A_MIGRATIONS_TABLE, loader });
    yield* sql`INSERT INTO j5_a2a_squadron (id,name,created_at) VALUES ('squadron:upgrade','Upgrade','2026-09-18')`;
    yield* sql`INSERT INTO j5_agent_crew_instance
        (id,squadron_id,captain_participant_id,captain_thread_id,display_name,brief,version,created_at)
        VALUES ('crew:upgrade','squadron:upgrade','captain','thread:captain','Upgrade','Work',1,'2026-09-18')`;
    yield* sql`INSERT INTO j5_agent_crew_member
        (crew_instance_id,seat_name,agent_id,participant_id,thread_id,ordinal,added_version,reason)
        VALUES ('crew:upgrade','saved','scout','participant:saved','thread:saved',0,1,'Keep this')`;
    if (!skipped15)
      yield* sql`INSERT INTO j5_agent_crew_member
        (crew_instance_id,seat_name,agent_id,participant_id,thread_id,ordinal,added_version)
        VALUES ('crew:upgrade','existing-custom',NULL,'participant:existing','thread:existing',1,1)`;
    yield* runJ5A2AMigrations(BEFORE_REKEY);
    yield* runJ5A2AMigrations(BEFORE_REKEY);
    const saved =
      yield* sql`SELECT agent_id,reason FROM j5_agent_crew_member WHERE seat_name='saved'`;
    assert.deepStrictEqual(saved, [{ agent_id: "scout", reason: "Keep this" }]);
    if (!skipped15)
      assert.lengthOf(
        yield* sql`SELECT * FROM j5_agent_crew_member WHERE seat_name='existing-custom' AND agent_id IS NULL`,
        1,
      );
    yield* sql`INSERT INTO j5_agent_crew_member
        (crew_instance_id,seat_name,agent_id,participant_id,thread_id,ordinal,added_version)
        VALUES ('crew:upgrade','new-custom',NULL,'participant:new','thread:new',2,1)`;
    const columns =
      yield* sql`SELECT "notnull" FROM pragma_table_info('j5_agent_crew_member') WHERE name='agent_id'`;
    assert.deepStrictEqual(columns, [{ notnull: 0 }]);
    assert.lengthOf(yield* sql`SELECT * FROM j5_a2a_migrations WHERE migration_id=17`, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "upgrades existing playbook runs, prunes terminal movement receipts, and indexes both board queries",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runJ5A2AMigrations({ toMigrationInclusive: 18 });
      for (const status of ["active", "completed", "cancelled"] as const) {
        yield* sql`INSERT INTO j5_playbook_run VALUES (${status}, ${status}, '/workspace/.j5/playbooks/demo.yaml', 'first', ${status}, '2026-09-23', '2026-09-23')`;
        for (const operation of [
          "start",
          "next",
          "back",
          status === "cancelled" ? "cancel" : "complete",
        ]) {
          yield* sql`INSERT INTO j5_playbook_request VALUES (${status}, ${operation}, json_array(${operation}), ${status})`;
        }
      }
      const before = yield* sql`SELECT * FROM j5_playbook_run ORDER BY run_id`;
      yield* runJ5A2AMigrations(BEFORE_REKEY);
      // Later migrations add the nullable Crew link; existing runs stay thread runs. The columns
      // are named because the SQLite client caches statements by SQL text, and on Node 24.14 a
      // `SELECT *` prepared before the ALTER keeps its old column list.
      assert.deepStrictEqual(
        yield* sql`SELECT run_id, owner_thread_id, definition_path, current_step_id, status,
          created_at, updated_at, crew_instance_id FROM j5_playbook_run ORDER BY run_id`,
        before.map((row) => ({ ...row, crew_instance_id: null })),
      );
      assert.equal(
        (yield* sql`SELECT * FROM j5_playbook_request WHERE run_id = 'active'`).length,
        4,
      );
      for (const status of ["completed", "cancelled"]) {
        assert.equal(
          (yield* sql`SELECT * FROM j5_playbook_request WHERE run_id = ${status}`).length,
          2,
        );
      }
      const activePlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT * FROM j5_playbook_run WHERE status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 100`;
      const allPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT * FROM j5_playbook_run ORDER BY (status = 'active') DESC, updated_at DESC, rowid DESC LIMIT 100`;
      assert.isTrue(activePlan.some((row) => row.detail.includes("j5_playbook_status_updated")));
      assert.isTrue(allPlan.some((row) => row.detail.includes("j5_playbook_active_updated")));
      assert.isFalse([...activePlan, ...allPlan].some((row) => row.detail.includes("TEMP B-TREE")));
      yield* sql`UPDATE j5_playbook_run SET status = 'cancelled' WHERE run_id = 'active'`;
      assert.equal(
        (yield* sql`SELECT * FROM j5_playbook_request WHERE run_id = 'active'`).length,
        2,
      );
      yield* runJ5A2AMigrations(BEFORE_REKEY);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps every recorded peer as one that sends directly when poll mode arrives", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 29 });
    yield* sql`
      INSERT INTO j5_a2a_peer (environment_id, label, origin, credential, credential_expires_at, created_at, updated_at)
      VALUES ('environment-home', 'Home', 'https://home.example:3773', 'home-token', '2036-09-16T00:00:00.000Z',
        '2026-09-16T00:00:00.000Z', '2026-09-17T00:00:00.000Z')
    `;
    yield* runJ5A2AMigrations();

    assert.deepStrictEqual(
      yield* sql`SELECT environment_id, label, link_mode, origin, credential, credential_expires_at,
        roster_json, last_polled_at, last_error, created_at, updated_at FROM j5_a2a_peer`,
      [
        {
          environment_id: "environment-home",
          label: "Home",
          link_mode: "push",
          origin: "https://home.example:3773",
          credential: "home-token",
          credential_expires_at: "2036-09-16T00:00:00.000Z",
          roster_json: null,
          last_polled_at: null,
          last_error: null,
          created_at: "2026-09-16T00:00:00.000Z",
          updated_at: "2026-09-17T00:00:00.000Z",
        },
      ],
    );
    // A peer that polls has no origin or credential from it; one this server calls has both.
    yield* sql`
      INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
      VALUES ('environment-laptop', 'Laptop', 'store', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')
    `;
    const refused = yield* Effect.flip(sql`
      INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
      VALUES ('environment-vm', 'VM', 'push', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')
    `);
    assert.equal(refused._tag, "SqlError");
    assert.deepStrictEqual(
      yield* sql`SELECT environment_id FROM j5_a2a_peer ORDER BY environment_id`,
      [{ environment_id: "environment-home" }, { environment_id: "environment-laptop" }],
    );
    const handedOut = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('j5_a2a_delivery') WHERE name = 'handed_out_at'
    `;
    assert.lengthOf(handedOut, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
