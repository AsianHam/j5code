import {
  type ChatAttachment,
  isAgentPersonaReasoningOptionId,
  type ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import { playbookHandlers } from "../../playbooks/mcp.ts";
import { playbookWorkspaceRoot } from "../../playbooks/workspace.ts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  McpInvocationContext,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { resolveAttachmentReferences } from "../../../mcp/toolkits/attachment/handlers.ts";
import {
  assertTargetWithinLimits,
  type CallerLimits,
  loadCaller,
} from "../../../mcp/threadAccess.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { claimPendingAttachments } from "../../../orchestration-v2/AttachmentClaims.ts";
import { exceededDispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementService,
  latestActiveRun,
} from "../../../orchestration-v2/ThreadManagementService.ts";
import { ManagedProjectFolders } from "../../../project/ManagedProjectFolders.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { makeAgentPersonaLibrary } from "../../agents/agentPersonaLibrary.ts";
import { buildAgentPersonaCatalog } from "../../agents/agentPersonaRouting.ts";
import { translateAgentPersonaProviderPolicy } from "../../agents/agentPersonaProviderPolicy.ts";
import { prepareAgentPersonaPeerSpawn } from "../../agents/agentPersonaSpawn.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import type { ArchiveAgentConsequenceFacts } from "../ArchiveAgentService.ts";
import {
  ArchiveCrewConfirmationRequiredError,
  ArchiveCrewConfirmationStaleError,
  ArchiveCrewPartialFailureError,
  ArchiveCrewService,
  type ArchiveCrewConsequenceFacts,
} from "../ArchiveCrewService.ts";
import {
  CrewProposalService,
  type CrewProposalError,
  type CrewProposalOutcome,
} from "../CrewProposalService.ts";
import { CrewStopService } from "../CrewStopService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar, participantIdForThread } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { PeerDirectory } from "../PeerDirectory.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { withDeliveryNotice } from "../receiverBacklog.ts";
import { A2ASendService } from "../SendService.ts";
import { stopThread } from "../stopThread.ts";
import { sendClaimingAttachments } from "./attachments.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import {
  SpawnWorkspaceService,
  namedBaseRefs,
  namedWorktreePaths,
  resolveSpawnWorkspace,
  spawnCreateCommandId,
  spawnThreadCheckout,
} from "../spawnWorkspace.ts";
import { ThreadRegistration } from "../ThreadRegistration.ts";
import {
  crewSeatRequestKey,
  lifecycleCommandId,
  spawnFirstTurnText,
  spawnHomeCommandId,
  spawnMessageId,
  spawnPlacementCommandId,
  spawnThreadId,
  spawnTitle,
  stablePart,
} from "../spawnIds.ts";
import { CommCommandId, LedgerProjectId, type ParticipantDirectoryRow } from "../contracts.ts";
import type { ParticipantProvenanceView } from "../placementContracts.ts";
import {
  J5_LIST_PARTICIPANTS_DEFAULT_LIMIT,
  J5Toolkit,
  type J5ArchiveCrewFailure,
  type J5McpFailure,
  type J5ProposeCrewInput,
  spawnWorkspaceFromInput,
} from "./tools.ts";

class J5AgentToolStateError extends Data.TaggedError("J5AgentToolStateError")<{
  readonly state: string;
  readonly nextCommand: string;
}> {
  override get message(): string {
    return `${this.state} ${this.nextCommand}`;
  }
}

const failure = (error: unknown): J5McpFailure => ({
  code:
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "J5A2AError",
  message: error instanceof Error ? error.message : String(error),
});

const projectArchiveFacts = (facts: ArchiveAgentConsequenceFacts) => ({
  open_exchanges: facts.openExchanges.map((exchange) => ({
    exchange_id: exchange.exchangeId,
    direction: exchange.direction,
    reply_obligation: exchange.replyObligation,
    counterparty_id: exchange.counterpartyId,
    intent: exchange.intent,
    urgency: exchange.urgency,
    opened_at: exchange.openedAt,
  })),
  running_turn:
    facts.runningTurn === null
      ? null
      : { run_id: facts.runningTurn.runId, status: facts.runningTurn.status },
});

const projectCrewArchiveFacts = (facts: ArchiveCrewConsequenceFacts) => ({
  members: facts.members.map((member) => ({
    seat: member.seatName,
    participant_id: member.participantId,
    already_archived: member.alreadyArchived,
    ...projectArchiveFacts(member.facts),
  })),
});

const archiveCrewFailure = (error: unknown): J5ArchiveCrewFailure => {
  const base = failure(error);
  if (
    error instanceof ArchiveCrewConfirmationRequiredError ||
    error instanceof ArchiveCrewConfirmationStaleError
  ) {
    return {
      ...base,
      ...projectCrewArchiveFacts(error.facts),
      confirmation_token: error.confirmationToken,
    };
  }
  if (error instanceof ArchiveCrewPartialFailureError) {
    return {
      ...base,
      archived_seats: [...error.archivedSeats],
      failed_seat: error.failedSeat,
    };
  }
  return base;
};

const projectProvenance = (provenance: ParticipantProvenanceView) => {
  switch (provenance.kind) {
    case "spawned-by":
      return {
        kind: provenance.kind,
        spawned_by_participant_id: provenance.spawnedByParticipantId,
        source: provenance.source,
      } as const;
    case "forked-from":
      return {
        kind: provenance.kind,
        source_participant_id: provenance.sourceParticipantId,
        source: provenance.source,
      } as const;
    default:
      return provenance;
  }
};

/**
 * The ledger command id for a send or a clear. `toolName` is the id's own segment, not the tool's
 * registered name: it keeps the value these ids were written with before the tools gained their
 * `j5_` prefix, so a retry with the same client_request_id still finds its first command.
 */
export const commandIdForRequest = (input: {
  readonly toolName: "send_message" | "clear_own_ask";
  readonly providerSessionId: string;
  readonly requestKey: string;
}) => {
  return CommCommandId.make(
    `command:j5:a2a:mcp:${stablePart(input.providerSessionId)}:${stablePart(input.toolName)}:${stablePart(input.requestKey)}`,
  );
};

type AgentDirectoryRow = ParticipantDirectoryRow & {
  readonly participant: Extract<ParticipantDirectoryRow["participant"], { readonly kind: "agent" }>;
};

const stateError = (state: string, nextCommand: string) =>
  new J5AgentToolStateError({ state, nextCommand });

/**
 * The calling thread's scope. Every handler that reads it is declared `readsAsCaller` or
 * `actsAsCaller` below, which refuses a caller without a thread before the handler runs.
 */
const callerScope = McpInvocationContext.pipe(
  Effect.flatMap((scope) => requireThreadScope(scope, "This tool")),
);

const resolveCallerMembership = Effect.fn("j5.a2a.mcp.resolveCallerMembership")(function* (
  scope: McpThreadInvocationScope,
) {
  const directory = yield* (yield* A2ASendService)
    .listParticipants(scope.thread.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} has no usable membership in its project: ${error instanceof Error ? error.message : String(error)}.`,
          "Call j5_list_participants to inspect current membership before retrying.",
        ),
      ),
    );
  const memberships = directory.filter(
    (row): row is AgentDirectoryRow =>
      row.participant.kind === "agent" && row.participant.threadId === scope.thread.threadId,
  );
  if (memberships.length === 0) {
    return yield* stateError(
      `Caller membership is missing for thread ${scope.thread.threadId}.`,
      "Call j5_list_participants to inspect current membership before retrying.",
    );
  }
  if (memberships.length !== 1) {
    return yield* stateError(
      `Caller membership for thread ${scope.thread.threadId} is ambiguous across projects ${memberships.map((row) => row.projectId).join(", ")}.`,
      "Call j5_list_participants to inspect current membership before retrying.",
    );
  }
  return memberships[0]!;
});

const preflightSpawnCaller = Effect.fn("j5.a2a.mcp.preflightSpawnCaller")(function* (
  scope: McpThreadInvocationScope,
) {
  const ledger = yield* A2ALedger;
  // A thread from before every thread registered at creation registers here, on its first call.
  const home = yield* (yield* ThreadRegistration)
    .ensureRegistered(scope.thread.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} could not be registered in its project: ${error instanceof Error ? error.message : String(error)}.`,
          "Retry j5_spawn_agent; if it keeps failing, tell the human.",
        ),
      ),
    );
  if (home === null) {
    return yield* stateError(
      `Caller thread ${scope.thread.threadId} is a Subagent and is not an agent-to-agent participant.`,
      "Return your result to the agent that started you; it can spawn agents.",
    );
  }
  const project = yield* ledger
    .readProjectLedger(home.projectId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} is registered in project ${home.projectId}, but that project's ledger is unavailable: ${error instanceof Error ? error.message : String(error)}.`,
          "Tell the human before retrying j5_spawn_agent.",
        ),
      ),
    );
  const membership = yield* resolveCallerMembership(scope);
  if (membership.projectId !== home.projectId || membership.participantId !== home.participantId) {
    return yield* stateError(
      `Caller thread ${scope.thread.threadId} is registered as ${home.projectId}/${home.participantId}, but its current membership is ${membership.projectId}/${membership.participantId}.`,
      "Call j5_list_participants to inspect current membership, then ask the human to repair the mismatch before retrying j5_spawn_agent.",
    );
  }
  return { ...membership, project };
});

const selectSpawnModel = Effect.fn("j5.a2a.mcp.selectSpawnModel")(function* (
  scope: McpThreadInvocationScope,
  input: { readonly provider: string; readonly model: string; readonly reasoning: string },
) {
  const capabilities = yield* (yield* OrchestratorMcpService)
    .capabilities(scope)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Provider capabilities are unavailable for j5_spawn_agent: ${error.message}.`,
          "Call orchestrator_capabilities, choose an available provider, model, and reasoning option, then retry j5_spawn_agent.",
        ),
      ),
    );
  const provider = capabilities.providers.find(
    (candidate) => candidate.providerInstanceId === input.provider,
  );
  if (provider === undefined) {
    return yield* stateError(
      `Provider ${input.provider} is not present in current orchestrator capabilities.`,
      "Call orchestrator_capabilities and retry j5_spawn_agent with a listed provider.",
    );
  }
  if (provider.constraints.length > 0) {
    return yield* stateError(
      `Provider ${input.provider} is currently unavailable: ${provider.constraints.join(" ")}`,
      "Call orchestrator_capabilities and retry j5_spawn_agent with an unconstrained provider.",
    );
  }
  const model = provider.models.find((candidate) => candidate.id === input.model);
  if (model === undefined) {
    return yield* stateError(
      `Model ${input.model} is not listed for provider ${input.provider}.`,
      "Call orchestrator_capabilities and retry j5_spawn_agent with a model listed for that provider.",
    );
  }
  const reasoningDescriptor = model.options?.find(
    (descriptor) => descriptor.type === "select" && isAgentPersonaReasoningOptionId(descriptor.id),
  );
  if (reasoningDescriptor === undefined || reasoningDescriptor.type !== "select") {
    return yield* stateError(
      `Model ${input.model} on provider ${input.provider} exposes no reasoning options; j5_spawn_agent requires explicit reasoning selection.`,
      "Call orchestrator_capabilities and choose a model that exposes reasoning options before retrying j5_spawn_agent.",
    );
  }
  if (!reasoningDescriptor.options.some((option) => option.id === input.reasoning)) {
    return yield* stateError(
      `Reasoning ${input.reasoning} is not listed for model ${input.model} on provider ${input.provider}.`,
      `Call orchestrator_capabilities and retry j5_spawn_agent with one of: ${reasoningDescriptor.options.map((option) => option.id).join(", ")}.`,
    );
  }
  return {
    instanceId: provider.providerInstanceId,
    model: model.id,
    options: [{ id: reasoningDescriptor.id, value: input.reasoning }],
  } satisfies ModelSelection;
});

/**
 * A Role-ful spawn keeps the explicit provider/model/reasoning pick; the saved agent's declared
 * routes constrain it and its authority policy becomes the child's runtime mode. A child's
 * permissions come from its own saved agent's policy or from the human's approval, never from
 * the parent: J5 carries no parent-child permission ceiling (Jackson, 2026-09-16), because any
 * such guard is one message to a trusting peer away from bypass and every child-creation door
 * would have to enforce it identically.
 */
const prepareSpawnPersona = Effect.fn("j5.a2a.mcp.prepareSpawnPersona")(function* (
  input: {
    readonly persona: string;
    readonly provider: string;
    readonly model: string;
    readonly reasoning: string;
  },
  modelSelection: ModelSelection,
) {
  const library = yield* makeAgentPersonaLibrary;
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const assignment = yield* prepareAgentPersonaPeerSpawn(
    {
      personaId: input.persona,
      provider: providers.find((candidate) => candidate.instanceId === modelSelection.instanceId),
      instanceId: modelSelection.instanceId,
      model: input.model,
      reasoning: input.reasoning,
    },
    library,
  ).pipe(
    Effect.mapError((error) =>
      stateError(
        `Persona ${input.persona} cannot be spawned as requested: ${error.message}`,
        "Call orchestrator_capabilities, then retry j5_spawn_agent with a provider, model, and reasoning from that persona's declared routes, or omit persona for a plain Peer Agent.",
      ),
    ),
  );
  const policy = translateAgentPersonaProviderPolicy(
    assignment.authorityPolicy,
    assignment.resolvedDriver,
  );
  return {
    assignment,
    modelSelection: assignment.resolvedModelSelection,
    runtimeMode: policy.runtimeMode,
  };
});

/** Crew requests come from a Peer Agent with a home that is not itself a crew member (R20). */
const preflightCrewCaptain = Effect.fn("j5.a2a.mcp.preflightCrewCaptain")(function* (
  scope: McpThreadInvocationScope,
  command: "j5_propose_crew" | "j5_request_crew_member",
) {
  const caller = yield* preflightSpawnCaller(scope);
  const membership = yield* (yield* AgentCrewInstanceService)
    .findMembership(caller.participantId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Crew membership for ${caller.participantId} cannot be read: ${error.message}.`,
          `Retry ${command} once crew records are readable.`,
        ),
      ),
    );
  if (membership !== null) {
    return yield* stateError(
      `Caller ${caller.participantId} is seat ${membership.seatName} of crew ${membership.crewInstanceId}; crew members cannot request crews or seats.`,
      "Send your Captain an ask describing the extra hands you need.",
    );
  }
  const parent = yield* (yield* ThreadManagementService)
    .getThreadProjection(scope.thread.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} cannot be read for ${command}: ${error.message}.`,
          `Read the caller thread state and retry ${command} after it is available.`,
        ),
      ),
    );
  return {
    projectId: caller.projectId,
    projectTitle: caller.project.name,
    participantId: caller.participantId,
    thread: parent.thread,
  };
});

const crewProposalNextStep = (error: CrewProposalError) =>
  error._tag === "CrewProposalRequestError"
    ? error.nextStep
    : error._tag === "CrewLaunchSeatUnavailableError"
      ? "Choose a different persona from j5_list_personas or ask the user to fix that persona, then retry."
      : error._tag === "CrewLaunchCapError"
        ? "The crew is full. Work with the seats it has, or propose a new crew for the extra work."
        : error._tag === "CrewLaunchSeatConflictError"
          ? "Choose a seat name the crew does not already use, then retry."
          : error._tag === "CrewStepAlreadyOwnedError"
            ? "Claim only steps no seat owns yet, then retry."
            : "Retry with the same client_request_id; recovery is forward-only.";

const projectCrewProposal = (outcome: CrewProposalOutcome) => ({
  proposal_id: outcome.proposal.id,
  status: outcome.proposal.status,
  crew_instance_id: outcome.instance?.id ?? null,
  members: (outcome.instance?.members ?? []).map((member) => ({
    seat: member.seatName,
    persona_id: member.agentId,
    participant_id: member.participantId,
    thread_id: member.threadId,
  })),
  ...(outcome.playbook == null
    ? {}
    : {
        playbook: {
          name: outcome.playbook.name,
          title: outcome.playbook.title,
          unowned_steps: outcome.playbook.unownedSteps,
          persona_swaps: outcome.playbook.swaps.map(({ seat, swap }) => ({
            seat,
            step_id: swap.stepId,
            wanted_persona: swap.wanted,
            seat_persona: swap.seatPersona,
            wanted_problem: swap.wantedProblem,
          })),
        },
      }),
});

/** One j5_propose_crew seat as the proposal service takes it; unset fields stay unset. */
export const crewSeatFromInput = (seat: J5ProposeCrewInput["seats"][number]) => ({
  seat: seat.seat,
  agentId: seat.persona ?? null,
  reason: seat.reason,
  ...(seat.instructions === undefined ? {} : { instructions: seat.instructions }),
  ...(seat.model_selection === undefined ? {} : { modelSelection: seat.model_selection }),
  ...(seat.runtime_mode === undefined ? {} : { runtimeMode: seat.runtime_mode }),
  ...(seat.steps === undefined ? {} : { steps: seat.steps }),
  workspace: spawnWorkspaceFromInput(seat.workspace),
});

const handlers = {
  ...playbookHandlers,
  j5_send_message: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      // The send below registers a caller that has no home yet and refuses a Subagent.
      const callerParticipantId = yield* (yield* A2AHomeRegistrar)
        .getHomeForThread(scope.thread.threadId)
        .pipe(
          Effect.map((home) => home.participantId),
          Effect.catchTags({
            A2AHomeNotFoundError: () =>
              Effect.succeed(participantIdForThread(scope.thread.threadId)),
          }),
        );
      if (input.to === callerParticipantId) {
        return yield* stateError(
          `j5_send_message cannot target your own participant_id ${callerParticipantId}; self-messaging is not supported.`,
          "Call j5_list_participants to find the intended recipient, or use schedule_task if you need a future trigger for yourself.",
        );
      }
      const crypto = yield* Crypto.Crypto;
      const service = yield* A2ASendService;
      const worker = yield* A2ADeliveryWorker;
      const mode = input.mode ?? "queue";
      const attachments = input.attachments ?? [];
      // A plain queued message needs nothing read first. A steer, a restart or a file acts on
      // the receiver's own thread, so the receiver must be an agent on this server.
      const receiverThreadId =
        mode === "queue" && attachments.length === 0
          ? undefined
          : yield* Effect.gen(function* () {
              const receiver = (yield* service.listParticipants(scope.thread.threadId)).find(
                (row) => row.participantId === input.to,
              );
              if (receiver === undefined || receiver.participant.kind !== "agent") {
                return yield* stateError(
                  `${mode === "queue" ? "attachments reach" : `mode=${mode} reaches`} only an agent on this server, and ${input.to} is not one.`,
                  // A machine takes no message at all and a person takes only an ask, so the
                  // retry is not promised to work: the listing says what the recipient accepts.
                  `Call j5_list_participants to see what ${input.to} accepts; if it takes messages, retry j5_send_message without ${mode === "queue" ? "attachments" : "mode"}.`,
                );
              }
              return receiver.participant.threadId;
            });
      let modeLimit: CallerLimits | undefined;
      if (receiverThreadId !== undefined && mode !== "queue") {
        // Steering or restarting another agent's turn is a write to its thread, so upstream's
        // rule applies: the target must run within the caller's modes. A queued send has none.
        const target = yield* (yield* ThreadManagementService)
          .getThreadShell(receiverThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (target === null) {
          return yield* stateError(
            `The thread of ${input.to} cannot be read to check mode=${mode}.`,
            "Retry j5_send_message, or send without mode.",
          );
        }
        modeLimit = (yield* loadCaller()).limits;
        yield* assertTargetWithinLimits(modeLimit, target).pipe(
          Effect.mapError((error) =>
            stateError(
              `mode=${mode} is refused: ${input.to} runs with broader permissions than you do: ${error.message}`,
              "Retry j5_send_message without mode; an ordinary message needs no permission check.",
            ),
          ),
        );
      }
      const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const send = (claimed?: ReadonlyArray<ChatAttachment>) =>
        service.send({
          commandId: commandIdForRequest({
            toolName: "send_message",
            providerSessionId: scope.thread.providerSessionId,
            requestKey,
          }),
          senderThreadId: scope.thread.threadId,
          to: input.to,
          message: input.message,
          ...(input.expect_reply == null ? {} : { expectReply: input.expect_reply }),
          ...(input.exchange_id == null ? {} : { exchangeId: input.exchange_id }),
          ...(input.intent == null ? {} : { intent: input.intent }),
          ...(input.urgency == null ? {} : { urgency: input.urgency }),
          ...(mode === "queue" ? {} : { mode }),
          ...(modeLimit === undefined ? {} : { modeLimit }),
          ...(claimed === undefined ? {} : { attachments: claimed }),
          acceptedAt,
        });
      const result =
        receiverThreadId === undefined || attachments.length === 0
          ? yield* send()
          : yield* sendClaimingAttachments(receiverThreadId, attachments, send);
      yield* worker.notify;
      return yield* withDeliveryNotice(result, {
        receiverId: input.to,
        callerThreadId: scope.thread.threadId,
        mode,
      });
    }).pipe(Effect.mapError(failure)),
  ),
  j5_clear_own_ask: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const service = yield* A2ASendService;
      const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const cleared = yield* service.clearOwnAsk({
        commandId: commandIdForRequest({
          toolName: "clear_own_ask",
          providerSessionId: scope.thread.providerSessionId,
          requestKey: input.client_request_id,
        }),
        senderThreadId: scope.thread.threadId,
        exchangeId: input.exchange_id,
        acceptedAt,
      });
      // A withdrawal addressed to a peer is a pending delivery; wake the worker as a send does.
      const { withdrawalQueued, ...result } = cleared;
      if (withdrawalQueued) yield* (yield* A2ADeliveryWorker).notify;
      return result;
    }).pipe(Effect.mapError(failure)),
  ),
  j5_list_participants: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const service = yield* A2ASendService;
      const orchestrator = yield* OrchestratorV2;
      const includeArchived = input.include_archived ?? false;
      const directory = yield* service.listParticipants(scope.thread.threadId, includeArchived);
      // A project's title beside its id places a participant. Titles are
      // enrichment: a read that fails leaves them null rather than taking the
      // address book with it.
      const projectTitles = new Map(
        (yield* (yield* A2ALedger).listProjectLedgers().pipe(Effect.orElseSucceed(() => []))).map(
          (project) => [project.id, project.name] as const,
        ),
      );
      // Agents on peer servers are listed by naming their server. Once this server has a peer,
      // every row names the server it lives on; with none, no row does. A peer that did not
      // answer is reported, never omitted.
      const remote = yield* (yield* PeerDirectory).listAgents();
      const servers =
        remote.selfName === null
          ? {}
          : {
              servers: [
                { name: remote.selfName, local: true },
                ...[
                  ...new Set([
                    ...remote.agents.map((agent) => agent.environmentLabel),
                    ...remote.unreadPeers.map((peer) => peer.label),
                  ]),
                ]
                  .toSorted()
                  .map((name) => ({ name, local: false })),
              ],
            };
      const self = directory.find(
        (row) =>
          row.participant.kind === "agent" && row.participant.threadId === scope.thread.threadId,
      );
      const people = directory.filter((row) => row.participant.kind === "human");
      // People belong to no project, so their rows carry the project being listed.
      const personRowsIn = (listed: ParticipantDirectoryRow["projectId"] | undefined) =>
        people.map((row) => ({
          project_id: listed ?? row.projectId,
          project_title: projectTitles.get(listed ?? row.projectId) ?? null,
          participant_id: row.participantId,
          participant: { kind: "human" as const, id: row.participantId },
          self: false,
          archived: row.archived,
          can_receive_message: row.canReceiveMessage,
          can_open_exchange: row.canOpenExchange,
          accepts_urgency: row.acceptsUrgency,
          thread_id: null,
          provenance: projectProvenance({ kind: "not-applicable" } as const),
          placement_parent_id: null,
          display_name: null,
          ...(remote.selfName === null ? {} : { server: { name: remote.selfName, local: true } }),
        }));
      const nameContains = input.name_contains?.toLocaleLowerCase();
      const named = (displayName: string | null) =>
        nameContains === undefined ||
        (displayName !== null && displayName.toLocaleLowerCase().includes(nameContains));
      const page = <Row>(rows: ReadonlyArray<Row>) => {
        const cursor = input.cursor ?? 0;
        const participants = rows.slice(
          cursor,
          cursor + (input.limit ?? J5_LIST_PARTICIPANTS_DEFAULT_LIMIT),
        );
        return {
          unread_peer_count: remote.unreadPeers.length,
          participants,
          next_cursor:
            cursor + participants.length < rows.length ? cursor + participants.length : null,
          total: rows.length,
          ...servers,
        };
      };

      // A name selects a peer server whenever one carries it, even this server's own name:
      // peers name themselves, and this server's agents are the listing with no name at all.
      const namesPeer =
        input.server !== undefined &&
        servers.servers?.some((server) => !server.local && server.name === input.server) === true;
      if (input.server !== undefined && !namesPeer && input.server !== remote.selfName) {
        return yield* stateError(
          `This server has no peer server named ${input.server}.`,
          "Call j5_list_participants without server and choose a name from the result's servers.",
        );
      }
      if (namesPeer) {
        if (input.settled !== undefined) {
          return yield* stateError(
            "Whether an agent is settled is known for this server's agents only.",
            "Retry j5_list_participants without settled, or without server.",
          );
        }
        const remoteRows = remote.agents
          .filter((agent) => agent.environmentLabel === input.server)
          .filter((agent) => input.project_id === undefined || agent.projectId === input.project_id)
          .filter((agent) => includeArchived || !agent.archived)
          .filter((agent) => named(agent.displayName))
          .map((agent) => ({
            project_id: agent.projectId,
            project_title: agent.projectTitle,
            participant_id: agent.participantId,
            participant: {
              kind: "agent" as const,
              id: agent.participantId,
              thread_id: agent.threadId,
            },
            self: false,
            archived: agent.archived,
            can_receive_message: !agent.archived && agent.canReceiveMessage,
            can_open_exchange: !agent.archived && agent.canReceiveMessage,
            accepts_urgency: false,
            thread_id: agent.threadId,
            provenance: projectProvenance({ kind: "unrecorded" } as const),
            placement_parent_id: null,
            display_name: agent.displayName,
            server: {
              name: agent.environmentLabel,
              local: false,
              // Only a server that polls this one has its availability measured.
              ...(agent.available === null ? {} : { available: agent.available }),
              ...(agent.available === null || agent.lastAvailableAt === null
                ? {}
                : { last_available_at: agent.lastAvailableAt }),
            },
          }));
        return page([...personRowsIn(self?.projectId), ...remoteRows]);
      }

      // A caller's project is its own row's. Every thread joins its project's ledger when it is
      // created, so only a caller the ledger has not seen yet lists no project at all.
      const projectId = input.project_id ?? self?.projectId;
      if (input.project_id !== undefined) {
        const project = yield* (yield* ProjectService)
          .getById(ProjectId.make(input.project_id))
          .pipe(
            Effect.mapError((error) =>
              stateError(
                `Project ${input.project_id} cannot be read now: ${error.message}.`,
                "Retry j5_list_participants.",
              ),
            ),
          );
        if (Option.isNone(project)) {
          return yield* stateError(
            `This server has no project ${input.project_id}.`,
            "Call t3_project_list and retry j5_list_participants with one of its project ids.",
          );
        }
      }
      const snapshot = yield* Effect.option(orchestrator.getShellSnapshot());
      const threads = new Map(
        Option.match(snapshot, {
          onNone: () => [],
          onSome: ({ archivedThreads, threads }) =>
            [...threads, ...archivedThreads].map((thread) => [thread.id, thread] as const),
        }),
      );
      const placements = yield* ParticipantPlacementService;
      const placementByParticipant = new Map(
        (projectId === undefined
          ? []
          : // A project nobody has worked in yet has no ledger, so nothing is placed in it.
            yield* placements
              .listParticipants(projectId)
              .pipe(Effect.catchTags({ PlacementProjectNotFoundError: () => Effect.succeed([]) }))
        ).map((row) => [row.participantId, row] as const),
      );
      const localRows = directory
        .filter((row) => row.participant.kind !== "human" && row.projectId === projectId)
        .map((row) => {
          const placement = placementByParticipant.get(row.participantId);
          const thread =
            row.participant.kind === "agent" ? threads.get(row.participant.threadId) : undefined;
          const isSelf = row === self;
          return {
            thread,
            row: {
              project_id: row.projectId,
              project_title: projectTitles.get(row.projectId) ?? null,
              participant_id: row.participantId,
              participant:
                row.participant.kind === "agent"
                  ? {
                      kind: row.participant.kind,
                      id: row.participant.id,
                      thread_id: row.participant.threadId,
                    }
                  : row.participant,
              self: isSelf,
              archived: row.archived,
              can_receive_message: !isSelf && row.canReceiveMessage,
              can_open_exchange: !isSelf && row.canOpenExchange,
              accepts_urgency: row.acceptsUrgency,
              thread_id: row.participant.kind === "agent" ? row.participant.threadId : null,
              provenance: projectProvenance(
                placement?.provenance ??
                  (row.participant.kind !== "agent"
                    ? ({ kind: "not-applicable" } as const)
                    : ({ kind: "unrecorded" } as const)),
              ),
              placement_parent_id: placement?.placementParentId ?? null,
              display_name:
                row.participant.kind === "agent"
                  ? (thread?.title ?? null)
                  : row.participant.kind === "machine"
                    ? row.participant.name
                    : null,
              ...(remote.selfName === null
                ? {}
                : { server: { name: remote.selfName, local: true } }),
            },
          };
        })
        // Your own row is kept whatever the filters say, so a listing always shows who is asking.
        .filter(
          ({ row, thread }) =>
            row.self ||
            (named(row.display_name) &&
              (input.settled === undefined ||
                row.participant.kind !== "agent" ||
                (thread?.settledOverride === "settled") === input.settled)),
        )
        // Yourself first, then newest first as upstream lists threads; machines have no thread.
        .toSorted(
          (left, right) =>
            Number(right.row.self) - Number(left.row.self) ||
            (right.thread === undefined ? 0 : DateTime.toEpochMillis(right.thread.updatedAt)) -
              (left.thread === undefined ? 0 : DateTime.toEpochMillis(left.thread.updatedAt)) ||
            right.row.participant_id.localeCompare(left.row.participant_id),
        )
        .map(({ row }) => row);
      const [first, ...rest] = localRows;
      return page(
        first?.self === true
          ? [first, ...personRowsIn(projectId), ...rest]
          : [...personRowsIn(projectId), ...localRows],
      );
    }).pipe(Effect.mapError(failure)),
  ),
  j5_spawn_agent: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const crypto = yield* Crypto.Crypto;
      const caller = yield* preflightSpawnCaller(scope);
      // Only a Captain grows a Crew, and only through the human gate (Bryant, 2026-09-14): a seat
      // that wants more hands escalates to its Captain; its own helpers are subagents.
      const membership = yield* (yield* AgentCrewInstanceService)
        .findMembership(caller.participantId)
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Crew membership for ${caller.participantId} cannot be read: ${error.message}.`,
              "Retry j5_spawn_agent once crew records are readable.",
            ),
          ),
        );
      if (membership !== null) {
        return yield* stateError(
          `Caller ${caller.participantId} is seat ${membership.seatName} of crew ${membership.crewInstanceId}; crew members cannot spawn Peer Agents.`,
          "Ask your Captain for the seat with j5_send_message, or run the work yourself as a subagent with delegate_task.",
        );
      }
      const selected = yield* selectSpawnModel(scope, input);
      const threadManagement = yield* ThreadManagementService;
      const parent = yield* threadManagement
        .getThreadProjection(scope.thread.threadId)
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Caller thread ${scope.thread.threadId} cannot be read for j5_spawn_agent: ${error.message}.`,
              "Read the caller thread state and retry j5_spawn_agent after it is available.",
            ),
          ),
        );
      const personaId = input.persona;
      const persona =
        personaId === undefined
          ? undefined
          : yield* prepareSpawnPersona({ ...input, persona: personaId }, selected);
      const modelSelection = persona?.modelSelection ?? selected;
      // A persona's policy sets its permissions. Without one the agent gets the caller's modes,
      // or the ones the caller chose, which upstream's rule keeps within the caller's own.
      if (persona !== undefined && input.runtime_mode !== undefined) {
        return yield* stateError(
          `Persona ${personaId} sets its own permission mode, so runtime_mode cannot be chosen for it.`,
          "Retry j5_spawn_agent without runtime_mode, or without persona.",
        );
      }
      const runtimeMode = input.runtime_mode ?? persona?.runtimeMode ?? parent.thread.runtimeMode;
      const interactionMode = input.interaction_mode ?? parent.thread.interactionMode;
      const { limits } = yield* loadCaller();
      {
        // Each mode is held to the caller's own only where the caller chose it, so choosing an
        // interaction mode does not put a persona's permission mode under the ceiling.
        const exceeded = exceededDispatchModeLimit(limits, {
          runtimeMode: input.runtime_mode ?? limits.runtimeMode,
          interactionMode: input.interaction_mode ?? limits.interactionMode,
        });
        if (exceeded !== undefined) {
          return yield* stateError(
            `The ${exceeded === "runtime" ? `permission mode ${runtimeMode}` : `interaction mode ${interactionMode}`} is broader than your own.`,
            "Retry j5_spawn_agent with a mode no broader than yours, or omit it to give the agent your own.",
          );
        }
      }
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const stableInput = {
        providerSessionId: scope.thread.providerSessionId,
        requestKey,
      };
      const threadId = spawnThreadId(stableInput);
      const existing = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const firstAttempt = existing === null;
      // A retry finishes the agent its first attempt created, in the modes it was created with.
      // A caller's modes can be narrowed within one provider session, so those are checked
      // against what the caller may touch now. A persona's agent runs under its own policy.
      if (existing !== null && persona === undefined) {
        const exceeded = exceededDispatchModeLimit(limits, existing);
        if (exceeded !== undefined) {
          return yield* stateError(
            `client_request_id ${requestKey} already created an agent whose ${exceeded === "runtime" ? "permission" : "interaction"} mode is broader than yours is now.`,
            "Ask the user to start that agent, or spawn a new one with a fresh client_request_id.",
          );
        }
      }

      // The project the agent joins: the caller's, another one, or upstream's "No project".
      if (input.scratch === true && input.project_id !== undefined) {
        return yield* stateError(
          "scratch spawns an agent without a project, so it cannot be combined with project_id.",
          "Retry j5_spawn_agent with one of them.",
        );
      }
      const target =
        input.scratch === true
          ? yield* (yield* ManagedProjectFolders).ensureScratchProject.pipe(
              Effect.map(({ projectId }) => projectId),
              Effect.mapError((error) =>
                stateError(
                  `An agent without a project cannot be spawned here: ${error.message}`,
                  "Retry j5_spawn_agent with a project_id, or without scratch for your own project.",
                ),
              ),
            )
          : input.project_id === undefined
            ? parent.thread.projectId
            : ProjectId.make(input.project_id);
      const elsewhere = target !== parent.thread.projectId;
      const targetProject = !elsewhere
        ? { id: caller.projectId, title: caller.project.name }
        : yield* (yield* ProjectService).getById(target).pipe(
            Effect.mapError((error) =>
              stateError(
                `Project ${target} cannot be read now: ${error.message}.`,
                "Retry j5_spawn_agent.",
              ),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    stateError(
                      `This server has no project ${target}.`,
                      "Call t3_project_list and retry j5_spawn_agent with one of its project ids.",
                    ),
                  ),
                onSome: (project) =>
                  Effect.succeed({ id: LedgerProjectId.make(project.id), title: project.title }),
              }),
            ),
          );
      if (input.scratch === true && input.workspace.type !== "root") {
        return yield* stateError(
          "An agent without a project works in a folder of its own, not in a checkout or a worktree.",
          'Retry j5_spawn_agent with workspace {"type":"root"}.',
        );
      }
      if (elsewhere && input.workspace.type === "shared") {
        return yield* stateError(
          `Your own checkout belongs to your project, and this agent joins project ${target}.`,
          'Retry j5_spawn_agent with workspace {"type":"root"} for that project\'s main checkout, or a worktree of it.',
        );
      }
      const spawnWorkspace = yield* SpawnWorkspaceService;
      // The project's main checkout binds nothing, so it travels as the shared type with no
      // checkout to share: one create command, and nothing asked of git.
      const choice =
        input.workspace.type === "root"
          ? ({ type: "shared" } as const)
          : spawnWorkspaceFromInput(input.workspace);
      // A replay must not refuse the branch its own first attempt created, so a named branch is
      // checked for only before the thread exists.
      const checkBranches =
        choice.type === "worktree" && choice.branch !== undefined && firstAttempt;
      // Sharing a checkout asks nothing of git.
      const checkout =
        choice.type === "shared"
          ? null
          : yield* spawnWorkspace.inspect({
              projectId: target,
              worktreePath: elsewhere ? null : parent.thread.worktreePath,
              checkBranches,
              baseRefs: namedBaseRefs([choice]),
              existingWorktreePaths: namedWorktreePaths([choice]),
            });
      const workspace = yield* Effect.fromResult(
        checkout === null
          ? Result.succeed({ type: "shared" } as const)
          : resolveSpawnWorkspace(checkout, choice),
      ).pipe(
        Effect.mapError((error) =>
          stateError(`Peer Agent was not created: ${error.detail}`, error.nextStep),
        ),
      );
      return yield* spawnWorkspace
        .withSpawnStart(
          { stableInput, threadId, workspace },
          Effect.gen(function* () {
            // What a shared-type thread binds: the caller's checkout, or the project's main one.
            // As upstream's launch does, a main-checkout thread asks for a folder of its own, and
            // gets one only in the "No project" project. It is claimed here, inside the start
            // that only one call at a time may run, and only before the thread exists; a replay
            // replays its create. The thread is looked for again now that this call holds the
            // start: an earlier attempt may have created it since the read above.
            const created =
              input.workspace.type === "root" &&
              (yield* threadManagement
                .getThreadShell(threadId)
                .pipe(Effect.orElseSucceed(() => null))) !== null;
            const sharedCheckout =
              input.workspace.type !== "root"
                ? parent.thread
                : {
                    branch: null,
                    worktreePath: created
                      ? null
                      : Option.getOrNull(
                          yield* (yield* ManagedProjectFolders)
                            .folderForThread({ projectId: target, threadId, text: input.brief })
                            .pipe(
                              Effect.mapError((error) =>
                                stateError(
                                  `A folder for the agent could not be made: ${error.message}`,
                                  "Retry j5_spawn_agent with the same client_request_id.",
                                ),
                              ),
                            ),
                        ),
                  };
            yield* threadManagement
              .dispatch({
                type: "thread.create",
                createdBy: "agent",
                creationSource: "mcp",
                commandId: spawnCreateCommandId(stableInput, workspace.type),
                threadId,
                projectId: target,
                title: spawnTitle(input.brief, input.title),
                modelSelection,
                runtimeMode,
                interactionMode,
                ...(persona === undefined ? {} : { agentPersonaAssignment: persona.assignment }),
                ...spawnThreadCheckout(workspace, sharedCheckout),
              })
              .pipe(
                Effect.mapError((error) =>
                  stateError(
                    `Peer Agent thread ${threadId} could not be created: ${error.message}.`,
                    error._tag === "OrchestratorCommandPreviouslyRejectedError"
                      ? "Inspect the rejection, correct the request, and retry j5_spawn_agent with a fresh client_request_id; the rejected key is permanently bound."
                      : "Inspect the caller thread and provider state, then retry j5_spawn_agent with the same client_request_id.",
                  ),
                ),
              );
            const child = yield* threadManagement
              .getThreadProjection(threadId)
              .pipe(
                Effect.mapError((error) =>
                  stateError(
                    `Created Peer Agent thread ${threadId} is not readable: ${error.message}.`,
                    "Retry j5_spawn_agent with the same client_request_id so registration can continue safely.",
                  ),
                ),
              );
            const facts = yield* (yield* SpawnCompositionService)
              .recordFacts({
                homeCommandId: spawnHomeCommandId(stableInput),
                placementCommandId: spawnPlacementCommandId(stableInput),
                projectId: targetProject.id,
                threadId,
                provenance: {
                  kind: "spawned-by",
                  spawnedByParticipantId: caller.participantId,
                  source: "j5_spawn",
                },
                createdAt: DateTime.formatIso(child.thread.createdAt),
              })
              .pipe(
                Effect.mapError((error) =>
                  stateError(
                    `Peer Agent thread ${threadId} exists as a visible orphan without committed home/placement facts or a started brief: ${error.message}.`,
                    "Retry j5_spawn_agent with the same client_request_id only after repairing transient state; otherwise ask the human operator to retire or repair the orphan after A9 lifecycle support lands.",
                  ),
                ),
              );
            // In the spawner's own project the agent sits under it; in another it is a root.
            if (
              facts.placement.provenance.kind !== "spawned-by" ||
              facts.placement.provenance.source !== "j5_spawn" ||
              (facts.placement.placementParentId === null) !== elsewhere
            ) {
              return yield* stateError(
                `Peer Agent ${facts.home.participantId} committed placement facts that do not satisfy the J5 spawn contract.`,
                "Call j5_list_participants to inspect committed placement truth and ask the human operator to repair the inconsistent record.",
              );
            }
            // The brief's files are claimed into the new thread, which now exists.
            const attachments =
              input.attachments === undefined
                ? []
                : (yield* resolveAttachmentReferences(input.attachments, []).pipe(
                    Effect.flatMap((references) =>
                      claimPendingAttachments({ threadId, attachments: references }),
                    ),
                    Effect.mapError((error) =>
                      stateError(
                        `Peer Agent ${facts.home.participantId} is registered and addressable, but its brief's attachments could not be claimed: ${error.message}`,
                        "Retry j5_spawn_agent with the same client_request_id and attachments that are pending uploads.",
                      ),
                    ),
                  )).attachments;
            yield* spawnWorkspace
              .startBrief({
                workspace,
                stableInput,
                ledgerProjectId: facts.home.projectId,
                projectId: target,
                threadId,
                title: spawnTitle(input.brief, input.title),
                messageId: spawnMessageId(stableInput),
                text: spawnFirstTurnText({
                  brief: input.brief,
                  participantId: facts.home.participantId,
                  projectId: facts.home.projectId,
                  projectTitle: targetProject.title,
                  spawnedByParticipantId: caller.participantId,
                  spawnerThreadId: scope.thread.threadId,
                }),
                modelSelection,
                runtimeMode,
                interactionMode,
                attachments,
              })
              .pipe(
                Effect.mapError((error) =>
                  stateError(
                    `Peer Agent ${facts.home.participantId} is registered and addressable, but its brief did not start: ${error.message}.`,
                    "Retry j5_spawn_agent with the same client_request_id to start the same brief safely.",
                  ),
                ),
              );
            return {
              participant_id: facts.home.participantId,
              thread_id: threadId,
              project_id: facts.home.projectId,
              project_title: targetProject.title,
              placement: {
                placement_parent_id: facts.placement.placementParentId,
                provenance: {
                  kind: "spawned-by" as const,
                  spawned_by_participant_id: facts.placement.provenance.spawnedByParticipantId,
                  source: facts.placement.provenance.source,
                },
              },
            };
          }),
        )
        .pipe(
          Effect.catchTags({
            SpawnWorkspaceError: (error) =>
              Effect.fail(
                stateError(`Peer Agent was not created: ${error.detail}`, error.nextStep),
              ),
          }),
        );
    }).pipe(Effect.mapError(failure)),
  ),
  j5_propose_crew: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const crypto = yield* Crypto.Crypto;
      const captain = yield* preflightCrewCaptain(scope, "j5_propose_crew");
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      // The Captain's playbooks are the ones its own j5_playbook_list shows.
      const playbook =
        input.playbook === undefined
          ? undefined
          : {
              name: input.playbook,
              workspaceRoot: yield* playbookWorkspaceRoot(captain.thread.id).pipe(
                Effect.mapError((error) =>
                  stateError(
                    `Your playbook workspace could not be read: ${error.message}`,
                    "Retry, or propose the crew without a playbook.",
                  ),
                ),
              ),
            };
      const outcome = yield* (yield* CrewProposalService)
        .propose({
          requestKey: `${scope.thread.providerSessionId}:${requestKey}`,
          captain,
          displayName: input.name,
          brief: input.brief,
          ...(playbook === undefined ? {} : { playbook }),
          seats: input.seats.map(crewSeatFromInput),
        })
        .pipe(Effect.mapError((error) => stateError(error.message, crewProposalNextStep(error))));
      return projectCrewProposal(outcome);
    }).pipe(Effect.mapError(failure)),
  ),
  j5_request_crew_member: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const crypto = yield* Crypto.Crypto;
      const captain = yield* preflightCrewCaptain(scope, "j5_request_crew_member");
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const outcome = yield* (yield* CrewProposalService)
        .requestMember({
          requestKey: `${scope.thread.providerSessionId}:${requestKey}`,
          captain,
          crewInstanceId: input.crew_instance_id ?? null,
          seat: {
            seat: input.seat,
            agentId: input.persona ?? null,
            reason: input.reason,
            ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
            ...(input.model_selection === undefined
              ? {}
              : { modelSelection: input.model_selection }),
            ...(input.runtime_mode === undefined ? {} : { runtimeMode: input.runtime_mode }),
            ...(input.steps === undefined ? {} : { steps: input.steps }),
            workspace: spawnWorkspaceFromInput(input.workspace),
          },
          brief: input.brief ?? null,
        })
        .pipe(Effect.mapError((error) => stateError(error.message, crewProposalNextStep(error))));
      return projectCrewProposal(outcome);
    }).pipe(Effect.mapError(failure)),
  ),
  j5_list_personas: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const library = yield* makeAgentPersonaLibrary;
      const current = yield* library
        .catalog()
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `The persona library cannot be read: ${error.message}`,
              "Ask the user to fix the persona library in Settings → Personas, then retry j5_list_personas.",
            ),
          ),
        );
      const providers = yield* (yield* ProviderRegistry).getProviders;
      const disabled = new Set(current.disabledIds);
      const catalog = buildAgentPersonaCatalog(providers, current.definitions);
      return {
        personas: catalog.personas.map((persona) => {
          const isDisabled = disabled.has(persona.personaId);
          const available = !isDisabled && persona.availability.status === "available";
          return {
            id: persona.personaId,
            display_name: persona.displayName,
            description: persona.description,
            runtime_policy: persona.defaultAuthorityPolicy,
            availability: isDisabled
              ? ("disabled" as const)
              : available
                ? ("available" as const)
                : ("blocked" as const),
            route:
              persona.availability.status === "available" && !isDisabled
                ? `${persona.availability.resolvedDriver} · ${persona.availability.resolvedModelSelection.model}${
                    persona.availability.resolvedModelSelection.options?.[0]?.value === undefined
                      ? ""
                      : ` · ${persona.availability.resolvedModelSelection.options[0].value}`
                  }`
                : null,
          };
        }),
      };
    }).pipe(Effect.mapError(failure)),
  ),
  j5_stop_agent: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const crypto = yield* Crypto.Crypto;
      const caller = yield* resolveCallerMembership(scope);
      // Any agent on this server, archived ones included: archiving can leave a run executing.
      const matches = (yield* (yield* A2ASendService)
        .listParticipants(scope.thread.threadId, true)
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `This server's participants cannot be read for j5_stop_agent: ${error.message}.`,
              "Retry j5_stop_agent with the same client_request_id.",
            ),
          ),
        )).filter((row) => row.participantId === input.participant_id);
      if (matches.length !== 1) {
        return yield* stateError(
          `This server has ${matches.length === 0 ? "no" : "an ambiguous"} participant ${input.participant_id}.`,
          "Call j5_list_participants and retry j5_stop_agent with exactly one listed agent participant_id.",
        );
      }
      const target = matches[0]!.participant;
      if (target.kind !== "agent") {
        return yield* stateError(
          `Participant ${input.participant_id} is not an agent with a thread and cannot be stopped.`,
          "Call j5_list_participants and retry j5_stop_agent with an agent participant_id.",
        );
      }
      const threadManagement = yield* ThreadManagementService;
      const targetProjection = yield* threadManagement
        .getThreadProjection(target.threadId)
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Peer Agent thread ${target.threadId} cannot be read for j5_stop_agent: ${error.message}.`,
              "Call j5_list_participants to confirm the target thread, then retry j5_stop_agent.",
            ),
          ),
        );
      // Upstream's rule for a write to another thread: it must run within the caller's modes.
      // A Captain commands its own seats whatever their modes.
      const crews = yield* AgentCrewInstanceService;
      const seat = yield* crews.findMembership(input.participant_id);
      const crew = seat === null ? null : yield* crews.read(seat.crewInstanceId);
      const limits =
        crew !== null && crew.captainParticipantId === caller.participantId
          ? undefined
          : (yield* loadCaller()).limits;
      if (limits !== undefined) {
        yield* assertTargetWithinLimits(limits, targetProjection.thread).pipe(
          Effect.mapError((error) =>
            stateError(
              `Peer Agent ${input.participant_id} runs with broader permissions than you do: ${error.message}`,
              "Ask its Captain or the user to stop it; j5_stop_agent reaches only agents within your own permission modes.",
            ),
          ),
        );
      }
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const commandId = lifecycleCommandId({
        providerSessionId: scope.thread.providerSessionId,
        requestKey,
        operation: "stop-agent",
      });
      // Upstream's Stop, delegated tasks included (see stopThread.ts). The limit goes with it:
      // the target's modes can be raised after the check above, and upstream checks again under
      // the thread's lock.
      yield* stopThread(threadManagement, { commandId, threadId: target.threadId }, limits).pipe(
        Effect.mapError((error) =>
          stateError(
            `Peer Agent ${input.participant_id} on thread ${target.threadId} could not be stopped: ${error.message}.`,
            "Call j5_list_participants to confirm the target, then retry j5_stop_agent with the same client_request_id.",
          ),
        ),
      );
      return latestActiveRun(targetProjection) === undefined
        ? ("already_idle" as const)
        : ("interrupt_requested" as const);
    }).pipe(Effect.mapError(failure)),
  ),
  j5_stop_crew: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const crypto = yield* Crypto.Crypto;
      const caller = yield* resolveCallerMembership(scope);
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const outcome = yield* (yield* CrewStopService)
        .stop({
          callerParticipantId: caller.participantId,
          projectId: caller.projectId,
          crewInstanceId: input.crew_instance_id,
          commandIds: (seatName) => ({
            interruptCommandId: lifecycleCommandId({
              providerSessionId: scope.thread.providerSessionId,
              requestKey: crewSeatRequestKey(requestKey, seatName),
              operation: "stop-crew-interrupt",
            }),
          }),
        })
        .pipe(
          Effect.mapError((error) =>
            stateError(
              error.message,
              error._tag === "CrewStopNotFoundError"
                ? "Check crew_instance_id against the <j5_crew_gate> roster notice and retry."
                : error._tag === "CrewStopRequestError"
                  ? error.nextStep
                  : "Retry j5_stop_crew with the same client_request_id; seats already interrupted stay interrupted.",
            ),
          ),
        );
      return {
        crew_instance_id: outcome.crewInstanceId,
        members: outcome.members.map((member) => ({
          seat: member.seatName,
          participant_id: member.participantId,
          result: member.result,
        })),
      };
    }).pipe(Effect.mapError(failure)),
  ),
  j5_archive_crew: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const crypto = yield* Crypto.Crypto;
      const caller = yield* resolveCallerMembership(scope);
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const archivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const outcome = yield* (yield* ArchiveCrewService).archive({
        providerSessionId: scope.thread.providerSessionId,
        callerParticipantId: caller.participantId,
        projectId: caller.projectId,
        crewInstanceId: input.crew_instance_id,
        clientRequestKey: requestKey,
        ...(input.confirmation_token === undefined
          ? {}
          : { confirmationToken: input.confirmation_token }),
        archivedAt,
        commandIds: (seatName) => ({
          interruptCommandId: lifecycleCommandId({
            providerSessionId: scope.thread.providerSessionId,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-interrupt",
          }),
          archiveCommandId: lifecycleCommandId({
            providerSessionId: scope.thread.providerSessionId,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-thread",
          }),
        }),
      });
      return {
        status: outcome.status,
        crew_instance_id: input.crew_instance_id,
        members: outcome.members.map((member) => ({
          seat: member.seatName,
          participant_id: member.participantId,
          result: member.result,
        })),
      };
    }).pipe(Effect.mapError(archiveCrewFailure)),
  ),
} satisfies McpToolAccess.Handlers<typeof J5Toolkit.tools>;

/** What `/mcp` registers: every J5 tool with its access declared. */
export const layer = McpToolAccess.toLayer(J5Toolkit, handlers);

/** The same handlers as a plain layer, for tests that call a tool without registering it. */
export const J5ToolkitHandlersLive = McpToolAccess.HandlersLayer.layer(layer);
