import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type {
  PreArchiveCrewSeat,
  PreArchiveFacts,
  PreArchiveLiveCrew,
} from "@t3tools/contracts/j5";

import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService, type ArchiveCrewCaptainFacts } from "./ArchiveCrewService.ts";
import { A2AArchiveFacts, type ThreadPreArchiveFacts } from "./ArchiveFactsService.ts";
import type { ParticipantId } from "./contracts.ts";

/** What the dialog shows for a Crew the archived agent commands: each seat's consequences. */
const projectLiveCrew = (entry: ArchiveCrewCaptainFacts): PreArchiveLiveCrew => ({
  crewInstanceId: entry.instance.id,
  crewName: entry.instance.displayName,
  seats: entry.facts.members.map((member) => ({
    seat: member.seatName,
    participantId: member.participantId,
    runningTurn: member.facts.runningTurn !== null,
    openAsks: member.facts.openExchanges.length,
  })),
});

/**
 * AR2's human-facing read; it performs no archive mutation. A registered agent's
 * facts carry its Crew relations, because a Captain is never archived alone and a seat is never
 * archived one by one (Crews AC16, AC17): `liveCrews` are the Crews it commands, seat by seat,
 * which the lifecycle cascade retires as units when the archive commits, and `crewSeat` is the
 * seat it holds, which the web refuses to archive alone up front (the server's dispatch guard,
 * `crewSeatArchiveGuard.ts`, refuses it for every door). A failed Crew read is `null`, shown as
 * "couldn't check", never as no Crews.
 */
export const makePreArchiveFactsRead = Effect.gen(function* () {
  const archiveFacts = yield* A2AArchiveFacts;
  const archiveCrews = yield* ArchiveCrewService;
  const crews = yield* AgentCrewInstanceService;
  const readCrewSeat = (participantId: ParticipantId): Effect.Effect<PreArchiveCrewSeat | null> =>
    Effect.gen(function* () {
      const membership = yield* crews.findMembership(participantId);
      if (membership === null) return null;
      const instance = yield* crews.read(membership.crewInstanceId);
      if (instance === null || instance.archivedAt !== null) return null;
      return {
        crewInstanceId: instance.id,
        crewName: instance.displayName,
        seat: membership.seatName,
      };
    }).pipe(Effect.orElseSucceed(() => null));
  const withLiveCrews = (facts: ThreadPreArchiveFacts): Effect.Effect<PreArchiveFacts> => {
    if (facts.state !== "registered") return Effect.succeed(facts);
    const { archived: _archived, ...registered } = facts;
    return Effect.all({
      liveCrews: archiveCrews
        .readCaptainFacts({
          projectId: facts.projectId,
          captainParticipantId: facts.participantId,
        })
        .pipe(
          Effect.map((entries) => entries.map(projectLiveCrew)),
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 A2A pre-archive crew read failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
      crewSeat: readCrewSeat(facts.participantId),
    }).pipe(Effect.map((crewFacts) => ({ ...registered, ...crewFacts })));
  };
  return (threadId: ThreadId) =>
    archiveFacts.readForThread(threadId).pipe(Effect.flatMap(withLiveCrews));
});
