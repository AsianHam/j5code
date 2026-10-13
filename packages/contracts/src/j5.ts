import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Rpc, RpcGroup } from "effect/rpc";
export * from "./j5/actionError.ts";
export * from "./j5/peerPoll.ts";
export * from "./j5/playbook.ts";
export * from "./j5/sharing.ts";

import { ModelSelection } from "./modelSelection.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderInteractionMode,
  ProviderRequestKind,
  RuntimeMode,
} from "./providerPolicy.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "./baseSchemas.ts";
import { J5ActionError } from "./j5/actionError.ts";
import { AgentPersonaId } from "./j5/agentPersona.ts";

export const HumanInboxItem = Schema.Struct({
  personId: Schema.String,
  /** The asking agent's project, which keys its ledger. */
  projectId: Schema.String,
  projectTitle: Schema.String,
  exchangeId: Schema.String,
  senderId: Schema.String,
  senderThreadId: Schema.NullOr(Schema.String),
  intent: Schema.String,
  urgency: Schema.Literals(["blocking", "soon", "fyi"]),
  message: Schema.String,
  openedAt: Schema.String,
  status: Schema.Literals(["open", "answered"]),
  terminalAt: Schema.NullOr(Schema.String),
});
export type HumanInboxItem = typeof HumanInboxItem.Type;
export type ScopedHumanInboxItem = HumanInboxItem & { readonly environmentId: EnvironmentId };

export const scopedInboxItemKey = (item: ScopedHumanInboxItem): string =>
  JSON.stringify([item.environmentId, item.personId, item.projectId, item.exchangeId]);

export const HumanInboxResponse = Schema.Struct({
  personId: Schema.String,
  items: Schema.Array(HumanInboxItem),
});
export type HumanInboxResponse = typeof HumanInboxResponse.Type;

export const AnswerHumanExchangeRequest = Schema.Struct({
  personId: Schema.String.check(Schema.isNonEmpty()),
  exchangeId: Schema.String.check(Schema.isNonEmpty()),
  message: Schema.String.check(Schema.isNonEmpty()),
  clientRequestId: Schema.String.check(Schema.isNonEmpty()),
});
export type AnswerHumanExchangeRequest = typeof AnswerHumanExchangeRequest.Type;
export const AnswerHumanExchangeResponse = Schema.Struct({
  result: Schema.Struct({
    messageId: Schema.String,
    exchangeId: Schema.NullOr(Schema.String),
    exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
    joinedExistingExchange: Schema.Boolean,
    durableAtSeq: Schema.Number,
  }),
});

export const OpenInboxCountResponse = Schema.Struct({
  personId: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** A Crew holds at most this many seats, initial roster and additions together (Crews AC11). */
export const CREW_SEAT_CAP = 12;

/**
 * A step whose persona differs from the persona of the seat that owns it. `seatPersona` is null
 * for a custom seat; `wantedProblem` says why the wanted persona could not staff the step itself.
 */
export const CrewPersonaSwap = Schema.Struct({
  stepId: Schema.String,
  wanted: AgentPersonaId,
  seatPersona: Schema.NullOr(AgentPersonaId),
  wantedProblem: Schema.NullOr(Schema.Literals(["missing", "disabled"])),
});
export type CrewPersonaSwap = typeof CrewPersonaSwap.Type;

/**
 * Where a Crew seat works, chosen for every seat: the Captain's own checkout (`shared`), a new
 * worktree the server prepares from `baseRef` before the seat's brief starts, or one of the
 * project's existing worktrees. On a preview's seat runtime it is the resolved choice; an existing
 * worktree's `branch` is then the one git has checked out there.
 */
export const CrewSeatWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("shared") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.String,
    branch: Schema.optionalKey(Schema.String),
    startFromOrigin: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: Schema.String,
    branch: Schema.optionalKey(Schema.String),
  }),
]);
export type CrewSeatWorkspace = typeof CrewSeatWorkspace.Type;

/**
 * A seat's workspace as it is read. One this version can't decode, such as a type from a newer
 * server, reads as absent: it costs that seat its workspace, never the whole proposal list. The
 * server refuses a seat without a workspace, so nothing launches on a guess.
 */
const CrewSeatWorkspaceField = Schema.optionalKey(
  CrewSeatWorkspace.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
);

/** What the roster card offers when a seat's workspace is edited, read from the Captain's repo. */
export const CrewWorkspaceOptions = Schema.Struct({
  /** The branch checked out where the Captain works, to prefill a new worktree's base. */
  currentBranch: Schema.NullOr(Schema.String),
  /**
   * Where the Captain works: the directory the base-branch picker searches. Absent from servers
   * that sent a fixed branch list instead.
   */
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The project's worktrees other than its main checkout, each with its branch. */
  worktrees: Schema.Array(Schema.Struct({ path: Schema.String, branch: Schema.String })),
});
export type CrewWorkspaceOptions = typeof CrewWorkspaceOptions.Type;

/**
 * One requested or approved Crew seat, as the Captain proposed it or the human edited it. A null
 * agent is a custom seat. Human runtime edits apply to every seat; omitted fields use the persona
 * defaults or, for a custom seat, inherit the Captain.
 */
export const CrewProposalSeat = Schema.Struct({
  seat: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  reason: Schema.String,
  instructions: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  /** Ids of the playbook steps this seat owns; only on a Crew that follows a playbook. */
  steps: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Every seat proposed now names one; only seats recorded before workspaces were required, or
   * with one this version can't read, lack it, and the server refuses those until one is chosen.
   */
  workspace: CrewSeatWorkspaceField,
  /** Computed by the server at propose and approve; a client's value is ignored. */
  personaSwaps: Schema.optionalKey(Schema.Array(CrewPersonaSwap)),
});
export type CrewProposalSeat = typeof CrewProposalSeat.Type;

/**
 * A seat the human's card submits for preview or approval. Its workspace is decoded strictly: the
 * lenient read above is for what a client shows, not what it asks the server to launch.
 */
const CrewProposalSeatRequest = CrewProposalSeat.mapFields(
  Struct.assign({ workspace: Schema.optionalKey(CrewSeatWorkspace) }),
);

/** The playbook a proposal follows, read live from its YAML; `issue` says why it cannot be read. */
export const CrewProposalPlaybook = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      persona: Schema.optionalKey(AgentPersonaId),
    }),
  ),
  issue: Schema.NullOr(Schema.String),
});
export type CrewProposalPlaybook = typeof CrewProposalPlaybook.Type;

/** The human gate for one Crew request: a roster to launch or a seat to add to a live Crew. */
export const CrewProposal = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  captainParticipantId: Schema.String,
  captainThreadId: Schema.String,
  crewInstanceId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["roster", "addition"]),
  status: Schema.Literals(["open", "approved", "declined"]),
  displayName: Schema.String,
  brief: Schema.String,
  requestedSeats: Schema.Array(CrewProposalSeat),
  approvedSeats: Schema.NullOr(Schema.Array(CrewProposalSeat)),
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  playbook: Schema.optionalKey(Schema.NullOr(CrewProposalPlaybook)),
});
export type CrewProposal = typeof CrewProposal.Type;
export type ScopedCrewProposal = CrewProposal & { readonly environmentId: EnvironmentId };

export const CrewProposalsResponse = Schema.Struct({ proposals: Schema.Array(CrewProposal) });
/** Server-resolved runtime, displayed verbatim before a human approves this exact roster. */
export const CrewProposalSeatRuntime = Schema.Struct({
  seat: Schema.String,
  provider: Schema.String,
  harness: Schema.String,
  model: Schema.String,
  reasoning: Schema.String,
  access: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  /** Always sent by a current server; absent only from servers that predate seat workspaces. */
  workspace: CrewSeatWorkspaceField,
  /** The seat's persona swaps as the edited roster would record them. */
  personaSwaps: Schema.optionalKey(Schema.Array(CrewPersonaSwap)),
});
export type CrewProposalSeatRuntime = typeof CrewProposalSeatRuntime.Type;
export const CrewProposalPreviewRequest = Schema.Struct({
  proposalId: Schema.String,
  seats: Schema.optional(
    Schema.Array(CrewProposalSeatRequest).check(Schema.isMaxLength(CREW_SEAT_CAP)),
  ),
});
export type CrewProposalPreviewRequest = typeof CrewProposalPreviewRequest.Type;
export const CrewProposalPreviewResponse = Schema.Struct({
  proposalId: Schema.String,
  approvalToken: Schema.String,
  seats: Schema.Array(CrewProposalSeatRuntime),
  /**
   * Always sent by a current server; absent from one that predates seat workspaces, or read as
   * absent when this version can't decode it, and then the card shows the seats without the
   * workspace control.
   */
  workspaceOptions: Schema.optionalKey(
    CrewWorkspaceOptions.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  ),
  /** The plan the approval token binds: the live playbook and the steps no seat owns. */
  playbook: Schema.optionalKey(Schema.NullOr(CrewProposalPlaybook)),
  unownedSteps: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type CrewProposalPreviewResponse = typeof CrewProposalPreviewResponse.Type;

export const CrewProposalResolveRequest = Schema.Union([
  Schema.Struct({
    proposalId: Schema.String,
    decision: Schema.Literal("approve"),
    approvalToken: Schema.String,
    seats: Schema.optional(
      Schema.Array(CrewProposalSeatRequest).check(Schema.isMaxLength(CREW_SEAT_CAP)),
    ),
  }),
  Schema.Struct({
    proposalId: Schema.String,
    decision: Schema.Literal("decline"),
  }),
]);
export type CrewProposalResolveRequest = typeof CrewProposalResolveRequest.Type;
export const CrewProposalResolveResponse = Schema.Struct({
  proposal: CrewProposal,
  crewInstanceId: Schema.NullOr(Schema.String),
});

/** A live Crew as the sidebar names it; retired Crews are omitted from the read, not flagged. */
export const CrewRef = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
});
export type CrewRef = typeof CrewRef.Type;

/** What a sidebar row needs: which Crew a thread sits in, or which Crews it commands. */
export const ThreadCrewMembership = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("member"), seat: Schema.String, crew: CrewRef }),
  Schema.Struct({ kind: Schema.Literal("captain"), crews: Schema.Array(CrewRef) }),
]);
export type ThreadCrewMembership = typeof ThreadCrewMembership.Type;
export const CrewMembershipEntry = Schema.Struct({
  threadId: ThreadId,
  membership: ThreadCrewMembership,
});
export type CrewMembershipEntry = typeof CrewMembershipEntry.Type;
export const CrewMembershipsResponse = Schema.Struct({
  entries: Schema.Array(CrewMembershipEntry),
});

/** One agent placed directly under a visible thread, with its Crew seat when it has one. */
export const SpawnedChild = Schema.Struct({
  threadId: ThreadId,
  participantId: Schema.String,
  seat: Schema.NullOr(
    Schema.Struct({ crewInstanceId: Schema.String, crewName: Schema.String, seat: Schema.String }),
  ),
});
export type SpawnedChild = typeof SpawnedChild.Type;
export const SpawnedChildrenEntry = Schema.Struct({
  threadId: ThreadId,
  children: Schema.Array(SpawnedChild),
});
export type SpawnedChildrenEntry = typeof SpawnedChildrenEntry.Type;
export const SpawnedChildrenResponse = Schema.Struct({
  entries: Schema.Array(SpawnedChildrenEntry),
  /** The requested threads an agent spawned: these leave the sidebar's top level unless pinned. */
  spawnedByAgent: Schema.Array(ThreadId),
});

/**
 * A Crew as the Fleet page records it: the approved roster snapshot with why each seat joined;
 * every seat was approved by the person. Archived Crews keep their snapshot so a successor can be
 * briefed from it (Crews AC20).
 */
export const FleetCrew = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  captainParticipantId: Schema.String,
  captainThreadId: Schema.NullOr(Schema.String),
  brief: Schema.String,
  version: Schema.Number,
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  /** The playbook the Crew follows, fixed at approval. */
  playbook: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  /** Every seat was approved by the person; the record keeps the version it joined at and why. */
  roster: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      agentId: Schema.NullOr(Schema.String),
      participantId: Schema.String,
      addedVersion: Schema.Number,
      reason: Schema.NullOr(Schema.String),
      /** Ids of the playbook steps this seat owns. */
      steps: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /**
   * The Crew's active playbook run: where it is and who holds the current step. `state` has the
   * meaning of `PlaybookStepDelivery.state`; only `"captain"` means the Captain does the step.
   */
  playbookRun: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        runId: Schema.String,
        position: Schema.Number,
        total: Schema.Number,
        stepId: Schema.String,
        stepTitle: Schema.String,
        state: Schema.Literals(["delivered", "captain", "pending"]),
        seat: Schema.NullOr(Schema.String),
        /** Set when the live playbook can't be read or lacks the step; position is then 0. */
        issue: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export type FleetCrew = typeof FleetCrew.Type;

/** One agent row of the Fleet page: placement, provenance, Crew seat, and measured open asks. */
export const FleetAgent = Schema.Struct({
  participantId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  /** `agent` when another agent spawned it (roster-only in the sidebar); `unknown` when never recorded. */
  origin: Schema.Literals(["human", "agent", "unknown"]),
  placementParentId: Schema.NullOr(Schema.String),
  /**
   * Set when an outside agent (an MCP client signed in from outside the app) spawned it. Such an
   * agent has `origin: "agent"` and no placement parent, so this is the only place its spawner is
   * named. `name` is the label the client signed in with.
   */
  outsideSpawner: Schema.optional(
    Schema.Struct({ participantId: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  crew: Schema.NullOr(
    Schema.Struct({
      crewInstanceId: Schema.String,
      crewName: Schema.String,
      seat: Schema.String,
      captainParticipantId: Schema.String,
    }),
  ),
  /** Open Exchanges this agent owes a reply on. */
  openAsks: Schema.Number,
});
export type FleetAgent = typeof FleetAgent.Type;
/** One project's agents and Crews. `title` is the server's, for a project the client cannot find. */
export const FleetProject = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  agents: Schema.Array(FleetAgent),
  crews: Schema.Array(FleetCrew),
});
export type FleetProject = typeof FleetProject.Type;
/** The rail badge reads the live roster only; the Fleet page asks for retired Crews as well. */
export const FleetReadRequest = Schema.Struct({ includeRetired: Schema.optional(Schema.Boolean) });
export type FleetReadRequest = typeof FleetReadRequest.Type;
export const FleetResponse = Schema.Struct({ projects: Schema.Array(FleetProject) });
export type FleetResponse = typeof FleetResponse.Type;

/** A person stopping a Crew from the app: every running seat is interrupted, nothing is retired. */
export const CrewStopRequest = Schema.Struct({ crewInstanceId: Schema.String });
export type CrewStopRequest = typeof CrewStopRequest.Type;
export const CrewStopResponse = Schema.Struct({
  crewInstanceId: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      result: Schema.Literals(["interrupt_requested", "already_idle", "archived"]),
    }),
  ),
});
export type CrewStopResponse = typeof CrewStopResponse.Type;

/** A live Crew the archived agent commands, seat by seat, as the archive dialog shows it. */
export const PreArchiveLiveCrew = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  seats: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      runningTurn: Schema.Boolean,
      openAsks: Schema.Number,
    }),
  ),
});
export type PreArchiveLiveCrew = typeof PreArchiveLiveCrew.Type;
/** The Crew seat the archived agent holds; seats are never archived one by one. */
export const PreArchiveCrewSeat = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  seat: Schema.String,
});
export type PreArchiveCrewSeat = typeof PreArchiveCrewSeat.Type;

/**
 * A person retiring a Crew from the app, after a dialog that listed every seat's consequences:
 * the seats archive as one unit and nothing is deleted.
 */
export const CrewArchiveRequest = Schema.Struct({ crewInstanceId: Schema.String });
export type CrewArchiveRequest = typeof CrewArchiveRequest.Type;
export const CrewArchiveResponse = Schema.Struct({
  crewInstanceId: Schema.String,
  status: Schema.Literals(["archived", "already_archived"]),
  members: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      result: Schema.Literals(["archived", "already_archived"]),
    }),
  ),
});
export type CrewArchiveResponse = typeof CrewArchiveResponse.Type;

/**
 * What a J5 server reports about its ledger. Every J5 read is gated on `j5ProjectLedger`. The two
 * older keys are reported `false`, not left out: a client from before the ledger was re-keyed
 * gates its J5 reads on them, shows a `false` one as unsupported without calling its route, and
 * would probe a missing one, reading a route whose shape has changed.
 */
export const J5_LEDGER_CAPABILITIES = {
  j5ProjectLedger: true,
  j5Squadrons: false,
  j5HumanInbox: false,
} as const;

/**
 * Machine participants: registered non-agent senders (cron jobs, watchdogs,
 * shell scripts) that send plain messages from a project and never receive.
 * Their ids are `machine:<name>`; the name is server-unique.
 */
export const MACHINE_PARTICIPANT_ID_PREFIX = "machine:" as const;
export const MachineParticipantName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type MachineParticipantName = typeof MachineParticipantName.Type;
export const machineParticipantIdForName = (name: string): string =>
  `${MACHINE_PARTICIPANT_ID_PREFIX}${name}`;

export const MachineParticipantRecord = Schema.Struct({
  participantId: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
});
export type MachineParticipantRecord = typeof MachineParticipantRecord.Type;

export const RegisterMachineParticipantRequest = Schema.Struct({
  projectId: Schema.String.check(Schema.isNonEmpty()),
  name: MachineParticipantName,
});
export type RegisterMachineParticipantRequest = typeof RegisterMachineParticipantRequest.Type;
export const RegisterMachineParticipantResponse = Schema.Struct({
  participant: MachineParticipantRecord,
  created: Schema.Boolean,
});
export type RegisterMachineParticipantResponse = typeof RegisterMachineParticipantResponse.Type;

/** `to` is a participant id, a thread id, or an agent's display name. */
export const MachineSendRequest = Schema.Struct({
  to: Schema.String.check(Schema.isNonEmpty()),
  message: Schema.String.check(Schema.isNonEmpty()),
  clientRequestId: Schema.String.check(Schema.isNonEmpty()),
});
export type MachineSendRequest = typeof MachineSendRequest.Type;
export const MachineSendResponse = Schema.Struct({
  sender: Schema.String,
  receiver: Schema.String,
  result: Schema.Struct({
    messageId: Schema.String,
    exchangeId: Schema.NullOr(Schema.String),
    exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
    joinedExistingExchange: Schema.Boolean,
    durableAtSeq: Schema.Number,
  }),
});
export type MachineSendResponse = typeof MachineSendResponse.Type;

export const A2ARosterLiveness = Schema.Struct({
  /** Derived: active while a run is in flight, errored after a failed run, otherwise idle. */
  state: Schema.Literals(["idle", "active", "errored"]),
  /** The thread's measured shell status, verbatim. */
  runStatus: Schema.String,
  latestRunStartedAt: Schema.NullOr(Schema.String),
  latestRunCompletedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type A2ARosterLiveness = typeof A2ARosterLiveness.Type;

export const A2ARosterEntry = Schema.Struct({
  participantId: Schema.String,
  kind: Schema.Literals(["agent", "human", "machine"]),
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  archived: Schema.Boolean,
  canReceiveMessage: Schema.Boolean,
  acceptsUrgency: Schema.Boolean,
  /** Present for agents whose thread is in the shell snapshot; null otherwise. */
  liveness: Schema.NullOr(A2ARosterLiveness),
});
export type A2ARosterEntry = typeof A2ARosterEntry.Type;
export const A2ARosterResponse = Schema.Struct({ participants: Schema.Array(A2ARosterEntry) });
export type A2ARosterResponse = typeof A2ARosterResponse.Type;

export const MachineWhoamiResponse = Schema.Struct({
  participant: MachineParticipantRecord,
  server: Schema.Struct({ version: Schema.String }),
});
export type MachineWhoamiResponse = typeof MachineWhoamiResponse.Type;

export const J5_MACHINE_API_PATHS = {
  machineParticipants: "/api/j5/a2a/machine-participants",
  send: "/api/j5/a2a/send",
  roster: "/api/j5/a2a/roster",
  whoami: "/api/j5/a2a/whoami",
} as const;

/**
 * A provider approval waiting on a live Crew seat's thread. Seats run while the person watches
 * the Captain, so their approvals reach the Inbox instead of waiting unseen in the seat's composer
 * (Crews AC9); the Captain's own requests stay inline in its thread. Read live from the thread's
 * projection, and only while the provider can still take the answer. The approval fields match
 * the composer's `ThreadPendingApproval`, so the composer's approval UI renders it.
 */
export const CrewRuntimeRequestItem = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  projectId: Schema.String,
  seat: Schema.String,
  threadTitle: Schema.String,
  createdAt: Schema.String,
  requestKind: ProviderRequestKind,
  detail: Schema.optionalKey(Schema.String),
  appName: Schema.optionalKey(Schema.String),
  /** The provider's advertised choices; absent means the composer's defaults. */
  options: Schema.optionalKey(Schema.Array(ProviderApprovalOption)),
});
export type CrewRuntimeRequestItem = typeof CrewRuntimeRequestItem.Type;
export const CrewRuntimeRequestsResponse = Schema.Struct({
  requests: Schema.Array(CrewRuntimeRequestItem),
});
export type CrewRuntimeRequestsResponse = typeof CrewRuntimeRequestsResponse.Type;

/** A decision on a seat's approval, sent from the Inbox. */
export const CrewRuntimeRequestRespondRequest = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision,
});
export type CrewRuntimeRequestRespondRequest = typeof CrewRuntimeRequestRespondRequest.Type;
export const CrewRuntimeRequestRespondResponse = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
});
export type CrewRuntimeRequestRespondResponse = typeof CrewRuntimeRequestRespondResponse.Type;

/**
 * Peering: two servers that exchange agent messages. A peer holds a session of
 * the other server whose subject is `peer:<its own environment id>` and whose
 * only scope is `a2a:peer`. Records are mutual and pairwise; the client that is
 * connected to both environments introduces them.
 */
const PEER_SUBJECT_PREFIX = "peer:" as const;
export const peerSubjectForEnvironment = (environmentId: string): string =>
  `${PEER_SUBJECT_PREFIX}${environmentId}`;
export const environmentIdFromPeerSubject = (subject: string): string | null =>
  subject.startsWith(PEER_SUBJECT_PREFIX) && subject.length > PEER_SUBJECT_PREFIX.length
    ? subject.slice(PEER_SUBJECT_PREFIX.length)
    : null;

/** An http(s) origin with no path, query, or fragment. */
export const PeerOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        ((url.protocol === "http:" || url.protocol === "https:") &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === "" &&
          !value.endsWith("/")) ||
        "A peer origin must be an http(s) origin such as https://home.example:3773 with no path."
      );
    } catch {
      return "A peer origin must be an http(s) origin such as https://home.example:3773 with no path.";
    }
  }),
);
export type PeerOrigin = typeof PeerOrigin.Type;

/**
 * How messages travel between this server and a peer: `push` sends directly
 * both ways; `store` keeps messages here until the peer polls for them; `poll`
 * is this server's record of a peer it polls.
 */
export const PeerLinkMode = Schema.Literals(["push", "store", "poll"]);
export type PeerLinkMode = typeof PeerLinkMode.Type;

export const PeerRecord = Schema.Struct({
  environmentId: Schema.String,
  /** The peer server's own name, as it last reported it; its environment id until it reports one. */
  label: Schema.String,
  /** Servers from before poll mode omit it; every peer they record sends directly. */
  linkMode: PeerLinkMode.pipe(Schema.withDecodingDefault(Effect.succeed("push" as const))),
  /** Where this server reaches the peer; null for a peer that polls this server. */
  origin: Schema.NullOr(Schema.String),
  /** When the credential the peer issued to this server expires, as the peer reported it at hello. */
  credentialExpiresAt: Schema.NullOr(Schema.String),
  /** Whether the peer still holds a live session here; "missing" means it was revoked or expired and its deliveries are refused. */
  inboundSession: Schema.Literals(["active", "missing"]),
  createdAt: Schema.String,
  /** When the peer last polled here, or this server last had an answer to a poll of the peer. */
  lastPolledAt: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Why the last exchange with the peer failed: a poll failure or a peer protocol mismatch. */
  lastError: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Messages recorded here and not yet delivered to the peer, and when the oldest was sent. */
  waitingCount: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  oldestWaitingAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type PeerRecord = typeof PeerRecord.Type;
export const PeerListResponse = Schema.Struct({ peers: Schema.Array(PeerRecord) });
export type PeerListResponse = typeof PeerListResponse.Type;

/** Mint a credential the named environment will present when it delivers to this server. */
export const IssuePeerCredentialRequest = Schema.Struct({
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  /**
   * Names the issued session in Settings → Connections only. The client fills
   * it from the holder's own descriptor label; the peer record's name always
   * comes from what the peer reports at hello.
   */
  label: Schema.optional(Schema.String),
  /** The holder will poll this server, which stores its messages until then. */
  store: Schema.optional(Schema.Boolean),
});
export type IssuePeerCredentialRequest = typeof IssuePeerCredentialRequest.Type;
export const IssuePeerCredentialResponse = Schema.Struct({
  /** This server's environment id, which the holder records as the peer's id. */
  environmentId: Schema.String,
  credential: Schema.String,
  sessionId: Schema.String,
  subject: Schema.String,
  expiresAt: Schema.String,
});
export type IssuePeerCredentialResponse = typeof IssuePeerCredentialResponse.Type;

/** Record a peer after proving the credential at the origin; the peer names itself in the hello. */
export const AddPeerRequest = Schema.Struct({
  origin: PeerOrigin,
  credential: Schema.String.check(Schema.isNonEmpty()),
  /** A known peer keeps its recorded origin unless the caller says to move it. */
  replaceOrigin: Schema.optional(Schema.Boolean),
  /** This server cannot be reached, so it polls the peer, which stores its messages until then. */
  poll: Schema.optional(Schema.Boolean),
});
export type AddPeerRequest = typeof AddPeerRequest.Type;
export const AddPeerResponse = Schema.Struct({ peer: PeerRecord, created: Schema.Boolean });
export type AddPeerResponse = typeof AddPeerResponse.Type;

export const RemovePeerRequest = Schema.Struct({
  environmentId: Schema.String.check(Schema.isNonEmpty()),
});
export type RemovePeerRequest = typeof RemovePeerRequest.Type;
export const RemovePeerResponse = Schema.Struct({
  removed: Schema.Boolean,
  revokedSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RemovePeerResponse = typeof RemovePeerResponse.Type;

/**
 * Peer servers' own wire protocol. A breaking change bumps the version and a
 * mismatch stops peering until both servers match; an additive change is an
 * optional field or a capability and never bumps it. A server from before
 * versioning omits both and counts as version 1 with no capabilities.
 */
export const PEER_PROTOCOL_VERSION = 2;
/** Every peer request and response states its sender's version here; a server from before versioning sends none. */
export const PEER_PROTOCOL_HEADER = "x-j5-peer-protocol";
export const PeerCapabilities = Schema.Struct({
  /** This server stores messages for a peer that polls for them. */
  poll: Schema.optionalKey(Schema.Boolean),
  /** This server lands a message as its sender asked: a delivery's `landing` is read, not dropped. */
  landing: Schema.optionalKey(Schema.Boolean),
});
export type PeerCapabilities = typeof PeerCapabilities.Type;

/** What a server answers to a peer credential: who it is and whom the credential names. */
export const PeerHelloResponse = Schema.Struct({
  environmentId: Schema.String,
  subject: Schema.String,
  /** When the credential used for this hello expires; null when the session never expires. */
  credentialExpiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  server: Schema.Struct({ version: Schema.String }),
  /** The answering server's own name, the label its environment descriptor publishes. */
  label: Schema.optional(Schema.String),
  peerProtocolVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  capabilities: Schema.optional(PeerCapabilities),
});
export type PeerHelloResponse = typeof PeerHelloResponse.Type;

/**
 * One message crossing from a peer server. The receiving server records its own
 * received row (and the Exchange fact an ask or reply implies) before it
 * delivers locally; a retry with the same message id replays the first receipt.
 */
/**
 * The closing fact a terminal notice carries between servers. A dropped
 * Exchange names the retirement; a withdrawn ask says only that the asker
 * cleared it. The receiver works out the disposition from its own copy of
 * the Exchange, so the wire never says which side the retired party was on.
 */
export const PeerTerminalFact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dropped"),
    cause: Schema.Struct({
      kind: Schema.Literals(["participant-archived", "participant-deleted"]),
      participantId: Schema.String,
      projectId: Schema.String,
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("sender-cleared") }),
]);
export type PeerTerminalFact = typeof PeerTerminalFact.Type;

/** Peer-supplied strings are bounded: a peer names a sender, it does not get to fill the ledger. */
export const PEER_SENDER_LABEL_MAX_CHARS = 200;
/** One cap for a message's text, enforced at send so nothing is recorded that a peer would refuse. */
export const A2A_MESSAGE_TEXT_MAX_CHARS = 256_000;
export const PeerSenderLabel = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(PEER_SENDER_LABEL_MAX_CHARS),
);

/**
 * How a sender asked for its message to land on an agent that is mid-turn, with the broadest
 * modes the sender could touch when it asked. The receiving server refuses the delivery when its
 * agent runs above that limit. Sent only to a server that advertises the `landing` capability;
 * a server from before it would queue the message without saying so.
 */
export const PeerDeliveryLanding = Schema.Struct({
  mode: Schema.Literals(["steer", "restart"]),
  limit: Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
});
export type PeerDeliveryLanding = typeof PeerDeliveryLanding.Type;

export const PeerDeliveryRequest = Schema.Struct({
  messageId: Schema.String.check(Schema.isNonEmpty()),
  /** Absent for a message that waits its turn, which is every message from an older server. */
  landing: Schema.optional(PeerDeliveryLanding),
  senderId: Schema.String.check(Schema.isNonEmpty()),
  receiverId: Schema.String.check(Schema.isNonEmpty()),
  exchangeId: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
  correlationId: Schema.String.check(Schema.isNonEmpty()),
  exchangeRole: Schema.Literals(["none", "ask", "followup", "reply", "terminal_notice"]),
  envelopeChannel: Schema.Literals(["peer", "silence_notice", "lifecycle_notice"]),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(A2A_MESSAGE_TEXT_MAX_CHARS)),
  originProjectId: Schema.String.check(Schema.isNonEmpty()),
  /**
   * The sender's display name (its thread title) for the receiving side's
   * people, so a timeline names a remote sender as it names a local one.
   * Agents keep addressing by id.
   */
  senderLabel: Schema.optional(PeerSenderLabel),
  /** Required when `exchangeRole` is `ask`: the Exchange the receiver now owes a reply to. */
  intent: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /**
   * Present on a `terminal_notice`: the closing fact the origin recorded, so the
   * peer ends its own copy of the Exchange the same way.
   */
  terminal: Schema.optional(PeerTerminalFact),
  /**
   * Present on a silence notice: the open Exchange whose answerer went quiet.
   * The notice is not part of that Exchange; the receiver accepts it only when
   * the Exchange is open here with this peer as its other party.
   */
  regardingExchangeId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /** The origin's clock, kept for display; the receiving server stamps its own time on what it records. */
  createdAt: Schema.String.check(
    Schema.makeFilter(
      (value) => !Number.isNaN(Date.parse(value)) || "createdAt must be an ISO-8601 timestamp.",
    ),
  ),
});
export type PeerDeliveryRequest = typeof PeerDeliveryRequest.Type;

/** The one thing a peer may read here: the agents it could address, and nothing about people or machines. */
export const PeerRosterAgent = Schema.Struct({
  participantId: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  threadId: ThreadId,
  displayName: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  canReceiveMessage: Schema.Boolean,
});
export type PeerRosterAgent = typeof PeerRosterAgent.Type;
export const PeerRosterResponse = Schema.Struct({
  agents: Schema.Array(PeerRosterAgent),
  /** The answering server's own name, so a peer that reads the roster keeps its name current. */
  label: Schema.optional(Schema.String),
  /** What the answering server can do now, so a peer that reads the roster learns of an update. */
  capabilities: Schema.optional(PeerCapabilities),
});
export type PeerRosterResponse = typeof PeerRosterResponse.Type;
export const PeerDeliveryResponse = Schema.Struct({
  accepted: Schema.Literal(true),
  receivedSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** True when this message id had already been recorded; nothing was written twice. */
  replay: Schema.Boolean,
});
export type PeerDeliveryResponse = typeof PeerDeliveryResponse.Type;

/** The most deliveries one poll hands out. */
export const PEER_POLL_BATCH_COUNT = 50;
/** A poll acknowledges at most two batches: the one just handed out, and one resent after a lost answer. */
export const PEER_POLL_MAX_ACKS = 2 * PEER_POLL_BATCH_COUNT;
/** The longest refusal code a peer may send; real codes are a few words. */
export const PEER_REFUSAL_CODE_MAX_CHARS = 64;
/** The most agents a poller's roster may list. */
export const PEER_ROSTER_MAX_AGENTS = 5_000;

/** A polling peer's answer about one delivery it was handed in the previous poll. */
export const PeerPollAck = Schema.Union([
  Schema.Struct({
    messageId: Schema.String.check(Schema.isNonEmpty()),
    outcome: Schema.Literal("received"),
    receivedSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    replay: Schema.Boolean,
  }),
  Schema.Struct({
    messageId: Schema.String.check(Schema.isNonEmpty()),
    outcome: Schema.Literal("refused"),
    /** The refusal the deliver route would have answered with. */
    code: Schema.String.check(Schema.isMaxLength(PEER_REFUSAL_CODE_MAX_CHARS)),
    message: Schema.String.check(Schema.isMaxLength(4_000)),
  }),
]);
export type PeerPollAck = typeof PeerPollAck.Type;

/** A poll asks for the messages stored for the poller, acknowledges the last batch, and refreshes what the poller tells. */
export const PeerPollRequest = Schema.Struct({
  acks: Schema.Array(PeerPollAck).check(Schema.isMaxLength(PEER_POLL_MAX_ACKS)),
  /** The poller's agent roster, sent only when its hash differs from the one the last response held. */
  roster: Schema.optional(
    Schema.Array(PeerRosterAgent).check(Schema.isMaxLength(PEER_ROSTER_MAX_AGENTS)),
  ),
  rosterHash: Schema.String.check(Schema.isNonEmpty()),
  /** The poller's own name. */
  label: Schema.optional(PeerSenderLabel),
  capabilities: Schema.optional(PeerCapabilities),
});
export type PeerPollRequest = typeof PeerPollRequest.Type;

export const PeerPollResponse = Schema.Struct({
  /** Oldest first, each the body a direct delivery carries. */
  deliveries: Schema.Array(PeerDeliveryRequest),
  /** The roster snapshot this server holds for the poller, or null before its first. */
  rosterHash: Schema.NullOr(Schema.String),
  /** More deliveries are waiting beyond this batch. */
  more: Schema.Boolean,
  /** The storing server's own name and capabilities, so the poller refreshes them every poll. */
  label: Schema.String,
  capabilities: PeerCapabilities,
});
export type PeerPollResponse = typeof PeerPollResponse.Type;

/**
 * The reachability check before peering: the origins a server thinks others
 * might reach it at, and one server fetching another's public identity at an
 * origin. Nothing is recorded; the check only informs the setup.
 */
export const PeerAddressesResponse = Schema.Struct({
  /** Its non-loopback interface addresses with its port, and its configured host; empty when it listens on loopback only. */
  origins: Schema.Array(Schema.String),
});
export type PeerAddressesResponse = typeof PeerAddressesResponse.Type;
export const PeerProbeRequest = Schema.Struct({ origin: PeerOrigin });
export type PeerProbeRequest = typeof PeerProbeRequest.Type;
export const PeerProbeResponse = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("reached"),
    origin: Schema.String,
    /** Who answered: the caller compares it with the server it expected, so a loopback to itself is a miss. */
    environmentId: Schema.String,
    label: Schema.String,
  }),
  Schema.Struct({
    outcome: Schema.Literal("failed"),
    origin: Schema.String,
    /** The probe's own error, such as "10.20.4.17:3773: connection timed out after 4 s". */
    error: Schema.String,
  }),
]);
export type PeerProbeResponse = typeof PeerProbeResponse.Type;

export const J5_PEER_API_PATHS = {
  peers: "/api/j5/a2a/peers",
  credentials: "/api/j5/a2a/peers/credentials",
  remove: "/api/j5/a2a/peers/remove",
  hello: "/api/j5/a2a/peers/hello",
  roster: "/api/j5/a2a/peers/roster",
  deliver: "/api/j5/a2a/peers/deliver",
  poll: "/api/j5/a2a/peers/poll",
} as const;

/**
 * What a person does from a client, as WebSocket RPCs: the socket's scope check and the client's
 * permission guard (`j5/clientRpcPermissions.ts`) both apply. The reads beside them are
 * `J5ClientReadRpcGroup`. One group, merged into `WsRpcGroup` in `rpc.ts`.
 */
export const J5_CLIENT_ACTION_WS_METHODS = {
  previewCrewProposal: "j5.crews.previewProposal",
  resolveCrewProposal: "j5.crews.resolveProposal",
  stopCrew: "j5.crews.stop",
  archiveCrew: "j5.crews.archive",
  respondCrewRuntimeRequest: "j5.crews.respondRuntimeRequest",
  answerHumanExchange: "j5.inbox.answer",
  issuePeerCredential: "j5.peers.issueCredential",
  addPeer: "j5.peers.add",
  removePeer: "j5.peers.remove",
  listPeerAddresses: "j5.peers.addresses",
  probePeer: "j5.peers.probe",
} as const;

const clientActionError = Schema.Union([J5ActionError, EnvironmentAuthorizationError]);

export const J5ClientActionRpcGroup = RpcGroup.make(
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.previewCrewProposal, {
    payload: CrewProposalPreviewRequest,
    success: CrewProposalPreviewResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.resolveCrewProposal, {
    payload: CrewProposalResolveRequest,
    success: CrewProposalResolveResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.stopCrew, {
    payload: CrewStopRequest,
    success: CrewStopResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.archiveCrew, {
    payload: CrewArchiveRequest,
    success: CrewArchiveResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.respondCrewRuntimeRequest, {
    payload: CrewRuntimeRequestRespondRequest,
    success: CrewRuntimeRequestRespondResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.answerHumanExchange, {
    payload: AnswerHumanExchangeRequest,
    success: AnswerHumanExchangeResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.issuePeerCredential, {
    payload: IssuePeerCredentialRequest,
    success: IssuePeerCredentialResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.addPeer, {
    payload: AddPeerRequest,
    success: AddPeerResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.removePeer, {
    payload: RemovePeerRequest,
    success: RemovePeerResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.listPeerAddresses, {
    payload: Schema.Struct({}),
    success: PeerAddressesResponse,
    error: clientActionError,
  }),
  Rpc.make(J5_CLIENT_ACTION_WS_METHODS.probePeer, {
    payload: PeerProbeRequest,
    success: PeerProbeResponse,
    error: clientActionError,
  }),
);

/** The consequences an archive dialog lists before a thread is archived. */
const PreArchiveOpenExchange = Schema.Struct({
  projectId: Schema.String,
  exchangeId: Schema.String,
  direction: Schema.Literals(["inbound", "outbound"]),
  replyObligation: Schema.Literals(["participant-owes-reply", "counterparty-owes-reply"]),
  counterpartyId: Schema.String,
  intent: Schema.String,
  urgency: Schema.NullOr(Schema.Literals(["blocking", "soon", "fyi"])),
  openedAt: Schema.String,
});
export const PreArchiveFactsRequest = Schema.Struct({ threadId: ThreadId });
export type PreArchiveFactsRequest = typeof PreArchiveFactsRequest.Type;
export const PreArchiveFacts = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("not-an-a2a-participant"),
    threadId: ThreadId,
    openExchanges: Schema.Array(PreArchiveOpenExchange),
    placementSubtree: Schema.Struct({ state: Schema.Literal("not-applicable") }),
  }),
  Schema.Struct({
    state: Schema.Literal("registered"),
    threadId: ThreadId,
    projectId: Schema.String,
    participantId: Schema.String,
    retired: Schema.Boolean,
    openExchanges: Schema.Array(PreArchiveOpenExchange),
    placementSubtree: Schema.Union([
      Schema.Struct({
        state: Schema.Literal("unknown"),
        reason: Schema.Literal("placement-query-failed"),
      }),
      Schema.Struct({ state: Schema.Literal("none") }),
      Schema.Struct({
        state: Schema.Literal("known"),
        participantIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
      }),
    ]),
    /** The Crews this agent commands; null when the Crew read failed: "couldn't check". */
    liveCrews: Schema.NullOr(Schema.Array(PreArchiveLiveCrew)),
    /** The seat this agent holds in a live Crew; seats are never archived one by one. */
    crewSeat: Schema.NullOr(PreArchiveCrewSeat),
  }),
]);
export type PreArchiveFacts = typeof PreArchiveFacts.Type;

/** A participant's display name, or `unknown` when the ledger never learned one. */
export const ParticipantIdentitiesRequest = Schema.Struct({
  participantIds: Schema.Array(Schema.String),
});
export type ParticipantIdentitiesRequest = typeof ParticipantIdentitiesRequest.Type;
export const ParticipantIdentitiesResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      participantId: Schema.String,
      identity: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("known"), displayName: Schema.String }),
        Schema.Struct({ kind: Schema.Literal("unknown") }),
      ]),
    }),
  ),
});
export type ParticipantIdentitiesResponse = typeof ParticipantIdentitiesResponse.Type;

export const HumanInboxListRequest = Schema.Struct({
  status: Schema.Literals(["open", "answered"]),
  personId: Schema.optionalKey(Schema.String),
});
export type HumanInboxListRequest = typeof HumanInboxListRequest.Type;
export const OpenInboxCountRequest = Schema.Struct({
  personId: Schema.optionalKey(Schema.String),
});
export type OpenInboxCountRequest = typeof OpenInboxCountRequest.Type;

/** The sidebar asks about the rows it shows, in batches no larger than this. */
export const THREAD_HOME_READ_MAX_THREADS = 500;
export const ThreadHomesRequest = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_HOME_READ_MAX_THREADS)),
});
export type ThreadHomesRequest = typeof ThreadHomesRequest.Type;

/**
 * What a client reads from J5's ledger, as WebSocket RPCs beside `J5ClientActionRpcGroup`. Every
 * one needs only read scope, except the peer list, which needs `access:read` like the rest of
 * Settings → Connections. One group, merged into `WsRpcGroup` in `rpc.ts`.
 */
export const J5_CLIENT_READ_WS_METHODS = {
  listHumanInbox: "j5.inbox.list",
  readOpenInboxCount: "j5.inbox.openCount",
  listCrewProposals: "j5.crews.listProposals",
  listCrewRuntimeRequests: "j5.crews.listRuntimeRequests",
  listCrewMemberships: "j5.crews.listMemberships",
  readFleet: "j5.fleet.read",
  listSpawnedChildren: "j5.fleet.listSpawnedChildren",
  readPreArchiveFacts: "j5.archive.readFacts",
  readParticipantIdentities: "j5.participants.readIdentities",
  listPeers: "j5.peers.list",
  subscribeReadChanges: "j5.reads.subscribeChanges",
} as const;

/**
 * One counter per kind of J5 read, moved when something that read shows changed. It says which
 * reads are out of date and never what changed: a client re-reads when the counter for a read
 * it holds moves. The counters start from the time the server started.
 */
export const J5ReadRevisions = Schema.Struct({
  /** Questions waiting on a person, and the answered ones. */
  inbox: Schema.Int,
  /** Crew proposals, Crews and their seats. */
  crew: Schema.Int,
  /** Participants, placements, open Exchanges and Crew playbook runs. */
  fleet: Schema.Int,
  /** Provider approvals on threads. */
  runtimeRequests: Schema.Int,
  /** The peer list: each peer's link, heartbeat, last error, session and waiting messages. */
  peers: Schema.Int,
  /**
   * The people this server is shared with: a person, a name (the owner's too), a grant, a
   * device, a share link.
   */
  sharing: Schema.Int,
});
export type J5ReadRevisions = typeof J5ReadRevisions.Type;
export type J5ReadRevisionKey = keyof J5ReadRevisions;

const clientRead = <
  const Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
>(
  tag: Tag,
  payload: Payload,
  success: Success,
) => Rpc.make(tag, { payload, success, error: clientActionError });

export const J5ClientReadRpcGroup = RpcGroup.make(
  clientRead(J5_CLIENT_READ_WS_METHODS.listHumanInbox, HumanInboxListRequest, HumanInboxResponse),
  clientRead(
    J5_CLIENT_READ_WS_METHODS.readOpenInboxCount,
    OpenInboxCountRequest,
    OpenInboxCountResponse,
  ),
  clientRead(J5_CLIENT_READ_WS_METHODS.listCrewProposals, Schema.Struct({}), CrewProposalsResponse),
  clientRead(
    J5_CLIENT_READ_WS_METHODS.listCrewRuntimeRequests,
    Schema.Struct({}),
    CrewRuntimeRequestsResponse,
  ),
  clientRead(
    J5_CLIENT_READ_WS_METHODS.listCrewMemberships,
    ThreadHomesRequest,
    CrewMembershipsResponse,
  ),
  clientRead(J5_CLIENT_READ_WS_METHODS.readFleet, FleetReadRequest, FleetResponse),
  clientRead(
    J5_CLIENT_READ_WS_METHODS.listSpawnedChildren,
    ThreadHomesRequest,
    SpawnedChildrenResponse,
  ),
  clientRead(
    J5_CLIENT_READ_WS_METHODS.readPreArchiveFacts,
    PreArchiveFactsRequest,
    PreArchiveFacts,
  ),
  clientRead(
    J5_CLIENT_READ_WS_METHODS.readParticipantIdentities,
    ParticipantIdentitiesRequest,
    ParticipantIdentitiesResponse,
  ),
  clientRead(J5_CLIENT_READ_WS_METHODS.listPeers, Schema.Struct({}), PeerListResponse),
  // The whole record each time: a subscriber keeps only the latest element, so an event naming
  // one source could hide another source's move.
  Rpc.make(J5_CLIENT_READ_WS_METHODS.subscribeReadChanges, {
    payload: Schema.Struct({}),
    success: J5ReadRevisions,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
);
