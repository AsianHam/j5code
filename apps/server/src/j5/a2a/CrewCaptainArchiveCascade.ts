import type {
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { threadShellFromProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { isAutoSettlementCandidate } from "../../orchestration-v2/ThreadSettlementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { crewSeatRequestKey, lifecycleCommandId } from "./spawnIds.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";

const CASCADE_SESSION = "j5-captain-archive-cascade";

export interface CrewCaptainArchiveCascadeShape {
  /**
   * When a Captain's lifecycle event commits, carry its Crews with it: archive or delete retires
   * its live Crews as units, unarchive brings back the Crews its archive retired, and settle or
   * unsettle does the same to every seat of its live Crews. Returns the ids of the Crews it acted
   * on, or null when the event was not a Captain's.
   */
  readonly handleStoredEvent: (
    stored: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ReadonlyArray<string> | null>;
  /**
   * The boot sweep, for an archive or delete the stream missed while the server was down: retire
   * live Crews whose Captain is archived or gone. Returns the ids of the Crews it retired.
   */
  readonly reconcile: Effect.Effect<ReadonlyArray<string>>;
}

export class CrewCaptainArchiveCascade extends Context.Service<
  CrewCaptainArchiveCascade,
  CrewCaptainArchiveCascadeShape
>()("t3/j5/a2a/CrewCaptainArchiveCascade") {}

/**
 * Whether a Captain's settle carries this seat: only if upstream's `isAutoSettlementCandidate`
 * would let auto-settle take it, read through the sweep's own shell derivation. The auto-settle
 * opt-out and an unsettle's "active" override are exceptions: they hold off only automatic
 * settling, not a person's explicit Captain settle (register D14).
 */
const seatFollowsCaptainSettle = (projection: OrchestrationV2ThreadProjection, nowMs: number) => {
  const shell = threadShellFromProjection(projection);
  return isAutoSettlementCandidate(
    {
      ...shell,
      autoSettleDisabledAt: null,
      settledOverride: shell.settledOverride === "active" ? null : shell.settledOverride,
    },
    nowMs,
  );
};

/**
 * A Crew never outlives its Captain (Crews AC17). Upstream's command has committed when J5 sees it,
 * from any door, so this reactor carries the Crews along: an archive retires them as units, stamped
 * so the unarchive restores them; settle and unsettle go to each seat. Command ids derive from
 * Captain, Crew, seat and occurrence, so replays converge. A failed Crew is logged, skipped.
 */
export const layer = Layer.effect(
  CrewCaptainArchiveCascade,
  Effect.gen(function* () {
    const crews = yield* AgentCrewInstanceService;
    const archives = yield* ArchiveCrewService;
    const threads = yield* ThreadManagementService;

    const retire = Effect.fn("j5.a2a.captainArchiveCascade.retire")(function* (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      occurrence: string,
    ) {
      const requestKey = `${captainThreadId}:${instance.id}:${occurrence}`;
      const archivedAt = DateTime.formatIso(yield* DateTime.now);
      const outcome = yield* archives.archive({
        providerSessionId: CASCADE_SESSION,
        callerParticipantId: null,
        projectId: instance.projectId,
        crewInstanceId: instance.id,
        clientRequestKey: requestKey,
        confirmationSatisfied: true,
        archivedAt,
        withCaptain: true,
        commandIds: (seatName) => ({
          interruptCommandId: lifecycleCommandId({
            providerSessionId: CASCADE_SESSION,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-interrupt",
          }),
          archiveCommandId: lifecycleCommandId({
            providerSessionId: CASCADE_SESSION,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-thread",
          }),
        }),
      });
      yield* Effect.logInfo("J5 Captain archived; its Crew retired as a unit", {
        captainThreadId,
        crewInstanceId: instance.id,
        status: outcome.status,
      });
    });

    /** Run one Crew's step once; a failure is logged and reads as not acted on. */
    const once = <E>(
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      step: Effect.Effect<void, E>,
    ) =>
      step.pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Captain lifecycle cascade failed for a Crew", {
            captainThreadId,
            crewInstanceId: instance.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

    const seatCommandId = (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      seatName: string,
      operation: string,
      occurrence: string,
    ) =>
      lifecycleCommandId({
        providerSessionId: CASCADE_SESSION,
        requestKey: crewSeatRequestKey(`${captainThreadId}:${instance.id}:${occurrence}`, seatName),
        operation,
      });

    /**
     * Settle or unsettle every seat of one live Crew that is not already there. Settle skips a
     * seat upstream's auto-settle would leave alone (see `seatFollowsCaptainSettle`). Unsettle
     * only reaches seats that are settled, so a seat that never settled keeps upstream's automatic
     * settlement. A seat whose thread was never created, or an archived one, is left alone.
     */
    const moveSeats = Effect.fn("j5.a2a.captainArchiveCascade.moveSeats")(function* (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      to: "settle" | "unsettle",
      occurrence: string,
    ) {
      let moved = false;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      for (const member of instance.members) {
        const seat = yield* getThreadProjectionIfPresent(threads, member.threadId);
        if (seat === null || seat.thread.archivedAt !== null) continue;
        const settled = seat.thread.settledOverride === "settled";
        if (to === "settle" ? !seatFollowsCaptainSettle(seat, nowMs) : !settled) continue;
        const commandId = seatCommandId(
          captainThreadId,
          instance,
          member.seatName,
          `captain-${to}`,
          occurrence,
        );
        const command: OrchestrationV2Command =
          to === "settle"
            ? { type: "thread.settle", commandId, threadId: member.threadId }
            : { type: "thread.unsettle", commandId, threadId: member.threadId, reason: "user" };
        yield* threads.dispatch(command);
        moved = true;
      }
      if (moved)
        yield* Effect.logInfo(`J5 Captain ${to}d; its Crew's seats followed`, {
          captainThreadId,
          crewInstanceId: instance.id,
        });
    });

    /**
     * Bring back a Crew that retired with its Captain: unarchive each archived seat (the lifecycle
     * reactor restores its agent), then clear the Crew's stamp last, so a restore cut short leaves
     * it retired and archiving and unarchiving the Captain again resumes it.
     */
    const restore = Effect.fn("j5.a2a.captainArchiveCascade.restore")(function* (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      occurrence: string,
    ) {
      yield* crews.serialize(
        instance.id,
        Effect.gen(function* () {
          for (const member of instance.members) {
            const seat = yield* getThreadProjectionIfPresent(threads, member.threadId);
            if (seat === null || seat.thread.archivedAt === null) continue;
            yield* threads.dispatch({
              type: "thread.unarchive",
              commandId: seatCommandId(
                captainThreadId,
                instance,
                member.seatName,
                "captain-unarchive",
                occurrence,
              ),
              threadId: member.threadId,
            });
          }
          yield* crews.restoreWithCaptain(instance.id);
        }),
      );
      yield* Effect.logInfo("J5 Captain unarchived; its Crew came back with it", {
        captainThreadId,
        crewInstanceId: instance.id,
      });
    });

    const commandedBy = Effect.fn("j5.a2a.captainArchiveCascade.commandedBy")(function* (
      threadId: ThreadId,
    ) {
      // Placement and membership rows may already be gone for a deleted thread; the Crew
      // record names its Captain's thread directly, so the lookup needs no home.
      const involving = yield* crews.listInvolving({
        threadIds: [threadId],
        participantIds: [participantIdForThread(threadId)],
      });
      return involving.filter((instance) => instance.captainThreadId === threadId);
    });

    const handleStoredEvent: CrewCaptainArchiveCascadeShape["handleStoredEvent"] = Effect.fn(
      "j5.a2a.captainArchiveCascade.handleStoredEvent",
    )(
      function* (stored) {
        const event = stored.event;
        const threadId = event.threadId;
        const occurrence = String(event.id);
        const acted: Array<string> = [];
        switch (event.type) {
          case "thread.archived":
          case "thread.deleted": {
            const live = (yield* commandedBy(threadId)).filter(
              (instance) => instance.archivedAt === null,
            );
            if (live.length === 0) return null;
            for (const instance of live)
              if (yield* once(threadId, instance, retire(threadId, instance, occurrence)))
                acted.push(instance.id);
            return acted;
          }
          case "thread.unarchived": {
            const retired = yield* crews.listRetiredWithCaptain(threadId);
            if (retired.length === 0) return null;
            for (const instance of retired)
              if (yield* once(threadId, instance, restore(threadId, instance, occurrence)))
                acted.push(instance.id);
            return acted;
          }
          case "thread.settled":
          case "thread.unsettled": {
            const live = (yield* commandedBy(threadId)).filter(
              (instance) => instance.archivedAt === null,
            );
            if (live.length === 0) return null;
            const to = event.type === "thread.settled" ? "settle" : "unsettle";
            for (const instance of live)
              if (yield* once(threadId, instance, moveSeats(threadId, instance, to, occurrence)))
                acted.push(instance.id);
            return acted;
          }
          default:
            return null;
        }
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("J5 Captain lifecycle cascade skipped", { cause }).pipe(Effect.as(null)),
      ),
    );

    /**
     * When the Captain's thread was archived or deleted, as an ISO timestamp; null while it is
     * live. A deleted thread keeps its projection with `deletedAt` set, so both read as facts; a
     * projection that cannot be read is the store's problem, and the sweep leaves that Captain's
     * Crews alone this pass.
     */
    const captainGoneAt = Effect.fn("j5.a2a.captainArchiveCascade.captainGoneAt")(function* (
      instance: AgentCrewInstance,
    ) {
      const read = yield* Effect.result(threads.getThreadProjection(instance.captainThreadId));
      if (Result.isFailure(read)) {
        yield* Effect.logWarning("J5 Captain archive sweep could not read a Captain thread", {
          captainThreadId: instance.captainThreadId,
          crewInstanceId: instance.id,
          cause: read.failure,
        });
        return null;
      }
      const goneAt = read.success.thread.deletedAt ?? read.success.thread.archivedAt;
      return goneAt === null ? null : DateTime.formatIso(goneAt);
    });

    const reconcile: CrewCaptainArchiveCascadeShape["reconcile"] = Effect.gen(function* () {
      const retired: Array<string> = [];
      for (const instance of yield* crews.listLive()) {
        // A defect while reading one Captain skips that Crew, not the sweep.
        const goneAt = yield* captainGoneAt(instance).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Captain archive sweep could not read a Captain thread", {
              captainThreadId: instance.captainThreadId,
              crewInstanceId: instance.id,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        if (goneAt === null) continue;
        // The Captain's archive time names this occurrence, so a Captain archived again after an
        // unarchive gets fresh command ids. One Crew's failed retirement is logged and left for
        // the next boot; the sweep still reaches every other orphaned Crew.
        const occurrence = `sweep:${goneAt}`;
        const captain = instance.captainThreadId;
        if (yield* once(captain, instance, retire(captain, instance, occurrence)))
          retired.push(instance.id);
      }
      if (retired.length > 0)
        yield* Effect.logInfo("J5 Captain archive sweep retired orphaned Crews", { retired });
      return retired;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("J5 Captain archive sweep failed", { cause }).pipe(Effect.as([])),
      ),
    );

    return CrewCaptainArchiveCascade.of({ handleStoredEvent, reconcile });
  }),
);
