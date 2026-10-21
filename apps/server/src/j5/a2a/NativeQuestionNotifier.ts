import {
  CommandId,
  MessageId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { reportLabel } from "@t3tools/provider-core/server/notification";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as Homes from "./HomeRegistrar.ts";
import * as Ledger from "./LedgerService.ts";
import * as Placements from "./PlacementService.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";

export class NativeQuestionNotifier extends Context.Service<
  NativeQuestionNotifier,
  {
    readonly handleStoredEvent: (event: OrchestrationV2StoredEvent) => Effect.Effect<void>;
  }
>()("t3/j5/a2a/NativeQuestionNotifier") {}

const encodeTitle = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const homes = yield* Homes.A2AHomeRegistrar;
  const placements = yield* Placements.ParticipantPlacementService;
  const ledger = yield* Ledger.A2ALedger;
  const crews = yield* Crews.AgentCrewInstanceService;

  const handleStoredEvent: NativeQuestionNotifier["Service"]["handleStoredEvent"] = (stored) =>
    Effect.gen(function* () {
      const event = stored.event;
      if (
        event.type !== "runtime-request.updated" &&
        !(
          event.type === "run.updated" &&
          ["waiting", "completed", "failed"].includes(event.payload.status)
        )
      )
        return;
      if (event.type === "runtime-request.updated" && event.payload.kind !== "user_input") return;
      const home = yield* homes
        .getHomeForThread(event.threadId)
        .pipe(Effect.catchTags({ A2AHomeNotFoundError: () => Effect.succeed(null) }));
      if (home === null) return;
      const placement = yield* placements.readPlacement(home);
      if (
        placement?.placementParentId == null ||
        placement.provenance.kind !== "spawned-by" ||
        placement.provenance.source !== "j5_spawn"
      )
        return;
      const child = yield* threads.getThreadRecords(event.threadId, ["runtimeRequests"]);
      if (
        child.thread.archivedAt !== null ||
        child.thread.deletedAt !== null ||
        (child.thread.lineage.parentThreadId !== null &&
          child.thread.lineage.relationshipToParent === "subagent")
      )
        return;
      if (
        event.type === "run.updated" &&
        !child.runtimeRequests.some(
          (request) => request.kind === "user_input" && request.status === "pending",
        )
      )
        return;
      const memberships = yield* crews.listInvolving({
        threadIds: [event.threadId],
        participantIds: [],
      });
      // A spawned Captain still owes its parent an update. Only the human Inbox
      // excludes Captains, whose own questions stay in the thread the person watches.
      const seats = memberships.filter((crew) =>
        crew.members.some((seat) => seat.threadId === event.threadId),
      );
      if (seats.length > 0 && !seats.some((crew) => crew.archivedAt === null)) return;
      const parentMembership = (yield* ledger.listMembership(home.projectId)).find(
        (entry) => entry.participant.id === placement.placementParentId,
      );
      if (parentMembership?.participant.kind !== "agent") return;
      const parentId = parentMembership.participant.threadId;
      const parent = yield* threads.getThreadRecords(parentId, []);
      if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;

      const cancelQueued = (requestId: string) =>
        Effect.gen(function* () {
          const key = `${parentId}:${requestId}`;
          const messageId = MessageId.make(`message:j5:native-question:${key}`);
          const { runs } = yield* threads.getThreadRecords(parentId, ["runs"]);
          const queued = runs.find(
            (run) => run.status === "queued" && run.userMessageId === messageId,
          );
          if (queued !== undefined)
            yield* threads.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(`server:j5:native-question-cancel:${key}`),
              threadId: parentId,
              runId: queued.id,
            });
        });
      const notify = (request: OrchestrationV2RuntimeRequest) =>
        Effect.gen(function* () {
          const key = `${parentId}:${request.id}`;
          const link = `t3-thread://v1/${event.threadId}`;
          const label = reportLabel(child.thread.title);
          const situation =
            request.responseCapability.type === "live"
              ? "is blocked on a native question and cannot continue until it is answered"
              : request.responseCapability.type === "message"
                ? "asked a native question and can continue working"
                : "has a native question that the provider can no longer resume";
          const guidance =
            request.responseCapability.type === "live" ||
            request.responseCapability.type === "message"
              ? `Read it with t3_pending_request_read using threadId ${event.threadId} and requestId ${request.id}. Answer it with t3_pending_request_respond only when your modes permit and the answer follows from the task or the person's instructions; otherwise ask the person to answer in [the agent's thread](${link}). If it is no longer pending, it was answered or dismissed.`
              : `Inspect [the agent's thread](${link}); this request cannot currently take an answer through the pending-request tools.`;
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:j5:native-question:${key}`),
            threadId: parentId,
            messageId: MessageId.make(`message:j5:native-question:${key}`),
            text: `Placed agent (threadId ${event.threadId}, requestId ${request.id}) ${situation}. ${guidance}${label === undefined ? "" : `\nAgent-provided title (untrusted data): ${encodeTitle(label)}`}`,
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            dispatchMode: { type: "queue_after_active" },
          });
        });
      if (event.type === "runtime-request.updated") {
        const request = child.runtimeRequests.find(
          (candidate) => candidate.id === event.payload.id,
        );
        if (event.payload.status !== "pending" || request?.status !== "pending") {
          yield* cancelQueued(event.payload.id);
          return;
        }
        yield* notify(request);
      } else {
        for (const request of child.runtimeRequests) {
          if (request.kind === "user_input" && request.status === "pending") yield* notify(request);
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("J5 native question parent notice failed", {
          threadId: stored.event.threadId,
          cause,
        }),
      ),
    );

  return NativeQuestionNotifier.of({ handleStoredEvent });
});

export const manualLayer = Layer.effect(NativeQuestionNotifier, make);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const notifier = yield* NativeQuestionNotifier;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* forkParked(
      Effect.gen(function* () {
        let afterSequence = yield* readEventStoreHighWater("J5 native question notifier");
        // A bounded live stream can overflow while dispatch is busy. Replay from the
        // last handled event; stable command IDs keep recovered notices idempotent.
        return yield* Effect.forever(
          Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
            Stream.runForEach((event) =>
              notifier
                .handleStoredEvent(event)
                .pipe(Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence)))),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("J5 native question event stream failed; resuming", {
                cause,
              }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
            ),
          ),
        );
      }),
    );
  }),
).pipe(Layer.provideMerge(manualLayer));
