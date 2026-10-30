import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as J5Contracts from "@t3tools/contracts/j5";
import * as SqlClient from "effect/sql/SqlClient";

import { PlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { A2ALedger } from "./LedgerService.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { LedgerProjectId, isOutsideAgentParticipantId } from "./contracts.ts";
import { clientReadBatches } from "./clientReadBatches.ts";
import { readFleetLedgerFacts } from "./fleetFacts.ts";
import { outsideAgentNameRows } from "./outsideAgentNames.ts";
import type { ParticipantPlacementView } from "./placementContracts.ts";

// The response shape is the J5 contract the clients decode.
export const FleetAgent = J5Contracts.FleetAgent;
export const FleetProject = J5Contracts.FleetProject;
export const FleetResponse = J5Contracts.FleetResponse;
export type FleetAgent = J5Contracts.FleetAgent;
export type FleetResponse = J5Contracts.FleetResponse;

/** Pure projection from placement rows, live Crews, and open-ask counts to one project. */
export const projectFleetProject = (input: {
  readonly project: { readonly id: LedgerProjectId; readonly name: string };
  readonly participants: ReadonlyArray<ParticipantPlacementView>;
  readonly crews: ReadonlyArray<AgentCrewInstance>;
  readonly openAsks: ReadonlyMap<string, number>;
  readonly facts?: ReadonlyMap<string, J5Contracts.FleetAgentFacts>;
  /** Each live Crew's active playbook run, by Crew id. */
  readonly playbookRuns?: ReadonlyMap<string, J5Contracts.FleetCrew["playbookRun"]>;
  /** The label of each outside agent that spawned one of the participants, by its id. */
  readonly outsideAgentNames?: ReadonlyMap<string, string>;
}): FleetResponse["projects"][number] => {
  const seatByParticipant = new Map<string, FleetAgent["crew"]>();
  for (const crew of input.crews) {
    if (crew.archivedAt !== null) continue;
    for (const member of crew.members) {
      seatByParticipant.set(member.participantId, {
        crewInstanceId: crew.id,
        crewName: crew.displayName,
        seat: member.seatName,
        captainParticipantId: crew.captainParticipantId,
      });
    }
  }
  // A retired agent is never a row (fleet-page AC11). An archive touches one agent, so a child
  // still live beneath it keeps its parent id and the client roots it; retired Crews read below.
  const agents = input.participants.filter(
    (row) => row.participant.kind === "agent" && row.archivedAt == null,
  );
  // A seat on a live roster that the ledger has no row for (reserved, never created) is still a
  // seat of that Crew: it rides under its Captain with no thread, so the client counts it as
  // unknown instead of dropping it. A seat whose row was archived is retired, not unknown.
  const recorded = new Set(input.participants.map((row) => row.participantId as string));
  const unrecordedSeats = input.crews.flatMap((crew) =>
    crew.archivedAt !== null
      ? []
      : crew.members
          .filter((member) => !recorded.has(member.participantId))
          .map((member): FleetAgent => ({
            participantId: member.participantId,
            threadId: null,
            displayName: member.seatName,
            origin: "agent",
            placementParentId: crew.captainParticipantId,
            crew: seatByParticipant.get(member.participantId) ?? null,
            openAsks: 0,
            ...(input.facts === undefined
              ? {}
              : {
                  facts: {
                    asks: { owed: [], awaited: [] },
                    problems: [],
                    deliveryEnvironmentIds: [],
                  },
                }),
          })),
  );
  return {
    id: input.project.id,
    title: input.project.name,
    agents: [
      ...agents.map((row): FleetAgent => ({
        participantId: row.participantId,
        threadId: row.threadId,
        displayName:
          "displayName" in row.participant && typeof row.participant.displayName === "string"
            ? row.participant.displayName
            : null,
        // Every agent-created path (j5_spawn_agent, Crew seats, a fork) records a placement
        // at creation, so an agent with a project home and no placement row is one a person
        // launched through the composer: `unrecorded` is that measured fact, not a guess. Recorded
        // `unknown` (a native thread that joined later) stays `?`.
        origin:
          row.provenance.kind === "spawned-by"
            ? "agent"
            : row.provenance.kind === "unknown"
              ? "unknown"
              : "human",
        placementParentId: row.placementParentId,
        ...(row.provenance.kind === "spawned-by" &&
        isOutsideAgentParticipantId(row.provenance.spawnedByParticipantId)
          ? {
              outsideSpawner: {
                participantId: row.provenance.spawnedByParticipantId,
                name: input.outsideAgentNames?.get(row.provenance.spawnedByParticipantId) ?? null,
              },
            }
          : {}),
        crew: seatByParticipant.get(row.participantId) ?? null,
        openAsks: input.openAsks.get(row.participantId) ?? 0,
        ...(input.facts?.has(row.participantId)
          ? { facts: input.facts.get(row.participantId)! }
          : {}),
      })),
      ...unrecordedSeats,
    ],
    // Archived Crews ride along with their roster snapshot: the brief, the seats, and who
    // approved each stay readable for whoever proposes the successor (Crews AC20).
    crews: input.crews.map((crew) => ({
      crewInstanceId: crew.id,
      crewName: crew.displayName,
      captainParticipantId: crew.captainParticipantId,
      captainThreadId: crew.captainThreadId,
      brief: crew.brief,
      version: crew.version,
      createdAt: crew.createdAt,
      archivedAt: crew.archivedAt,
      playbook: crew.playbook == null ? null : { name: crew.playbook.name },
      roster: crew.members.map((member) => {
        const steps = member.playbookStepIds ?? [];
        return {
          seat: member.seatName,
          agentId: member.agentId,
          participantId: member.participantId,
          addedVersion: member.addedVersion,
          reason: member.reason,
          ...(steps.length === 0 ? {} : { steps }),
        };
      }),
      playbookRun: input.playbookRuns?.get(crew.id) ?? null,
    })),
  };
};

/**
 * The Roster read (SB6): every project with its active agents, placement parents, Crew seats,
 * and open Exchanges and delivery alarms. Runtime facts stay on the live shell stream.
 */
export const makeFleetRead = Effect.gen(function* () {
  const ledger = yield* A2ALedger;
  const placements = yield* ParticipantPlacementService;
  const crews = yield* AgentCrewInstanceService;
  const relay = yield* PlaybookCrewRelay;
  const sql = yield* SqlClient.SqlClient;
  return (includeRetired: boolean) =>
    Effect.gen(function* () {
      const projects = yield* ledger.listProjectLedgers();
      const result: Array<FleetResponse["projects"][number]> = [];
      const remoteDeliveryAlarms: NonNullable<FleetResponse["remoteDeliveryAlarms"]>[number][] = [];
      const participantsByProject = new Map<string, ReadonlyArray<ParticipantPlacementView>>();
      // Removed people keep their names on historical Exchange and delivery facts.
      const people = yield* sql<{ readonly person_id: string; readonly display_name: string }>`
        SELECT person_id, display_name FROM j5_a2a_human_person
        WHERE display_name IS NOT NULL
      `;
      const names = new Map(people.map((person) => [person.person_id, person.display_name]));
      for (const project of projects) {
        const participants = yield* placements.listParticipants(project.id);
        participantsByProject.set(project.id, participants);
        for (const row of participants) {
          if ("displayName" in row.participant && typeof row.participant.displayName === "string")
            names.set(row.participantId, row.participant.displayName);
        }
      }
      const agents = [...participantsByProject.values()]
        .flat()
        .filter((row) => row.threadId !== null);
      const threadIds = [
        ...new Set(agents.flatMap((row) => (row.threadId === null ? [] : [row.threadId]))),
      ];
      const threadNames = new Map<string, string>();
      for (const batch of clientReadBatches(threadIds)) {
        const titles = yield* sql<{ readonly thread_id: string; readonly title: string }>`
          SELECT thread_id, title FROM orchestration_v2_projection_threads
          WHERE thread_id IN ${sql.in(batch)}
        `;
        for (const row of titles) threadNames.set(row.thread_id, row.title);
      }
      for (const row of agents) {
        const title = row.threadId === null ? undefined : threadNames.get(row.threadId);
        if (title !== undefined) names.set(row.participantId, title);
      }
      for (const project of projects) {
        const participants = participantsByProject.get(project.id)!;
        const agentIds = participants
          .filter((row) => row.participant.kind === "agent")
          .map((row) => row.participantId);
        const outsideSpawnerIds = [
          ...new Set(
            participants.flatMap((row) =>
              row.provenance.kind === "spawned-by" &&
              isOutsideAgentParticipantId(row.provenance.spawnedByParticipantId)
                ? [row.provenance.spawnedByParticipantId]
                : [],
            ),
          ),
        ];
        const outsideAgentNames = new Map(
          (outsideSpawnerIds.length === 0
            ? []
            : yield* Effect.forEach(clientReadBatches(outsideSpawnerIds), (batch) =>
                outsideAgentNameRows(sql, batch),
              ).pipe(Effect.map((batches) => batches.flat()))
          ).map((row) => [row.participant_id, row.display_name] as const),
        );
        const ledgerFacts = yield* readFleetLedgerFacts(
          sql,
          project.id,
          agentIds,
          (id) => names.get(id) ?? outsideAgentNames.get(id) ?? null,
        );
        remoteDeliveryAlarms.push(...ledgerFacts.remoteDeliveryAlarms);
        const facts = new Map(
          agentIds.map((id) => [
            id,
            {
              asks: {
                owed: ledgerFacts.owed.get(id) ?? [],
                awaited: ledgerFacts.awaited.get(id) ?? [],
              },
              problems: ledgerFacts.problems.get(id) ?? [],
              deliveryEnvironmentIds: ledgerFacts.deliveryEnvironmentIds.get(id) ?? [],
            },
          ]),
        );
        const openAsks = new Map(agentIds.map((id) => [id, ledgerFacts.owed.get(id)?.length ?? 0]));
        // Retired Crews carry rosters and briefs; only the page that shows them pays for them.
        const projectCrews = (yield* crews.listForProject(project.id)).filter(
          (crew) => includeRetired || crew.archivedAt === null,
        );
        // Archiving a Crew cancels its run, so only live Crews can have one.
        const playbookRuns = new Map<string, J5Contracts.FleetCrew["playbookRun"]>();
        for (const crew of projectCrews)
          if (crew.archivedAt === null) playbookRuns.set(crew.id, yield* relay.fleetRun(crew.id));
        result.push(
          projectFleetProject({
            project,
            participants,
            crews: projectCrews,
            openAsks,
            facts,
            playbookRuns,
            outsideAgentNames,
          }),
        );
      }
      return {
        projects: result,
        remoteDeliveryAlarms,
        asOf: DateTime.formatIso(yield* DateTime.now),
      } satisfies FleetResponse;
    });
});
