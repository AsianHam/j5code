import { ThreadId } from "@t3tools/contracts";
import type { NativeQuestionInboxItem } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";

export const makeNativeQuestionInboxRead = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const crews = yield* AgentCrewInstanceService;

  return Effect.gen(function* () {
    // The shell read is cached upstream. Only threads with pending requests need records;
    // an idle fleet costs no per-thread projection reads.
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    const pending = new Set(
      snapshot.threads
        .filter(
          (thread) =>
            thread.pendingRuntimeRequest !== null &&
            thread.archivedAt === null &&
            thread.deletedAt === null &&
            !(
              thread.lineage.parentThreadId !== null &&
              thread.lineage.relationshipToParent === "subagent"
            ),
        )
        .map((thread) => thread.id),
    );
    if (pending.size === 0) return [];
    const candidates = yield* sql<{ readonly thread_id: string; readonly project_id: string }>`
      SELECT m.thread_id, m.project_id
      FROM j5_a2a_membership m
      JOIN j5_a2a_participant_placement p
        ON p.project_id = m.project_id AND p.participant_id = m.participant_id
      WHERE m.archived_at IS NULL AND m.thread_id IS NOT NULL
        AND m.thread_id IN ${sql.in([...pending])}
        AND p.provenance_kind = 'spawned-by' AND p.provenance_source = 'j5_spawn'
    `;
    const memberships = yield* crews.listInvolving({
      threadIds: candidates.map((row) => ThreadId.make(row.thread_id)),
      participantIds: [],
    });
    const live = yield* crews.listLive();
    const captains = new Set(live.map((crew) => crew.captainThreadId));
    const perThread = yield* Effect.forEach(
      candidates,
      (row) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(row.thread_id);
          if (captains.has(threadId)) return [];
          const seats = memberships.filter((crew) =>
            crew.members.some((member) => member.threadId === threadId),
          );
          const crew = seats.find((entry) => entry.archivedAt === null);
          if (seats.length > 0 && crew === undefined) return [];
          const records = yield* threads.getThreadRecords(threadId, ["runtimeRequests"]);
          if (records.thread.archivedAt !== null || records.thread.deletedAt !== null) return [];
          return records.runtimeRequests.flatMap((request): Array<NativeQuestionInboxItem> => {
            if (
              request.kind !== "user_input" ||
              request.status !== "pending" ||
              (request.responseCapability.type !== "live" &&
                request.responseCapability.type !== "message")
            )
              return [];
            return [
              {
                threadId,
                requestId: request.id,
                projectId: row.project_id,
                threadTitle: records.thread.title,
                createdAt: DateTime.formatIso(request.createdAt),
                responseCapability: request.responseCapability.type,
                ...(crew === undefined
                  ? {}
                  : {
                      crew: {
                        name: crew.displayName,
                        seat: crew.members.find((member) => member.threadId === threadId)!.seatName,
                      },
                    }),
              },
            ];
          });
        }),
      { concurrency: 8 },
    );
    return perThread.flat().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
});
