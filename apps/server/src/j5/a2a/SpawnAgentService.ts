import * as SpawnCompositionService from "./SpawnCompositionService.ts";
import * as AgentCrewInstanceService from "./AgentCrewInstanceService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import {
  isAgentPersonaReasoningOptionId,
  type ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { SqlError } from "effect/sql/SqlError";
import {
  requireThreadScope,
  type McpInvocationScope,
  type McpThreadInvocationScope,
} from "../../mcp/McpInvocationContext.ts";
import { loadCaller } from "../../mcp/threadAccess.ts";

import { resolveAttachmentReferences } from "../../mcp/toolkits/attachment/handlers.ts";
import {
  AttachmentClaimError,
  claimPendingAttachments,
  validateAttachmentLimits,
} from "../../orchestration-v2/AttachmentClaims.ts";
import {
  type DispatchModes,
  exceededDispatchModeLimit,
} from "../../orchestration-v2/DispatchModeLimit.ts";

import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { translateAgentPersonaProviderPolicy } from "../agents/agentPersonaProviderPolicy.ts";
import { prepareAgentPersonaPeerSpawn } from "../agents/agentPersonaSpawn.ts";

import { preflightSpawnCaller, stateError } from "./AgentCaller.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { outsideAgentParticipantId, LedgerProjectId } from "./contracts.ts";
import {
  assertPersonaWithinApprovedLevel,
  outsideAgentCaller,
  outsideSpawnHasNoCheckout,
  outsideSpawnNeedsProject,
} from "./mcp/outsideAgent.ts";
import type { J5SpawnAgentInput } from "./mcp/tools.ts";

import * as RequestReplayService from "./RequestReplayService.ts";
import * as SpawnWorkspace from "./spawnWorkspace.ts";
import {
  spawnThreadId,
  spawnHomeCommandId,
  spawnPlacementCommandId,
  spawnTitle,
  spawnMessageId,
  spawnFirstTurnText,
} from "./spawnIds.ts";
import { ChatAttachmentId, type ChatAttachment, type ThreadId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import { planAttachmentClaim, resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
export class SpawnAgentService extends Context.Service<
  SpawnAgentService,
  {
    readonly spawn: (
      input: J5SpawnAgentInput,
      scope: McpInvocationScope,
    ) => ReturnType<typeof spawn>;
  }
>()("t3/j5/a2a/SpawnAgentService") {}

const selectSpawnModel = Effect.fn("j5.a2a.mcp.selectSpawnModel")(function* (
  scope: McpInvocationScope,
  input: { readonly provider: string; readonly model: string; readonly reasoning: string },
) {
  const capabilities = yield* (yield* OrchestratorMcpService.OrchestratorMcpService)
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
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
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

/**
 * The calling thread as a spawner: its home, its project and its checkout. An outside agent has
 * none of these, so `j5_spawn_agent` reads this for a thread caller only.
 */
const preflightThreadSpawner = Effect.fn("j5.a2a.mcp.preflightThreadSpawner")(function* (
  scope: McpThreadInvocationScope,
) {
  const caller = yield* preflightSpawnCaller(scope);
  // Only a Captain grows a Crew, and only through the human gate (Bryant, 2026-09-14): a seat
  // that wants more hands escalates to its Captain; its own helpers are subagents.
  const membership = yield* (yield* AgentCrewInstanceService.AgentCrewInstanceService)
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
  const parent = yield* (yield* ThreadManagementService.ThreadManagementService)
    .getThreadProjection(scope.thread.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} cannot be read for j5_spawn_agent: ${error.message}.`,
          "Read the caller thread state and retry j5_spawn_agent after it is available.",
        ),
      ),
    );
  return {
    participantId: caller.participantId,
    // Retry keys are the provider session's, as they were before outside agents could spawn.
    requestNamespace: scope.thread.providerSessionId,
    home: {
      ledgerProject: { id: caller.projectId, title: caller.project.name },
      thread: parent.thread,
    },
    outside: undefined,
  };
});

/** Read-only preflight; claiming repeats the checks because uploads can change before dispatch. */
const preflightSpawnUploads = Effect.fn("j5.a2a.mcp.preflightSpawnUploads")(function* (
  threadId: ThreadId,
  attachments: ReadonlyArray<ChatAttachment>,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    attachments,
    (attachment) =>
      Effect.gen(function* () {
        const claim = planAttachmentClaim({
          attachmentsDir: config.attachmentsDir,
          threadId,
          attachmentId: attachment.id,
        });
        if (!claim.ok)
          return yield* new AttachmentClaimError({
            message: `Attachment cannot be sent: ${claim.reason}.`,
          });
        const info = yield* fs.stat(claim.currentPath).pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentClaimError({
                message: `Attachment cannot be sent: attachment not found.`,
                cause,
              }),
          ),
        );
        if (Number(info.size) !== attachment.sizeBytes)
          return yield* new AttachmentClaimError({
            message: `Attachment cannot be sent: stored size does not match.`,
          });
        const expectedPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: {
            ...attachment,
            id: ChatAttachmentId.make(claim.finalId),
            mimeType: attachment.mimeType.toLowerCase(),
          },
        });
        if (expectedPath !== claim.finalPath)
          return yield* new AttachmentClaimError({
            message: `Attachment cannot be sent: attachment type does not match the upload.`,
          });
      }),
    { concurrency: 1, discard: true },
  );
});

const spawn = Effect.fn("j5.a2a.spawnAgent")(function* (
  input: J5SpawnAgentInput,
  scope: McpInvocationScope,
) {
  const crypto = yield* Crypto.Crypto;
  // An outside agent has no thread, home, project or checkout: it is recorded as the spawner
  // and the new agent sits at the top level of the project it names.
  const outside = yield* outsideAgentCaller;
  const spawner =
    outside === undefined
      ? yield* preflightThreadSpawner(yield* requireThreadScope(scope, "This tool"))
      : {
          participantId: outsideAgentParticipantId(outside.client.sessionId),
          // A new sign-in is a new session, so it is a new set of retry keys.
          requestNamespace: scope.requestNamespace,
          home: undefined,
          outside,
        };
  const { home } = spawner;
  const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
  const stableInput = { providerSessionId: spawner.requestNamespace, requestKey };
  const threadId = spawnThreadId(stableInput);
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const spawnReadFailure = (error: { readonly message: string }) =>
    stateError(
      `Peer Agent thread ${threadId} could not be read: ${error.message}`,
      "Retry j5_spawn_agent with the same client_request_id once it is readable.",
    );
  const existing = yield* threadManagement
    .getThreadShell(threadId)
    .pipe(Effect.mapError(spawnReadFailure));
  const workspaceRequest =
    input.workspace.type === "worktree"
      ? { ...input.workspace, start_from_origin: input.workspace.start_from_origin ?? false }
      : input.workspace.type === "existing_worktree"
        ? {
            ...input.workspace,
            worktree_path: input.workspace.worktree_path.replace(/[\\/]+$/, ""),
          }
        : input.workspace;
  const request = {
    ...input,
    client_request_id: undefined,
    title: input.title,
    scratch: input.scratch ?? false,
    workspace: workspaceRequest,
  };
  const replayService = yield* RequestReplayService.RequestReplayService;
  const replayFailure = (error: SqlError | RequestReplayService.RequestReplayConflictError) => {
    switch (error._tag) {
      case "SqlError":
        return stateError(
          `The spawn's client_request_id could not be checked: ${error.message}`,
          "Retry j5_spawn_agent with the same client_request_id.",
        );
      case "RequestReplayConflictError":
        return stateError(error.message, "Inspect the original target before starting new work.");
    }
  };
  // A generated key can never be retried, so it has nothing to bind.
  const replayable = input.client_request_id !== undefined;
  if (replayable)
    yield* replayService.check(threadId, request).pipe(Effect.mapError(replayFailure));
  // Refuse invalid uploads before acceptance so corrected metadata can reuse the key.
  if (input.attachments !== undefined) {
    const attachments = input.attachments;
    yield* resolveAttachmentReferences(attachments, []).pipe(
      Effect.flatMap(validateAttachmentLimits),
      Effect.andThen(
        new Set(attachments.map((attachment) => attachment.id)).size === attachments.length
          ? Effect.void
          : new AttachmentClaimError({ message: "Duplicate attachment ids are not allowed." }),
      ),
      // Accepted retries may outlive their pending upload; only a new child needs preflight.
      Effect.andThen(
        existing === null ? preflightSpawnUploads(threadId, attachments) : Effect.void,
      ),
      Effect.mapError((error) =>
        stateError(
          `Peer Agent was not created: ${error.message}`,
          "Retry j5_spawn_agent with corrected attachments; the same client_request_id still works.",
        ),
      ),
    );
  }
  const selected = existing?.modelSelection ?? (yield* selectSpawnModel(scope, input));
  const personaId = input.persona;
  const persona =
    personaId === undefined || existing !== null
      ? undefined
      : yield* prepareSpawnPersona({ ...input, persona: personaId }, selected);
  const modelSelection = existing?.modelSelection ?? persona?.modelSelection ?? selected;
  // A persona's policy sets its permissions. Without one the agent gets the caller's modes,
  // or the ones the caller chose, which upstream's rule keeps within the caller's own.
  if (personaId !== undefined && input.runtime_mode !== undefined) {
    return yield* stateError(
      `Persona ${personaId} sets its own permission mode, so runtime_mode cannot be chosen for it.`,
      "Retry j5_spawn_agent without runtime_mode, or without persona.",
    );
  }
  const { limits } = yield* loadCaller();
  // An outside persona's replay is capped against the existing thread's modes below.
  if (persona !== undefined && personaId !== undefined && outside !== undefined) {
    yield* assertPersonaWithinApprovedLevel(outside, personaId, persona.runtimeMode);
  }
  // With no mode chosen the agent gets the caller's: its thread's, or its approved level.
  const runtimeMode =
    existing?.runtimeMode ??
    input.runtime_mode ??
    persona?.runtimeMode ??
    home?.thread.runtimeMode ??
    limits.runtimeMode;
  const interactionMode =
    existing?.interactionMode ??
    input.interaction_mode ??
    home?.thread.interactionMode ??
    limits.interactionMode;
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
  const firstAttempt = existing === null;
  // A retry finishes the agent its first attempt created, in the modes it was created with.
  // A caller's modes can be narrowed within one provider session, so those are checked
  // against what the caller may touch now. A persona's agent runs under its own policy,
  // except for an outside agent, whose approved level caps every agent it starts. The start
  // checks, after reading the thread again, so an agent a concurrent attempt created counts too.
  const replayExceedsCaller = (caller: DispatchModes, thread: DispatchModes) => {
    if (personaId !== undefined && outside === undefined) return Effect.void;
    const exceeded = exceededDispatchModeLimit(caller, thread);
    return exceeded === undefined
      ? Effect.void
      : Effect.fail(
          stateError(
            `Peer Agent ${participantIdForThread(threadId)} already exists with a ${exceeded === "runtime" ? "permission" : "interaction"} mode broader than yours is now.`,
            "Ask the user to start that agent, or spawn a new one with a fresh client_request_id.",
          ),
        );
  };

  // The project the agent joins: the caller's, another one, or upstream's "No project".
  if (input.scratch === true && input.project_id !== undefined) {
    return yield* stateError(
      "scratch spawns an agent without a project, so it cannot be combined with project_id.",
      "Retry j5_spawn_agent with one of them.",
    );
  }
  const target =
    input.scratch === true
      ? yield* (yield* ManagedProjectFolders.ManagedProjectFolders).ensureScratchProject.pipe(
          Effect.map(({ projectId }) => projectId),
          Effect.mapError((error) =>
            stateError(
              `An agent without a project cannot be spawned here: ${error.message}`,
              "Retry j5_spawn_agent with a project_id, or without scratch for your own project.",
            ),
          ),
        )
      : input.project_id !== undefined
        ? ProjectId.make(input.project_id)
        : home === undefined
          ? yield* outsideSpawnNeedsProject
          : home.thread.projectId;
  // The spawner's own project and checkout, when the agent joins that project.
  const own = home !== undefined && target === home.thread.projectId ? home : undefined;
  const elsewhere = own === undefined;
  const targetProject =
    own !== undefined
      ? own.ledgerProject
      : yield* (yield* ProjectService.ProjectService).getById(target).pipe(
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
  if (home === undefined && input.workspace.type === "shared") {
    return yield* outsideSpawnHasNoCheckout;
  }
  if (elsewhere && input.workspace.type === "shared") {
    return yield* stateError(
      `Your own checkout belongs to your project, and this agent joins project ${target}.`,
      'Retry j5_spawn_agent with workspace {"type":"root"} for that project\'s main checkout, or a worktree of it.',
    );
  }
  const spawnWorkspace = yield* SpawnWorkspace.SpawnWorkspaceService;
  // The project's main checkout binds nothing, so it travels as the shared type with no
  // checkout to share: one create command, and nothing asked of git.
  const choice =
    input.workspace.type === "root"
      ? ({ type: "shared" } as const)
      : SpawnWorkspace.spawnWorkspaceFromInput(input.workspace);
  // A replay must not refuse the branch its own first attempt created, so a named branch is
  // checked for only before the thread exists.
  const checkBranches = choice.type === "worktree" && choice.branch !== undefined && firstAttempt;
  // Sharing a checkout asks nothing of git.
  const checkout =
    choice.type === "shared"
      ? null
      : yield* spawnWorkspace.inspect({
          projectId: target,
          worktreePath: own?.thread.worktreePath ?? null,
          checkBranches,
          baseRefs: SpawnWorkspace.namedBaseRefs([choice]),
          existingWorktreePaths: SpawnWorkspace.namedWorktreePaths([choice]),
        });
  const workspace = yield* Effect.fromResult(
    checkout === null
      ? Result.succeed({ type: "shared" } as const)
      : SpawnWorkspace.resolveSpawnWorkspace(checkout, choice),
  ).pipe(
    Effect.mapError((error) =>
      stateError(`Peer Agent was not created: ${error.detail}`, error.nextStep),
    ),
  );
  return yield* spawnWorkspace
    .withSpawnStart(
      { stableInput, threadId },
      Effect.gen(function* () {
        // What a shared-type thread binds: the caller's checkout, or the project's main one.
        // As upstream's launch does, a main-checkout thread asks for a folder of its own, and
        // gets one only in the "No project" project. It is claimed here, inside the start
        // that only one call at a time may run, and only before the thread exists; a replay
        // replays its create. The thread is looked for again now that this call holds the
        // start: an earlier attempt may have created it since the read above.
        const current = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(spawnReadFailure));
        if (current !== null) {
          yield* spawnWorkspace.assertExistingWorkspace({ stableInput, workspace: workspace.type });
          yield* replayExceedsCaller((yield* loadCaller()).limits, current);
        }
        if (replayable)
          yield* replayService
            .bind({
              id: threadId,
              target: `Peer Agent ${participantIdForThread(threadId)} on thread ${threadId}`,
              request,
            })
            .pipe(Effect.mapError(replayFailure));

        const sharedCheckout =
          current !== null
            ? current
            : input.workspace.type !== "root" && home !== undefined
              ? home.thread
              : {
                  branch: null,
                  worktreePath: Option.getOrNull(
                    yield* (yield* ManagedProjectFolders.ManagedProjectFolders)
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
            commandId: SpawnWorkspace.spawnCreateCommandId(stableInput, workspace.type),
            threadId,
            projectId: target,
            title: spawnTitle(input.title),
            modelSelection: current?.modelSelection ?? modelSelection,
            runtimeMode: current?.runtimeMode ?? runtimeMode,
            interactionMode: current?.interactionMode ?? interactionMode,
            ...(persona === undefined ? {} : { agentPersonaAssignment: persona.assignment }),
            ...(current === null
              ? SpawnWorkspace.spawnThreadCheckout(workspace, sharedCheckout)
              : { branch: current.branch, worktreePath: current.worktreePath }),
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
        const facts = yield* (yield* SpawnCompositionService.SpawnCompositionService)
          .recordFacts({
            homeCommandId: spawnHomeCommandId(stableInput),
            placementCommandId: spawnPlacementCommandId(stableInput),
            projectId: targetProject.id,
            threadId,
            provenance: {
              kind: "spawned-by",
              spawnedByParticipantId: spawner.participantId,
              source: "j5_spawn",
            },
            ...(outside === undefined ? {} : { outsideSpawnerName: outside.client.label }),
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
        // In the spawner's own project the agent sits under it; in another it is a root, as
        // is every agent an outside agent starts.
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
        // The brief's files are claimed into the new thread, which now exists. Once the brief's
        // receipt shows it accepted, they are the thread's already: claiming again would copy them
        // a second time, and fails once the pending upload is swept. A thread without that
        // receipt never got its brief, so a retry still claims.
        const briefAccepted =
          current !== null &&
          (yield* spawnWorkspace
            .briefAccepted({ stableInput, workspace: workspace.type })
            .pipe(
              Effect.mapError((error) =>
                stateError(
                  `Peer Agent ${facts.home.participantId} is registered and addressable, but whether its brief started could not be read: ${error.message}`,
                  "Retry j5_spawn_agent with the same client_request_id.",
                ),
              ),
            ));
        const attachments =
          input.attachments === undefined || briefAccepted
            ? []
            : (yield* resolveAttachmentReferences(input.attachments, []).pipe(
                Effect.flatMap((references) =>
                  claimPendingAttachments({ threadId, attachments: references }),
                ),
                Effect.mapError((error) =>
                  stateError(
                    `Peer Agent ${facts.home.participantId} is registered and addressable, but its brief's attachments could not be claimed: ${error.message}`,
                    "Retry j5_spawn_agent with the same client_request_id and the original attachment ids after repairing the upload; use a fresh client_request_id for a changed brief.",
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
            title: spawnTitle(input.title),
            messageId: spawnMessageId(stableInput),
            text: spawnFirstTurnText({
              brief: input.brief,
              participantId: facts.home.participantId,
              projectId: facts.home.projectId,
              projectTitle: targetProject.title,
              spawnedByParticipantId: spawner.participantId,
              ...(outside === undefined
                ? { spawnerThreadId: scope.thread?.threadId }
                : { outsideAgentName: outside.client.label }),
            }),
            modelSelection: child.thread.modelSelection,
            runtimeMode: child.thread.runtimeMode,
            interactionMode: child.thread.interactionMode,
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
          Effect.fail(stateError(`Peer Agent was not created: ${error.detail}`, error.nextStep)),
      }),
    );
});

export const layer = Layer.succeed(SpawnAgentService, SpawnAgentService.of({ spawn }));
