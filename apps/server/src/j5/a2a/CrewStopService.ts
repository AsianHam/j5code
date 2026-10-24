import type { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  latestActiveRun,
  ThreadManagementService,
} from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewMember } from "./AgentCrewInstanceService.ts";
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";
import type { ParticipantId, LedgerProjectId } from "./contracts.ts";
import { AGENT_STOP_REASON, stopThread } from "./stopThread.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";

/** `never_created`: the seat's row was recorded but its thread never came to exist. */
export type CrewSeatStopResult =
  | "interrupt_requested"
  | "already_idle"
  | "archived"
  | "never_created";

export interface StopCrewInput {
  /** The Captain calling over MCP, or null when a person stops the Crew from the app. */
  readonly callerParticipantId: ParticipantId | null;
  /** The caller's project when an agent calls; the Crew must live there. */
  readonly projectId: LedgerProjectId | null;
  readonly crewInstanceId: string;
  /** Deterministic per seat so a retried stop cannot stop twice. */
  readonly commandIds: (seatName: string) => { readonly interruptCommandId: CommandId };
}

export interface StopCrewOutcome {
  readonly crewInstanceId: string;
  readonly members: ReadonlyArray<{
    readonly seatName: string;
    readonly participantId: ParticipantId;
    readonly result: CrewSeatStopResult;
  }>;
}

export class CrewStopNotFoundError extends Data.TaggedError("CrewStopNotFoundError")<{
  readonly crewInstanceId: string;
}> {
  override get message() {
    return `Crew ${this.crewInstanceId} does not exist.`;
  }
}

export class CrewStopRequestError extends Data.TaggedError("CrewStopRequestError")<{
  readonly detail: string;
  readonly nextStep: string;
}> {
  override get message() {
    return this.detail;
  }
}

export class CrewStopOperationError extends Data.TaggedError("CrewStopOperationError")<{
  readonly phase: string;
  readonly seatName: string | null;
  readonly cause: unknown;
}> {
  override get message() {
    return `Stopping the crew failed while ${this.phase}${this.seatName === null ? "" : ` (seat ${this.seatName})`}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export type CrewStopError = CrewStopNotFoundError | CrewStopRequestError | CrewStopOperationError;

export interface CrewStopServiceShape {
  /**
   * Stop every seat the way upstream's Stop does (`thread.stop`: the running turn is interrupted,
   * its queue held, its delegated tasks stopped); nothing settles or archives, and the Crew stays
   * live so any seat can be messaged again. Only the Captain or a
   * person may stop a Crew: stopping is a controller's act, and a member owns nothing about its
   * crewmates' turns (Bryant, 2026-09-14).
   */
  readonly stop: (input: StopCrewInput) => Effect.Effect<StopCrewOutcome, CrewStopError>;
}

export class CrewStopService extends Context.Service<CrewStopService, CrewStopServiceShape>()(
  "t3/j5/a2a/CrewStopService",
) {}

export const layer = Layer.effect(
  CrewStopService,
  Effect.gen(function* () {
    const crews = yield* AgentCrewInstanceService;
    const threads = yield* ThreadManagementService;
    const archiveFacts = yield* A2AArchiveFacts;

    const seatError = (phase: string, seatName: string) => (cause: unknown) =>
      new CrewStopOperationError({ phase, seatName, cause });

    /**
     * A seat's projection, or null when its thread provably never came to exist: the store
     * answers not-found and no home was ever registered for it. Held under the Crew's unit lock,
     * so no launch or addition is creating it meanwhile. A store that cannot answer, or a home
     * with no thread behind it, fails the stop rather than skipping a seat that may be live.
     */
    const readSeat = Effect.fn("j5.a2a.crewStop.readSeat")(function* (member: AgentCrewMember) {
      const projection = yield* getThreadProjectionIfPresent(threads, member.threadId).pipe(
        Effect.mapError(seatError("reading a seat", member.seatName)),
      );
      if (projection !== null) return projection;
      const home = yield* archiveFacts
        .readForThread(member.threadId)
        .pipe(Effect.mapError(seatError("reading a seat's home", member.seatName)));
      if (home.state === "not-an-a2a-participant") return null;
      return yield* seatError(
        "reading a seat",
        member.seatName,
      )(new Error(`seat thread ${member.threadId} has a home but no thread`));
    });

    // Under the Crew's unit lock, like archive, so a seat mid-spawn is never read as missing.
    const stop: CrewStopServiceShape["stop"] = (input) =>
      Effect.gen(function* () {
        const instance = yield* crews
          .read(input.crewInstanceId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new CrewStopOperationError({ phase: "reading the crew", seatName: null, cause }),
            ),
          );
        if (instance === null)
          return yield* new CrewStopNotFoundError({ crewInstanceId: input.crewInstanceId });
        if (input.projectId !== null && instance.projectId !== input.projectId)
          return yield* new CrewStopRequestError({
            detail: `Crew ${instance.id} lives in project ${instance.projectId}, and the caller is in project ${input.projectId}.`,
            nextStep: "A Captain stops a Crew from the Crew's own project.",
          });
        if (
          input.callerParticipantId !== null &&
          instance.captainParticipantId !== input.callerParticipantId
        )
          return yield* new CrewStopRequestError({
            detail: `Crew ${instance.id} is commanded by ${instance.captainParticipantId}; only its Captain or the human may stop it.`,
            nextStep:
              "Ask the Captain with j5_send_message, or stop one agent you command with j5_stop_agent.",
          });
        if (instance.archivedAt !== null)
          return yield* new CrewStopRequestError({
            detail: `Crew ${instance.id} was archived at ${instance.archivedAt}; there is nothing running to stop.`,
            nextStep: "Nothing to do.",
          });
        const members = yield* Effect.forEach(
          instance.members,
          (member) =>
            Effect.gen(function* () {
              const projection = yield* readSeat(member);
              if (projection === null)
                return {
                  seatName: member.seatName,
                  participantId: member.participantId,
                  result: "never_created" as const,
                };
              if (projection.thread.archivedAt !== null)
                return {
                  seatName: member.seatName,
                  participantId: member.participantId,
                  result: "archived" as const,
                };
              yield* stopThread(threads, {
                commandId: input.commandIds(member.seatName).interruptCommandId,
                threadId: member.threadId,
                // A person's stop keeps upstream's "Stopped by user".
                ...(input.callerParticipantId === null ? {} : { reason: AGENT_STOP_REASON }),
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new CrewStopOperationError({
                      phase: "stopping a seat",
                      seatName: member.seatName,
                      cause,
                    }),
                ),
              );
              return {
                seatName: member.seatName,
                participantId: member.participantId,
                result:
                  latestActiveRun(projection) === undefined
                    ? ("already_idle" as const)
                    : ("interrupt_requested" as const),
              };
            }),
          { concurrency: 1 },
        );
        return { crewInstanceId: instance.id, members };
      }).pipe((unit) => crews.serialize(input.crewInstanceId, unit));

    return CrewStopService.of({ stop });
  }),
);
