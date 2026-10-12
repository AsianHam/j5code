import { Tool, Toolkit } from "effect/ai";
import { playbookTools } from "../../playbooks/mcp.ts";
import * as Schema from "effect/Schema";
import { PLAYBOOK_MAX_STEPS } from "@t3tools/contracts/j5";
import { PlaybookStore } from "../../playbooks/PlaybookStore.ts";
import { ManagedProjectFolders } from "../../../project/ManagedProjectFolders.ts";
import { ProjectService } from "../../../project/ProjectService.ts";

import {
  AgentPersonaId,
  ModelSelection,
  OrchestrationV2RunStatus,
  ProviderInstanceId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { McpAttachmentInput } from "../../../mcp/toolkits/attachment/input.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "../ArchiveCrewService.ts";
import {
  CREW_NAME_MAX_CHARS,
  CREW_NAME_PATTERN,
  CREW_REASON_MAX_CHARS,
  CREW_SEAT_CAP,
  CREW_SEAT_NAME_PATTERN,
  CREW_TEXT_MAX_CHARS,
} from "../crewLimits.ts";
import { CrewProposalService } from "../CrewProposalService.ts";
import { CrewStopService } from "../CrewStopService.ts";
import {
  A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
} from "../EnvelopeFormatter.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { PeerDirectory } from "../PeerDirectory.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { GitRefName, SpawnWorkspaceService, WorktreePath } from "../spawnWorkspace.ts";
import { ThreadRegistration } from "../ThreadRegistration.ts";
import {
  AgentParticipant,
  ClearOwnAskResult,
  ExchangeId,
  HumanParticipant,
  MachineParticipant,
  ParticipantId,
  SendMessageResult,
  LedgerProjectId,
  SendMode,
  Urgency,
} from "../contracts.ts";
import {
  ForkedFromParticipantProvenance,
  SpawnedByParticipantProvenance,
  UnknownParticipantProvenance,
} from "../placementContracts.ts";

export const J5McpFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type J5McpFailure = typeof J5McpFailure.Type;

export const J5SendMessageInput = Schema.Struct({
  to: ParticipantId,
  message: Schema.String.check(Schema.isNonEmpty()),
  client_request_id: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isNonEmpty()))),
  expect_reply: Schema.optional(Schema.NullOr(Schema.Boolean)),
  exchange_id: Schema.optional(Schema.NullOr(ExchangeId)),
  intent: Schema.optional(
    Schema.NullOr(
      Schema.String.check(Schema.isNonEmpty()).annotate({
        description:
          "One line saying what an ask (expect_reply=true) is about. It labels the ask and does not change how the message is delivered; to interrupt a busy agent, set mode.",
      }),
    ),
  ),
  urgency: Schema.optional(Schema.NullOr(Urgency)),
  attachments: Schema.optional(
    Schema.NullOr(
      Schema.Array(McpAttachmentInput)
        .check(Schema.isMinLength(1), Schema.isMaxLength(8))
        .annotate({
          description:
            "Files for an agent on this server: pending uploads from t3_attachment_prepare_upload, or attachments its thread already holds.",
        }),
    ),
  ),
  mode: Schema.optional(
    Schema.NullOr(
      SendMode.annotate({
        description:
          "Set this to interrupt an agent that is mid-turn. steer puts your message into the turn it is running now. restart stops that turn and starts it again on your message. queue, the default, is ordinary delivery: after the turn ends for most agents, and into the running turn for Codex GPT 6 agents.",
      }),
    ),
  ),
});
export type J5SendMessageInput = typeof J5SendMessageInput.Type;

export const J5ClearOwnAskInput = Schema.Struct({
  exchange_id: ExchangeId,
  client_request_id: Schema.String.check(Schema.isNonEmpty()),
});
export type J5ClearOwnAskInput = typeof J5ClearOwnAskInput.Type;

const J5AgentParticipant = Schema.Struct({
  kind: AgentParticipant.fields.kind,
  id: AgentParticipant.fields.id,
  thread_id: AgentParticipant.fields.threadId,
});

const J5Participant = Schema.Union([J5AgentParticipant, HumanParticipant, MachineParticipant]);

export const J5ParticipantProvenanceView = Schema.Union([
  Schema.Struct({
    kind: SpawnedByParticipantProvenance.fields.kind,
    spawned_by_participant_id: SpawnedByParticipantProvenance.fields.spawnedByParticipantId,
    source: SpawnedByParticipantProvenance.fields.source,
  }),
  Schema.Struct({
    kind: ForkedFromParticipantProvenance.fields.kind,
    source_participant_id: ForkedFromParticipantProvenance.fields.sourceParticipantId,
    source: ForkedFromParticipantProvenance.fields.source,
  }),
  UnknownParticipantProvenance,
  Schema.Struct({ kind: Schema.Literal("unrecorded") }),
  Schema.Struct({ kind: Schema.Literal("not-applicable") }),
]);
export type J5ParticipantProvenanceView = typeof J5ParticipantProvenanceView.Type;

export const J5ParticipantDirectoryRow = Schema.Struct({
  project_id: LedgerProjectId,
  /** The project's title beside its id; on the self row, the caller's own project. */
  project_title: Schema.NullOr(Schema.String),
  participant_id: ParticipantId,
  participant: J5Participant,
  self: Schema.Boolean,
  archived: Schema.Boolean,
  can_receive_message: Schema.Boolean,
  can_open_exchange: Schema.Boolean,
  accepts_urgency: Schema.Boolean,
  thread_id: Schema.NullOr(ThreadId),
  provenance: J5ParticipantProvenanceView,
  placement_parent_id: Schema.NullOr(ParticipantId),
  display_name: Schema.NullOr(Schema.String),
  /** Where the participant lives, by the server's own name; present once this server has a peer. */
  server: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      local: Schema.Boolean,
      /** Only on a peer server that polls this one: whether it is online; while it is not, its messages wait. */
      available: Schema.optionalKey(Schema.Boolean),
      /** When that server last polled, once it has. */
      last_available_at: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type J5ParticipantDirectoryRow = typeof J5ParticipantDirectoryRow.Type;

/** The most rows one listing returns, and how many it returns when `limit` is omitted. */
export const J5_LIST_PARTICIPANTS_MAX_LIMIT = 100;
export const J5_LIST_PARTICIPANTS_DEFAULT_LIMIT = 50;

/**
 * One page of one project's address book, shaped as upstream's `t3_thread_list` is: an offset
 * cursor, a capped limit and optional filters, read from current state on every call.
 */
export const J5ListParticipantsInput = Schema.Struct({
  project_id: Schema.optional(
    LedgerProjectId.annotate({
      description:
        "Project to list. Omit for your own project; find other projects with t3_project_list.",
    }),
  ),
  server: Schema.optional(
    Schema.String.check(Schema.isNonEmpty()).annotate({
      description:
        "Name of a peer server, from the result's servers, to list its agents. Omit for this server.",
    }),
  ),
  name_contains: Schema.optional(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
      description: "Keep agents and machines whose display name contains this text.",
    }),
  ),
  settled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true keeps only settled agents, false only active ones; omit for both. This server only.",
    }),
  ),
  include_archived: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: J5_LIST_PARTICIPANTS_MAX_LIMIT })),
  ),
});
export type J5ListParticipantsInput = typeof J5ListParticipantsInput.Type;

export const J5ListParticipantsResult = Schema.Struct({
  participants: Schema.Array(J5ParticipantDirectoryRow),
  /** Pass as `cursor` for the next page; null on the last page. */
  next_cursor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** How many rows match the filters across every page. */
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Every server whose agents can be listed, once this server has a peer. */
  servers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, local: Schema.Boolean })),
  ),
  /** Peer servers whose address books could not be read: their agents are absent, not gone. */
  unread_peer_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());

/** The snake_case MCP form of a spawn's workspace choice; see `spawnWorkspace.ts`. */
export const J5SpawnWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("shared") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    base_ref: GitRefName.annotate({
      description: "Branch, tag, or commit the new worktree starts from; it must already exist.",
    }),
    branch: Schema.optional(
      GitRefName.annotate({
        description:
          "New branch name. It must not exist yet. Omit and the server names it from the brief.",
      }),
    ),
    start_from_origin: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Fetch origin and start from its copy of base_ref when it has one. Defaults to false: start from local commits.",
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktree_path: WorktreePath.annotate({
      description: "Path of one of this project's worktrees; the agent works on its branch.",
    }),
  }),
]);
export type J5SpawnWorkspace = typeof J5SpawnWorkspace.Type;

/** The stored camelCase form of an MCP workspace choice; unset fields stay unset. */
export const spawnWorkspaceFromInput = (workspace: J5SpawnWorkspace) =>
  workspace.type === "shared"
    ? { type: "shared" as const }
    : workspace.type === "existing_worktree"
      ? { type: "existing_worktree" as const, worktreePath: workspace.worktree_path }
      : {
          type: "worktree" as const,
          baseRef: workspace.base_ref,
          ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
          ...(workspace.start_from_origin === undefined
            ? {}
            : { startFromOrigin: workspace.start_from_origin }),
        };

/**
 * A spawn's workspace choice: a Crew seat's three, and the project's own checkout, which is
 * upstream's `root`. A spawn into another project has no "your own checkout" to share.
 */
export const J5SpawnAgentWorkspace = Schema.Union([
  ...J5SpawnWorkspace.members,
  Schema.Struct({ type: Schema.Literal("root") }),
]);
export type J5SpawnAgentWorkspace = typeof J5SpawnAgentWorkspace.Type;

export const J5SpawnAgentInput = Schema.Struct({
  brief: NonEmptyString,
  title: Schema.optional(NonEmptyString),
  project_id: Schema.optional(
    LedgerProjectId.annotate({
      description:
        "Project the Peer Agent joins. Omit for your own; find others with t3_project_list.",
    }),
  ),
  scratch: Schema.optional(
    Schema.Boolean.annotate({
      description:
        'Spawn without a project: the agent joins the "No project" project and works in a fresh folder of its own, outside any repository. Not with project_id; workspace must be {"type":"root"}.',
    }),
  ),
  runtime_mode: Schema.optional(
    RuntimeMode.annotate({
      description:
        "The agent's permission mode. Omit to give it yours. Not broader than your own, and not with persona, whose policy sets it.",
    }),
  ),
  interaction_mode: Schema.optional(
    ProviderInteractionMode.annotate({
      description:
        "The agent's interaction mode. Omit to give it yours. Not broader than your own.",
    }),
  ),
  attachments: Schema.optional(
    Schema.Array(McpAttachmentInput).check(Schema.isMinLength(1), Schema.isMaxLength(8)).annotate({
      description: "Files for the brief: pending uploads from t3_attachment_prepare_upload.",
    }),
  ),
  persona: Schema.optional(
    AgentPersonaId.annotate({
      description:
        "Persona id from j5_list_personas. The spawn runs with that persona's instructions and runtime policy, and provider, model, and reasoning must be one of its declared routes.",
    }),
  ),
  provider: ProviderInstanceId,
  model: NonEmptyString,
  reasoning: NonEmptyString,
  workspace: J5SpawnAgentWorkspace.annotate({
    description:
      'Where the Peer Agent works, chosen every time: {"type":"shared"} is your own checkout and branch, in your own project only; {"type":"root"} the project\'s main checkout; {"type":"worktree","base_ref":...} a new worktree and branch from base_ref; {"type":"existing_worktree","worktree_path":...} one of the project\'s worktrees, on its branch.',
  }),
  client_request_id: Schema.optional(NonEmptyString),
});
export type J5SpawnAgentInput = typeof J5SpawnAgentInput.Type;

export const J5SpawnAgentResult = Schema.Struct({
  participant_id: ParticipantId,
  thread_id: ThreadId,
  project_id: LedgerProjectId,
  project_title: Schema.String,
  placement: Schema.Struct({
    /** The spawner, when the agent joined the spawner's own project; null in another project. */
    placement_parent_id: Schema.NullOr(ParticipantId),
    provenance: Schema.Struct({
      kind: Schema.Literal("spawned-by"),
      spawned_by_participant_id: ParticipantId,
      source: Schema.Literal("j5_spawn"),
    }),
  }),
});

export const J5ListAgentsResult = Schema.Struct({
  personas: Schema.Array(
    Schema.Struct({
      id: AgentPersonaId,
      display_name: NonEmptyString,
      description: NonEmptyString,
      runtime_policy: NonEmptyString,
      availability: Schema.Literals(["available", "blocked", "disabled"]),
      /** The provider, model, and reasoning this persona would run on right now, or null when blocked. */
      route: Schema.NullOr(NonEmptyString),
    }),
  ),
});

/**
 * Bounds keep a runaway Captain from filing megabyte briefs into the gate and the snapshot, and
 * names stay one line each because the platform writes them into the notices whose fields the
 * Captain's card parses (see `crewLimits.ts`).
 */
export { CREW_NAME_MAX_CHARS, CREW_REASON_MAX_CHARS, CREW_TEXT_MAX_CHARS };
const CrewName = NonEmptyString.check(
  Schema.isMaxLength(CREW_NAME_MAX_CHARS),
  Schema.isPattern(CREW_NAME_PATTERN),
);
const CrewSeatName = NonEmptyString.check(
  Schema.isMaxLength(CREW_NAME_MAX_CHARS),
  Schema.isPattern(CREW_SEAT_NAME_PATTERN),
);
const CrewReason = NonEmptyString.check(Schema.isMaxLength(CREW_REASON_MAX_CHARS));
const CrewText = NonEmptyString.check(Schema.isMaxLength(CREW_TEXT_MAX_CHARS));
const CrewSeatPersona = AgentPersonaId.annotate({
  description:
    "Persona id from j5_list_personas. Omit for a custom seat with required instructions and optional model_selection/runtime_mode overrides; an omitted model_selection inherits the Captain's and an omitted runtime_mode is full-access. Saved personas are proposed with their own configuration; the human may edit their runtime before approval.",
});

const CrewSeatModelSelection = Schema.toType(ModelSelection).annotate({
  description:
    "Custom seats only: provider instance and model from orchestrator_capabilities. Set options to an array of {id, value} using that model's advertised reasoning option. Omit to inherit the Captain's model selection.",
});
const CrewSeatSteps = Schema.Array(NonEmptyString)
  .check(Schema.isMaxLength(PLAYBOOK_MAX_STEPS))
  .annotate({
    description:
      "Only when the crew follows a playbook: ids of the steps this seat owns, from j5_playbook_read. A step has one owner; steps no seat owns are yours to do as Captain.",
  });
const CrewPlaybookName = NonEmptyString.annotate({
  description:
    "Optional: the playbook this crew follows, by the name j5_playbook_list returns (the same name j5_playbook_start takes). Give seats the step ids they own with steps.",
});
const CrewSeatWorkspace = J5SpawnWorkspace.annotate({
  description:
    'Where the seat works, chosen for every seat, with the same three choices as j5_spawn_agent: {"type":"shared"} (your checkout), {"type":"worktree","base_ref":...}, or {"type":"existing_worktree","worktree_path":...}.',
});
const CrewSeatRuntimeMode = RuntimeMode.annotate({
  description:
    "Custom seats only: access mode. Omit for full-access; the Captain's access mode is not inherited.",
});

export const J5CrewSeatInput = Schema.Struct({
  seat: CrewSeatName,
  persona: Schema.optional(CrewSeatPersona),
  model_selection: Schema.optional(CrewSeatModelSelection),
  runtime_mode: Schema.optional(CrewSeatRuntimeMode),
  reason: CrewReason,
  instructions: Schema.optional(CrewText),
  steps: Schema.optional(CrewSeatSteps),
  workspace: CrewSeatWorkspace,
});

export const J5ProposeCrewInput = Schema.Struct({
  name: CrewName,
  brief: CrewText,
  playbook: Schema.optional(CrewPlaybookName),
  seats: Schema.Array(J5CrewSeatInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CREW_SEAT_CAP),
  ),
  client_request_id: Schema.optional(NonEmptyString),
});
export type J5ProposeCrewInput = typeof J5ProposeCrewInput.Type;

export const J5RequestCrewMemberInput = Schema.Struct({
  crew_instance_id: Schema.optional(NonEmptyString),
  seat: CrewSeatName,
  persona: Schema.optional(CrewSeatPersona),
  model_selection: Schema.optional(CrewSeatModelSelection),
  runtime_mode: Schema.optional(CrewSeatRuntimeMode),
  reason: CrewReason,
  brief: Schema.optional(CrewText),
  instructions: Schema.optional(CrewText),
  steps: Schema.optional(CrewSeatSteps),
  workspace: CrewSeatWorkspace,
  client_request_id: Schema.optional(NonEmptyString),
});
export type J5RequestCrewMemberInput = typeof J5RequestCrewMemberInput.Type;

export const J5CrewProposalResult = Schema.Struct({
  proposal_id: NonEmptyString,
  status: Schema.Literals(["open", "approved", "declined"]),
  crew_instance_id: Schema.NullOr(NonEmptyString),
  members: Schema.Array(
    Schema.Struct({
      seat: NonEmptyString,
      persona_id: Schema.NullOr(AgentPersonaId),
      participant_id: ParticipantId,
      thread_id: ThreadId,
    }),
  ),
  /** Present only when the proposal follows a playbook. */
  playbook: Schema.optional(
    Schema.Struct({
      name: NonEmptyString,
      title: NonEmptyString,
      unowned_steps: Schema.Array(NonEmptyString),
      persona_swaps: Schema.Array(
        Schema.Struct({
          seat: NonEmptyString,
          step_id: NonEmptyString,
          wanted_persona: AgentPersonaId,
          seat_persona: Schema.NullOr(AgentPersonaId),
          wanted_problem: Schema.NullOr(Schema.Literals(["missing", "disabled"])),
        }),
      ),
    }),
  ),
});

export const J5StopAgentInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  participant_id: ParticipantId,
});
export type J5StopAgentInput = typeof J5StopAgentInput.Type;

export const J5StopAgentResult = Schema.Literals(["interrupt_requested", "already_idle"]);

export const J5StopCrewInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  crew_instance_id: NonEmptyString,
});
export type J5StopCrewInput = typeof J5StopCrewInput.Type;

export const J5StopCrewResult = Schema.Struct({
  crew_instance_id: NonEmptyString,
  members: Schema.Array(
    Schema.Struct({
      seat: NonEmptyString,
      participant_id: ParticipantId,
      result: Schema.Literals(["interrupt_requested", "already_idle", "archived", "never_created"]),
    }),
  ),
});

export const J5_STOP_CREW_DESCRIPTION =
  "Stop a Crew you command the way a user Stop does, seat by seat: each seat's running turn is interrupted now, turns already queued behind it, messages you sent it included, are held until a person resumes its queue (no tool releases them, and a message sent after the stop runs ahead of them), its pull request watches end, and the tasks it delegated stop too. Nothing settles or is retired, and every seat can be messaged again afterwards. Captain-only. Reuse client_request_id to retry safely.";

export const J5ArchiveResult = Schema.Literals(["archived", "already_archived"]);

export const J5ArchiveOpenExchangeFact = Schema.Struct({
  exchange_id: ExchangeId,
  direction: Schema.Literals(["inbound", "outbound"]),
  reply_obligation: Schema.Literals(["participant-owes-reply", "counterparty-owes-reply"]),
  counterparty_id: ParticipantId,
  intent: Schema.String,
  urgency: Schema.NullOr(Urgency),
  opened_at: Schema.String,
});

export const J5ArchiveRunningTurnFact = Schema.Struct({
  run_id: RunId,
  status: OrchestrationV2RunStatus,
});

export const J5ArchiveCrewInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  crew_instance_id: NonEmptyString,
  confirmation_token: Schema.optional(NonEmptyString),
});
export type J5ArchiveCrewInput = typeof J5ArchiveCrewInput.Type;

export const J5ArchiveCrewResult = Schema.Struct({
  status: J5ArchiveResult,
  crew_instance_id: NonEmptyString,
  members: Schema.Array(
    Schema.Struct({
      seat: NonEmptyString,
      participant_id: ParticipantId,
      // never_created: the seat's thread never came to exist, so the unit retired past it.
      result: Schema.Literals(["archived", "already_archived", "never_created"]),
    }),
  ),
});

export const J5ArchiveCrewMemberFacts = Schema.Struct({
  seat: NonEmptyString,
  participant_id: ParticipantId,
  already_archived: Schema.Boolean,
  open_exchanges: Schema.Array(J5ArchiveOpenExchangeFact),
  running_turn: Schema.NullOr(J5ArchiveRunningTurnFact),
});

export const J5ArchiveCrewFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  members: Schema.optional(Schema.Array(J5ArchiveCrewMemberFacts)),
  confirmation_token: Schema.optional(Schema.NullOr(Schema.String)),
  archived_seats: Schema.optional(Schema.Array(NonEmptyString)),
  failed_seat: Schema.optional(NonEmptyString),
});
export type J5ArchiveCrewFailure = typeof J5ArchiveCrewFailure.Type;

export const J5_SPAWN_AGENT_DESCRIPTION =
  "Spawn a Peer Agent: a full-citizen teammate with its own top-level thread, starting on your brief as its first turn. It joins your project unless you name another with project_id or set scratch for none, and records you as its immutable spawner; in your own project it is placed under you. It is addressable the moment this returns. In your brief, tell the new agent what it should do first and whether it should reply to you. Choose provider, model, and reasoning for the work in the brief — see orchestrator_capabilities for what's available. To run a persona from j5_list_personas, set `persona` to its id: the spawn gets that persona's instructions and runtime policy, and provider, model, and reasoning must be one of that persona's declared routes. Without a persona it runs in your permission and interaction modes, or in narrower ones you set with runtime_mode and interaction_mode. Attach files to the brief with attachments. Choose its workspace every time (see the workspace field). A new worktree is prepared after this returns, and the agent begins once it is bound, possibly while the project's setup script is still running; if preparing it fails, the agent's thread shows why, and it is not retried. Reuse client_request_id to retry the same spawn safely; a retry replays the first spawn, so a different base_ref or worktree_path needs a fresh client_request_id.";

export const J5_LIST_AGENTS_DESCRIPTION =
  "List the personas in this environment: id, purpose, runtime policy, whether each can start now, and the provider, model, and reasoning it would run on. Read this before choosing a persona for j5_spawn_agent or a crew roster so the choice fits the task and the user's budget. Read-only.";

export const J5_PROPOSE_CREW_DESCRIPTION =
  "Propose the crew you need for the brief you were given. Use it when the user asks for a crew or the work splits into distinct responsibilities that should run at once. Mix saved personas and custom seats in the same roster: call j5_list_personas when choosing a saved persona, or leave persona unset for a custom seat with its own instructions (required) and the brief. Custom seats inherit your harness, model, and reasoning by default and run with full-access unless you set runtime_mode; to choose different ones, set model_selection (instanceId, model, options) and/or runtime_mode using orchestrator_capabilities. Saved personas are proposed with their own configuration; only the human may override their runtime before approval. To have the crew follow a playbook, set playbook to a name from j5_playbook_list and give seats the step ids they own (steps, from j5_playbook_read); a step has one owner, steps no seat owns are yours as Captain, and the result reports unowned steps and any step whose persona differs from its seat's. For a crew built from a playbook, staff one seat per distinct persona its steps name, each owning that persona's steps, and propose a custom seat, noted in its reason, where a named persona isn't available. Every seat names its workspace, with the same three choices as j5_spawn_agent. Name the crew for what it is for and give each seat a short lowercase-hyphen name like code-reviewer. The user reviews the roster and each seat's resolved provider, model, reasoning, and access in this thread, may remove or add seats, and approves or declines; you receive the decision and the roster as a message here. Approved seats run with the runtime the human approves, which may exceed yours. You become the crew's Captain and may command several crews at once; later requests, stops, and archives name the crew they mean. Use j5_send_message for member-to-member, member-to-Captain, and Captain-to-Captain coordination, including findings and direct results; artifacts do not gate these conversations. Reuse client_request_id to retry safely. This call is itself the human gate, so it works under every sandbox and approval policy, including approval policy never; never refuse the brief because approvals are disabled.";

export const J5_REQUEST_CREW_MEMBER_DESCRIPTION =
  "Ask the user to add one seat to a crew you command when the work needs one the roster lacks: seat name, persona id from j5_list_personas (or none for a custom seat with required instructions and optional model_selection/runtime_mode overrides; an omitted model_selection inherits yours and an omitted runtime_mode is full-access; saved-persona runtime changes are made only by the human before approval), a clear reason identifying the concern and missing expertise or responsibility, its workspace (the same three choices as j5_propose_crew), and optionally instructions and a brief for the new seat. On a crew that follows a playbook, steps may claim step ids from j5_playbook_read that no seat owns yet. The user decides from their inbox; you receive the decision and the updated roster as a message here. Continue the already-approved work and direct coordination while the addition is pending. Captain-only; a member sends the concern and needed expertise to its Captain with j5_send_message. Reuse client_request_id to retry safely. Filing the request is the human gate itself and works under every approval policy, including approval policy never.";

export const J5_STOP_AGENT_DESCRIPTION =
  "Stop one Peer Agent the way a user Stop does: its running turn is interrupted now, turns already queued behind it, messages you sent it included, are held until a person resumes its queue (no tool releases them, and a message sent after the stop runs ahead of them), its pull request watches end, and the tasks it delegated stop too. The agent remains, stays readable, and can be messaged again later — stopping halts work, it retires nothing. It reaches any agent on this server, in any project. Reuse client_request_id to retry safely.";

export const J5_ARCHIVE_CREW_DESCRIPTION =
  "Retire a whole Crew you command. Crews archive only as a unit — members are never retired one by one. A clean archive completes immediately; otherwise the call refuses with the facts and a confirmation_token. Before retrying with that token, check with the user. Nothing is destroyed: worktrees, branches, and ledgers stay readable. Reuse client_request_id to retry safely.";

// McpToolAccess reads the calling thread before any tool that needs one, so each of those
// tools depends on ThreadManagementService whether or not its handler does.
const sendDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService,
  A2ASendService,
  A2AHomeRegistrar,
  A2ADeliveryWorker,
  Crypto.Crypto,
  OrchestratorV2,
  // The receiver backlog read behind the send result's deliveryNotice.
  SqlClient.SqlClient,
  // Attachments are claimed into the receiver's thread before the message is committed.
  ServerConfig,
  FileSystem.FileSystem,
];

const placementDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService,
  A2ASendService,
  ParticipantPlacementService,
  OrchestratorV2,
  PeerDirectory,
  A2ALedger,
  // Tells a project that does not exist from one with nobody in it.
  ProjectService,
];

const spawnDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  A2AHomeRegistrar,
  ThreadRegistration,
  A2ALedger,
  SpawnCompositionService,
  // Resolves the workspace, binds the request key to it, and starts the brief.
  SpawnWorkspaceService,
  ThreadManagementService,
  OrchestratorMcpService,
  // A Crew member is refused before anything is created (members never spawn Peer Agents).
  AgentCrewInstanceService,
  ProviderRegistry,
  // Another project, the "No project" project and its per-thread folder, and brief attachments.
  ProjectService,
  ManagedProjectFolders,
  ServerConfig,
  FileSystem.FileSystem,
];

const crewProposalDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  A2AHomeRegistrar,
  ThreadRegistration,
  A2ALedger,
  ThreadManagementService,
  AgentCrewInstanceService,
  CrewProposalService,
  // j5_propose_crew resolves the Captain's playbook workspace like the playbook tools do.
  PlaybookStore,
  ProjectService,
];

const listAgentsDependencies = [McpInvocationContext.McpInvocationContext, ProviderRegistry];

const stopDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  ThreadManagementService,
  // A Captain stops its own seats whatever their permission modes.
  AgentCrewInstanceService,
];

const stopCrewDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService,
  A2ASendService,
  Crypto.Crypto,
  A2ALedger,
  CrewStopService,
];

const archiveCrewDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService,
  A2ASendService,
  Crypto.Crypto,
  A2ALedger,
  ArchiveCrewService,
];

export const J5SendMessageTool = Tool.make("j5_send_message", {
  description: A2A_SEND_TOOL_DESCRIPTION,
  parameters: J5SendMessageInput,
  success: SendMessageResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: sendDependencies,
})
  .annotate(Tool.Title, "Send a cross-agent message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5ListParticipantsTool = Tool.make("j5_list_participants", {
  description: A2A_LIST_TOOL_DESCRIPTION,
  parameters: J5ListParticipantsInput,
  success: J5ListParticipantsResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: placementDependencies,
})
  .annotate(Tool.Title, "List cross-agent messaging participants")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const J5SpawnAgentTool = Tool.make("j5_spawn_agent", {
  description: J5_SPAWN_AGENT_DESCRIPTION,
  parameters: J5SpawnAgentInput,
  success: J5SpawnAgentResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: spawnDependencies,
})
  .annotate(Tool.Title, "Spawn a Peer Agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5ProposeCrewTool = Tool.make("j5_propose_crew", {
  description: J5_PROPOSE_CREW_DESCRIPTION,
  parameters: J5ProposeCrewInput,
  success: J5CrewProposalResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: crewProposalDependencies,
})
  .annotate(Tool.Title, "Propose a Crew")
  .annotate(Tool.Readonly, false)
  // Files a human-gated request; nothing spawns until the user approves it in the app.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5RequestCrewMemberTool = Tool.make("j5_request_crew_member", {
  description: J5_REQUEST_CREW_MEMBER_DESCRIPTION,
  parameters: J5RequestCrewMemberInput,
  success: J5CrewProposalResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: crewProposalDependencies,
})
  .annotate(Tool.Title, "Request a crew member")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5ListAgentsTool = Tool.make("j5_list_personas", {
  description: J5_LIST_AGENTS_DESCRIPTION,
  success: J5ListAgentsResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: listAgentsDependencies,
})
  .annotate(Tool.Title, "List personas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const J5StopAgentTool = Tool.make("j5_stop_agent", {
  description: J5_STOP_AGENT_DESCRIPTION,
  parameters: J5StopAgentInput,
  success: J5StopAgentResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: stopDependencies,
})
  .annotate(Tool.Title, "Stop one Peer Agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const J5StopCrewTool = Tool.make("j5_stop_crew", {
  description: J5_STOP_CREW_DESCRIPTION,
  parameters: J5StopCrewInput,
  success: J5StopCrewResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: stopCrewDependencies,
})
  .annotate(Tool.Title, "Stop a Crew's running seats")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const J5ArchiveCrewTool = Tool.make("j5_archive_crew", {
  description: J5_ARCHIVE_CREW_DESCRIPTION,
  parameters: J5ArchiveCrewInput,
  success: J5ArchiveCrewResult,
  failure: J5ArchiveCrewFailure,
  failureMode: "return",
  dependencies: archiveCrewDependencies,
})
  .annotate(Tool.Title, "Retire a Crew as a unit")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const J5ClearOwnAskTool = Tool.make("j5_clear_own_ask", {
  description: A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION,
  parameters: J5ClearOwnAskInput,
  success: ClearOwnAskResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService,
    A2ASendService,
    A2ADeliveryWorker,
  ],
})
  .annotate(Tool.Title, "Withdraw your open ask")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Shared J5 toolkit bootstrap. Later J5 milestones append their tools here. */
export const J5Toolkit = Toolkit.make(
  ...playbookTools,
  J5SendMessageTool,
  J5ListParticipantsTool,
  J5SpawnAgentTool,
  J5ListAgentsTool,
  J5ProposeCrewTool,
  J5RequestCrewMemberTool,
  J5StopAgentTool,
  J5StopCrewTool,
  J5ArchiveCrewTool,
  J5ClearOwnAskTool,
);
