import * as Layer from "effect/Layer";
import * as SpawnAgentService from "../SpawnAgentService.ts";
import { stateError, preflightSpawnCaller, resolveCallerMembership } from "../AgentCaller.ts";
import { type ChatAttachment, ProjectId } from "@t3tools/contracts";
import { playbookHandlers } from "../../playbooks/mcp.ts";
import { playbookWorkspaceRoot } from "../../playbooks/workspace.ts";
import * as Crypto from "effect/Crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  McpInvocationContext,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";

import {
  assertTargetWithinLimits,
  type CallerLimits,
  loadCaller,
} from "../../../mcp/threadAccess.ts";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementService,
  latestActiveRun,
} from "../../../orchestration-v2/ThreadManagementService.ts";

import { ProjectService } from "../../../project/ProjectService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { makeAgentPersonaLibrary } from "../../agents/agentPersonaLibrary.ts";
import { buildAgentPersonaCatalog } from "../../agents/agentPersonaRouting.ts";

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
import { PeerRegistryService } from "../PeerRegistryService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { withDeliveryNotice } from "../receiverBacklog.ts";
import { A2ASendService } from "../SendService.ts";
import { AGENT_STOP_REASON, stopThread } from "../stopThread.ts";
import { sendClaimingAttachments } from "./attachments.ts";
import {
  outsideAgentCaller,
  sendAsOutsideAgent,
  spawnAndBrief,
  actsAsThreadCaller,
} from "./outsideAgent.ts";

import { spawnWorkspaceFromInput } from "../spawnWorkspace.ts";

import { crewSeatRequestKey, lifecycleCommandId, stablePart } from "../spawnIds.ts";
import {
  CommCommandId,
  LedgerProjectId,
  type ParticipantDirectoryRow,
  type ParticipantId,
} from "../contracts.ts";
import type { ParticipantProvenanceView } from "../placementContracts.ts";
import {
  J5_LIST_PARTICIPANTS_DEFAULT_LIMIT,
  J5Toolkit,
  type J5ArchiveCrewFailure,
  type J5McpFailure,
  type J5ProposeCrewInput,
} from "./tools.ts";

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

/**
 * The calling thread's scope, for a handler that has already ruled out an outside agent or is
 * declared `actsAsCaller`. Tools an outside agent is refused use `actsAsThreadCaller`, which names
 * its legal move.
 */
const callerScope = McpInvocationContext.pipe(
  Effect.flatMap((scope) => requireThreadScope(scope, "This tool")),
);

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
  // Declared `writes` so an outside agent is admitted and a read-only client is refused. A thread
  // caller gets the checks `actsAsCaller` gave it, and `writes` also requires the orchestration
  // capability, which every provider session J5 starts carries.
  j5_send_message: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const outside = yield* outsideAgentCaller;
      if (outside !== undefined) {
        return yield* sendAsOutsideAgent(outside, input, (requestKey) =>
          commandIdForRequest({
            toolName: "send_message",
            providerSessionId: outside.scope.requestNamespace,
            requestKey,
          }),
        );
      }
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
      // A plain queued message needs nothing read first. A file is claimed into the receiver's
      // thread, so its receiver must be an agent on this server. A steer or a restart acts on the
      // receiver's turn: here this server checks it, and on a peer server that server does.
      const receiver =
        mode === "queue" && attachments.length === 0
          ? undefined
          : (yield* service.listParticipants(scope.thread.threadId)).find(
              (row) => row.participantId === input.to,
            );
      const receiverThreadId =
        receiver?.participant.kind === "agent" ? receiver.participant.threadId : undefined;
      let modeLimit: CallerLimits | undefined;
      if (receiverThreadId === undefined && (mode !== "queue" || attachments.length > 0)) {
        const refusal = (what: string) =>
          stateError(
            `${what} only an agent on this server, and ${input.to} is not one.`,
            // A machine takes no message at all and a person takes only an ask, so the
            // retry is not promised to work: the listing says what the recipient accepts.
            `Call j5_list_participants to see what ${input.to} accepts; if it takes messages, retry j5_send_message without ${attachments.length > 0 ? "attachments" : "mode"}.`,
          );
        if (attachments.length > 0) return yield* refusal("attachments reach");
        // Not a participant of this server: an agent on a peer server, if it is anyone.
        const remote =
          receiver !== undefined
            ? []
            : (yield* (yield* PeerDirectory).resolveAgent(input.to)).agents.filter(
                (agent) => !agent.archived,
              );
        const peer = remote.length === 1 ? remote[0] : undefined;
        if (peer === undefined) {
          return yield* stateError(
            `mode=${mode} reaches only an agent, on this server or a peer server, and ${input.to} is not one.`,
            `Call j5_list_participants to see what ${input.to} accepts; if it takes messages, retry j5_send_message without mode.`,
          );
        }
        // An older server would queue the message and say nothing, so it is refused here.
        if (
          (yield* (yield* PeerRegistryService).capabilities(peer.environmentId)).landing !== true
        ) {
          return yield* stateError(
            `${peer.environmentLabel} runs a J5 version that cannot ${mode} a message, so mode=${mode} is refused for ${input.to}.`,
            `Retry j5_send_message without mode, or ask the user to update J5 on ${peer.environmentLabel}.`,
          );
        }
        // That server knows its agent's modes and checks this limit when the message arrives.
        modeLimit = (yield* loadCaller()).limits;
      }
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
      const requestKey =
        input.client_request_id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
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
  j5_clear_own_ask: actsAsThreadCaller(
    "j5_clear_own_ask",
    "An outside agent cannot ask, so it has no ask to withdraw.",
    (input, scope) =>
      Effect.gen(function* () {
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
  j5_list_participants: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const outside = yield* outsideAgentCaller;
      const callerThreadId =
        outside === undefined ? (yield* callerScope).thread.threadId : undefined;
      const service = yield* A2ASendService;
      const orchestrator = yield* OrchestratorV2;
      const includeArchived = input.include_archived ?? false;
      // An outside agent has no row and no project of its own, so it names the project.
      if (callerThreadId === undefined && input.project_id === undefined) {
        return yield* stateError(
          "An outside agent has no project of its own, so j5_list_participants needs a project_id.",
          "Call t3_project_list and retry j5_list_participants with one of its project ids.",
        );
      }
      const directory =
        callerThreadId === undefined
          ? // An outside agent sends plain messages only, so nobody accepts an Exchange or an
            // urgency from it, and a person, who takes only asks, accepts nothing.
            (yield* service.listParticipantsWithoutCaller({
              includeArchived,
              ...(input.project_id === undefined
                ? {}
                : { peopleProjectId: LedgerProjectId.make(input.project_id) }),
            })).map((row) => ({ ...row, canOpenExchange: false, acceptsUrgency: false }))
          : yield* service.listParticipants(callerThreadId, includeArchived);
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
      const self =
        callerThreadId === undefined
          ? undefined
          : directory.find(
              (row) =>
                row.participant.kind === "agent" && row.participant.threadId === callerThreadId,
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
          display_name: row.displayName ?? null,
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
            // An outside agent reaches this server's agents only.
            can_receive_message:
              callerThreadId !== undefined && !agent.archived && agent.canReceiveMessage,
            can_open_exchange:
              callerThreadId !== undefined && !agent.archived && agent.canReceiveMessage,
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
                    : (row.displayName ?? null),
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
  // Declared `writes`, as send and stop are, so an outside agent is admitted and a read-only
  // client is refused. The spawn service holds the chosen modes to the caller's limits: a
  // thread's own modes, or the level an outside agent's sign-in was approved at.
  j5_spawn_agent: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      return yield* (yield* SpawnAgentService.SpawnAgentService).spawn(input, scope);
    }).pipe(Effect.mapError(failure)),
  ),
  j5_propose_crew: actsAsThreadCaller(
    "j5_propose_crew",
    spawnAndBrief("propose the Crew"),
    (input, scope) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const captain = yield* preflightCrewCaptain(scope, "j5_propose_crew");
        const requestKey =
          input.client_request_id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
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
  j5_request_crew_member: actsAsThreadCaller(
    "j5_request_crew_member",
    spawnAndBrief("propose the Crew and ask for the seat"),
    (input, scope) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const captain = yield* preflightCrewCaptain(scope, "j5_request_crew_member");
        const requestKey =
          input.client_request_id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
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
  j5_stop_agent: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext;
      const outside = yield* outsideAgentCaller;
      const scope = outside === undefined ? yield* callerScope : undefined;
      const crypto = yield* Crypto.Crypto;
      // An outside agent has no membership, and is never a Captain.
      const callerParticipantId: ParticipantId | undefined =
        scope === undefined ? undefined : (yield* resolveCallerMembership(scope)).participantId;
      const service = yield* A2ASendService;
      // Any agent on this server, archived ones included: archiving can leave a run executing.
      const matches = (yield* (
        scope === undefined
          ? service.listParticipantsWithoutCaller({ includeArchived: true })
          : service.listParticipants(scope.thread.threadId, true)
      ).pipe(
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
        callerParticipantId !== undefined &&
        crew !== null &&
        crew.captainParticipantId === callerParticipantId
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
      const requestKey =
        input.client_request_id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const commandId = lifecycleCommandId({
        // An outside agent's retry keys are namespaced by its client session.
        providerSessionId: scope?.thread.providerSessionId ?? invocation.requestNamespace,
        requestKey,
        operation: "stop-agent",
      });
      // Upstream's Stop, delegated tasks included (see stopThread.ts). The limit goes with it:
      // the target's modes can be raised after the check above, and upstream checks again under
      // the thread's lock.
      yield* stopThread(
        threadManagement,
        { commandId, threadId: target.threadId, reason: AGENT_STOP_REASON },
        limits,
      ).pipe(
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
  j5_stop_crew: actsAsThreadCaller(
    "j5_stop_crew",
    "Only a Crew's Captain stops it: message the Captain with j5_send_message, or stop one agent with j5_stop_agent.",
    (input, scope) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const caller = yield* resolveCallerMembership(scope);
        const requestKey =
          input.client_request_id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
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
  j5_archive_crew: actsAsThreadCaller(
    "j5_archive_crew",
    "Only a Crew's Captain archives it: message the Captain with j5_send_message and ask it to.",
    (input, scope) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const caller = yield* resolveCallerMembership(scope);
        const requestKey =
          input.client_request_id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
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
export const J5ToolkitHandlersLive = McpToolAccess.HandlersLayer.layer(layer).pipe(
  Layer.provideMerge(SpawnAgentService.layer),
);
