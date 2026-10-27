import {
  describeCrewSeatRuntime,
  materializeCrewModelSelection,
  crewModelSelectionProblem,
} from "./crewRuntimePreview.ts";
import type { CrewProposalSeatRuntime, CrewWorkspaceOptions } from "@t3tools/contracts/j5";
import { isProviderAvailable } from "@t3tools/contracts";
import type {
  ModelSelection,
  OrchestrationV2AgentPersonaCommandAssignment,
  OrchestrationV2AppThread,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { prepareAgentPersonaLaunch } from "../agents/agentPersonaLaunch.ts";
import { agentHandoffArtifactPath } from "../agents/agentPersonaArtifacts.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import {
  providerCanEnforceAgentPersonaAuthority,
  translateAgentPersonaProviderPolicy,
} from "../agents/agentPersonaProviderPolicy.ts";
import {
  AgentCrewInstanceService,
  CrewStepAlreadyOwnedError,
  type AgentCrewInstance,
} from "./AgentCrewInstanceService.ts";
import { j5AnalyticsRecorder } from "../analytics/recorder.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import {
  type ResolvedSpawnWorkspace,
  type SpawnWorkspaceChoice,
  SpawnWorkspaceService,
  namedBaseRefs,
  namedWorktreePaths,
  resolveSpawnWorkspace,
  spawnCreateCommandId,
  spawnThreadCheckout,
} from "./spawnWorkspace.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";
import { CREW_SEAT_CAP } from "./crewLimits.ts";
import type { ParticipantId, LedgerProjectId } from "./contracts.ts";
import {
  crewSeatRequestKey,
  spawnCrewInstanceId,
  spawnFirstTurnText,
  spawnHomeCommandId,
  spawnMessageId,
  spawnPlacementCommandId,
  spawnThreadId,
  spawnTitle,
} from "./spawnIds.ts";

/**
 * One approved seat: who fills it, why, and any wiring text its brief carries verbatim. A null
 * agent is a custom seat: the human can override its runtime; an omitted model selection inherits
 * the Captain's, and omitted access is Full access.
 */
export interface CrewLaunchSeat {
  readonly name: string;
  readonly agentId: string | null;
  readonly reason: string | null;
  readonly instructions?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  /** Ids of the playbook steps the seat owns; recorded on its member row. */
  readonly steps?: ReadonlyArray<string> | undefined;
  /** Where the seat works, chosen for every seat. */
  readonly workspace: SpawnWorkspaceChoice;
}

/**
 * The playbook a Crew follows as its seats are briefed: its identity for the record, and the live
 * step titles each seat's first turn lists.
 */
export interface CrewLaunchPlaybook {
  readonly name: string;
  readonly definitionPath: string;
  readonly title: string;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

/**
 * Hard cap per Crew, initial roster and additions together. The proposal gate checks it when a
 * roster or request is filed (counting pending requests); additions are also enforced inside the
 * store's reservation transaction so two approvals landing together cannot both slip under it.
 */
export { CREW_SEAT_CAP };

export interface CrewCaptain {
  readonly projectId: LedgerProjectId;
  readonly projectTitle: string;
  readonly participantId: ParticipantId;
  readonly thread: OrchestrationV2AppThread;
}

/** One immutable resolution shared by preview, approval validation, and thread creation. */
export interface ResolvedCrewLaunchSeat {
  readonly seat: CrewLaunchSeat;
  readonly assignment: OrchestrationV2AgentPersonaCommandAssignment | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly outputArtifact: string | null;
  readonly agentDisplayName: string;
  readonly workspace: ResolvedSpawnWorkspace;
  readonly runtime: CrewProposalSeatRuntime;
}

export interface CrewLaunchInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly displayName: string;
  readonly seats: ReadonlyArray<CrewLaunchSeat>;
  readonly resolvedSeats?: ReadonlyArray<ResolvedCrewLaunchSeat>;
  readonly brief: string;
  readonly playbook?: CrewLaunchPlaybook | null | undefined;
  /**
   * Runs once the Crew is recorded and before any seat spawns, so the caller can bind its own
   * record (the proposal) to the instance and resolve it. A failure here aborts the launch with
   * no seat spawned; recording is idempotent, so the same approval can be made again.
   */
  readonly onRecorded?: (
    instance: AgentCrewInstance,
  ) => Effect.Effect<void, CrewLaunchOperationError>;
}

export interface CrewAddSeatsInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly instance: AgentCrewInstance;
  readonly seats: ReadonlyArray<CrewLaunchSeat>;
  readonly resolvedSeats?: ReadonlyArray<ResolvedCrewLaunchSeat>;
  /** The brief the new seats start on; defaults to the Crew's original brief. */
  readonly brief?: string | undefined;
  /** The Crew's playbook with live titles, for the new seats' briefs. */
  readonly playbook?: CrewLaunchPlaybook | null | undefined;
  /**
   * Runs once the seats are reserved and before any spawns, like `onRecorded` on a launch. A
   * failure releases the reservation, so the request can be approved again.
   */
  readonly onReserved?: (
    instance: AgentCrewInstance,
  ) => Effect.Effect<void, CrewLaunchOperationError>;
}

/**
 * How one approved seat's launch went: `created` when its thread, home, and brief all went out;
 * `not_created` when its thread was never created, so its row is dropped and nothing can message
 * it; `not_started` when the thread exists but its home or its brief did not go through.
 */
export type CrewSeatLaunchOutcome =
  | { readonly seatName: string; readonly kind: "created" }
  | { readonly seatName: string; readonly kind: "not_created"; readonly detail: string }
  | { readonly seatName: string; readonly kind: "not_started"; readonly detail: string };

export interface CrewLaunchResult {
  /** The Crew as launched: seats that were never created are no longer on it. */
  readonly instance: AgentCrewInstance;
  readonly seats: ReadonlyArray<CrewSeatLaunchOutcome>;
}

export class CrewLaunchSeatUnavailableError extends Data.TaggedError(
  "CrewLaunchSeatUnavailableError",
)<{ readonly seatName: string; readonly agentId: string; readonly detail: string }> {
  override get message(): string {
    return `Seat ${this.seatName} (agent ${this.agentId}) is unavailable: ${this.detail} Nothing was spawned.`;
  }
}

/** The Crew is full; the seats it holds already reach the cap once the request is counted. */
export class CrewLaunchCapError extends Data.TaggedError("CrewLaunchCapError")<{
  readonly crewInstanceId: string;
  readonly held: number;
  readonly adding: number;
  readonly cap: number;
}> {
  override get message(): string {
    return `Crew ${this.crewInstanceId} holds ${this.held} seats; adding ${this.adding} would exceed the cap of ${this.cap}. Nothing was spawned.`;
  }
}

/** A seat name the reservation could not take: another participant already holds it. */
export class CrewLaunchSeatConflictError extends Data.TaggedError("CrewLaunchSeatConflictError")<{
  readonly crewInstanceId: string;
  readonly seatNames: ReadonlyArray<string>;
}> {
  override get message(): string {
    return `Crew ${this.crewInstanceId} already holds ${this.seatNames.length === 1 ? "a seat" : "seats"} named ${this.seatNames.join(", ")} filled by a different agent. Nothing was spawned.`;
  }
}

export class CrewLaunchOperationError extends Data.TaggedError("CrewLaunchOperationError")<{
  readonly phase: string;
  readonly seatName: string | null;
  readonly createdSeats: ReadonlyArray<string>;
  readonly cause: unknown;
}> {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    const seat = this.seatName === null ? "" : ` seat ${this.seatName}`;
    return `Crew launch failed while ${this.phase}${seat}: ${cause} Seats created so far: ${this.createdSeats.join(", ") || "none"}.`;
  }
}

export type CrewLaunchError =
  | CrewLaunchSeatUnavailableError
  | CrewLaunchCapError
  | CrewLaunchSeatConflictError
  | CrewLaunchOperationError
  // Passed through every wrapper so the gate can refuse the approval with its own words.
  | CrewStepAlreadyOwnedError;

/** Wraps a store failure for the launch, except a step-ownership refusal, which stays typed. */
const unlessStepOwned =
  (wrap: (cause: unknown) => CrewLaunchOperationError) =>
  <E>(cause: E): CrewLaunchOperationError | CrewStepAlreadyOwnedError =>
    cause instanceof CrewStepAlreadyOwnedError ? cause : wrap(cause);

export interface CrewLaunchServiceShape {
  readonly resolveSeats: (
    captain: CrewCaptain,
    seats: ReadonlyArray<CrewLaunchSeat>,
  ) => Effect.Effect<ReadonlyArray<ResolvedCrewLaunchSeat>, CrewLaunchError>;
  /**
   * Launch an approved roster once: seats resolve, the instance is recorded with every planned
   * seat, `onRecorded` runs, then every seat is attempted and briefed. A seat that fails does not
   * stop the next one; each seat's outcome is returned, and a seat whose thread was never created
   * is dropped from the record so the roster matches what exists.
   */
  readonly launch: (input: CrewLaunchInput) => Effect.Effect<CrewLaunchResult, CrewLaunchError>;
  /** Spawn approved additional seats under the Captain of an existing Crew, the same way. */
  readonly addSeats: (input: CrewAddSeatsInput) => Effect.Effect<CrewLaunchResult, CrewLaunchError>;
  /**
   * What the roster card can offer a seat's workspace: the Captain's branch, the directory
   * its base-branch picker searches, and the project's worktrees. An unreadable repository offers none.
   */
  readonly workspaceOptions: (captain: CrewCaptain) => Effect.Effect<CrewWorkspaceOptions>;
}

export class CrewLaunchService extends Context.Service<CrewLaunchService, CrewLaunchServiceShape>()(
  "t3/j5/a2a/CrewLaunchService",
) {}

export const layer = Layer.effect(
  CrewLaunchService,
  Effect.gen(function* () {
    const threadManagement = yield* ThreadManagementService;
    const composition = yield* SpawnCompositionService;
    const crews = yield* AgentCrewInstanceService;
    const recordAnalytics = yield* j5AnalyticsRecorder;
    const registry = yield* ProviderRegistry;
    const agents = yield* makeAgentPersonaLibrary;
    const spawnWorkspace = yield* SpawnWorkspaceService;

    // Resolve every seat before creating anything: a Crew launches whole or not at all.
    const resolveSeats = Effect.fn("j5.a2a.crewLaunch.resolveSeats")(function* (
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewLaunchSeat>,
    ) {
      const providers = yield* registry.getProviders;
      // Every seat's workspace resolves against one read of the Captain's repository, here at
      // preview, so the approval token binds what each seat will get. Shared seats need none.
      const checkout = seats.every((seat) => seat.workspace.type === "shared")
        ? null
        : yield* spawnWorkspace.inspect({
            projectId: captain.thread.projectId,
            worktreePath: captain.thread.worktreePath,
            checkBranches: seats.some(
              (seat) => seat.workspace.type === "worktree" && seat.workspace.branch !== undefined,
            ),
            baseRefs: namedBaseRefs(seats.map((seat) => seat.workspace)),
            existingWorktreePaths: namedWorktreePaths(seats.map((seat) => seat.workspace)),
          });
      const resolveWorkspace = (seat: CrewLaunchSeat) =>
        Effect.fromResult(
          checkout === null
            ? Result.succeed({ type: "shared" } as const)
            : resolveSpawnWorkspace(checkout, seat.workspace),
        ).pipe(
          Effect.mapError(
            (error) =>
              new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId: seat.agentId ?? "custom seat",
                detail: `${error.detail} ${error.nextStep}`,
              }),
          ),
        );
      const resolved: Array<ResolvedCrewLaunchSeat> = [];
      const resolveSelection = Effect.fn("j5.a2a.crewLaunch.resolveSelection")(function* (
        seat: CrewLaunchSeat,
        selection: ModelSelection,
      ) {
        const provider = providers.find(
          (candidate) => candidate.instanceId === selection.instanceId,
        );
        const problem =
          provider === undefined
            ? "is no longer configured"
            : !isProviderAvailable(provider)
              ? "is unavailable"
              : !provider.enabled || provider.status === "disabled"
                ? "is disabled"
                : !provider.installed
                  ? "is not installed"
                  : provider.status === "error"
                    ? "reports an error"
                    : provider.auth.status === "unauthenticated"
                      ? "is signed out"
                      : !provider.models.some((model) => model.slug === selection.model)
                        ? `does not advertise ${selection.model}`
                        : null;
        if (problem !== null)
          return yield* new CrewLaunchSeatUnavailableError({
            seatName: seat.name,
            agentId: seat.agentId ?? "custom seat",
            detail: `Provider ${selection.instanceId} ${problem}.`,
          });
        const modelSelection = materializeCrewModelSelection(selection, provider!);
        const optionProblem =
          seat.modelSelection === undefined
            ? null
            : crewModelSelectionProblem(modelSelection, provider!);
        if (optionProblem !== null)
          return yield* new CrewLaunchSeatUnavailableError({
            seatName: seat.name,
            agentId: seat.agentId ?? "custom seat",
            detail: optionProblem,
          });
        return { modelSelection, provider: provider! };
      });
      for (const seat of seats) {
        const agentId = seat.agentId;
        if (agentId === null) {
          const selection = seat.modelSelection ?? captain.thread.modelSelection;
          const { modelSelection, provider } = yield* resolveSelection(seat, selection);
          // Access is the one setting a custom seat does not take from its Captain: a seat nobody
          // configured runs in Full access, so it never stops for approvals in a thread the person
          // is not watching. The person sees and can change it on the roster card.
          const runtimeMode = seat.runtimeMode ?? "full-access";
          if (
            provider!.driver === "acpRegistry" &&
            (runtimeMode === "auto" || runtimeMode === "auto-accept-edits")
          )
            return yield* new CrewLaunchSeatUnavailableError({
              seatName: seat.name,
              agentId: "custom seat",
              detail:
                "This ACP harness cannot enforce the selected access mode. Choose Supervised or Full access.",
            });
          // Custom seats carry the selected access mode, without a persona sandbox assignment.
          const workspace = yield* resolveWorkspace(seat);
          resolved.push({
            seat,
            assignment: null,
            modelSelection,
            workspace,
            runtime: {
              ...describeCrewSeatRuntime(seat.name, modelSelection, provider!, runtimeMode, null),
              workspace,
            },
            runtimeMode,
            outputArtifact: null,
            agentDisplayName: "custom",
          });
          continue;
        }
        const assignment = yield* Effect.gen(function* () {
          if (seat.modelSelection === undefined) {
            const prepared = yield* prepareAgentPersonaLaunch(
              { personaId: agentId },
              providers,
              agents,
            );
            return {
              ...prepared,
              resolvedModelSelection: (yield* resolveSelection(
                seat,
                prepared.resolvedModelSelection,
              )).modelSelection,
              ...(seat.runtimeMode === undefined ? {} : { runtimeModeOverride: seat.runtimeMode }),
            };
          }
          const { modelSelection, provider } = yield* resolveSelection(seat, seat.modelSelection);
          const catalog = yield* agents.catalog();
          const definition = catalog.definitions.find(({ id }) => id === agentId);
          if (definition === undefined || catalog.disabledIds.includes(agentId))
            return yield* new CrewLaunchSeatUnavailableError({
              seatName: seat.name,
              agentId,
              detail: "The selected persona is unknown or disabled in this environment.",
            });
          if (
            seat.runtimeMode === undefined &&
            !providerCanEnforceAgentPersonaAuthority(
              provider.driver,
              definition.authority.defaultPolicy,
            )
          )
            return yield* new CrewLaunchSeatUnavailableError({
              seatName: seat.name,
              agentId,
              detail:
                "This harness cannot enforce the persona's default access. Select an explicit access mode.",
            });
          const definitionDigest = yield* agents.snapshot(definition);
          return {
            personaId: agentId,
            definitionVersion: definition.version,
            definitionDigest,
            displayName: definition.displayName,
            authorityPolicy: definition.authority.defaultPolicy,
            resolvedRoute: "override" as const,
            resolvedDriver: provider.driver,
            resolvedModelSelection: modelSelection,
            ...(seat.runtimeMode === undefined ? {} : { runtimeModeOverride: seat.runtimeMode }),
          };
        }).pipe(
          Effect.mapError(
            (error) =>
              new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId,
                detail: error.message,
              }),
          ),
        );
        // Every seat reaching this point was approved by a human, and that approval is the
        // authority: explicit runtime choices override the persona sandbox while its behavior
        // instructions remain pinned to the original snapshot.
        const policy = translateAgentPersonaProviderPolicy(
          assignment.authorityPolicy,
          assignment.resolvedDriver,
        );
        const runtimeMode = seat.runtimeMode ?? policy.runtimeMode;
        if (
          assignment.resolvedDriver === "acpRegistry" &&
          (runtimeMode === "auto" || runtimeMode === "auto-accept-edits")
        )
          return yield* new CrewLaunchSeatUnavailableError({
            seatName: seat.name,
            agentId,
            detail:
              "This ACP harness cannot enforce the selected access mode. Choose Supervised or Full access.",
          });
        // The obligation is read from the same immutable snapshot the seat will run on, so a
        // later library edit cannot change what a running seat owes.
        const definition = yield* agents.readSnapshot(assignment).pipe(
          Effect.mapError(
            (error) =>
              new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId,
                detail: error.message,
              }),
          ),
        );
        const workspace = yield* resolveWorkspace(seat);
        resolved.push({
          seat,
          assignment,
          modelSelection: assignment.resolvedModelSelection,
          workspace,
          runtime: {
            ...describeCrewSeatRuntime(
              seat.name,
              assignment.resolvedModelSelection,
              providers.find(
                (provider) => provider.instanceId === assignment.resolvedModelSelection.instanceId,
              )!,
              runtimeMode,
              assignment,
            ),
            workspace,
          },
          runtimeMode,
          outputArtifact: definition.outputArtifact ?? null,
          agentDisplayName: assignment.displayName ?? agentId,
        });
      }
      return resolved;
    });

    const plan = (
      providerSessionId: string,
      requestKey: string,
      seats: ReadonlyArray<ResolvedCrewLaunchSeat>,
    ) =>
      seats.map((entry) => {
        const stableInput = {
          providerSessionId,
          requestKey: crewSeatRequestKey(requestKey, entry.seat.name),
        };
        const threadId = spawnThreadId(stableInput);
        return {
          ...entry,
          stableInput,
          threadId,
          participantId: participantIdForThread(threadId),
        };
      });
    type Planned = ReturnType<typeof plan>[number];

    const detailOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

    /** Create one seat's thread and commit its home and placement. */
    const startSeat = Effect.fn("j5.a2a.crewLaunch.startSeat")(function* (
      captain: CrewCaptain,
      member: Planned,
    ) {
      const seatName = member.seat.name;
      const create = yield* Effect.result(
        threadManagement.dispatch({
          type: "thread.create",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: spawnCreateCommandId(member.stableInput, member.workspace.type),
          threadId: member.threadId,
          projectId: captain.thread.projectId,
          // The seat's name alone: the sidebar group and the Crew chip already say which Crew.
          title: spawnTitle(seatName),
          modelSelection: member.modelSelection,
          runtimeMode: member.runtimeMode,
          interactionMode: captain.thread.interactionMode,
          ...(member.assignment === null ? {} : { agentPersonaAssignment: member.assignment }),
          ...spawnThreadCheckout(member.workspace, captain.thread),
        }),
      );
      const child = yield* Effect.result(
        getThreadProjectionIfPresent(threadManagement, member.threadId),
      );
      if (Result.isFailure(child))
        return {
          seatName,
          kind: "not_started",
          detail: `reading the seat thread failed: ${detailOf(child.failure)}`,
        } satisfies CrewSeatLaunchOutcome;
      if (child.success === null)
        return {
          seatName,
          kind: "not_created",
          detail: Result.isFailure(create)
            ? detailOf(create.failure)
            : "the thread did not appear after it was created",
        } satisfies CrewSeatLaunchOutcome;
      const facts = yield* Effect.result(
        composition.recordFacts({
          homeCommandId: spawnHomeCommandId(member.stableInput),
          placementCommandId: spawnPlacementCommandId(member.stableInput),
          projectId: captain.projectId,
          threadId: member.threadId,
          provenance: {
            kind: "spawned-by",
            spawnedByParticipantId: captain.participantId,
            source: "j5_spawn",
          },
          createdAt: DateTime.formatIso(child.success.thread.createdAt),
        }),
      );
      if (Result.isFailure(facts))
        return {
          seatName,
          kind: "not_started",
          detail: `recording its home and placement failed: ${detailOf(facts.failure)}`,
        } satisfies CrewSeatLaunchOutcome;
      return { seatName, kind: "created" } satisfies CrewSeatLaunchOutcome;
    });

    /**
     * Create each seat's thread and commit its home and placement, carrying on past a seat that
     * fails. A failed create is checked against the store: only a thread that never came to exist
     * is `not_created`; one that exists without its home is `not_started`.
     */
    const spawnSeats = Effect.fn("j5.a2a.crewLaunch.spawnSeats")(function* (
      captain: CrewCaptain,
      planned: ReadonlyArray<Planned>,
    ) {
      const outcomes: Array<CrewSeatLaunchOutcome> = [];
      const created: Array<Planned> = [];
      for (const member of planned) {
        const seatName = member.seat.name;
        // Seats go through the same start guard as j5_spawn_agent (see `withSpawnStart`), so every
        // door that creates a spawn thread keeps its invariant. A Crew's launches are already
        // serialized and its approval binds each seat's workspace type, so neither refusal is
        // expected here; the brief takes the guard again once every seat exists.
        const started = yield* Effect.result(
          spawnWorkspace.withSpawnStart(
            {
              stableInput: member.stableInput,
              threadId: member.threadId,
              workspace: member.workspace,
            },
            startSeat(captain, member),
          ),
        );
        if (Result.isFailure(started)) {
          outcomes.push({ seatName, kind: "not_started", detail: detailOf(started.failure) });
          continue;
        }
        outcomes.push(started.success);
        if (started.success.kind === "created") created.push(member);
      }
      return { outcomes, created };
    });

    /** Brief every created seat, carrying on past one whose brief did not go out. */
    const startBriefs = Effect.fn("j5.a2a.crewLaunch.startBriefs")(function* (
      captain: CrewCaptain,
      instance: AgentCrewInstance,
      planned: ReadonlyArray<Planned>,
      brief: string,
      playbook: CrewLaunchPlaybook | null,
    ) {
      const roster = instance.members.map((member) => ({
        seat: member.seatName,
        participantId: member.participantId,
        agentDisplayName:
          planned.find((entry) => entry.seat.name === member.seatName)?.agentDisplayName ??
          member.agentId ??
          "custom",
      }));
      const failed = new Map<string, string>();
      for (const member of planned) {
        const text = spawnFirstTurnText({
          brief,
          participantId: member.participantId,
          projectId: captain.projectId,
          projectTitle: captain.projectTitle,
          spawnedByParticipantId: captain.participantId,
          spawnerThreadId: captain.thread.id,
          crew: {
            displayName: instance.displayName,
            instanceId: instance.id,
            seatName: member.seat.name,
            seatInstructions: member.seat.instructions,
            captainParticipantId: captain.participantId,
            obligation:
              member.outputArtifact === null || member.assignment === null
                ? undefined
                : {
                    kind: member.outputArtifact,
                    path: agentHandoffArtifactPath({
                      personaId: member.assignment.personaId,
                      artifact: member.outputArtifact,
                      threadId: member.threadId,
                    }),
                  },
            roster,
            playbook:
              playbook === null
                ? undefined
                : {
                    name: playbook.name,
                    title: playbook.title,
                    steps: playbook.steps.filter((step) => member.seat.steps?.includes(step.id)),
                  },
          },
        });
        const dispatched = yield* Effect.result(
          spawnWorkspace.withSpawnStart(
            {
              stableInput: member.stableInput,
              threadId: member.threadId,
              workspace: member.workspace,
            },
            spawnWorkspace.startBrief({
              workspace: member.workspace,
              stableInput: member.stableInput,
              ledgerProjectId: captain.projectId,
              projectId: captain.thread.projectId,
              threadId: member.threadId,
              title: spawnTitle(member.seat.name),
              messageId: spawnMessageId(member.stableInput),
              text,
              modelSelection: member.modelSelection,
              runtimeMode: member.runtimeMode,
              interactionMode: captain.thread.interactionMode,
            }),
          ),
        );
        if (Result.isFailure(dispatched))
          failed.set(
            member.seat.name,
            `starting its brief failed: ${detailOf(dispatched.failure)}`,
          );
      }
      return failed;
    });

    /**
     * Spawn and brief the reserved seats, then drop the rows of seats that were never created.
     * Every seat is attempted; the outcomes say what became of each.
     */
    const spawnAndBrief = Effect.fn("j5.a2a.crewLaunch.spawnAndBrief")(function* (
      captain: CrewCaptain,
      instance: AgentCrewInstance,
      planned: ReadonlyArray<Planned>,
      brief: string,
      playbook: CrewLaunchPlaybook | null,
      addition: boolean,
    ) {
      const spawned = yield* spawnSeats(captain, planned);
      const notCreated = spawned.outcomes.flatMap((outcome) =>
        outcome.kind === "not_created" ? [outcome.seatName] : [],
      );
      // A row the store refused to delete is dropped by the launch report, which removes every
      // row this proposal minted whose thread does not exist before it measures the seats.
      if (notCreated.length > 0)
        yield* crews.removeMembers(instance.id, notCreated).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 crew launch could not drop seats that were never created", {
              crewInstanceId: instance.id,
              seats: notCreated,
              cause,
            }),
          ),
        );
      const current = (yield* crews.read(instance.id).pipe(Effect.orElseSucceed(() => null))) ?? {
        ...instance,
        members: instance.members.filter((member) => !notCreated.includes(member.seatName)),
      };
      const briefFailures = yield* startBriefs(captain, current, spawned.created, brief, playbook);
      const seats = spawned.outcomes.map((outcome): CrewSeatLaunchOutcome => {
        const briefFailure = briefFailures.get(outcome.seatName);
        return outcome.kind === "created" && briefFailure !== undefined
          ? { seatName: outcome.seatName, kind: "not_started", detail: briefFailure }
          : outcome;
      });
      const outcomes = (kind: CrewSeatLaunchOutcome["kind"]) =>
        seats.filter((seat) => seat.kind === kind).length;
      yield* recordAnalytics("j5.crew.launched", {
        addition,
        seats: planned.length,
        personaSeats: planned.filter((member) => member.assignment !== null).length,
        worktreeSeats: planned.filter((member) => member.workspace.type === "worktree").length,
        fullAccessSeats: planned.filter((member) => member.runtimeMode === "full-access").length,
        models: new Set(planned.map((member) => member.modelSelection.model)).size,
        hasPlaybook: playbook !== null,
        created: outcomes("created"),
        notCreated: outcomes("not_created"),
        notStarted: outcomes("not_started"),
      });
      return { instance: current, seats } satisfies CrewLaunchResult;
    });

    const launch: CrewLaunchServiceShape["launch"] = Effect.fn("j5.a2a.crewLaunch.launch")(
      function* (input) {
        const resolved = input.resolvedSeats ?? (yield* resolveSeats(input.captain, input.seats));
        const planned = plan(input.providerSessionId, input.requestKey, resolved);
        const recordError = (phase: string) => (cause: unknown) =>
          new CrewLaunchOperationError({ phase, seatName: null, createdSeats: [], cause });
        const crewInstanceId = spawnCrewInstanceId({
          providerSessionId: input.providerSessionId,
          requestKey: input.requestKey,
        });
        // An approval whose link or resolution failed recorded the Crew and spawned nothing. If
        // the person renamed seats before approving again, the earlier names are still on the
        // record with no thread behind them; drop them so the record holds only this roster.
        const earlier = yield* crews
          .read(crewInstanceId)
          .pipe(Effect.mapError(recordError("reading the earlier record")));
        const stale = (earlier?.members ?? []).filter(
          (member) => !planned.some((entry) => entry.seat.name === member.seatName),
        );
        if (stale.length > 0)
          yield* crews
            .removeMembers(
              crewInstanceId,
              stale.map((member) => member.seatName),
            )
            .pipe(Effect.mapError(recordError("releasing renamed seats")));
        // Record the unit before any seat exists: every planned seat is named under its
        // deterministic ids, and a member's own crew request is refused from its first turn.
        const instance = yield* crews
          .record({
            id: crewInstanceId,
            projectId: input.captain.projectId,
            captainParticipantId: input.captain.participantId,
            captainThreadId: input.captain.thread.id,
            displayName: input.displayName,
            brief: input.brief,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            playbook:
              input.playbook == null
                ? null
                : { name: input.playbook.name, definitionPath: input.playbook.definitionPath },
            members: planned.map((member) => ({
              seatName: member.seat.name,
              agentId: member.seat.agentId,
              participantId: member.participantId,
              threadId: member.threadId,
              reason: member.seat.reason,
              playbookStepIds: member.seat.steps,
            })),
          })
          .pipe(Effect.mapError(unlessStepOwned(recordError("recording the crew"))));
        if (input.onRecorded !== undefined) yield* input.onRecorded(instance);
        return yield* spawnAndBrief(
          input.captain,
          instance,
          planned,
          input.brief,
          input.playbook ?? null,
          false,
        );
      },
      (launch, input) =>
        // One unit step from the record through the briefs, so a unit archive waits for every
        // seat to exist before it reads the roster.
        crews.serialize(
          spawnCrewInstanceId({
            providerSessionId: input.providerSessionId,
            requestKey: input.requestKey,
          }),
          launch,
        ),
    );

    // One unit step from the reservation through the briefs, like a launch.
    const addSeats: CrewLaunchServiceShape["addSeats"] = Effect.fn("j5.a2a.crewLaunch.addSeats")(
      function* (input) {
        const resolved = input.resolvedSeats ?? (yield* resolveSeats(input.captain, input.seats));
        const planned = plan(input.providerSessionId, input.requestKey, resolved);
        // Reserve the seats before anything spawns: the store decides the cap and the version in
        // one transaction, so two approvals landing together cannot both pass.
        const reservation = yield* crews
          .addMembers(
            input.instance.id,
            planned.map((member) => ({
              seatName: member.seat.name,
              agentId: member.seat.agentId,
              participantId: member.participantId,
              threadId: member.threadId,
              reason: member.seat.reason,
              playbookStepIds: member.seat.steps,
            })),
            { maxSeats: CREW_SEAT_CAP },
          )
          .pipe(
            Effect.mapError(
              unlessStepOwned(
                (cause) =>
                  new CrewLaunchOperationError({
                    phase: "reserving the added seats",
                    seatName: null,
                    createdSeats: [],
                    cause,
                  }),
              ),
            ),
          );
        if (reservation.status === "missing" || reservation.instance === null)
          return yield* new CrewLaunchOperationError({
            phase: "reserving the added seats",
            seatName: null,
            createdSeats: [],
            cause: `crew ${input.instance.id} no longer exists`,
          });
        if (reservation.status === "archived")
          return yield* new CrewLaunchOperationError({
            phase: "reserving the added seats",
            seatName: null,
            createdSeats: [],
            cause: `crew ${input.instance.id} is retired`,
          });
        if (reservation.status === "conflict")
          return yield* new CrewLaunchSeatConflictError({
            crewInstanceId: input.instance.id,
            seatNames: reservation.conflicts,
          });
        if (reservation.status === "cap-exceeded")
          return yield* new CrewLaunchCapError({
            crewInstanceId: input.instance.id,
            held: reservation.instance.members.length,
            adding: planned.length,
            cap: CREW_SEAT_CAP,
          });
        const reserved = reservation.instance;
        if (input.onReserved !== undefined)
          yield* input.onReserved(reserved).pipe(
            // Nothing spawned: release the rows so the same request can be approved again.
            Effect.tapError(() =>
              crews
                .removeMembers(
                  reserved.id,
                  planned.map((member) => member.seat.name),
                )
                .pipe(Effect.ignore),
            ),
          );
        return yield* spawnAndBrief(
          input.captain,
          reserved,
          planned,
          input.brief ?? reserved.brief,
          input.playbook ?? null,
          true,
        );
      },
      (addition, input) => crews.serialize(input.instance.id, addition),
    );

    // Only the card's select lists; every seat's workspace is bound from a fresh read above, at
    // preview and again at approval, where the token refuses a launch that no longer matches.
    const workspaceOptions: CrewLaunchServiceShape["workspaceOptions"] = (captain) =>
      spawnWorkspace.workspaceOptions({
        projectId: captain.thread.projectId,
        worktreePath: captain.thread.worktreePath,
      });

    return CrewLaunchService.of({ launch, addSeats, resolveSeats, workspaceOptions });
  }),
);
