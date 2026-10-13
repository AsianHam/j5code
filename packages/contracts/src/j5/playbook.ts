import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { ProjectId, ThreadId } from "../baseSchemas.ts";
import { AgentPersonaId } from "./agentPersona.ts";

export const PLAYBOOK_MAX_BYTES = 262144;
export const PLAYBOOK_MAX_STEPS = 100;
/** A playbook's name is its file stem: lowercase words joined by hyphens, like persona ids. */
export const PLAYBOOK_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The valid playbook name closest to a file stem such as "Release Plan", or null if none. */
export function suggestPlaybookName(text: string): string | null {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return null;
  return /^[a-z]/.test(slug) ? slug : `playbook-${slug}`;
}

export const J5_PLAYBOOK_WS_METHODS = {
  subscribeChanges: "j5.playbooks.subscribeChanges",
  readLibrary: "j5.playbooks.readLibrary",
  listThreadRuns: "j5.playbooks.listThreadRuns",
  listRuns: "j5.playbooks.listRuns",
  exportPlaybook: "j5.playbooks.export",
  deletePlaybook: "j5.playbooks.delete",
  renamePlaybook: "j5.playbooks.rename",
} as const;

const Text = Schema.String.check(Schema.isPattern(/\S/));
/** `persona` names the library persona a step wants; a missing or disabled one is a warning. */
export const PlaybookStep = Schema.Struct({
  id: Text,
  title: Text,
  prompt: Text,
  persona: Schema.optionalKey(AgentPersonaId),
});
export type PlaybookStep = typeof PlaybookStep.Type;
export const PlaybookDefinition = Schema.Struct({
  title: Text,
  description: Text,
  steps: Schema.Array(PlaybookStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PLAYBOOK_MAX_STEPS),
  ),
});
export type PlaybookDefinition = typeof PlaybookDefinition.Type;

/** Advisory findings about a valid definition; unlike `issue`, they never block starting. */
export const PlaybookWarning = Schema.Struct({
  code: Schema.Literals(["persona_missing", "persona_disabled", "persona_unverified"]),
  stepId: Text,
  persona: AgentPersonaId,
  message: Schema.String,
});
export type PlaybookWarning = typeof PlaybookWarning.Type;

export class PlaybookError extends Schema.TaggedError<PlaybookError>()("PlaybookError", {
  code: Schema.String,
  message: Schema.String,
  availableStepIds: Schema.Array(Schema.String),
}) {}

export const PlaybookRun = Schema.Struct({
  runId: Text,
  ownerThreadId: ThreadId,
  definitionPath: Text,
  currentStepId: Text,
  status: Schema.Literals(["active", "completed", "cancelled"]),
  createdAt: Text,
  updatedAt: Text,
  /** The Crew whose seats receive this run's steps; absent or null for an ordinary thread run. */
  crewInstanceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type PlaybookRun = typeof PlaybookRun.Type;

/**
 * Who holds a Crew-linked run's current step. Only `state: "captain"` means the Captain does it;
 * `pending` means the hand-off hasn't finished and nobody should start the step yet.
 */
export const PlaybookStepDelivery = Schema.Struct({
  state: Schema.Literals(["delivered", "captain", "pending"]),
  seat: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
});
export type PlaybookStepDelivery = typeof PlaybookStepDelivery.Type;

/** The board receives titles, never the other steps' prompt bodies. */
export const PlaybookProgress = Schema.Struct({
  ...PlaybookRun.fields,
  title: Schema.String,
  description: Schema.String,
  steps: Schema.Array(Schema.Struct({ id: Text, title: Text })),
  position: Schema.NullOr(Schema.Int),
  total: Schema.Int,
  issue: Schema.NullOr(PlaybookError),
});
export type PlaybookProgress = typeof PlaybookProgress.Type;
export const PlaybookStepResponse = Schema.Struct({
  ...PlaybookProgress.fields,
  currentStep: Schema.NullOr(PlaybookStep),
  replayed: Schema.Boolean,
  /** Set for Crew-linked runs' step tools; null on complete and cancel; absent for thread runs. */
  delivery: Schema.optionalKey(Schema.NullOr(PlaybookStepDelivery)),
});
export type PlaybookStepResponse = typeof PlaybookStepResponse.Type;
export const PlaybookDiscovery = Schema.Struct({
  playbooks: Schema.Array(
    Schema.Struct({
      name: Text,
      title: Schema.String,
      description: Schema.String,
      stepCount: Schema.Int,
      steps: Schema.Array(
        Schema.Struct({ id: Text, title: Text, persona: Schema.optionalKey(AgentPersonaId) }),
      ),
      issue: Schema.NullOr(PlaybookError),
      // Optional so a newer client still reads an older server; this server always sends it.
      warnings: Schema.optionalKey(Schema.Array(PlaybookWarning)),
    }),
  ),
});
/** One playbook's live definition, read without starting or moving a run. */
export const PlaybookReadResponse = Schema.Struct({
  name: Text,
  title: Text,
  description: Text,
  steps: Schema.Array(PlaybookStep),
  warnings: Schema.Array(PlaybookWarning),
});
export type PlaybookReadResponse = typeof PlaybookReadResponse.Type;
export const ThreadPlaybooksRequest = Schema.Struct({ threadId: ThreadId });
export const ThreadPlaybooksResponse = Schema.Struct({ runs: Schema.Array(PlaybookProgress) });
export const PLAYBOOK_RUNS_PAGE_SIZE = 100;
export const PlaybookRunsRequest = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(["active", "all"])),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type PlaybookRunsRequest = typeof PlaybookRunsRequest.Type;
export const PlaybookRunsResponse = Schema.Struct({
  runs: Schema.Array(PlaybookProgress),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const PlaybookLibraryRequest = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type PlaybookLibraryRequest = typeof PlaybookLibraryRequest.Type;
export const PlaybookLibraryResponse = Schema.Struct({
  workspaceRoot: Schema.String,
  ...PlaybookDiscovery.fields,
});
export const PlaybookDeleteRequest = Schema.Struct({
  ...PlaybookLibraryRequest.fields,
  name: Text,
});
export type PlaybookDeleteRequest = typeof PlaybookDeleteRequest.Type;
export const PlaybookDeleteResponse = Schema.Struct({ deleted: Schema.Boolean });
export const PlaybookRenameRequest = Schema.Struct({
  ...PlaybookLibraryRequest.fields,
  name: Text,
  title: Text,
});
export type PlaybookRenameRequest = typeof PlaybookRenameRequest.Type;
export const PlaybookRenameResponse = Schema.Struct({ renamed: Schema.Boolean });
export const PlaybookExportRequest = Schema.Struct({
  ...PlaybookLibraryRequest.fields,
  name: Text,
});
export type PlaybookExportRequest = typeof PlaybookExportRequest.Type;
export const PlaybookExportResponse = Schema.Struct({ fileName: Text, yaml: Schema.String });
export type PlaybookExportResponse = typeof PlaybookExportResponse.Type;

export const J5PlaybookRpcGroup = RpcGroup.make(
  Rpc.make(J5_PLAYBOOK_WS_METHODS.subscribeChanges, {
    payload: Schema.Struct({}),
    success: Schema.Int,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
  Rpc.make(J5_PLAYBOOK_WS_METHODS.readLibrary, {
    payload: PlaybookLibraryRequest,
    success: PlaybookLibraryResponse,
    error: Schema.Union([PlaybookError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(J5_PLAYBOOK_WS_METHODS.listThreadRuns, {
    payload: ThreadPlaybooksRequest,
    success: ThreadPlaybooksResponse,
    error: Schema.Union([PlaybookError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(J5_PLAYBOOK_WS_METHODS.listRuns, {
    payload: PlaybookRunsRequest,
    success: PlaybookRunsResponse,
    error: Schema.Union([PlaybookError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(J5_PLAYBOOK_WS_METHODS.exportPlaybook, {
    payload: PlaybookExportRequest,
    success: PlaybookExportResponse,
    error: Schema.Union([PlaybookError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(J5_PLAYBOOK_WS_METHODS.deletePlaybook, {
    payload: PlaybookDeleteRequest,
    success: PlaybookDeleteResponse,
    error: Schema.Union([PlaybookError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(J5_PLAYBOOK_WS_METHODS.renamePlaybook, {
    payload: PlaybookRenameRequest,
    success: PlaybookRenameResponse,
    error: Schema.Union([PlaybookError, EnvironmentAuthorizationError]),
  }),
);
