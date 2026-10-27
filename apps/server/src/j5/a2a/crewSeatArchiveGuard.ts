import type { OrchestrationV2Command, ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";

/**
 * A Crew member is never archived or deleted alone (Crews AC16); the unit retires through Archive
 * crew, `j5_archive_crew`, or its Captain's archive. Every client archive is one `dispatchCommand`,
 * so this check on that handler covers every door, and the organize MCP tool applies it too. The
 * unit paths archive seats through the lifecycle service, not this handler.
 */
export class CrewSeatArchivedAloneError extends Data.TaggedError("CrewSeatArchivedAloneError")<{
  readonly threadId: string;
  readonly action: "archive" | "delete";
  readonly seatName: string;
  readonly crewName: string;
  readonly crewInstanceId: string;
}> {
  override get message(): string {
    return `This thread is seat ${this.seatName} of Crew ${this.crewName}. Crew members are never ${this.action === "archive" ? "archived" : "deleted"} one by one; retire the whole Crew with Archive crew on the Fleet page, or message the member instead.`;
  }
}

const guardedTarget = (
  command: OrchestrationV2Command,
): { readonly action: "archive" | "delete"; readonly threadId: ThreadId } | null =>
  command.type === "thread.archive"
    ? { action: "archive", threadId: command.threadId }
    : command.type === "thread.delete"
      ? { action: "delete", threadId: command.threadId }
      : null;

export type CrewSeatArchiveGuard = (
  command: OrchestrationV2Command,
) => Effect.Effect<void, CrewSeatArchivedAloneError>;

/**
 * Resolves the Crew store once and returns the per-command check. A store that cannot be read
 * never blocks the person's archive: the check logs and lets the command through, because a
 * refusal must rest on a live fact, not on an outage.
 */
export const makeCrewSeatArchiveGuard: Effect.Effect<
  CrewSeatArchiveGuard,
  never,
  AgentCrewInstanceService
> = Effect.gen(function* () {
  const crews = yield* AgentCrewInstanceService;
  return Effect.fn("j5.a2a.crewSeatArchiveGuard")(function* (command: OrchestrationV2Command) {
    const target = guardedTarget(command);
    if (target === null) return;
    const seat = yield* Effect.gen(function* () {
      const membership = yield* crews.findMembership(participantIdForThread(target.threadId));
      if (membership === null) return null;
      const instance = yield* crews.read(membership.crewInstanceId);
      return instance === null || instance.archivedAt !== null
        ? null
        : {
            seatName: membership.seatName,
            crewName: instance.displayName,
            crewInstanceId: instance.id,
          };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("J5 crew seat archive guard could not read the Crew; allowing", {
          threadId: target.threadId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (seat === null) return;
    return yield* new CrewSeatArchivedAloneError({ ...target, ...seat });
  });
});
