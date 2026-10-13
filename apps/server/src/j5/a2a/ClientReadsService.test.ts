import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { PlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { AgentCrewProposalService } from "./AgentCrewProposalService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";
import { CrewRuntimeRequestService } from "./CrewRuntimeRequestService.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { recordOutsideAgentName } from "./outsideAgentNames.ts";
import {
  ClientReadsService,
  explainOpenInboxCountStatement,
  explainPeerSenderLabelStatement,
  layer as clientReadsLayer,
} from "./ClientReadsService.ts";
import {
  CommCommandId,
  ParticipantId,
  LedgerProjectId,
  type AgentParticipant,
} from "./contracts.ts";

const firstPerson = ParticipantId.make("human:person-one");
const secondPerson = ParticipantId.make("human:person-two");

const makeTestLayer = () => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  // These tests read identities and the open count; the Crew, Fleet and archive reads the service
  // also carries are never reached, so their services stand in unimplemented.
  const unreached = Layer.mergeAll(
    Layer.mock(ParticipantPlacementService)({}),
    Layer.mock(AgentCrewInstanceService)({}),
    Layer.mock(AgentCrewProposalService)({}),
    Layer.mock(CrewRuntimeRequestService)({}),
    Layer.mock(PlaybookCrewRelay)({}),
    Layer.mock(PlaybookStore)({}),
    Layer.mock(A2AArchiveFacts)({}),
    Layer.mock(ArchiveCrewService)({}),
  );
  const clientReads = clientReadsLayer.pipe(
    Layer.provide(inbox),
    Layer.provide(ledger),
    Layer.provide(unreached),
    Layer.provide(database),
  );
  return Layer.mergeAll(database, ledger, inbox, clientReads);
};

it.effect("reads total batched identities without participant-id normalization", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const reads = yield* ClientReadsService;
    const sql = yield* SqlClient.SqlClient;

    const alpha: AgentParticipant = {
      kind: "agent",
      id: ParticipantId.make("agent:j5:a2a:thread:client-reads:alpha"),
      threadId: ThreadId.make("thread:client-reads:alpha"),
    };
    const beta: AgentParticipant = {
      kind: "agent",
      id: ParticipantId.make("agent:j5:a2a:thread%3Aclient-reads%3Abeta"),
      threadId: ThreadId.make("thread:client-reads:beta"),
    };
    const alphaProject = LedgerProjectId.make("project:client-reads:alpha");
    const betaProject = LedgerProjectId.make("project:client-reads:beta");
    const createdAt = "2026-08-29T00:00:00.000Z";
    const earlierDuplicateJoinAt = "2026-08-28T00:00:00.000Z";
    const laterDuplicateJoinAt = "2026-08-30T00:00:00.000Z";

    const join = Effect.fn("test.j5.a2a.clientReads.join")(function* (input: {
      readonly projectId: LedgerProjectId;
      readonly agent: AgentParticipant;
    }) {
      yield* ledger.ensureProject({ projectId: input.projectId, createdAt });
      yield* ledger.appendEvents({
        commandId: CommCommandId.make(`command:client-reads:join:${input.agent.id}`),
        projectId: input.projectId,
        acceptedAt: createdAt,
        events: [
          {
            kind: "participant.joined",
            sender: null,
            receiver: input.agent.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant: input.agent },
            createdAt,
          },
        ],
      });
    });
    yield* join({ projectId: alphaProject, agent: alpha });
    yield* join({ projectId: betaProject, agent: beta });
    yield* ledger.appendEvents({
      commandId: CommCommandId.make("command:client-reads:leave:beta"),
      projectId: betaProject,
      acceptedAt: createdAt,
      events: [
        {
          kind: "participant.left",
          sender: null,
          receiver: beta.id,
          exchangeId: null,
          correlationId: null,
          payload: { participant: beta },
          createdAt,
        },
      ],
    });
    const legacyHuman = ParticipantId.make("human:legacy-history");
    const duplicateHistory = ParticipantId.make("agent:client-reads:duplicate-history");
    yield* sql`
        INSERT INTO j5_a2a_comm_event (
          seq, project_id, kind, sender, receiver, exchange_id, correlation_id,
          payload, created_at, command_id
        ) VALUES (
          2, ${alphaProject}, 'participant.joined', NULL, ${duplicateHistory}, NULL, NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', ${duplicateHistory},
              'threadId', 'thread:client-reads:duplicate-history:first'
            )
          ),
          ${laterDuplicateJoinAt}, NULL
        )
      `;
    yield* sql`
        INSERT INTO j5_a2a_comm_event (
          seq, project_id, kind, sender, receiver, exchange_id, correlation_id,
          payload, created_at, command_id
        ) VALUES (
          3, ${betaProject}, 'participant.joined', NULL, ${duplicateHistory}, NULL, NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', ${duplicateHistory},
              'threadId', 'thread:client-reads:duplicate-history:second'
            )
          ),
          ${earlierDuplicateJoinAt}, NULL
        )
      `;
    yield* sql`
        INSERT INTO j5_a2a_comm_event (
          seq, project_id, kind, sender, receiver, exchange_id, correlation_id,
          payload, created_at, command_id
        ) VALUES (
          3, ${alphaProject}, 'participant.joined', NULL, ${legacyHuman}, NULL, NULL,
          json_object('participant', json_object('kind', 'human', 'id', ${legacyHuman})),
          ${createdAt}, NULL
        )
      `;
    yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at,
          archived_at, deleted_at, payload_json
        ) VALUES (
          (${alpha.threadId}), 'project:client-reads', 'Alpha Thread', 'codex', 'full-access',
          'default', NULL, ${createdAt}, ${createdAt}, NULL, NULL, '{}'
        )
      `;
    yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at,
          archived_at, deleted_at, payload_json
        ) VALUES (
          ('thread:client-reads:duplicate-history:second'), 'project:client-reads',
          'Earlier Duplicate Thread', 'codex', 'full-access',
          'default', NULL, ${createdAt}, ${createdAt}, NULL, NULL, '{}'
        )
      `;
    yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at,
          archived_at, deleted_at, payload_json
        ) VALUES (
          (${beta.threadId}), 'project:client-reads', '   ', 'codex', 'full-access',
          'default', NULL, ${createdAt}, ${createdAt}, NULL, NULL, '{}'
        )
      `;

    const missing = ParticipantId.make("agent:client-reads:missing");
    const identities = yield* reads.participantIdentities({
      participantIds: [beta.id, duplicateHistory, missing, alpha.id, beta.id],
    });
    assert.deepStrictEqual(identities, {
      entries: [
        { participantId: beta.id, identity: { kind: "unknown" } },
        {
          participantId: duplicateHistory,
          identity: { kind: "known", displayName: "Earlier Duplicate Thread" },
        },
        { participantId: missing, identity: { kind: "unknown" } },
        { participantId: alpha.id, identity: { kind: "known", displayName: "Alpha Thread" } },
      ],
    });
    assert.deepStrictEqual(yield* reads.participantIdentities({ participantIds: [] }), {
      entries: [],
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("names an outside agent by the label it signed in with", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const sql = yield* SqlClient.SqlClient;
    const reads = yield* ClientReadsService;
    const known = ParticipantId.make("outside:session-known");
    const unseen = ParticipantId.make("outside:session-unseen");
    yield* recordOutsideAgentName(sql, {
      participantId: known,
      name: "Claude Code (laptop)",
      at: "2026-10-12T00:00:00.000Z",
    });
    assert.deepStrictEqual(
      yield* reads.participantIdentities({ participantIds: [known, unseen] }),
      {
        entries: [
          {
            participantId: known,
            identity: { kind: "known", displayName: "Claude Code (laptop)" },
          },
          { participantId: unseen, identity: { kind: "unknown" } },
        ],
      },
    );
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "counts exactly the A4 open list for explicit people and uses the literal open partial index",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const inbox = yield* A2AHumanInbox;
      const reads = yield* ClientReadsService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = LedgerProjectId.make("project:client-reads:count");
      const createdAt = "2026-08-29T00:00:00.000Z";
      yield* sql`
        INSERT INTO j5_a2a_project_ledger (project_id, created_at)
        VALUES (${projectId}, ${createdAt})
      `;
      yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${firstPerson}, 1, ${createdAt}), (${secondPerson}, 0, ${createdAt})
      `;
      const insertExchange = Effect.fn("test.j5.a2a.clientReads.exchange")(function* (input: {
        readonly id: string;
        readonly personId: ParticipantId;
        readonly inboxStatus: "open" | "answered";
        readonly exchangeStatus: "open" | "closed";
      }) {
        const exchangeId = `exchange:client-reads:${input.id}`;
        const messageId = `message:client-reads:${input.id}`;
        const senderId = `agent:client-reads:sender:${input.id}`;
        yield* sql`
          INSERT INTO j5_a2a_exchange (
            project_id, exchange_id, sender_id, receiver_id, status, intent, urgency,
            opened_seq, closed_seq, created_at, updated_at
          ) VALUES (
            ${projectId}, ${exchangeId}, ${senderId}, ${input.personId},
            ${input.exchangeStatus}, 'Count fixture', 'soon', 1,
            ${input.exchangeStatus === "closed" ? 2 : null}, ${createdAt}, ${createdAt}
          )
        `;
        yield* sql`
          INSERT INTO j5_a2a_human_inbox (
            person_id, project_id, exchange_id, sender_id, intent, urgency,
            latest_message_id, latest_message, opened_seq, opened_at, status,
            terminal_seq, terminal_at, terminal_disposition, terminal_cause,
            terminal_facts, terminal_notice_message_id
          ) VALUES (
            ${input.personId}, ${projectId}, ${exchangeId}, ${senderId},
            'Count fixture', 'soon', ${messageId}, 'Count fixture',
            1, ${createdAt}, ${input.inboxStatus},
            ${input.inboxStatus === "open" ? null : 2},
            ${input.inboxStatus === "open" ? null : createdAt},
            ${input.inboxStatus === "open" ? null : "answered"}, NULL, NULL, NULL
          )
        `;
      });
      yield* insertExchange({
        id: "first-open-one",
        personId: firstPerson,
        inboxStatus: "open",
        exchangeStatus: "open",
      });
      yield* insertExchange({
        id: "first-open-two",
        personId: firstPerson,
        inboxStatus: "open",
        exchangeStatus: "open",
      });
      yield* insertExchange({
        id: "first-answered",
        personId: firstPerson,
        inboxStatus: "answered",
        exchangeStatus: "open",
      });
      yield* insertExchange({
        id: "first-closed-exchange",
        personId: firstPerson,
        inboxStatus: "open",
        exchangeStatus: "closed",
      });
      yield* insertExchange({
        id: "second-open",
        personId: secondPerson,
        inboxStatus: "open",
        exchangeStatus: "open",
      });
      const firstList = yield* inbox.list(firstPerson);
      const firstCount = yield* reads.openInboxCount(firstPerson);
      assert.equal(firstCount.personId, firstPerson);
      assert.equal(firstCount.count, firstList.length);
      assert.equal(firstCount.count, 2);
      const secondCount = yield* reads.openInboxCount(secondPerson);
      assert.deepStrictEqual(secondCount, { personId: secondPerson, count: 1 });
      assert.deepStrictEqual(yield* reads.openInboxCount(), { personId: firstPerson, count: 2 });

      const plan = yield* explainOpenInboxCountStatement(sql, firstPerson);
      assert.isTrue(
        plan.some((row) => row.detail.includes("j5_a2a_human_inbox_open_person_idx")),
        "the literal open-count predicate should use the partial person index",
      );
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("names a sender homed on a peer by the label its server sent, after any local name", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const reads = yield* ClientReadsService;
    const sql = yield* SqlClient.SqlClient;
    const project = LedgerProjectId.make("project:client-reads:peer");
    const remoteSender = ParticipantId.make("agent:j5:a2a:thread:remote-asker");
    const local: AgentParticipant = {
      kind: "agent",
      id: ParticipantId.make("agent:j5:a2a:thread:client-reads:local"),
      threadId: ThreadId.make("thread:client-reads:local"),
    };
    const createdAt = "2026-09-21T00:00:00.000Z";
    yield* ledger.ensureProject({ projectId: project, createdAt });
    yield* ledger.appendEvents({
      commandId: CommCommandId.make("command:client-reads:peer:join"),
      projectId: project,
      acceptedAt: createdAt,
      events: [
        {
          kind: "participant.joined",
          sender: null,
          receiver: local.id,
          exchangeId: null,
          correlationId: null,
          payload: { participant: local },
          createdAt,
        },
      ],
    });
    // Deliveries from one remote sender into two projects here. Each project
    // numbers its own rows, so the renamed sender's latest label sits at a
    // lower seq than an older one; the time this server recorded each wins.
    const other = LedgerProjectId.make("project:client-reads:peer:other");
    yield* ledger.ensureProject({ projectId: other, createdAt });
    const received = (inProject: LedgerProjectId, seq: number, label: string, at: string) => sql`
      INSERT INTO j5_a2a_comm_event (
        seq, project_id, kind, sender, receiver, exchange_id, correlation_id,
        payload, created_at, command_id
      ) VALUES (
        ${seq}, ${inProject}, 'message.received', ${remoteSender}, ${local.id}, NULL,
        ${`correlation:client-reads:peer:${inProject}:${String(seq)}`},
        ${JSON.stringify({
          originProjectId: "project:home",
          originEnvironmentId: "environment-home",
          senderLabel: label,
          message: {},
        })},
        ${at}, ${`command:client-reads:peer:${inProject}:${String(seq)}`}
      )
    `;
    yield* received(project, 500, "Old title", "2026-09-21T00:01:00.000Z");
    yield* received(other, 10, "Incident asker", "2026-09-21T00:02:00.000Z");

    const identities = yield* reads.participantIdentities({
      participantIds: [remoteSender, local.id],
    });
    assert.deepStrictEqual(identities, {
      entries: [
        { participantId: remoteSender, identity: { kind: "known", displayName: "Incident asker" } },
        { participantId: local.id, identity: { kind: "unknown" } },
      ],
    });
    // Two rows recorded at the same instant: the tie falls to project id, so one label wins.
    yield* received(other, 11, "Tie in other", "2026-09-21T00:03:00.000Z");
    yield* received(project, 501, "Tie in peer", "2026-09-21T00:03:00.000Z");
    const tied = yield* reads.participantIdentities({ participantIds: [remoteSender] });
    assert.deepStrictEqual(tied.entries, [
      { participantId: remoteSender, identity: { kind: "known", displayName: "Tie in other" } },
    ]);

    // Each id asked about is one backward seek on the recency index: no scan, no sort.
    const plan = yield* explainPeerSenderLabelStatement(sql, [remoteSender]);
    const rendered = plan.map((row) => row.detail).join(" | ");
    const ledgerReads = plan.filter((row) => /\b(?:SCAN|SEARCH) event\b/.test(row.detail));
    assert.equal(ledgerReads.length, 1, `one read of the ledger per id: ${rendered}`);
    assert.match(
      ledgerReads[0]!.detail,
      /^SEARCH event USING INDEX j5_a2a_comm_event_received_label_recency_idx \(sender=\?\)/,
      rendered,
    );
    assert.notMatch(rendered, /TEMP B-TREE/, `the index order is the answer order: ${rendered}`);
  }).pipe(Effect.provide(makeTestLayer())),
);
