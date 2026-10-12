import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as J5Contracts from "@t3tools/contracts/j5";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { authenticateClientRead, invalidRequest, jsonBody } from "./ClientReadsHttp.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId } from "./contracts.ts";

export const CLIENT_READS_SPAWNED_CHILDREN_PATH = "/api/j5/a2a/client-reads/spawned-children";

const AGENT_PARTICIPANT_PREFIX = "agent:j5:a2a:";

/** The inverse of `participantIdForThread`; non-thread participants (humans) yield null. */
export const threadIdForParticipant = (participantId: string): ThreadId | null =>
  participantId.startsWith(AGENT_PARTICIPANT_PREFIX)
    ? ThreadId.make(participantId.slice(AGENT_PARTICIPANT_PREFIX.length))
    : null;

// Shared with the clients through the J5 contract so encode and decode cannot drift.
export const SpawnedChild = J5Contracts.SpawnedChild;
export const SpawnedChildrenRequest = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(500)),
});
export const SpawnedChildrenResponse = J5Contracts.SpawnedChildrenResponse;
export type SpawnedChildrenResponse = typeof SpawnedChildrenResponse.Type;

const decodeRequest = Schema.decodeUnknownEffect(SpawnedChildrenRequest);
const encodeResponse = Schema.encodeEffect(SpawnedChildrenResponse);

interface PlacementRow {
  readonly participant_id: string;
  readonly placement_parent_id: string;
}

/** A roster seat's ledger row, when it has one: its membership and where it is placed. */
export interface RecordedSeat {
  readonly archived: boolean;
  readonly placementParentId: string | null;
}

/**
 * Pure projection: placement rows keyed by parent, annotated with live Crew seats. A Captain's
 * row also carries every seat on its live rosters that no parent holds (reserved but never
 * created, or registered and not yet placed), so a Crew never under-counts or vanishes while its
 * seats are unknown; the client shows those as unknown. A seat whose membership was archived,
 * or that is placed under another parent, is not added here. Parents without children get no
 * entry.
 */
export const projectSpawnedChildren = (
  threadIds: ReadonlyArray<ThreadId>,
  rows: ReadonlyArray<PlacementRow>,
  crews: ReadonlyArray<AgentCrewInstance>,
  recordedSeats: ReadonlyMap<string, RecordedSeat> = new Map(),
  spawnedParticipantIds: ReadonlySet<string> = new Set(),
): SpawnedChildrenResponse => {
  const seats = new Map<string, NonNullable<typeof SpawnedChild.Type.seat>>();
  const live = crews.filter((crew) => crew.archivedAt === null);
  for (const crew of live) {
    for (const member of crew.members)
      seats.set(member.participantId, {
        crewInstanceId: crew.id,
        crewName: crew.displayName,
        seat: member.seatName,
      });
  }
  const entries: Array<SpawnedChildrenResponse["entries"][number]> = [];
  for (const threadId of new Set(threadIds)) {
    const parentId = participantIdForThread(threadId);
    const children = rows.flatMap((row) => {
      if (row.placement_parent_id !== parentId) return [];
      const childThreadId = threadIdForParticipant(row.participant_id);
      return childThreadId === null
        ? []
        : [
            {
              threadId: childThreadId,
              participantId: ParticipantId.make(row.participant_id),
              seat: seats.get(row.participant_id) ?? null,
            },
          ];
    });
    const placed = new Set(children.map((child) => child.participantId as string));
    for (const crew of live) {
      if (crew.captainParticipantId !== parentId) continue;
      for (const member of crew.members) {
        if (placed.has(member.participantId)) continue;
        const recorded = recordedSeats.get(member.participantId);
        if (recorded !== undefined && (recorded.archived || recorded.placementParentId !== null))
          continue;
        children.push({
          threadId: member.threadId,
          participantId: member.participantId,
          seat: seats.get(member.participantId) ?? null,
        });
      }
    }
    if (children.length > 0) entries.push({ threadId, children });
  }
  return {
    entries,
    spawnedByAgent: [...new Set(threadIds)].filter((threadId) =>
      spawnedParticipantIds.has(participantIdForThread(threadId)),
    ),
  };
};

/**
 * Sidebar discovery read: the agents placed directly under each visible thread, so a Captain's
 * (or any spawner's) row can expand into the work it started. Placement is the J5 org tree;
 * upstream lineage children (subagents, forks) are not included here. It also says which of the
 * visible threads an agent spawned, which is what moves a row under its spawner.
 */
export const makeSpawnedChildrenHttpRouteLayer = (path: HttpRouter.PathInput) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const crews = yield* AgentCrewInstanceService;
      return HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.clientReads.spawnedChildren");
          yield* authenticateClientRead;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeRequest(body.success));
          if (Result.isFailure(decoded))
            return invalidRequest("threadIds must be an array of at most 500 thread ids.");
          const threadIds = decoded.success.threadIds;
          const read = yield* Effect.result(
            Effect.gen(function* () {
              if (threadIds.length === 0)
                return { entries: [], spawnedByAgent: [] } satisfies SpawnedChildrenResponse;
              const parentIds = [...new Set(threadIds.map(participantIdForThread))];
              // Retired children leave the expander as they leave the Fleet page: a membership
              // stamped archived_at (reversible archive) is not a live child.
              const rows = yield* sql<PlacementRow>`
                SELECT p.participant_id, p.placement_parent_id
                FROM j5_a2a_participant_placement p
                JOIN j5_a2a_membership m
                  ON m.project_id = p.project_id AND m.participant_id = p.participant_id
                WHERE p.placement_parent_id IN ${sql.in(parentIds)} AND m.archived_at IS NULL
              `;
              const childThreadIds = rows.flatMap((row) => {
                const id = threadIdForParticipant(row.participant_id);
                return id === null ? [] : [id];
              });
              // Crews the requested rows sit in or command: a Captain's roster may name seats
              // that have no placement row yet.
              const involved = yield* crews.listInvolving({
                threadIds: childThreadIds,
                participantIds: parentIds,
              });
              const rosterIds = [
                ...new Set(
                  involved
                    .filter(
                      (crew) =>
                        crew.archivedAt === null && parentIds.includes(crew.captainParticipantId),
                    )
                    .flatMap((crew) => crew.members.map((member) => member.participantId)),
                ),
              ];
              const recorded =
                rosterIds.length === 0
                  ? []
                  : yield* sql<{
                      readonly participant_id: string;
                      readonly archived_at: string | null;
                      readonly placement_parent_id: string | null;
                    }>`
                      SELECT m.participant_id, m.archived_at, p.placement_parent_id
                      FROM j5_a2a_membership m
                      LEFT JOIN j5_a2a_participant_placement p
                        ON p.project_id = m.project_id AND p.participant_id = m.participant_id
                      WHERE m.participant_id IN ${sql.in(rosterIds)}
                    `;
              // The sidebar's membership rule: a row an agent spawned leaves the top level, to
              // sit under its spawner. One spawned into another project has no parent in its own
              // project's tree, so it stays at the top level, where it can be found.
              const spawned = yield* sql<{ readonly participant_id: string }>`
                SELECT participant_id
                FROM j5_a2a_participant_placement
                WHERE participant_id IN ${sql.in(parentIds)}
                  AND provenance_kind = 'spawned-by'
                  AND placement_parent_id IS NOT NULL
              `;
              return projectSpawnedChildren(
                threadIds,
                rows,
                involved,
                new Map(
                  recorded.map((row) => [
                    row.participant_id,
                    {
                      archived: row.archived_at !== null,
                      placementParentId: row.placement_parent_id,
                    },
                  ]),
                ),
                new Set(spawned.map((row) => row.participant_id)),
              );
            }).pipe(Effect.flatMap(encodeResponse)),
          );
          if (Result.isFailure(read)) {
            yield* Effect.logError("J5 spawned-children read failed", { cause: read.failure });
            return HttpServerResponse.jsonUnsafe(
              { error: "SpawnedChildrenReadError", message: "Spawned children read failed." },
              { status: 500 },
            );
          }
          return HttpServerResponse.jsonUnsafe(read.success);
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      );
    }),
  );

export const spawnedChildrenHttpRouteLayer = makeSpawnedChildrenHttpRouteLayer(
  CLIENT_READS_SPAWNED_CHILDREN_PATH,
);
