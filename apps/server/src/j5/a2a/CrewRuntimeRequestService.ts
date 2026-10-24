import {
  type CommandId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type { CrewRuntimeRequestItem, NativeQuestionInboxItem } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";

import { inboxAnswerableApprovals } from "@t3tools/shared/j5/crewRuntimeRequests";
import type { OrchestratorV2Error } from "../../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementService,
  type ThreadManagementProviderInstanceDisabledError,
} from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";
import { makeNativeQuestionInboxRead } from "./nativeQuestionInboxRead.ts";

/** A seat's thread, and the Crew that holds the seat. */
interface CrewSeatThread {
  readonly threadId: ThreadId;
  readonly crew: AgentCrewInstance;
  readonly seat: string;
}

export { inboxAnswerableApprovals } from "@t3tools/shared/j5/crewRuntimeRequests";

export class CrewRuntimeRequestNotFoundError extends Data.TaggedError(
  "CrewRuntimeRequestNotFoundError",
)<{ readonly threadId: ThreadId; readonly requestId: RuntimeRequestId }> {
  override get message() {
    return `No pending approval ${this.requestId} on a live Crew seat's thread ${this.threadId}.`;
  }
}

/** The request exists but can no longer take this answer: answered, expired, or not resumable. */
export class CrewRuntimeRequestConflictError extends Data.TaggedError(
  "CrewRuntimeRequestConflictError",
)<{ readonly detail: string }> {
  override get message() {
    return this.detail;
  }
}

/** The answer could not be sent for a reason other than the request's state; the route logs it. */
export class CrewRuntimeRequestDispatchError extends Data.TaggedError(
  "CrewRuntimeRequestDispatchError",
)<{ readonly cause: OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError }> {
  override get message() {
    return "The answer could not be sent.";
  }
}

/** Reading the Crews or a thread failed; never read as "nothing pending" or "not found". */
type CrewRuntimeRequestReadError = SqlError | OrchestratorV2Error;

export interface RespondToCrewRuntimeRequestInput {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
  /** Fresh per answer, so a second answer is refused by the request's state, not deduplicated. */
  readonly commandId: CommandId;
}

export interface CrewRuntimeRequestServiceShape {
  readonly questions: Effect.Effect<
    ReadonlyArray<NativeQuestionInboxItem>,
    CrewRuntimeRequestReadError
  >;
  /** Every approval the Inbox can answer on a live Crew's seat threads, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<CrewRuntimeRequestItem>, CrewRuntimeRequestReadError>;
  readonly respond: (
    input: RespondToCrewRuntimeRequestInput,
  ) => Effect.Effect<
    void,
    | CrewRuntimeRequestNotFoundError
    | CrewRuntimeRequestConflictError
    | CrewRuntimeRequestDispatchError
    | CrewRuntimeRequestReadError
  >;
}

export class CrewRuntimeRequestService extends Context.Service<
  CrewRuntimeRequestService,
  CrewRuntimeRequestServiceShape
>()("t3/j5/a2a/CrewRuntimeRequestService") {}

/**
 * The Captain is the thread the person watches, so its approvals and questions stay inline there;
 * a seat runs out of view, so its provider approvals reach the Inbox (Crews AC9) and are answered
 * through the same `runtime-request.respond` command the composer sends. Only what the Inbox can
 * answer is listed here: approvals the provider can still take. The separate questions read
 * lists placed agents' actionable native questions as links to the original thread forms.
 * The approval list covers only live Crew seats; the question links also cover solo Peer Agents.
 * A Captain's own requests remain inline, and retired seats leave both lists.
 */
export const layer = Layer.effect(
  CrewRuntimeRequestService,
  Effect.gen(function* () {
    const crews = yield* AgentCrewInstanceService;
    const threads = yield* ThreadManagementService;
    const questions = yield* makeNativeQuestionInboxRead;

    /**
     * One entry per seat thread, even when more than one Crew record names it. A thread that
     * captains any live Crew is left out: the person answers it in place.
     */
    const liveSeatThreads = crews.listLive().pipe(
      Effect.map((live) => {
        const captains = new Set(live.map((crew) => crew.captainThreadId));
        const seats = new Map<ThreadId, CrewSeatThread>();
        for (const crew of live)
          for (const member of crew.members)
            if (!captains.has(member.threadId) && !seats.has(member.threadId))
              seats.set(member.threadId, {
                threadId: member.threadId,
                crew,
                seat: member.seatName,
              });
        return seats;
      }),
    );

    /**
     * A reserved seat may have no thread yet, and an archived one takes no answers; both read as
     * null. Any other store failure propagates, so an outage is an error, not an empty Inbox.
     */
    const liveProjection = (threadId: ThreadId) =>
      getThreadProjectionIfPresent(threads, threadId).pipe(
        Effect.map((projection) =>
          projection !== null && projection.thread.archivedAt === null ? projection : null,
        ),
      );

    const list: CrewRuntimeRequestServiceShape["list"] = Effect.gen(function* () {
      const seats = yield* liveSeatThreads;
      // Independent reads, so a Crew's threads are read side by side rather than one by one.
      const perThread = yield* Effect.forEach(
        seats.values(),
        (entry) =>
          liveProjection(entry.threadId).pipe(
            Effect.map((projection): Array<CrewRuntimeRequestItem> =>
              projection === null
                ? []
                : inboxAnswerableApprovals(projection).map((approval) => ({
                    ...approval,
                    threadId: entry.threadId,
                    crewInstanceId: entry.crew.id,
                    crewName: entry.crew.displayName,
                    projectId: entry.crew.projectId,
                    seat: entry.seat,
                    threadTitle: projection.thread.title,
                  })),
            ),
          ),
        { concurrency: 8 },
      );
      return perThread
        .flat()
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    });

    const respond: CrewRuntimeRequestServiceShape["respond"] = Effect.fn(
      "j5.a2a.crewRuntimeRequest.respond",
    )(function* (input) {
      const notFound = new CrewRuntimeRequestNotFoundError({
        threadId: input.threadId,
        requestId: input.requestId,
      });
      if (!(yield* liveSeatThreads).has(input.threadId)) return yield* notFound;
      const projection = yield* liveProjection(input.threadId);
      if (projection === null) return yield* notFound;
      // The same selection `list` shows, so a request the Inbox never listed is never answered.
      const listed = inboxAnswerableApprovals(projection).some(
        (entry) => entry.requestId === input.requestId,
      );
      if (!listed) {
        const resolved = projection.runtimeRequests.find(
          (entry) => entry.id === input.requestId && entry.status !== "pending",
        );
        if (resolved === undefined) return yield* notFound;
        return yield* new CrewRuntimeRequestConflictError({
          detail: `This request is already ${resolved.status}; it may have been answered on another device.`,
        });
      }
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId: input.commandId,
          threadId: input.threadId,
          requestId: input.requestId,
          decision: input.decision,
        })
        .pipe(
          // The decider refuses with its reason as a string ("... is resolved", "Provider session
          // ... was not found"): a conflict the person can read. Any other cause is a failure to
          // send, reported as one.
          Effect.mapError((error) =>
            (error._tag === "OrchestratorDispatchError" ||
              error._tag === "OrchestratorCommandRejectedError") &&
            typeof error.cause === "string"
              ? new CrewRuntimeRequestConflictError({
                  detail: `The request could not be answered: ${error.cause}`,
                })
              : new CrewRuntimeRequestDispatchError({ cause: error }),
          ),
        );
    });

    return CrewRuntimeRequestService.of({ list, respond, questions });
  }),
);
