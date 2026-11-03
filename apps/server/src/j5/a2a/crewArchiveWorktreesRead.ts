import type { CrewArchiveWorktreeEstimate } from "@t3tools/contracts/j5";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { CrewWorktrees } from "./CrewWorktrees.ts";

/** An estimate with the Captain's thread it belongs to, so a narrowed reader sees only their own. */
export type CrewArchiveWorktreeRead = CrewArchiveWorktreeEstimate & {
  readonly captainThreadId: ThreadId;
};

/**
 * What archiving these live Crews would do with the worktrees J5 created for their seats, read
 * for the dialog that confirms the archive: the sidebar's, when a Captain with Crews is archived,
 * and Fleet's Archive crew. A Crew that is unknown or already retired has nothing to say.
 * Changes nothing, and is an estimate: the archive checks again when it runs.
 */
export const makeCrewArchiveWorktreesRead = Effect.gen(function* () {
  const crews = yield* AgentCrewInstanceService;
  const worktrees = yield* CrewWorktrees;
  return Effect.fn("j5.a2a.crewArchiveWorktrees.read")(function* (
    crewInstanceIds: ReadonlyArray<string>,
  ) {
    const instances = yield* Effect.forEach([...new Set(crewInstanceIds)], (id) => crews.read(id), {
      concurrency: 1,
    });
    const live = instances.flatMap((instance) =>
      instance === null || instance.archivedAt !== null ? [] : [instance],
    );
    const estimates = yield* worktrees.estimate({
      crews: live.map((instance) => ({
        crewInstanceId: instance.id,
        seats: instance.members.map((member) => ({
          seatName: member.seatName,
          threadId: member.threadId,
        })),
      })),
    });
    const captainOf = new Map(live.map((instance) => [instance.id, instance.captainThreadId]));
    return estimates.flatMap((estimate): Array<CrewArchiveWorktreeRead> => {
      const captainThreadId = captainOf.get(estimate.crewInstanceId);
      return captainThreadId === undefined ? [] : [{ ...estimate, captainThreadId }];
    });
  });
});
