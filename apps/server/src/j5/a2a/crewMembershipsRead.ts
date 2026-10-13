import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as J5Contracts from "@t3tools/contracts/j5";

import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";

export type ThreadCrewMembership = J5Contracts.ThreadCrewMembership;
export type CrewMembershipsResponse = typeof J5Contracts.CrewMembershipsResponse.Type;

const crewRef = (instance: AgentCrewInstance) => ({
  crewInstanceId: instance.id,
  crewName: instance.displayName,
});

/**
 * Pure projection: every requested thread that is a live member or a Captain gets one entry;
 * threads outside any Crew get none. A live member's entry wins over a captain's, since a member
 * cannot launch; a retired Crew's seat is a plain agent again, so its old membership never hides
 * the Crews that agent now commands.
 */
export const projectCrewMemberships = (
  threadIds: ReadonlyArray<ThreadId>,
  instances: ReadonlyArray<AgentCrewInstance>,
): CrewMembershipsResponse => {
  const entries: Array<CrewMembershipsResponse["entries"][number]> = [];
  for (const threadId of new Set(threadIds)) {
    const participantId = participantIdForThread(threadId);
    let member: ThreadCrewMembership | undefined;
    const commanded: Array<ReturnType<typeof crewRef>> = [];
    for (const instance of instances) {
      const seat =
        instance.archivedAt === null
          ? instance.members.find((candidate) => candidate.threadId === threadId)
          : undefined;
      if (seat !== undefined)
        member = { kind: "member", seat: seat.seatName, crew: crewRef(instance) };
      if (instance.archivedAt === null && instance.captainParticipantId === participantId)
        commanded.push(crewRef(instance));
    }
    if (member !== undefined) entries.push({ threadId, membership: member });
    else if (commanded.length > 0)
      entries.push({ threadId, membership: { kind: "captain", crews: commanded } });
  }
  return { entries };
};

/** The Sidebar's crew chips: which of the visible threads sit in, or command, a live Crew. */
export const makeCrewMembershipsRead = Effect.gen(function* () {
  const crews = yield* AgentCrewInstanceService;
  return (threadIds: ReadonlyArray<ThreadId>) =>
    crews
      .listInvolving({ threadIds, participantIds: threadIds.map(participantIdForThread) })
      .pipe(Effect.map((instances) => projectCrewMemberships(threadIds, instances)));
});
