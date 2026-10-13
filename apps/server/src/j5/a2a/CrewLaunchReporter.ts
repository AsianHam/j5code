import { makeCrewFailureAlert } from "./crewFailureAlert.ts";
import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";
import type { OrchestratorV2Error } from "../../orchestration-v2/Orchestrator.ts";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { AgentCrewProposalService, type CrewProposal } from "./AgentCrewProposalService.ts";
import { crewLaunchReportText, type SeatStartVerdict } from "./crewGateNotice.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";
import type { CrewSeatLaunchOutcome } from "./CrewLaunchService.ts";
import {
  CREW_PROPOSAL_SESSION,
  crewSeatBriefMessageId,
  crewSeatReservedBy,
} from "./crewSeatIds.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { runFailureDetail } from "./runFailures.ts";
import { lifecycleCommandId, lifecycleId } from "./spawnIds.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";

/**
 * A quiet provider may still be working. When this window closes without provider activity,
 * its start is reported as unconfirmed, and its eventual finish remains reportable.
 */
export const CREW_LAUNCH_REPORT_WINDOW_MS = 60_000;

/**
 * The launch report: the one notice a Captain gets for an approval, posted when every seat this
 * proposal launched has produced provider activity or ended, or the window closed. Dispatching a brief commits intent only; before this, "your crew is running" was
 * said the moment the briefs were dispatched, and two seats that died on a signed-out provider
 * arrived later as finishes with no reason (Jackson's dogfood, 2026-09-17).
 */
export interface CrewLaunchReporterShape {
  /**
   * Watch an approved proposal's seats. Takes a verdict for each seat from what its thread already
   * shows, then waits on the stored-event stream for the rest; posts the report and stamps the
   * proposal reported. Idempotent per proposal while a watch is pending. `outcomes` are the
   * launch's own per-seat results: a seat that was never created, or whose home or brief did not
   * go through, is decided from them. Without them (the boot sweep), a seat is measured from its
   * thread, and one with no thread reads as not created.
   *
   * Before measuring, a row this proposal minted whose thread does not exist is dropped, so the
   * roster matches what the launch made; a seat the launch reported created or not started keeps
   * its row. A failed drop fails the report, which stays owed for the next boot sweep. That a
   * missing thread is final rests on every production writer of member rows holding
   * `crews.serialize` for the Crew; never call this while holding it for the same Crew.
   */
  readonly watch: (
    proposalId: string,
    outcomes?: ReadonlyArray<CrewSeatLaunchOutcome>,
  ) => Effect.Effect<void>;
  /** Returns the proposal id whose report this event completed, or null. */
  readonly handleStoredEvent: (stored: OrchestrationV2StoredEvent) => Effect.Effect<string | null>;
  /**
   * Whether a failed first run belongs to an owed report or was included in its durable message.
   * The finish notifier stays quiet for those, so the Captain hears of a dead seat once.
   */
  readonly coversFailure: (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) => Effect.Effect<boolean, SqlError | OrchestratorV2Error>;
  /** The boot sweep: watch every approved proposal whose report never reached its Captain. */
  readonly reconcile: Effect.Effect<ReadonlyArray<string>>;
}

export class CrewLaunchReporter extends Context.Service<
  CrewLaunchReporter,
  CrewLaunchReporterShape
>()("t3/j5/a2a/CrewLaunchReporter") {}

interface WatchedSeat {
  readonly seatName: string;
  readonly threadId: ThreadId;
  readonly briefMessageId: string;
}

interface PendingLaunch {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance;
  readonly seats: ReadonlyArray<WatchedSeat>;
  readonly verdicts: Map<string, SeatStartVerdict>;
  /** Verdicts the launch decided (a failed home or brief); a thread read never overrides them. */
  readonly decided: ReadonlyMap<string, SeatStartVerdict>;
  timer: Fiber.Fiber<void> | null;
}

const NOT_CREATED_DETAIL = "its thread was never created";

const isFirstTurnRun = (seat: WatchedSeat, run: OrchestrationV2Run) =>
  run.threadId === seat.threadId && run.userMessageId === seat.briefMessageId;

// Both orchestration and some adapters publish running before making the provider request.
// Only provider work (or a completed run) proves the seat got beyond that startup boundary.
const isProviderActivity = (item: OrchestrationV2TurnItem) => {
  switch (item.type) {
    case "assistant_message":
    case "reasoning":
      return item.text.trim().length > 0;
    case "proposed_plan":
      return item.markdown.trim().length > 0;
    case "todo_list":
    case "user_input_request":
    case "approval_request":
    case "file_change":
    case "command_execution":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
      return true;
    default:
      return false;
  }
};

const verdictFor = (
  run: OrchestrationV2Run | undefined,
  projection: OrchestrationV2ThreadProjection | null,
): SeatStartVerdict => {
  if (run === undefined) return { kind: "pending" };
  switch (run.status) {
    case "completed":
      return { kind: "started" };
    // A new worktree's first turn waits here while ThreadLaunch prepares it, and that
    // preparation's own items are not the seat's agent at work.
    case "preparing":
      return { kind: "pending" };
    case "failed":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return {
        kind: "failed",
        runId: run.id,
        runStatus: run.status,
        failure: projection === null ? null : runFailureDetail(projection, run.id),
      };
    default:
      return projection?.turnItems.some((item) => item.runId === run.id && isProviderActivity(item))
        ? { kind: "started" }
        : { kind: "pending" };
  }
};

const noticeMessageId = (proposalId: string) =>
  MessageId.make(
    lifecycleId({
      providerSessionId: CREW_PROPOSAL_SESSION,
      requestKey: proposalId,
      kind: "message",
      operation: "proposal-notice",
    }),
  );

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    CrewLaunchReporter,
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const alertHumanOfCrewFailure = yield* makeCrewFailureAlert;
      const proposals = yield* AgentCrewProposalService;
      const playbooks = yield* PlaybookStore;
      const crews = yield* AgentCrewInstanceService;
      const timers = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(timers, Exit.void));
      const pending = new Map<string, PendingLaunch>();
      // One resolver at a time: a window closing and a final run update must not both post.
      const gate = yield* Semaphore.make(1);

      /** Posts the report and stamps the proposal; ids derive from the proposal, so a replay converges. */
      const post = Effect.fn("j5.a2a.crewLaunchReporter.post")(function* (launch: PendingLaunch) {
        const proposal = launch.proposal;
        const stable = { providerSessionId: CREW_PROPOSAL_SESSION, requestKey: proposal.id };
        const captain = yield* threads.getThreadProjection(proposal.captainThreadId);
        for (const [seatName, verdict] of launch.verdicts) {
          if (verdict.kind === "failed")
            yield* alertHumanOfCrewFailure({
              instance: launch.instance,
              seatName,
              runId: verdict.runId,
              failure: verdict.failure,
            });
        }
        // Dispatch can commit before the report stamp fails. Replay the already-persisted
        // outcome instead of recomputing it from runs that may have changed since that report.
        if (captain.messages.some((message) => message.id === noticeMessageId(proposal.id))) {
          yield* proposals.markReported(proposal.id, DateTime.formatIso(yield* DateTime.now));
          return;
        }
        // The playbook's title is read live; the name stands in when the file can't be read.
        const followed = launch.instance.playbook ?? null;
        const playbook =
          followed === null
            ? null
            : {
                name: followed.name,
                title: yield* playbooks.readPath(followed.definitionPath).pipe(
                  Effect.map((definition) => definition.title),
                  Effect.orElseSucceed(() => followed.name),
                ),
              };
        yield* threads.dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          commandId: lifecycleCommandId({ ...stable, operation: "proposal-notice" }),
          threadId: proposal.captainThreadId,
          messageId: MessageId.make(
            lifecycleId({ ...stable, kind: "message", operation: "proposal-notice" }),
          ),
          text: crewLaunchReportText({
            proposal,
            instance: launch.instance,
            verdicts: launch.verdicts,
            windowMs: CREW_LAUNCH_REPORT_WINDOW_MS,
            playbook,
          }),
          attachments: [],
          modelSelection: captain.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* proposals.markReported(proposal.id, DateTime.formatIso(yield* DateTime.now));
      });

      const refreshSeat = Effect.fn("j5.a2a.crewLaunchReporter.refreshSeat")(function* (
        launch: PendingLaunch,
        seat: WatchedSeat,
      ) {
        const decided = launch.decided.get(seat.seatName);
        if (decided !== undefined) {
          launch.verdicts.set(seat.seatName, decided);
          return;
        }
        const projection = yield* getThreadProjectionIfPresent(threads, seat.threadId);
        launch.verdicts.set(
          seat.seatName,
          projection === null
            ? { kind: "not_created", detail: NOT_CREATED_DETAIL }
            : verdictFor(
                projection.runs.find((candidate) => isFirstTurnRun(seat, candidate)),
                projection,
              ),
        );
      });

      // Called only with the permit held. The window fiber must not interrupt itself.
      const settle = Effect.fn("j5.a2a.crewLaunchReporter.settle")(function* (
        proposalId: string,
        cause: "verdicts" | "window",
      ) {
        const launch = pending.get(proposalId);
        if (launch === undefined) return null;
        if (cause === "window") {
          // A missed/failed stream read must not turn an old snapshot into a false timeout.
          for (const seat of launch.seats) yield* refreshSeat(launch, seat);
        }
        if (cause === "verdicts" && launch.timer !== null) yield* Fiber.interrupt(launch.timer);
        yield* post(launch);
        pending.delete(proposalId);
        return proposalId;
      });

      const allDecided = (launch: PendingLaunch) =>
        launch.seats.every((seat) => launch.verdicts.get(seat.seatName)?.kind !== "pending");

      /**
       * Drops the rows this proposal minted whose threads were never created. Under the Crew's
       * lock the launch that reserved them has finished or died with the process, and nothing
       * recreates a seat for a resolved proposal, so a missing thread is final. Taken before the
       * gate: the reporter never waits on a Crew lock while holding its gate.
       */
      const dropSeatsNeverCreated = Effect.fn("j5.a2a.crewLaunchReporter.dropSeatsNeverCreated")(
        function* (proposalId: string, outcomes: ReadonlyArray<CrewSeatLaunchOutcome>) {
          const proposal = yield* proposals.read(proposalId);
          if (
            proposal === null ||
            proposal.status !== "approved" ||
            proposal.crewInstanceId === null ||
            proposal.reportedAt !== null
          )
            return;
          const crewInstanceId = proposal.crewInstanceId;
          // A seat the launch created, or whose thread it could not read, is not known missing.
          const kept = new Set(
            outcomes.flatMap((outcome) =>
              outcome.kind === "not_created" ? [] : [outcome.seatName],
            ),
          );
          yield* crews.serialize(
            crewInstanceId,
            Effect.gen(function* () {
              const instance = yield* crews.read(crewInstanceId);
              if (instance === null) return;
              const missing: Array<string> = [];
              for (const member of instance.members.filter(crewSeatReservedBy(proposal.id))) {
                if (kept.has(member.seatName)) continue;
                if ((yield* getThreadProjectionIfPresent(threads, member.threadId)) === null)
                  missing.push(member.seatName);
              }
              yield* crews.removeMembers(instance.id, missing);
            }),
          );
        },
      );

      const watch: CrewLaunchReporterShape["watch"] = (proposalId, outcomes = []) =>
        dropSeatsNeverCreated(proposalId, outcomes).pipe(
          Effect.andThen(
            gate.withPermit(
              Effect.gen(function* () {
                if (pending.has(proposalId)) return;
                const proposal = yield* proposals.read(proposalId);
                if (
                  proposal === null ||
                  proposal.status !== "approved" ||
                  proposal.crewInstanceId === null ||
                  proposal.reportedAt !== null
                )
                  return;
                const instance = yield* crews.read(proposal.crewInstanceId);
                if (instance === null) return;
                const members =
                  proposal.kind === "roster"
                    ? instance.members
                    : instance.members.filter(crewSeatReservedBy(proposal.id));
                const seats = members.map((member) => ({
                  seatName: member.seatName,
                  threadId: member.threadId,
                  briefMessageId: crewSeatBriefMessageId(proposal.id, member.seatName),
                }));
                const decided = new Map<string, SeatStartVerdict>(
                  outcomes.flatMap((outcome) =>
                    outcome.kind === "created"
                      ? []
                      : [
                          [
                            outcome.seatName,
                            { kind: outcome.kind, detail: outcome.detail },
                          ] as const,
                        ],
                  ),
                );
                const verdicts = new Map<string, SeatStartVerdict>(
                  seats.map((seat) => [seat.seatName, { kind: "pending" }]),
                );
                // An approved seat with no row was never created: the launch dropped it, so it is
                // decided now and reported by name, though it is not on the roster.
                const onRoster = new Set(seats.map((seat) => seat.seatName));
                for (const approved of proposal.approvedSeats ?? proposal.requestedSeats)
                  if (!onRoster.has(approved.seat))
                    verdicts.set(
                      approved.seat,
                      decided.get(approved.seat) ?? {
                        kind: "not_created",
                        detail: NOT_CREATED_DETAIL,
                      },
                    );
                const launch: PendingLaunch = {
                  proposal,
                  instance,
                  seats,
                  verdicts,
                  decided,
                  timer: null,
                };
                // Snapshot reads and stream handling share the permit. An update arriving during a
                // read waits for registration, then refreshes the seat; it cannot fall between them.
                for (const seat of seats) yield* refreshSeat(launch, seat);
                pending.set(proposalId, launch);
                launch.timer = yield* Effect.sleep(
                  Duration.millis(CREW_LAUNCH_REPORT_WINDOW_MS),
                ).pipe(
                  Effect.andThen(gate.withPermit(settle(proposalId, "window"))),
                  Effect.asVoid,
                  Effect.catchCause((cause) =>
                    Effect.logWarning("J5 crew launch report window failed", {
                      proposalId,
                      cause,
                    }),
                  ),
                  Effect.forkIn(timers, { startImmediately: true }),
                );
                if (allDecided(launch)) yield* settle(proposalId, "verdicts");
              }),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 crew launch report could not start watching", {
              proposalId,
              cause,
            }),
          ),
        );

      const handleStoredEvent: CrewLaunchReporterShape["handleStoredEvent"] = (stored) =>
        gate
          .withPermit(
            Effect.gen(function* () {
              if (stored.event.type !== "run.updated" && stored.event.type !== "turn-item.updated")
                return null;
              for (const [proposalId, launch] of pending) {
                const seat = launch.seats.find(
                  (candidate) => candidate.threadId === stored.event.threadId,
                );
                if (seat === undefined) continue;
                yield* refreshSeat(launch, seat);
                return allDecided(launch) ? yield* settle(proposalId, "verdicts") : null;
              }
              return null;
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("J5 crew launch report skipped an event", { cause }).pipe(
                Effect.as(null),
              ),
            ),
          );

      const coversFailure: CrewLaunchReporterShape["coversFailure"] = (threadId, run) =>
        Effect.gen(function* () {
          const membership = yield* crews.findMembership(participantIdForThread(threadId));
          if (membership === null) return false;
          const instance = yield* crews.read(membership.crewInstanceId);
          if (instance === null) return false;
          const candidates = yield* proposals.listForCaptain(instance.captainParticipantId);
          const proposal = candidates.find(
            (candidate) =>
              candidate.crewInstanceId === instance.id &&
              candidate.status === "approved" &&
              crewSeatReservedBy(candidate.id)({
                participantId: participantIdForThread(threadId),
                seatName: membership.seatName,
              }) &&
              run.userMessageId === crewSeatBriefMessageId(candidate.id, membership.seatName),
          );
          if (proposal === undefined) return false;
          const captain = yield* threads.getThreadProjection(instance.captainThreadId);
          const report = captain.messages.find(
            (message) => message.id === noticeMessageId(proposal.id),
          );
          if (report !== undefined)
            return report.text.split("\n").includes(`failed_run: ${run.id}`);
          // The approval and instance are durable before any brief starts. Cover early failures
          // even before watch(), and after restart while the report is still owed. Once posted,
          // only the exact failed runs in that durable message are suppressed; later failures speak.
          return proposal.reportedAt === null;
        });

      const reconcile: CrewLaunchReporterShape["reconcile"] = Effect.gen(function* () {
        const unreported = yield* proposals.listUnreported();
        for (const proposal of unreported) yield* watch(proposal.id);
        if (unreported.length > 0)
          yield* Effect.logInfo("J5 crew launch report sweep picked up unreported launches", {
            proposalIds: unreported.map(({ id }) => id),
          });
        return unreported.map(({ id }) => id);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("J5 crew launch report sweep failed", { cause }).pipe(Effect.as([])),
        ),
      );

      if (daemon) {
        // From the event store's current high-water mark, so a launch approved while the server
        // was down is reported by the sweep and everything after by the stream.
        const runDaemon = Effect.gen(function* () {
          let afterSequence = yield* readEventStoreHighWater("J5 crew launch reporter");
          yield* reconcile;
          return yield* Effect.forever(
            Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
              Stream.runForEach((event) =>
                handleStoredEvent(event).pipe(
                  Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 crew launch report stream failed; resuming", { cause }).pipe(
                  Effect.andThen(Effect.sleep(Duration.seconds(1))),
                ),
              ),
            ),
          );
        });
        yield* Effect.forkScoped(runDaemon);
      }

      return CrewLaunchReporter.of({ watch, handleStoredEvent, coversFailure, reconcile });
    }),
  );

/** Production: the sweep and the stream run once the layer is built. */
export const layer = makeLayer(true);
/** For tests and for a runtime whose own stream feeds `handleStoredEvent`. */
export const manualLayer = makeLayer(false);
