import type {
  CrewProposal as ClientCrewProposal,
  CrewSeatWorkspace,
  CrewPersonaSwap,
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
  PlaybookError,
  PlaybookReadResponse,
} from "@t3tools/contracts/j5";
import { crewApprovalToken, crewPlaybookPlanDigest } from "./crewRuntimePreview.ts";
import { MessageId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { makeAgentPersonaLibrary, personaCatalogProblem } from "../agents/agentPersonaLibrary.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  type CrewPlaybookRef,
  type CrewProposal,
  type CrewProposalSeat,
} from "./AgentCrewProposalService.ts";
import {
  CREW_SEAT_CAP,
  CrewLaunchOperationError,
  CrewLaunchService,
  type CrewCaptain,
  type CrewLaunchError,
  type CrewLaunchPlaybook,
  type CrewLaunchSeat,
  type ResolvedCrewLaunchSeat,
} from "./CrewLaunchService.ts";
import { planCrewPlaybook, withPersonaSwaps, type CrewPlaybookPlan } from "./crewPlaybookPlan.ts";
import { crewDeclinedNoticeText, crewRosterChanges } from "./crewGateNotice.ts";
import { durationMsBetween, j5AnalyticsRecorder } from "../analytics/recorder.ts";
import { CrewLaunchReporter } from "./CrewLaunchReporter.ts";
import { crewSeatShapeProblem } from "./crewLimits.ts";
import { CREW_PROPOSAL_SESSION } from "./crewSeatIds.ts";
import { A2ALedger } from "./LedgerService.ts";
import { lifecycleCommandId, lifecycleId } from "./spawnIds.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";

/** Hard cap on seats per Crew, initial roster and additions together. */
export { CREW_SEAT_CAP } from "./CrewLaunchService.ts";

const PROPOSAL_SESSION = CREW_PROPOSAL_SESSION;

/**
 * A proposal seat as the launcher takes it. `validateSeats` refuses a seat with no workspace before
 * any preview or launch, so one reaching here without it is a bug, not a request.
 */
const launchSeatOf = (seat: CrewProposalSeat): CrewLaunchSeat => {
  if (seat.workspace === undefined)
    throw new Error(`Seat ${seat.seat} reached the launcher without a workspace.`);
  return {
    name: seat.seat,
    agentId: seat.agentId,
    reason: seat.reason,
    instructions: seat.instructions,
    modelSelection: seat.modelSelection,
    runtimeMode: seat.runtimeMode,
    steps: seat.steps,
    workspace: seat.workspace,
  };
};

export class CrewProposalRequestError extends Data.TaggedError("CrewProposalRequestError")<{
  readonly detail: string;
  readonly nextStep: string;
}> {
  override get message(): string {
    return `${this.detail} ${this.nextStep}`;
  }
}

export class CrewProposalNotOpenError extends Data.TaggedError("CrewProposalNotOpenError")<{
  readonly proposalId: string;
  readonly status: string;
}> {
  override get message(): string {
    return `Proposal ${this.proposalId} is ${this.status}, not open; nothing was changed.`;
  }
}

export class CrewProposalNotFoundError extends Data.TaggedError("CrewProposalNotFoundError")<{
  readonly proposalId: string;
}> {
  override get message(): string {
    return `Proposal ${this.proposalId} does not exist in this environment.`;
  }
}

export class CrewProposalOperationError extends Data.TaggedError("CrewProposalOperationError")<{
  readonly phase: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Crew proposal failed while ${this.phase}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export type CrewProposalError =
  | CrewProposalRequestError
  | CrewProposalNotOpenError
  | CrewProposalNotFoundError
  | CrewProposalOperationError
  | CrewLaunchError;

export interface ProposeCrewInput {
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly displayName: string;
  readonly brief: string;
  readonly seats: ReadonlyArray<CrewProposalSeat>;
  /** The playbook the Crew follows, by name in the Captain's workspace. */
  readonly playbook?: { readonly name: string; readonly workspaceRoot: string } | undefined;
}

export interface RequestCrewMemberInput {
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly crewInstanceId: string | null;
  readonly seat: CrewProposalSeat;
  /** The brief the new seat starts on; the Crew's brief when omitted. */
  readonly brief: string | null;
}

export interface ResolveCrewProposalInput {
  readonly proposalId: string;
  readonly decision: "approve" | "decline";
  readonly approvalToken?: string | undefined;
  /** The human's final roster on approval; the requested seats when omitted. */
  readonly seats?: ReadonlyArray<CrewProposalSeat> | undefined;
  /** Who is answering, as the Captain is told; given only for a shared conversation. */
  readonly decidedBy?: string | null | undefined;
}

/** What the Captain is told about a playbook proposal it just filed. */
export interface CrewProposalPlaybookOutcome {
  readonly name: string;
  readonly title: string;
  readonly unownedSteps: ReadonlyArray<string>;
  readonly swaps: ReadonlyArray<{ readonly seat: string; readonly swap: CrewPersonaSwap }>;
}

export interface CrewProposalOutcome {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance | null;
  /** Present when this call validated a proposal that follows a playbook. */
  readonly playbook?: CrewProposalPlaybookOutcome | null | undefined;
}

/** Stands in for a folder on the host wherever a guest is shown a seat's workspace. */
const GUEST_PLACEHOLDER_PATH = "/";

/**
 * A seat as a guest is shown it: the same seat, with a worktree's folder on the host replaced.
 * Its branch, model and access are the roster's own and stay.
 */
export const withoutHostPaths = <S extends { readonly workspace?: CrewSeatWorkspace | undefined }>(
  seat: S,
): S =>
  seat.workspace?.type === "existing_worktree"
    ? { ...seat, workspace: { ...seat.workspace, worktreePath: GUEST_PLACEHOLDER_PATH } }
    : seat;

/**
 * A proposal as a guest is shown it: its seats without the host's folders, and a problem with
 * its playbook said without the reader's own words, which can name a file on the host.
 */
export const proposalForGuest = (proposal: ClientCrewProposal): ClientCrewProposal => ({
  ...proposal,
  requestedSeats: proposal.requestedSeats.map(withoutHostPaths),
  approvedSeats: proposal.approvedSeats?.map(withoutHostPaths) ?? null,
  ...(proposal.playbook == null || proposal.playbook.issue == null
    ? {}
    : {
        playbook: {
          ...proposal.playbook,
          issue: "This roster's playbook has a problem. A member can see what it is.",
        },
      }),
});

export interface CrewProposalServiceShape {
  readonly preview: (
    input: CrewProposalPreviewRequest,
    /**
     * For a guest's connection: the host's folders and branches are left out, and git is not
     * asked for them. A guest approves a roster as proposed and has no use for where a seat
     * could be moved to.
     */
    options?: { readonly forGuest?: boolean },
  ) => Effect.Effect<CrewProposalPreviewResponse, CrewProposalError>;
  readonly propose: (
    input: ProposeCrewInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
  readonly requestMember: (
    input: RequestCrewMemberInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
  /**
   * Resolves a proposal once. A decline is told to the Captain and recorded. An approval records
   * the Crew, resolves the proposal, then attempts every seat; the launch report tells the
   * Captain what became of each, including seats that were never created.
   */
  readonly resolve: (
    input: ResolveCrewProposalInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
}

export class CrewProposalService extends Context.Service<
  CrewProposalService,
  CrewProposalServiceShape
>()("t3/j5/a2a/CrewProposalService") {}

const seatNamesUnique = (seats: ReadonlyArray<CrewProposalSeat>) =>
  new Set(seats.map(({ seat }) => seat)).size === seats.length;

type PlannedPlaybook = Extract<CrewPlaybookPlan, { readonly problem: null }>;

const playbookOutcome = (plan: PlannedPlaybook): CrewProposalPlaybookOutcome | null =>
  plan.summary === null
    ? null
    : {
        name: plan.summary.name,
        title: plan.summary.title,
        unownedSteps: plan.unownedSteps,
        swaps: [...plan.swapsBySeat].flatMap(([seat, swaps]) =>
          swaps.map((swap) => ({ seat, swap })),
        ),
      };

/** The token binds this digest, so a live edit the card has not shown refuses the approval. */
const planDigest = (playbook: CrewPlaybookRef | null | undefined, plan: PlannedPlaybook) =>
  playbook == null || plan.summary === null
    ? undefined
    : crewPlaybookPlanDigest({
        definitionPath: playbook.definitionPath,
        summary: plan.summary,
        swapsBySeat: plan.swapsBySeat,
        unownedSteps: plan.unownedSteps,
      });

/**
 * The playbook a launch records and briefs. Without a readable definition (possible only when no
 * seat claims a step) the Crew still records it, and each brief says the seat owns no steps.
 */
const launchPlaybook = (
  playbook: CrewPlaybookRef | null | undefined,
  definition: PlaybookReadResponse | null,
): CrewLaunchPlaybook | null =>
  playbook == null
    ? null
    : {
        name: playbook.name,
        definitionPath: playbook.definitionPath,
        title: definition?.title ?? playbook.name,
        steps: (definition?.steps ?? []).map(({ id, title }) => ({ id, title })),
      };

const claimsSteps = (seats: ReadonlyArray<CrewProposalSeat>) =>
  seats.some((seat) => (seat.steps?.length ?? 0) > 0);

const memberSteps = (instance: AgentCrewInstance | null) =>
  (instance?.members ?? []).map((member) => ({
    seatName: member.seatName,
    playbookStepIds: member.playbookStepIds ?? [],
  }));

export const layer = Layer.effect(
  CrewProposalService,
  Effect.gen(function* () {
    const proposals = yield* AgentCrewProposalService;
    const crews = yield* AgentCrewInstanceService;
    const launcher = yield* CrewLaunchService;
    const reporter = yield* CrewLaunchReporter;
    const recordAnalytics = yield* j5AnalyticsRecorder;
    /** `j5.crew.proposal.resolved`: what the person decided, and what they changed first. */
    const recordResolved = Effect.fn("j5.a2a.crewProposal.recordResolved")(function* (
      proposal: CrewProposal,
      approved: ReadonlyArray<CrewProposalSeat> | null,
    ) {
      const changes =
        approved === null ? null : crewRosterChanges(proposal.requestedSeats, approved);
      yield* recordAnalytics("j5.crew.proposal.resolved", {
        kind: proposal.kind,
        decision: approved === null ? "declined" : "approved",
        requestedSeats: proposal.requestedSeats.length,
        hasPlaybook: proposal.playbook !== undefined && proposal.playbook !== null,
        ...durationMsBetween(proposal.createdAt, DateTime.formatIso(yield* DateTime.now)),
        ...(approved === null || changes === null
          ? {}
          : {
              approvedSeats: approved.length,
              seatsAdded: changes.added.length,
              seatsRemoved: changes.removed.length,
              seatsRenamed: changes.renamed.length,
              seatsRuntimeChanged: changes.runtimeChanged.length,
              seatsInstructionsChanged: changes.instructionsChanged.length,
            }),
      });
    });
    const threadManagement = yield* ThreadManagementService;
    const ledger = yield* A2ALedger;
    const agents = yield* makeAgentPersonaLibrary;
    const playbooks = yield* PlaybookStore;
    // One resolution of a proposal at a time on this server, so an approval and a decline from
    // two devices cannot interleave; the store's compare-and-set from open decides the winner.
    const gates = yield* KeyedLock.make<string>();

    const operationError = (phase: string) => (cause: unknown) =>
      new CrewProposalOperationError({ phase, cause });

    /** The one refusal for an addition past the cap, whether filed or approved. */
    const crewFullError = (
      displayName: string,
      held: number,
      adding: number,
      kind: "request" | "approval",
    ) =>
      new CrewProposalRequestError({
        detail:
          kind === "request"
            ? `Crew ${displayName} is full: it holds ${held} of ${CREW_SEAT_CAP} seats counting requests still open, and this request adds ${adding}.`
            : `Crew ${displayName} is full: it holds ${held} of ${CREW_SEAT_CAP} seats, and this approval adds ${adding}.`,
        nextStep:
          "A member finishing frees no seat. Work with the seats this crew has, or propose a new crew for the extra hands.",
      });

    /**
     * A playbook the Crew cannot follow, told to whoever is at the door: the Captain naming one
     * to propose, the Captain adding a seat to a Crew that follows one, or the person approving.
     */
    const playbookRefusal =
      (name: string, door: "propose" | "crew" | "approval") => (error: PlaybookError) =>
        door === "approval"
          ? new CrewProposalRequestError({
              detail:
                error.code === "not_found"
                  ? `Playbook ${name} can no longer be read: its file is gone from the Captain's workspace.`
                  : `Playbook ${name} can no longer be read: ${error.message}`,
              nextStep:
                "Ask the Captain to fix the playbook and propose again, or decline this proposal.",
            })
          : door === "crew"
            ? new CrewProposalRequestError({
                detail:
                  error.code === "not_found"
                    ? `Playbook ${name}, which this crew follows, can no longer be read: its file is gone from the Captain's workspace.`
                    : `Playbook ${name}, which this crew follows, can no longer be read: ${error.message}`,
                nextStep: "Restore or fix the playbook file, or request the seat without steps.",
              })
            : error.code === "not_found" || error.code === "invalid_name"
              ? new CrewProposalRequestError({
                  detail: `No playbook named ${name} in your workspace.`,
                  nextStep: "Call j5_playbook_list and pass a name it returns.",
                })
              : new CrewProposalRequestError({
                  detail: `Playbook ${name} cannot be followed: ${error.message}`,
                  nextStep:
                    "Fix the definition until j5_playbook_list lists it without an issue, then retry.",
                });

    /** The live definition; a Crew's plan is always checked against the YAML as it is now. */
    const readPlaybook = (playbook: CrewPlaybookRef, door: "propose" | "crew" | "approval") =>
      playbooks
        .readPath(playbook.definitionPath)
        .pipe(Effect.mapError(playbookRefusal(playbook.name, door)));

    /**
     * A followed Crew's definition for seats joining it. Only a seat claiming steps needs it, so
     * a missing or broken file refuses only those; other seats go ahead without live titles.
     */
    const readFollowed = (
      playbook: CrewPlaybookRef | null | undefined,
      seats: ReadonlyArray<CrewProposalSeat>,
      door: "crew" | "approval",
    ) =>
      playbook == null
        ? Effect.succeed(null)
        : claimsSteps(seats)
          ? readPlaybook(playbook, door)
          : playbooks.readPath(playbook.definitionPath).pipe(Effect.orElseSucceed(() => null));

    /**
     * Persona seats must name known, enabled personas; the library is the source of truth, not the
     * Captain. A custom seat names none and is checked for shape only. A playbook Crew's seats
     * must claim existing steps, one owner each.
     */
    const validateSeats = Effect.fn("j5.a2a.crewProposal.validateSeats")(function* (
      seats: ReadonlyArray<CrewProposalSeat>,
      /** The live Crew's seat names for an addition; null for a new roster. */
      existingSeatNames: ReadonlyArray<string> | null,
      humanReview = false,
      playbook: {
        readonly definition: PlaybookReadResponse;
        readonly existingMembers: ReturnType<typeof memberSteps>;
      } | null = null,
    ) {
      if (seats.length === 0)
        return yield* new CrewProposalRequestError({
          detail: "A crew request needs at least one seat.",
          nextStep: "Call j5_list_personas, then propose seats with a reason each.",
        });
      // The MCP schema already bounds a Captain's seats; the human's card submits the same shape
      // through HTTP, so every door meets the rule here rather than surfacing a storage error.
      for (const seat of seats) {
        if (
          !humanReview &&
          seat.agentId !== null &&
          (seat.modelSelection !== undefined || seat.runtimeMode !== undefined)
        )
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} is a saved persona; only the human can override its runtime.`,
            nextStep:
              "Propose the persona with its defaults; the human may edit its runtime before approval.",
          });
        const problem = crewSeatShapeProblem(seat);
        if (problem !== null)
          return yield* new CrewProposalRequestError({
            detail: `Seat "${seat.seat}": ${problem.detail}`,
            nextStep: `Correct the seat's ${problem.field} and retry.`,
          });
      }
      if (!seatNamesUnique(seats))
        return yield* new CrewProposalRequestError({
          detail: "Seat names must be unique within a crew.",
          nextStep: "Rename the duplicate seats and retry.",
        });
      const taken = seats.find((seat) => existingSeatNames?.includes(seat.seat));
      if (taken !== undefined)
        return yield* new CrewProposalRequestError({
          detail: `The crew already has a seat named ${taken.seat}.`,
          nextStep: "Choose a different seat name.",
        });
      if (existingSeatNames === null && seats.length > CREW_SEAT_CAP)
        return yield* new CrewProposalRequestError({
          detail: `A crew may hold at most ${CREW_SEAT_CAP} seats; this roster names ${seats.length}.`,
          nextStep: `Keep the roster to ${CREW_SEAT_CAP} seats; a second crew is how you get more hands.`,
        });
      const catalog = yield* agents
        .catalog()
        .pipe(Effect.mapError(operationError("reading the agent library")));
      for (const seat of seats) {
        if (seat.agentId === null) continue;
        const problem = personaCatalogProblem(catalog, seat.agentId);
        if (problem === "missing")
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} names persona "${seat.agentId}", which is not in this environment's library.`,
            nextStep: "Call j5_list_personas and pick a persona id it returns.",
          });
        if (problem === "disabled")
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} names persona "${seat.agentId}", which is turned off.`,
            nextStep:
              "Pick an enabled persona from j5_list_personas, or ask the user to turn it on.",
          });
      }
      const plan = planCrewPlaybook({
        definition: playbook?.definition ?? null,
        seats,
        existingMembers: playbook?.existingMembers ?? [],
        catalog,
      });
      if (plan.problem !== null) return yield* new CrewProposalRequestError(plan.problem);
      return plan;
    });

    /** The decline is told at once; an approval is told by the launch report, once the seats are up. */
    const notifyDeclined = Effect.fn("j5.a2a.crewProposal.notifyDeclined")(function* (
      proposal: CrewProposal,
    ) {
      const stable = { providerSessionId: PROPOSAL_SESSION, requestKey: proposal.id };
      const captain = yield* getThreadProjectionIfPresent(
        threadManagement,
        proposal.captainThreadId,
      ).pipe(Effect.mapError(operationError("reading the Captain thread")));
      // A deleted Captain takes no messages; the decline still has to go through, or the gate
      // it was refused at could never close.
      if (captain === null || captain.thread.deletedAt != null) return;
      yield* threadManagement
        .dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          commandId: lifecycleCommandId({ ...stable, operation: "proposal-notice" }),
          threadId: proposal.captainThreadId,
          messageId: MessageId.make(
            lifecycleId({ ...stable, kind: "message", operation: "proposal-notice" }),
          ),
          text: crewDeclinedNoticeText(proposal),
          attachments: [],
          modelSelection: captain.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.mapError(operationError("notifying the Captain")));
    });

    const captainFor = Effect.fn("j5.a2a.crewProposal.captainFor")(function* (
      proposal: CrewProposal,
    ) {
      const projection = yield* getThreadProjectionIfPresent(
        threadManagement,
        proposal.captainThreadId,
      ).pipe(Effect.mapError(operationError("reading the Captain thread")));
      // Checked when the person approves, not held: a Captain archived or deleted while its gate
      // is open is refused here, since new seats would be briefed to report to a participant
      // delivery no longer reaches. A Captain archived after this read is not caught.
      if (projection === null || projection.thread.deletedAt != null)
        return yield* new CrewProposalRequestError({
          detail: `Captain ${projection?.thread.title ?? proposal.captainParticipantId} has been deleted, so this crew has no one to command it.`,
          nextStep: "Decline this proposal.",
        });
      if (projection.thread.archivedAt !== null)
        return yield* new CrewProposalRequestError({
          detail: `Captain ${projection.thread.title} is archived, so this crew has no one to command it.`,
          nextStep: "Unarchive the Captain to approve it, or decline this proposal.",
        });
      const project = yield* ledger
        .readProjectLedger(proposal.projectId)
        .pipe(Effect.mapError(operationError("reading the project")));
      return {
        projectId: proposal.projectId,
        projectTitle: project.name,
        participantId: proposal.captainParticipantId,
        thread: projection.thread,
      } satisfies CrewCaptain;
    });

    /**
     * Resolves the proposal as approved, compare-and-set from open. It runs before any seat
     * spawns, so a proposal that launched can never be approved or declined again.
     */
    const recordApproval = (
      proposal: CrewProposal,
      seats: ReadonlyArray<CrewProposalSeat>,
    ): Effect.Effect<void, CrewLaunchOperationError> =>
      Effect.gen(function* () {
        const failed = (cause: unknown) =>
          new CrewLaunchOperationError({
            phase: `approving proposal ${proposal.id}`,
            seatName: null,
            createdSeats: [],
            cause,
          });
        const approved = yield* proposals
          .resolve({
            id: proposal.id,
            decision: "approve",
            approvedSeats: seats,
            resolvedAt: DateTime.formatIso(yield* DateTime.now),
            decidedBy: proposal.decidedBy,
          })
          .pipe(Effect.mapError(failed));
        if (approved === null)
          return yield* failed(
            `proposal ${proposal.id} was no longer open, so nothing was launched`,
          );
      });

    /**
     * Launch the approved seats: the Crew is recorded and linked, the proposal resolved, then every
     * seat is attempted. The proposal id keys every spawn.
     */
    const fulfil = Effect.fn("j5.a2a.crewProposal.fulfil")(function* (
      proposal: CrewProposal,
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewProposalSeat>,
      resolvedSeats: ReadonlyArray<ResolvedCrewLaunchSeat>,
      playbook: CrewLaunchPlaybook | null,
    ) {
      const launchSeats = seats.map(launchSeatOf);
      if (proposal.kind === "roster") {
        return yield* launcher.launch({
          providerSessionId: PROPOSAL_SESSION,
          requestKey: proposal.id,
          captain,
          displayName: proposal.displayName,
          seats: launchSeats,
          resolvedSeats,
          brief: proposal.brief,
          playbook,
          // The launch report finds its Crew through this link, so a lost write fails the
          // approval before any seat spawns; recording is idempotent, so approving again is safe.
          onRecorded: (instance) =>
            proposals.attachInstance(proposal.id, instance.id).pipe(
              Effect.mapError(
                (cause) =>
                  new CrewLaunchOperationError({
                    phase: `linking proposal ${proposal.id} to crew ${instance.id}`,
                    seatName: null,
                    createdSeats: [],
                    cause,
                  }),
              ),
              Effect.andThen(recordApproval(proposal, seats)),
            ),
        });
      }
      const instance =
        proposal.crewInstanceId === null
          ? null
          : yield* crews
              .read(proposal.crewInstanceId)
              .pipe(Effect.mapError(operationError("reading the crew")));
      if (instance === null)
        return yield* new CrewProposalRequestError({
          detail: `Proposal ${proposal.id} adds to crew ${proposal.crewInstanceId}, which no longer exists.`,
          nextStep: "Decline this proposal.",
        });
      return yield* launcher.addSeats({
        providerSessionId: PROPOSAL_SESSION,
        requestKey: proposal.id,
        captain,
        instance,
        seats: launchSeats,
        resolvedSeats,
        brief: proposal.brief,
        playbook,
        onReserved: () => recordApproval(proposal, seats),
      });
    });

    const propose: CrewProposalServiceShape["propose"] = (input) =>
      Effect.gen(function* () {
        let playbook: { ref: CrewPlaybookRef; definition: PlaybookReadResponse } | null = null;
        if (input.playbook !== undefined) {
          const { definitionPath } = yield* playbooks
            .definitionPathFor(input.playbook.workspaceRoot, input.playbook.name)
            .pipe(Effect.mapError(playbookRefusal(input.playbook.name, "propose")));
          const definition = yield* readPlaybook(
            { name: input.playbook.name, definitionPath },
            "propose",
          );
          playbook = { ref: { name: definition.name, definitionPath }, definition };
        }
        const plan = yield* validateSeats(
          input.seats,
          null,
          false,
          playbook === null ? null : { definition: playbook.definition, existingMembers: [] },
        );
        const proposal = yield* proposals
          .create({
            id: lifecycleId({
              kind: "crew",
              operation: "proposal",
              providerSessionId: PROPOSAL_SESSION,
              requestKey: input.requestKey,
            }),
            projectId: input.captain.projectId,
            captainParticipantId: input.captain.participantId,
            captainThreadId: input.captain.thread.id,
            crewInstanceId: null,
            kind: "roster",
            brief: input.brief,
            displayName: input.displayName,
            requestedSeats: withPersonaSwaps(input.seats, plan.swapsBySeat),
            createdAt: DateTime.formatIso(yield* DateTime.now),
            playbook: playbook?.ref ?? null,
          })
          .pipe(Effect.mapError(operationError("recording the proposal")));
        if (proposal.status !== "open") {
          const instance =
            proposal.crewInstanceId === null
              ? null
              : yield* crews.read(proposal.crewInstanceId).pipe(Effect.orDie);
          return { proposal, instance, playbook: playbookOutcome(plan) };
        }
        return { proposal, instance: null, playbook: playbookOutcome(plan) };
      });

    const requestMember: CrewProposalServiceShape["requestMember"] = (input) =>
      Effect.gen(function* () {
        const commanded = yield* crews
          .listForCaptain({
            projectId: input.captain.projectId,
            captainParticipantId: input.captain.participantId,
          })
          .pipe(
            Effect.map((instances) => instances.filter((instance) => instance.archivedAt === null)),
            Effect.mapError(operationError("reading commanded crews")),
          );
        const instance =
          input.crewInstanceId === null
            ? commanded.length === 1
              ? commanded[0]!
              : null
            : (commanded.find(({ id }) => id === input.crewInstanceId) ?? null);
        if (instance === null)
          return yield* new CrewProposalRequestError({
            detail:
              commanded.length === 0
                ? "You command no live crew, so there is nothing to add a member to."
                : input.crewInstanceId === null
                  ? `You command ${commanded.length} crews; say which one.`
                  : `You do not command crew ${input.crewInstanceId}.`,
            nextStep:
              commanded.length === 0
                ? "Propose a crew with j5_propose_crew first."
                : `Retry with crew_instance_id set to one of: ${commanded.map(({ id }) => id).join(", ")}.`,
          });
        const proposalId = lifecycleId({
          kind: "crew",
          operation: "proposal",
          providerSessionId: PROPOSAL_SESSION,
          requestKey: input.requestKey,
        });
        // A replayed request finds its proposal before anything is checked or counted: once its
        // seat has launched, the name clash and the cap would both refuse the retry otherwise.
        const replayed = yield* proposals
          .read(proposalId)
          .pipe(Effect.mapError(operationError("reading the proposal")));
        if (replayed !== null) {
          const current = yield* crews.read(instance.id).pipe(Effect.orDie);
          return { proposal: replayed, instance: current };
        }
        const definition = yield* readFollowed(instance.playbook, [input.seat], "crew");
        const plan = yield* validateSeats(
          [input.seat],
          instance.members.map(({ seatName }) => seatName),
          false,
          definition === null ? null : { definition, existingMembers: memberSteps(instance) },
        );
        const admitted = yield* proposals
          .admit(
            {
              id: proposalId,
              projectId: input.captain.projectId,
              captainParticipantId: input.captain.participantId,
              captainThreadId: input.captain.thread.id,
              crewInstanceId: instance.id,
              kind: "addition",
              brief: input.brief ?? instance.brief,
              displayName: instance.displayName,
              requestedSeats: withPersonaSwaps([input.seat], plan.swapsBySeat),
              createdAt: DateTime.formatIso(yield* DateTime.now),
              playbook: instance.playbook ?? null,
            },
            { maxSeats: CREW_SEAT_CAP },
          )
          .pipe(Effect.mapError(operationError("recording the proposal")));
        if (admitted.status === "cap-exceeded")
          return yield* crewFullError(
            instance.displayName,
            admitted.held,
            admitted.adding,
            "request",
          );
        if (admitted.proposal.status !== "open") {
          const current = yield* crews.read(instance.id).pipe(Effect.orDie);
          return {
            proposal: admitted.proposal,
            instance: current,
            playbook: playbookOutcome(plan),
          };
        }
        return { proposal: admitted.proposal, instance, playbook: playbookOutcome(plan) };
      });

    /**
     * A roster approval that recorded its Crew and then failed before it resolved (its link or
     * its resolution write) spawned nothing. Declining that proposal retires the empty record so
     * no Crew is left live beneath a declined card.
     */
    const retireUnlaunchedCrew = Effect.fn("j5.a2a.crewProposal.retireUnlaunchedCrew")(function* (
      proposal: CrewProposal,
    ) {
      if (proposal.kind !== "roster" || proposal.crewInstanceId === null) return;
      const instance = yield* crews
        .read(proposal.crewInstanceId)
        .pipe(Effect.mapError(operationError("reading the crew")));
      if (instance === null || instance.archivedAt !== null) return;
      yield* crews
        .markArchived(instance.id, DateTime.formatIso(yield* DateTime.now))
        .pipe(Effect.mapError(operationError("retiring the unlaunched crew")));
    });

    const resolveRuntime = (captain: CrewCaptain, seats: ReadonlyArray<CrewProposalSeat>) =>
      launcher.resolveSeats(captain, seats.map(launchSeatOf));

    /** Preview and approval consult the same live roster and the same live playbook. */
    const validateProposalSeats = Effect.fn("j5.a2a.crewProposal.validateProposalSeats")(function* (
      proposal: CrewProposal,
      seats: ReadonlyArray<CrewProposalSeat>,
    ) {
      // The human may have renamed or added seats on the card; check them against the live
      // roster, or an approved duplicate would spawn a seat the snapshot cannot record.
      const existingCrew =
        proposal.crewInstanceId === null || proposal.kind === "roster"
          ? null
          : yield* crews
              .read(proposal.crewInstanceId)
              .pipe(Effect.mapError(operationError("reading the crew")));
      // A request left open past j5_archive_crew must not seat agents into a retired Crew.
      if (existingCrew !== null && existingCrew.archivedAt !== null)
        return yield* new CrewProposalRequestError({
          detail: `Proposal ${proposal.id} adds to crew ${existingCrew.id}, which has been retired.`,
          nextStep: "Decline this proposal.",
        });
      const otherSeats =
        proposal.kind === "roster"
          ? null
          : (existingCrew?.members ?? []).map(({ seatName }) => seatName);
      // Read again at every preview and approval: a step removed or a file broken since the
      // Captain proposed refuses a seat claiming steps here, and the card shows why.
      const definition = yield* readFollowed(proposal.playbook, seats, "approval");
      const plan = yield* validateSeats(
        seats,
        otherSeats,
        true,
        definition === null ? null : { definition, existingMembers: memberSteps(existingCrew) },
      );
      // The request was counted against open requests when it was filed; the approval only has
      // to fit the live rows, which the member store enforces again when it reserves them.
      if (otherSeats !== null && otherSeats.length + seats.length > CREW_SEAT_CAP)
        return yield* crewFullError(
          proposal.displayName,
          otherSeats.length,
          seats.length,
          "approval",
        );
      return { plan, definition };
    });

    const preview: CrewProposalServiceShape["preview"] = Effect.fn("j5.a2a.crewProposal.preview")(
      function* (input, options) {
        const forGuest = options?.forGuest === true;
        const proposal = yield* proposals
          .read(input.proposalId)
          .pipe(Effect.mapError(operationError("reading the proposal")));
        if (proposal === null)
          return yield* new CrewProposalNotFoundError({ proposalId: input.proposalId });
        if (proposal.status !== "open")
          return yield* new CrewProposalNotOpenError({
            proposalId: proposal.id,
            status: proposal.status,
          });
        const seats = input.seats ?? proposal.requestedSeats;
        const { plan } = yield* validateProposalSeats(proposal, seats);
        const captain = yield* captainFor(proposal);
        const resolved = yield* resolveRuntime(captain, seats);
        return {
          proposalId: proposal.id,
          ...(forGuest ? {} : { workspaceOptions: yield* launcher.workspaceOptions(captain) }),
          approvalToken: crewApprovalToken(
            proposal,
            captain,
            resolved,
            planDigest(proposal.playbook, plan),
          ),
          seats: resolved.map((entry) => {
            const swaps = plan.swapsBySeat.get(entry.runtime.seat);
            const runtime = forGuest ? withoutHostPaths(entry.runtime) : entry.runtime;
            return swaps === undefined ? runtime : { ...runtime, personaSwaps: swaps };
          }),
          ...(plan.summary === null
            ? {}
            : { playbook: plan.summary, unownedSteps: plan.unownedSteps }),
        };
      },
    );

    const resolve: CrewProposalServiceShape["resolve"] = (input) =>
      gates.withLock(
        input.proposalId,
        Effect.gen(function* () {
          // Who is answering rides on the proposal from here: both notices and the record read it.
          const proposal = yield* proposals.read(input.proposalId).pipe(
            Effect.mapError(operationError("reading the proposal")),
            Effect.map((read) =>
              read === null ? null : { ...read, decidedBy: input.decidedBy ?? null },
            ),
          );
          if (proposal === null)
            return yield* new CrewProposalNotFoundError({ proposalId: input.proposalId });
          if (proposal.status !== "open")
            return yield* new CrewProposalNotOpenError({
              proposalId: proposal.id,
              status: proposal.status,
            });
          if (input.decision === "decline") {
            // Told before it is recorded: a notice or cleanup the store refused leaves the
            // proposal open for the person to decline again, and the notice id is deterministic.
            yield* retireUnlaunchedCrew(proposal);
            yield* notifyDeclined(proposal);
            const declined = yield* proposals
              .resolve({
                id: proposal.id,
                decision: "decline",
                approvedSeats: null,
                resolvedAt: DateTime.formatIso(yield* DateTime.now),
                decidedBy: proposal.decidedBy,
              })
              .pipe(Effect.mapError(operationError("recording the decline")));
            if (declined === null)
              return yield* new CrewProposalNotOpenError({
                proposalId: proposal.id,
                status: "resolved",
              });
            yield* recordResolved(proposal, null);
            return { proposal: declined, instance: null } satisfies CrewProposalOutcome;
          }
          const seats = input.seats ?? proposal.requestedSeats;
          const { plan, definition } = yield* validateProposalSeats(proposal, seats);
          const captain = yield* captainFor(proposal);
          const resolved = yield* resolveRuntime(captain, seats);
          if (
            input.approvalToken !==
            crewApprovalToken(proposal, captain, resolved, planDigest(proposal.playbook, plan))
          )
            return yield* new CrewProposalRequestError({
              detail:
                "The crew runtime preview is missing or has changed since it was shown: the roster, a seat's runtime, the playbook plan, a seat's workspace, or the Captain's branch or worktree may have changed.",
              nextStep: "Refresh the preview and review the current settings before approving.",
            });
          const launched = yield* fulfil(
            proposal,
            captain,
            withPersonaSwaps(seats, plan.swapsBySeat),
            resolved,
            launchPlaybook(proposal.playbook, definition),
          ).pipe(
            // The member store is the last word on ownership: two additions that both passed
            // preview race to it, and the second is refused with nothing written and left open.
            Effect.catchTags({
              CrewStepAlreadyOwnedError: (error) =>
                Effect.fail(
                  new CrewProposalRequestError({
                    detail: `Step ${error.stepId} is already owned by seat ${error.ownerSeat}.`,
                    nextStep: "Ask the Captain to request the seat again with only unowned steps.",
                  }),
                ),
            }),
          );
          const final = yield* proposals
            .read(proposal.id)
            .pipe(Effect.mapError(operationError("reading the approved proposal")));
          // The Captain hears once the seats have started or failed to start, not now: a
          // dispatched brief is intent, and the report says what became of it.
          yield* reporter.watch(proposal.id, launched.seats);
          yield* recordResolved(proposal, seats);
          return {
            proposal: final ?? proposal,
            instance: launched.instance,
          } satisfies CrewProposalOutcome;
        }),
      );

    return CrewProposalService.of({ propose, requestMember, preview, resolve });
  }),
);
