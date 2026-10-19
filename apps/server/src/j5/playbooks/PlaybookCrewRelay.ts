import { MessageId, ThreadId } from "@t3tools/contracts";
import type { FleetCrew } from "@t3tools/contracts/j5";
import {
  PlaybookError,
  type PlaybookStepDelivery,
  type PlaybookStepResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  type AgentCrewInstance,
} from "../a2a/AgentCrewInstanceService.ts";
import { lifecycleCommandId, lifecycleId } from "../a2a/spawnIds.ts";
import { getThreadProjectionIfPresent } from "../a2a/threadProjectionReads.ts";
import { crewStepNoticeText } from "./crewStepNotice.ts";
import {
  PlaybookStore,
  playbookError,
  type PlaybookLanding,
  type PlaybookMutation,
} from "./PlaybookStore.ts";

/**
 * Step notices derive both their command id and their message id from the run and the landing's
 * request. Exactly-once rests on two layers, and both are wanted: a re-dispatch after a crash
 * between the dispatch and its record replays the orchestrator's command receipt, and the
 * deterministic message id keeps a second copy out of the thread even if a receipt were lost.
 * PlaybookCrewRelay.integration.test.ts only fails when both ids vary.
 */
export const PLAYBOOK_STEP_SESSION = "j5-playbook-step";

const isPlaybookError = Schema.is(PlaybookError);
const operationFailed = (error: unknown) =>
  isPlaybookError(error)
    ? error
    : playbookError("operation_failed", error instanceof Error ? error.message : String(error));

/** The orchestrator will never accept this notice, so the Captain does the step. */
const PERMANENT_REJECTIONS = new Set([
  "OrchestratorCommandRejectedError",
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorCommandIdConflictError",
]);

const stepCommandId = (runId: string, requestId: string) =>
  lifecycleCommandId({
    providerSessionId: PLAYBOOK_STEP_SESSION,
    requestKey: `${runId}:${requestId}`,
    operation: "playbook-step",
  });
const stepMessageId = (runId: string, requestId: string) =>
  MessageId.make(
    lifecycleId({
      providerSessionId: PLAYBOOK_STEP_SESSION,
      requestKey: `${runId}:${requestId}`,
      kind: "message",
      operation: "playbook-step",
    }),
  );

/** How a landing reads to the Captain and Fleet; null once it was skipped. */
const deliveryOf = (
  landing: PlaybookLanding,
  captainThreadId: string,
): PlaybookStepDelivery | null => {
  if (landing.outcome === "skipped") return null;
  if (landing.outcome === "captain")
    return { state: "captain", seat: null, threadId: captainThreadId };
  if (landing.outcome === "delivered")
    return { state: "delivered", seat: landing.targetSeat, threadId: landing.targetThreadId };
  return { state: "pending", seat: landing.targetSeat, threadId: landing.targetThreadId };
};

/** A step tool response with who holds a Crew-linked run's current step. */
const withDelivery = (
  response: PlaybookStepResponse,
  delivery: PlaybookStepDelivery | null,
): PlaybookStepResponse => ({ ...response, delivery });

/** The seat that owns a step in the Crew's live roster, if any. */
const stepOwner = (instance: AgentCrewInstance, stepId: string) =>
  instance.members.find((member) => (member.playbookStepIds ?? []).includes(stepId)) ?? null;

export const makePlaybookCrewRelay = Effect.gen(function* () {
  const store = yield* PlaybookStore;
  const crews = yield* AgentCrewInstanceService;
  const threads = yield* ThreadManagementService;
  const readCrew = (id: string) => crews.read(id).pipe(Effect.mapError(operationFailed));

  /** Where a landing goes: a live seat that owns the step, or else the Captain. */
  const resolveTarget = Effect.fn("PlaybookCrewRelay.resolveTarget")(function* (
    instance: AgentCrewInstance,
    stepId: string,
  ) {
    const owner = stepOwner(instance, stepId);
    if (owner === null) return { seat: null, threadId: instance.captainThreadId };
    const projection = yield* getThreadProjectionIfPresent(threads, owner.threadId);
    const live =
      projection !== null &&
      projection.thread.archivedAt === null &&
      projection.thread.deletedAt === null;
    return live
      ? { seat: owner.seatName, threadId: owner.threadId }
      : { seat: null, threadId: instance.captainThreadId };
  });

  /**
   * Hands one landing to its owner. The caller holds the Crew's lock. A resolved landing returns
   * its stored delivery. Only a finished run, a retired Crew, or a live definition that no longer
   * has the step skips a landing; anything that can't be read or sent right now leaves it pending
   * for the Captain's retry or next move, with the reason.
   */
  const handOff = Effect.fn("PlaybookCrewRelay.handOff")(function* (
    runId: string,
    requestId: string,
  ) {
    let landing = yield* store.landing(runId, requestId);
    const run = yield* store.runById(runId);
    if (landing === null || run === null) return { delivery: null, reason: null };
    const settled = (resolved: PlaybookLanding) => ({
      delivery: deliveryOf(resolved, run.ownerThreadId),
      reason: null,
    });
    const pending = (reason: string) => ({
      delivery: deliveryOf(landing!, run.ownerThreadId),
      reason,
    });
    if (landing.resolvedAt !== null) return settled(landing);
    const instance = run.crewInstanceId ? yield* readCrew(run.crewInstanceId) : null;
    if (run.status !== "active" || instance === null || instance.archivedAt !== null)
      return settled(yield* store.resolveLanding(runId, requestId, "skipped"));
    const live = yield* store.liveStep(run, landing.stepId).pipe(Effect.result);
    if (live._tag === "Failure")
      return pending(
        `the playbook can't be read (${live.failure.message}). Fix its YAML, then retry; j5_playbook_cancel still works`,
      );
    // The Captain's own response already reports the step_missing issue.
    if (live.success.step === null)
      return settled(yield* store.resolveLanding(runId, requestId, "skipped"));
    const { step, ...playbook } = live.success;
    if (landing.targetThreadId === null) {
      // Persisted before dispatch, so a retry reuses this target and its command id.
      const target = yield* resolveTarget(instance, step.id).pipe(Effect.option);
      if (target._tag === "None")
        return pending("the owning seat's thread can't be read right now");
      landing = yield* store.targetLanding(runId, requestId, target.value);
    }
    // The Captain's own tool response already carries the prompt; no notice to its thread.
    if (landing.targetSeat === null)
      return settled(yield* store.resolveLanding(runId, requestId, "captain"));
    const seatThreadId = ThreadId.make(landing.targetThreadId!);
    const outcome = yield* Effect.gen(function* () {
      const seat = yield* getThreadProjectionIfPresent(threads, seatThreadId);
      if (seat === null) return "captain" as const;
      yield* threads.dispatch({
        type: "message.dispatch",
        createdBy: "system",
        creationSource: "server",
        commandId: stepCommandId(runId, requestId),
        threadId: seatThreadId,
        messageId: stepMessageId(runId, requestId),
        text: crewStepNoticeText({
          playbookName: playbook.name,
          playbookTitle: playbook.title,
          crewInstanceId: instance.id,
          stepId: step.id,
          stepTitle: step.title,
          position: playbook.position,
          total: playbook.total,
          captainParticipantId: instance.captainParticipantId,
          prompt: step.prompt,
        }),
        attachments: [],
        modelSelection: seat.thread.modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      return "delivered" as const;
    }).pipe(
      Effect.catch((error) =>
        PERMANENT_REJECTIONS.has(error._tag)
          ? Effect.succeed("captain" as const)
          : Effect.logWarning("J5 playbook step hand-off failed; it stays pending", {
              runId,
              requestId,
              error,
            }).pipe(Effect.as(null)),
      ),
    );
    if (outcome === null) return pending("the orchestrator didn't accept the notice yet");
    // A crash between dispatch and this write re-dispatches the same command id, which the
    // orchestrator's command receipts replay without a second message.
    const resolved = yield* store.resolveLanding(runId, requestId, outcome).pipe(Effect.option);
    return resolved._tag === "Some"
      ? settled(resolved.value)
      : pending("its hand-off couldn't be recorded");
  }, Effect.mapError(operationFailed));

  const deliverLocked = (runId: string, requestId: string) =>
    handOff(runId, requestId).pipe(Effect.map(({ delivery }) => delivery));

  /** Resolves every pending landing of a run, oldest first; the run must not move past one. */
  const drainLocked = Effect.fn("PlaybookCrewRelay.drainLocked")(function* (runId: string) {
    for (const landing of yield* store.pendingLandings(runId)) {
      const { delivery, reason } = yield* handOff(runId, landing.requestId);
      if (delivery?.state === "pending")
        return yield* playbookError(
          "delivery_pending",
          `The hand-off of step ${landing.stepId} to ${delivery.seat ?? "its owner"} hasn't completed: ${reason ?? "it is still in progress"}. Retry the same call.`,
        );
    }
  });

  const withCrew = <A, E, R>(crewInstanceId: string, effect: Effect.Effect<A, E, R>) =>
    crews.serialize(crewInstanceId, effect);

  const deliver = (runId: string, requestId: string) =>
    Effect.gen(function* () {
      const run = yield* store.runById(runId);
      if (!run?.crewInstanceId) return null;
      return yield* withCrew(run.crewInstanceId, deliverLocked(runId, requestId));
    });

  const drainRun = (runId: string) =>
    Effect.gen(function* () {
      const run = yield* store.runById(runId);
      if (!run?.crewInstanceId) return;
      yield* withCrew(run.crewInstanceId, drainLocked(runId));
    });

  /** Who holds the run's current step, read-only: never dispatches, never drains. */
  const currentDelivery = Effect.fn("PlaybookCrewRelay.currentDelivery")(function* (
    runId: string,
    currentStepId: string,
  ) {
    const run = yield* store.runById(runId);
    const landing = yield* store.latestLanding(runId, currentStepId);
    return run === null || landing === null ? null : deliveryOf(landing, run.ownerThreadId);
  });

  /**
   * The delivery a step tool reports: the landing on the step the response shows. A retry
   * returns live progress, so its own landing may be an older one; that one is still finished
   * first, and a run that has ended reports none.
   */
  const respond = Effect.fn("PlaybookCrewRelay.respond")(function* (
    response: PlaybookStepResponse,
    requestId: string,
  ) {
    yield* deliverLocked(response.runId, requestId);
    return withDelivery(
      response,
      response.status === "active"
        ? yield* currentDelivery(response.runId, response.currentStepId)
        : null,
    );
  });

  /**
   * Starts a Crew-linked run from its Captain's thread. The link, the run, and the first
   * hand-off run under the Crew's lock, the one archive holds, so an archive can't interleave.
   */
  const start = (input: {
    readonly owner: ThreadId;
    readonly root: string;
    readonly name: string;
    readonly key: string;
    readonly crewInstanceId: string;
  }) =>
    withCrew(
      input.crewInstanceId,
      Effect.gen(function* () {
        const { definitionPath } = yield* store.startDefinitionPathFor(
          input.owner,
          input.root,
          input.name,
          input.key,
          input.crewInstanceId,
        );
        const instance = yield* readCrew(input.crewInstanceId);
        const refusal =
          instance === null
            ? `No Crew ${input.crewInstanceId} is recorded in this environment.`
            : instance.archivedAt !== null
              ? `Crew ${instance.id} is archived.`
              : instance.captainThreadId !== input.owner
                ? `Crew ${instance.id} is commanded from another thread; only its Captain starts its playbook.`
                : instance.playbook?.definitionPath !== definitionPath
                  ? `Crew ${instance.id} follows ${instance.playbook ? `playbook ${instance.playbook.name}` : "no playbook"}, not ${input.name}.`
                  : null;
        if (refusal !== null) return yield* playbookError("crew_not_linkable", refusal);
        const response = yield* store.start(input.owner, input.root, input.name, input.key, {
          crewInstanceId: input.crewInstanceId,
        });
        return yield* respond(response, input.key);
      }),
    );

  /**
   * Moves a run. A Crew-linked run first resolves every earlier hand-off, then moves, then hands
   * the new step to its owner, all under the Crew's lock. Cancel always works and never drains.
   */
  const mutate = (owner: ThreadId, input: PlaybookMutation) =>
    Effect.gen(function* () {
      const run = yield* store.runById(input.runId);
      // Only the owner's own call hands anything off; anyone else gets the store's refusal
      // (not_owner) before a pending landing is touched.
      const crewInstanceId = run?.ownerThreadId === owner ? run.crewInstanceId : undefined;
      if (!crewInstanceId) {
        // A thread run's response carries no delivery at all.
        const response: PlaybookStepResponse = yield* store.mutate(owner, input);
        return response;
      }
      if (input.operation === "cancel")
        return withDelivery(yield* store.mutate(owner, input), null);
      return yield* withCrew(
        crewInstanceId,
        Effect.gen(function* () {
          yield* drainLocked(input.runId);
          const response = yield* store.mutate(owner, input);
          if (input.operation === "complete") return withDelivery(response, null);
          return yield* respond(response, input.client_request_id);
        }),
      );
    });

  /** The run's live prompt and progress, with who holds a Crew-linked run's current step. */
  const current = (owner: ThreadId, runId?: string) =>
    Effect.gen(function* () {
      const response: PlaybookStepResponse = yield* store.current(owner, runId);
      if (!response.crewInstanceId) return response;
      return withDelivery(
        response,
        response.status === "active"
          ? yield* currentDelivery(response.runId, response.currentStepId)
          : null,
      );
    });

  /** Where a Crew's active run is and who holds its step, as Fleet shows it; null when none. */
  const fleetRun = Effect.fn("PlaybookCrewRelay.fleetRun")(function* (crewInstanceId: string) {
    const run = yield* store.activeRunForCrew(crewInstanceId);
    if (run === null) return null;
    const delivery = yield* currentDelivery(run.runId, run.currentStepId);
    // The live YAML can't be read, or no longer has the recorded step: Fleet still shows the run
    // at that step, marked as needing attention.
    if (run.position === null)
      return {
        runId: run.runId,
        position: 0,
        total: run.total,
        stepId: run.currentStepId,
        stepTitle: run.currentStepId,
        state: delivery?.state ?? "pending",
        seat: delivery?.seat ?? null,
        issue: run.issue?.message ?? "The playbook's current step can't be read.",
      } satisfies NonNullable<FleetCrew["playbookRun"]>;
    if (delivery === null) return null;
    return {
      runId: run.runId,
      position: run.position,
      total: run.total,
      stepId: run.currentStepId,
      stepTitle: run.steps[run.position - 1]?.title ?? run.currentStepId,
      state: delivery.state,
      seat: delivery.seat,
    } satisfies NonNullable<FleetCrew["playbookRun"]>;
  });

  return { start, mutate, current, deliver, drainRun, currentDelivery, fleetRun };
});

export class PlaybookCrewRelay extends Context.Service<
  PlaybookCrewRelay,
  Effect.Success<typeof makePlaybookCrewRelay>
>()("t3/j5/playbooks/PlaybookCrewRelay") {}

/**
 * Nothing sweeps pending hand-offs in the background: the Captain's next step call, or a retry
 * of the same one, finishes them before the run moves.
 */
export const layer = Layer.effect(PlaybookCrewRelay, makePlaybookCrewRelay);
