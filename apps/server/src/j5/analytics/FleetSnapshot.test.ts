import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "../a2a/AgentCrewInstanceService.ts";
import { CommCommandId, ExchangeId, LedgerProjectId, ParticipantId } from "../a2a/contracts.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { FleetSnapshot, manualLayer } from "./FleetSnapshot.ts";

const at = "2026-10-10T12:00:00.000Z";
const projectId = LedgerProjectId.make("ledger:fleet-snapshot");
const threadIdOf = (name: string) => ThreadId.make(`thread:fleet-snapshot:${name}`);

/** A thread row as the projection stores it, with the runs it holds. */
const thread = Effect.fn(function* (
  name: string,
  createdBy: "user" | "agent",
  runs: ReadonlyArray<string>,
  archived = false,
  payload: Readonly<Record<string, unknown>> = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const threadId = threadIdOf(name);
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, payload_json
    ) VALUES (
      ${threadId}, 'project:fleet-snapshot', ${name}, 'codex', 'full-access', 'default',
      ${at}, ${at}, ${archived ? at : null}, ${JSON.stringify({ createdBy, ...payload })}
    )
  `;
  for (const [index, status] of runs.entries())
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        ${`run:${name}:${index}`}, ${threadId}, ${index + 1}, 'codex', ${status}, ${at}, '{}'
      )
    `;
  return threadId;
});

it.effect("counts what the fleet is doing right now, and names nothing", () =>
  Effect.gen(function* () {
    const recorded: Array<Readonly<Record<string, unknown>>> = [];
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      yield* TestClock.setTime(Date.parse(at));
      const snapshot = yield* FleetSnapshot;

      yield* snapshot.record;

      const pullRequests = (count: number) => ({
        pullRequests: Array.from({ length: count }, (_, number) => ({ number })),
      });
      // The person's thread is mid-turn with a follow-up queued behind it.
      const captain = yield* thread(
        "captain",
        "user",
        ["completed", "running", "queued"],
        false,
        pullRequests(2),
      );
      // Two seats: one working, one waiting on an approval.
      const builder = yield* thread("builder", "agent", ["running"], false, pullRequests(1));
      const critic = yield* thread("critic", "agent", ["waiting"]);
      // An idle spawned agent, and a retired one whose last run is long over.
      const idle = yield* thread("idle", "agent", ["completed"]);
      const retired = yield* thread("retired", "agent", ["completed"], true, pullRequests(5));
      // A task the builder delegated.
      yield* thread("delegated", "agent", [], false, {
        lineage: { parentThreadId: builder, relationshipToParent: "subagent" },
      });

      const ledger = yield* A2ALedger;
      yield* ledger.ensureProject({ projectId, createdAt: at });
      const sql = yield* SqlClient.SqlClient;
      // The captain spawned both seats; a retired thread's children no longer count.
      for (const [index, [parent, child]] of [
        [captain, builder],
        [captain, critic],
        [retired, idle],
      ].entries())
        yield* sql`
          INSERT INTO j5_a2a_participant_placement (
            project_id, participant_id, provenance_kind, provenance_participant_id,
            provenance_source, created_event_seq, updated_event_seq
          ) VALUES (
            ${projectId}, ${participantIdForThread(child!)}, 'spawned-by',
            ${participantIdForThread(parent!)}, 'j5_spawn', ${index + 1}, ${index + 1}
          )
        `;
      // Two guests on the captain's thread, one of them on the whole project too.
      for (const guest of ["human:guest-a", "human:guest-b"]) {
        yield* sql`
          INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at, kind)
          VALUES (${guest}, 0, ${at}, 'guest')
        `;
        yield* sql`
          INSERT INTO j5_a2a_person_grant (
            person_id, target_kind, target_id, level, created_at, updated_at
          ) VALUES (${guest}, 'thread', ${captain}, 'view', ${at}, ${at})
        `;
      }
      yield* sql`
        INSERT INTO j5_a2a_person_grant (
          person_id, target_kind, target_id, level, created_at, updated_at
        ) VALUES ('human:guest-a', 'project', 'project:fleet-snapshot', 'collaborate', ${at}, ${at})
      `;
      // One open link still works; the others were revoked or have expired.
      for (const [name, expiresAt, revokedAt] of [
        ["live", "2999-01-01T00:00:00.000Z", null],
        ["revoked", "2999-01-01T00:00:00.000Z", at],
        ["expired", "2000-01-01T00:00:00.000Z", null],
      ])
        yield* sql`
          INSERT INTO j5_a2a_open_link (link_id, token_hash, thread_id, created_at, expires_at, revoked_at)
          VALUES (${name}, ${name}, ${captain}, ${at}, ${expiresAt}, ${revokedAt})
        `;
      yield* sql`
        INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
        VALUES ('environment:peer', 'Peer', 'store', ${at}, ${at})
      `;
      yield* (yield* AgentCrewInstanceService).record({
        id: "crew:fleet-snapshot",
        projectId,
        captainParticipantId: participantIdForThread(captain),
        captainThreadId: captain,
        displayName: "Crew",
        brief: "Brief.",
        createdAt: at,
        members: [builder, critic].map((threadId, index) => ({
          seatName: `seat-${index}`,
          agentId: "builder",
          participantId: participantIdForThread(threadId),
          threadId,
          reason: null,
        })),
      });
      for (const [name, receiver] of [
        ["to-person", ParticipantId.make("human:global")],
        ["to-agent", participantIdForThread(critic)],
      ] as const)
        yield* ledger.append({
          commandId: CommCommandId.make(`command:fleet-snapshot:${name}`),
          projectId,
          acceptedAt: at,
          event: {
            kind: "exchange.opened",
            sender: participantIdForThread(builder),
            receiver,
            exchangeId: ExchangeId.make(`exchange:fleet-snapshot:${name}`),
            correlationId: null,
            payload: { intent: "The intent never leaves the machine", urgency: null },
            createdAt: at,
          },
        });

      yield* snapshot.record;
    }).pipe(
      Effect.provide(
        manualLayer.pipe(
          Layer.provideMerge(Layer.mergeAll(ledgerLayer, crewInstanceLayer)),
          Layer.provide(
            Layer.succeed(
              AnalyticsService,
              AnalyticsService.of({
                record: (event, properties = {}) =>
                  Effect.sync(() => void recorded.push({ event, ...properties })),
                flush: Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    );

    const empty = {
      event: "j5.fleet.snapshot",
      openThreads: 0,
      workingThreads: 0,
      workingAgentStartedThreads: 0,
      queuedRuns: 0,
      liveCrews: 0,
      largestCrewSeats: 0,
      openAsksToPerson: 0,
      openAsksToAgents: 0,
      threadsWithChildren: 0,
      children: 0,
      mostChildren: 0,
      threadsWithPullRequests: 0,
      pullRequests: 0,
      mostPullRequests: 0,
      guests: 0,
      sharedThreads: 0,
      sharedProjects: 0,
      liveOpenLinks: 0,
      peerServers: 0,
    };
    assert.deepStrictEqual(recorded, [
      empty,
      {
        ...empty,
        openThreads: 5,
        workingThreads: 3,
        workingAgentStartedThreads: 2,
        queuedRuns: 1,
        liveCrews: 1,
        largestCrewSeats: 2,
        openAsksToPerson: 1,
        openAsksToAgents: 1,
        threadsWithChildren: 2,
        children: 3,
        mostChildren: 2,
        threadsWithPullRequests: 2,
        pullRequests: 3,
        mostPullRequests: 2,
        guests: 2,
        sharedThreads: 1,
        sharedProjects: 1,
        liveOpenLinks: 1,
        peerServers: 1,
      },
    ]);
  }),
);
