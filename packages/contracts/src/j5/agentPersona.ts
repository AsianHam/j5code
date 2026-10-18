import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import type { SelectProviderOptionDescriptor } from "../model.ts";
import { ModelSelection } from "../modelSelection.ts";
import { RuntimeMode } from "../providerPolicy.ts";
import { ProviderDriverKind } from "../providerInstance.ts";
import type { ServerProviderModel } from "../server.ts";

/**
 * J5-owned agent persona wire schemas. Upstream orchestration structs reference only
 * `OrchestrationV2AgentPersonaAssignment` and `OrchestrationV2AgentPersonaRequest`
 * through additive-optional fields; everything else stays here.
 */
export const BUILT_IN_AGENT_PERSONA_IDS = [
  "scout",
  "navigator",
  "advocate",
  "skeptic",
  "builder",
  "critic",
  "sentry",
  "publisher",
  "investigator",
  "prosecutor",
  "herald",
] as const;

export const AgentPersonaId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
);
export type AgentPersonaId = typeof AgentPersonaId.Type;

export const BuiltInAgentPersonaId = Schema.Literals(BUILT_IN_AGENT_PERSONA_IDS);
export type BuiltInAgentPersonaId = typeof BuiltInAgentPersonaId.Type;

export const AgentPersonaAuthorityPolicy = Schema.Literals([
  "read-only",
  "workspace-write",
  "critic-review",
  "critic-fix",
  "diagnostic",
  "publish-only",
  "full-access",
]);
export type AgentPersonaAuthorityPolicy = typeof AgentPersonaAuthorityPolicy.Type;
export const isAgentPersonaAuthorityPolicy = Schema.is(AgentPersonaAuthorityPolicy);

/**
 * A policy as the server reports it. Read models accept any name so a policy added by a newer
 * server costs one unsupported row instead of the whole payload; what clients send and what the
 * server validates stay on the closed `AgentPersonaAuthorityPolicy`.
 */
export const AgentPersonaReportedAuthorityPolicy = Schema.String;
export type AgentPersonaReportedAuthorityPolicy = typeof AgentPersonaReportedAuthorityPolicy.Type;

export const BUILT_IN_AGENT_ARTIFACT_IDS = [
  "ContextBrief",
  "PlanHandoff",
  "PlanCritique",
  "CodeCompleteHandoff",
  "ReviewHandoff",
  "PublicationReceipt",
  "DiagnosisHandoff",
  "DiagnosisCritique",
  "ReviewInbox",
] as const;

export const BuiltInAgentArtifactId = Schema.Literals(BUILT_IN_AGENT_ARTIFACT_IDS);
export type BuiltInAgentArtifactId = typeof BuiltInAgentArtifactId.Type;

export const OrchestrationV2AgentPersonaRequest = Schema.Struct({
  personaId: AgentPersonaId,
  authorityPolicy: Schema.optional(AgentPersonaAuthorityPolicy),
});
export type OrchestrationV2AgentPersonaRequest = typeof OrchestrationV2AgentPersonaRequest.Type;

/** Immutable launch-time provenance; definitionDigest references an environment-owned snapshot. */
export const OrchestrationV2AgentPersonaAssignment = Schema.Struct({
  personaId: AgentPersonaId,
  definitionVersion: PositiveInt,
  definitionDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  displayName: Schema.optional(TrimmedNonEmptyString),
  authorityPolicy: AgentPersonaReportedAuthorityPolicy,
  resolvedRoute: Schema.Literals(["primary", "fallback", "override"]),
  resolvedDriver: ProviderDriverKind,
  resolvedModelSelection: ModelSelection,
  /** Human-approved crew access, independent of the persona behavior instructions. */
  runtimeModeOverride: Schema.optional(RuntimeMode),
});
export type OrchestrationV2AgentPersonaAssignment =
  typeof OrchestrationV2AgentPersonaAssignment.Type;

/** The assignment as the server issues it in commands, where only known policies are valid. */
export const OrchestrationV2AgentPersonaCommandAssignment = Schema.Struct({
  ...OrchestrationV2AgentPersonaAssignment.fields,
  authorityPolicy: AgentPersonaAuthorityPolicy,
});
export type OrchestrationV2AgentPersonaCommandAssignment =
  typeof OrchestrationV2AgentPersonaCommandAssignment.Type;

/** Why one route of a definition could not be used in this environment. */
export const AgentPersonaRouteFailureCode = Schema.Literals([
  "provider-not-configured",
  "provider-unavailable",
  "provider-disabled",
  "provider-not-installed",
  "provider-error",
  "provider-unauthenticated",
  "model-not-advertised",
  "reasoning-effort-not-advertised",
  "authority-not-enforceable",
]);
export type AgentPersonaRouteFailureCode = typeof AgentPersonaRouteFailureCode.Type;

/** One rejected route with the reasons every candidate provider gave. */
export const AgentPersonaRouteAttempt = Schema.Struct({
  route: Schema.Literals(["primary", "fallback"]),
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  reasoningEffort: TrimmedNonEmptyString,
  failures: Schema.Array(AgentPersonaRouteFailureCode),
});
export type AgentPersonaRouteAttempt = typeof AgentPersonaRouteAttempt.Type;

export const OrchestrationV2AgentPersonaAvailability = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    resolvedRoute: Schema.Literals(["primary", "fallback"]),
    resolvedDriver: ProviderDriverKind,
    resolvedModelSelection: ModelSelection,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "routes-unavailable",
      "authority-not-enforceable",
      "disabled",
      "removed",
    ]),
    /** Per-route detail behind a blocked reason; absent for disabled and removed entries. */
    attempts: Schema.optional(Schema.Array(AgentPersonaRouteAttempt)),
  }),
]);
export type OrchestrationV2AgentPersonaAvailability =
  typeof OrchestrationV2AgentPersonaAvailability.Type;

/** Any provider driver; launch checks whether a signed-in instance advertises the model. */
export const AgentPersonaModelTarget = Schema.Struct({
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  reasoningEffort: TrimmedNonEmptyString,
});
export type AgentPersonaModelTarget = typeof AgentPersonaModelTarget.Type;

/**
 * The select option that carries a model's reasoning level. Providers name it differently:
 * Codex and Grok `reasoningEffort`, Claude and Cursor `effort` or `reasoning`, OpenCode
 * `variant`, Pi `thinking`.
 */
export function agentPersonaReasoningDescriptor(
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
): SelectProviderOptionDescriptor | undefined {
  for (const descriptor of model?.capabilities?.optionDescriptors ?? []) {
    if (descriptor.type === "select" && isAgentPersonaReasoningOptionId(descriptor.id))
      return descriptor;
  }
  return undefined;
}
const AGENT_PERSONA_REASONING_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "thinking",
]);
export const isAgentPersonaReasoningOptionId = (id: string) =>
  AGENT_PERSONA_REASONING_OPTION_IDS.has(id);
export const AgentPersonaEditableDetails = Schema.Struct({
  definitionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export const AGENT_PERSONA_INSTRUCTIONS_MAX_LENGTH = 32768;
const AgentPersonaInstructions = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(AGENT_PERSONA_INSTRUCTIONS_MAX_LENGTH),
);
export const AgentPersonaEditInput = Schema.Struct({
  personaId: AgentPersonaId,
  expectedDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  instructions: AgentPersonaInstructions,
  authorityPolicy: AgentPersonaAuthorityPolicy,
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export type AgentPersonaEditInput = typeof AgentPersonaEditInput.Type;

/** The full definition as stored; the catalog omits instructions to keep lists small. */
export const AgentPersonaDefinitionView = Schema.Struct({
  id: AgentPersonaId,
  version: PositiveInt,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  instructions: AgentPersonaInstructions,
  acceptedInput: Schema.optional(TrimmedNonEmptyString),
  artifacts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  inputArtifacts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  outputArtifact: Schema.optional(TrimmedNonEmptyString),
  authority: Schema.Struct({
    defaultPolicy: AgentPersonaReportedAuthorityPolicy,
    allowedPolicies: Schema.Array(AgentPersonaReportedAuthorityPolicy),
  }),
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export type AgentPersonaDefinitionView = typeof AgentPersonaDefinitionView.Type;

/** A personal agent authored in Settings; the server fills the remaining definition fields. */
export const AgentPersonaCreateInput = Schema.Struct({
  id: AgentPersonaId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  instructions: AgentPersonaInstructions,
  authorityPolicy: AgentPersonaAuthorityPolicy,
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export type AgentPersonaCreateInput = typeof AgentPersonaCreateInput.Type;

/** Where the definition in effect came from; folder paths are server paths shown for orientation only. */
export const AgentPersonaOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("bundled") }),
  Schema.Struct({ kind: Schema.Literal("imported") }),
  Schema.Struct({ kind: Schema.Literal("folder"), path: TrimmedNonEmptyString }),
]);
export type AgentPersonaOrigin = typeof AgentPersonaOrigin.Type;

/** Environment-specific, presentation-safe view of one library persona. */
export const OrchestrationV2AgentPersonaCatalogEntry = Schema.Struct({
  personaId: AgentPersonaId,
  imported: Schema.optional(Schema.Boolean),
  origin: Schema.optional(AgentPersonaOrigin),
  /** A source or bundled definition the user removed; it stays listed so it can be restored. */
  removed: Schema.optional(Schema.Boolean),
  /** Content digest of the current definition; compared with launch snapshots to show drift. */
  definitionDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  editable: Schema.optional(AgentPersonaEditableDetails),
  definitionVersion: PositiveInt,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  acceptedInput: Schema.optional(TrimmedNonEmptyString),
  outputArtifact: Schema.optional(TrimmedNonEmptyString),
  defaultAuthorityPolicy: AgentPersonaReportedAuthorityPolicy,
  allowedAuthorityPolicies: Schema.Array(AgentPersonaReportedAuthorityPolicy),
  availability: OrchestrationV2AgentPersonaAvailability,
});
export type OrchestrationV2AgentPersonaCatalogEntry =
  typeof OrchestrationV2AgentPersonaCatalogEntry.Type;

export class AgentPersonaCatalogError extends Schema.TaggedError<AgentPersonaCatalogError>()(
  "AgentPersonaCatalogError",
  { message: Schema.String },
) {}

/** The provider drivers whose sandbox enforces one runtime policy; the editor shows these. */
export const AgentPersonaPolicyEnforcement = Schema.Struct({
  policy: AgentPersonaReportedAuthorityPolicy,
  drivers: Schema.Array(ProviderDriverKind),
});
export type AgentPersonaPolicyEnforcement = typeof AgentPersonaPolicyEnforcement.Type;

export const OrchestrationV2AgentPersonaCatalog = Schema.Struct({
  personas: Schema.Array(OrchestrationV2AgentPersonaCatalogEntry),
  /** Absent from servers that predate it. */
  policyEnforcement: Schema.optional(Schema.Array(AgentPersonaPolicyEnforcement)),
});
export type OrchestrationV2AgentPersonaCatalog = typeof OrchestrationV2AgentPersonaCatalog.Type;

/** User-authored definitions are YAML only; internal stores and snapshots stay JSON. */
export const isAgentPersonaDefinitionFile = (name: string): boolean => /\.ya?ml$/i.test(name);

export const AGENT_PERSONA_IMPORT_MAX_FILES = 50;
export const AGENT_PERSONA_IMPORT_MAX_BYTES = 65536;
export const AgentPersonaImportConflict = Schema.Struct({
  personaId: AgentPersonaId,
  displayName: TrimmedNonEmptyString,
  definitionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AgentPersonaImportConflict = typeof AgentPersonaImportConflict.Type;
export class AgentPersonaImportConflictError extends Schema.TaggedError<AgentPersonaImportConflictError>()(
  "AgentPersonaImportConflictError",
  { message: Schema.String, conflicts: Schema.Array(AgentPersonaImportConflict) },
) {}

export const AgentPersonaImportFile = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  content: Schema.String.check(Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_BYTES)),
});
export type AgentPersonaImportFile = typeof AgentPersonaImportFile.Type;

export const AgentPersonaImportInput = Schema.Struct({
  files: Schema.Array(AgentPersonaImportFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_FILES),
  ),
  replaceExisting: Schema.Boolean,
  skippedPersonaIds: Schema.optional(
    Schema.Array(AgentPersonaId).check(Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_FILES)),
  ),
  confirmedConflicts: Schema.optional(
    Schema.Array(AgentPersonaImportConflict).check(
      Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_FILES),
    ),
  ),
});
export type AgentPersonaImportInput = typeof AgentPersonaImportInput.Type;

/**
 * Per-agent usage aggregated from the environment's thread, run, and provider-turn
 * projections at request time; nothing new is persisted. Token totals sum the
 * per-turn figures providers report and are absent when none were reported.
 */
export const AgentPersonaUsageEntry = Schema.Struct({
  personaId: AgentPersonaId,
  threads: NonNegativeInt,
  runs: NonNegativeInt,
  completedRuns: NonNegativeInt,
  failedRuns: NonNegativeInt,
  /** Mean wall-clock time of completed runs in milliseconds. */
  averageRunDurationMs: Schema.NullOr(NonNegativeInt),
  lastLaunchedAt: Schema.NullOr(Schema.String),
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  /** Which pinned routes tasks actually resolved to, most used first. */
  routes: Schema.Array(
    Schema.Struct({
      driver: ProviderDriverKind,
      model: TrimmedNonEmptyString,
      threads: NonNegativeInt,
    }),
  ),
});
export type AgentPersonaUsageEntry = typeof AgentPersonaUsageEntry.Type;
export const AgentPersonaUsage = Schema.Struct({ personas: Schema.Array(AgentPersonaUsageEntry) });
export type AgentPersonaUsage = typeof AgentPersonaUsage.Type;

/** Read-only git signals for a source folder; the server never fetches, pulls, or commits. */
export const AgentPersonaFolderGitStatus = Schema.Struct({
  repositoryRoot: TrimmedNonEmptyString,
  /** Uncommitted changes within this folder. */
  uncommittedChanges: Schema.Boolean,
  /** Commits on the tracked remote branch not yet pulled; null without an upstream. */
  remoteAhead: Schema.NullOr(NonNegativeInt),
});
export type AgentPersonaFolderGitStatus = typeof AgentPersonaFolderGitStatus.Type;
export const AgentPersonaLibraryFolder = Schema.Struct({
  /** The entry as written in agent-personas.json (relative paths resolve from the state directory). */
  configuredPath: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  exists: Schema.Boolean,
  definitionCount: NonNegativeInt,
  git: Schema.NullOr(AgentPersonaFolderGitStatus),
});
export type AgentPersonaLibraryFolder = typeof AgentPersonaLibraryFolder.Type;
export const AgentPersonaLibrarySources = Schema.Struct({
  configPath: TrimmedNonEmptyString,
  /** False while the default folder applies and bundled examples fill in for a missing one. */
  configured: Schema.Boolean,
  folders: Schema.Array(AgentPersonaLibraryFolder),
});
export type AgentPersonaLibrarySources = typeof AgentPersonaLibrarySources.Type;
export const AGENT_PERSONA_LIBRARY_MAX_FOLDERS = 32;
export const AgentPersonaLibraryFoldersInput = Schema.Struct({
  folders: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(AGENT_PERSONA_LIBRARY_MAX_FOLDERS),
  ),
});
export type AgentPersonaLibraryFoldersInput = typeof AgentPersonaLibraryFoldersInput.Type;

/**
 * A saved agent's declared output artifact, tracked per task. The agent writes it to the
 * project's shared artifacts through j5_write_artifact; the server checks at run end, asks once
 * when it is missing (`nudged`), and marks it `missing` if the follow-up ends without it.
 */
export const AgentHandoffStatus = Schema.Literals(["written", "nudged", "missing"]);
export type AgentHandoffStatus = typeof AgentHandoffStatus.Type;
export const AgentHandoff = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  personaId: AgentPersonaId,
  artifact: TrimmedNonEmptyString,
  /** Path relative to the project's artifacts directory, e.g. handoffs/critic/ReviewHandoff-8f3a2c1d.md. */
  path: TrimmedNonEmptyString,
  status: AgentHandoffStatus,
  runId: Schema.NullOr(RunId),
  checkedAt: Schema.String,
});
export type AgentHandoff = typeof AgentHandoff.Type;

// Library management RPCs. These ride the upstream WebSocket RPC transport via one
// `WsRpcGroup.merge(...)` call so environment scoping, remote connections, and
// mobile keep working without a second wire path, while every definition stays here.

export const J5_AGENT_PERSONA_WS_METHODS = {
  getAgentPersonaCatalog: "j5.agentPersonas.getCatalog",
  importAgentPersonas: "j5.agentPersonas.import",
  listAgentPersonaImportFiles: "j5.agentPersonas.listImportFiles",
  readAgentPersonaImportFiles: "j5.agentPersonas.readImportFiles",
  editImportedAgentPersona: "j5.agentPersonas.editImported",
  setImportedAgentPersonaEnabled: "j5.agentPersonas.setImportedEnabled",
  removeImportedAgentPersona: "j5.agentPersonas.removeImported",
  removeSourceAgentPersona: "j5.agentPersonas.removeSource",
  removeAgentPersona: "j5.agentPersonas.remove",
  restoreSourceAgentPersona: "j5.agentPersonas.restoreSource",
  createAgentPersona: "j5.agentPersonas.create",
  readAgentPersona: "j5.agentPersonas.read",
  getAgentPersonaUsage: "j5.agentPersonas.getUsage",
  getAgentPersonaLibrarySources: "j5.agentPersonas.getLibrarySources",
  setAgentPersonaLibraryFolders: "j5.agentPersonas.setLibraryFolders",
  setAgentPersonaEnabled: "j5.agentPersonas.setEnabled",
  getAgentHandoffs: "j5.agentPersonas.getHandoffs",
  subscribeAgentHandoffRefreshes: "j5.agentPersonas.subscribeHandoffRefreshes",
} as const;

export const J5AgentPersonaRpcSchemas = {
  getAgentPersonaCatalog: {
    input: Schema.Struct({}),
    output: OrchestrationV2AgentPersonaCatalog,
  },
  importAgentPersonas: {
    input: AgentPersonaImportInput,
    output: Schema.Struct({ importedIds: Schema.Array(AgentPersonaId) }),
  },
  /** YAML files directly inside a folder on the environment's machine, for the import picker. */
  listAgentPersonaImportFiles: {
    input: Schema.Struct({ directory: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)) }),
    output: Schema.Struct({
      files: Schema.Array(
        Schema.Struct({ name: TrimmedNonEmptyString, fullPath: TrimmedNonEmptyString }),
      ),
    }),
  },
  /**
   * Reads one YAML file, or every YAML file under a folder, from the environment's machine so
   * the result can go through `importAgentPersonas` and its conflict confirmation unchanged.
   */
  readAgentPersonaImportFiles: {
    input: Schema.Struct({ path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)) }),
    output: Schema.Struct({
      files: Schema.Array(AgentPersonaImportFile).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_FILES),
      ),
    }),
  },
  editImportedAgentPersona: {
    input: AgentPersonaEditInput,
    output: Schema.Void,
  },
  setImportedAgentPersonaEnabled: {
    input: Schema.Struct({ personaId: AgentPersonaId, enabled: Schema.Boolean }),
    output: Schema.Void,
  },
  removeImportedAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  removeSourceAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  removeAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  restoreSourceAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  createAgentPersona: {
    input: AgentPersonaCreateInput,
    output: Schema.Struct({ personaId: AgentPersonaId }),
  },
  readAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Struct({
      definition: AgentPersonaDefinitionView,
      fileName: TrimmedNonEmptyString,
      yaml: Schema.String,
    }),
  },
  getAgentPersonaUsage: {
    input: Schema.Struct({}),
    output: AgentPersonaUsage,
  },
  getAgentPersonaLibrarySources: {
    input: Schema.Struct({}),
    output: AgentPersonaLibrarySources,
  },
  setAgentPersonaLibraryFolders: {
    input: AgentPersonaLibraryFoldersInput,
    output: Schema.Void,
  },
  /** On/off for any listed agent: imported copies keep their flag, source and bundled ids join a disabled list. */
  setAgentPersonaEnabled: {
    input: Schema.Struct({ personaId: AgentPersonaId, enabled: Schema.Boolean }),
    output: Schema.Void,
  },
  getAgentHandoffs: {
    input: Schema.Struct({
      threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(200))),
    }),
    output: Schema.Struct({ handoffs: Schema.Array(AgentHandoff) }),
  },
  /** Emits a revision after every handoff row write; clients refetch `getAgentHandoffs` on it. */
  subscribeAgentHandoffRefreshes: {
    input: Schema.Struct({}),
    output: NonNegativeInt,
  },
} as const;

const catalogErrors = Schema.Union([EnvironmentAuthorizationError, AgentPersonaCatalogError]);

export const WsJ5GetAgentPersonaCatalogRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog,
  {
    payload: J5AgentPersonaRpcSchemas.getAgentPersonaCatalog.input,
    success: J5AgentPersonaRpcSchemas.getAgentPersonaCatalog.output,
    error: catalogErrors,
  },
);
export const WsJ5ImportAgentPersonasRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas,
  {
    payload: J5AgentPersonaRpcSchemas.importAgentPersonas.input,
    success: J5AgentPersonaRpcSchemas.importAgentPersonas.output,
    error: Schema.Union([
      EnvironmentAuthorizationError,
      AgentPersonaCatalogError,
      AgentPersonaImportConflictError,
    ]),
  },
);
export const WsJ5ListAgentPersonaImportFilesRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.listAgentPersonaImportFiles,
  {
    payload: J5AgentPersonaRpcSchemas.listAgentPersonaImportFiles.input,
    success: J5AgentPersonaRpcSchemas.listAgentPersonaImportFiles.output,
    error: catalogErrors,
  },
);
export const WsJ5ReadAgentPersonaImportFilesRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.readAgentPersonaImportFiles,
  {
    payload: J5AgentPersonaRpcSchemas.readAgentPersonaImportFiles.input,
    success: J5AgentPersonaRpcSchemas.readAgentPersonaImportFiles.output,
    error: catalogErrors,
  },
);
export const WsJ5EditImportedAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.editImportedAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.editImportedAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.editImportedAgentPersona.output,
    error: catalogErrors,
  },
);
export const WsJ5SetImportedAgentPersonaEnabledRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.setImportedAgentPersonaEnabled,
  {
    payload: J5AgentPersonaRpcSchemas.setImportedAgentPersonaEnabled.input,
    success: J5AgentPersonaRpcSchemas.setImportedAgentPersonaEnabled.output,
    error: catalogErrors,
  },
);
export const WsJ5RemoveImportedAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.removeImportedAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.removeImportedAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.removeImportedAgentPersona.output,
    error: catalogErrors,
  },
);
export const WsJ5RemoveSourceAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.removeSourceAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.removeSourceAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.removeSourceAgentPersona.output,
    error: catalogErrors,
  },
);
export const WsJ5RemoveAgentPersonaRpc = Rpc.make(J5_AGENT_PERSONA_WS_METHODS.removeAgentPersona, {
  payload: J5AgentPersonaRpcSchemas.removeAgentPersona.input,
  success: J5AgentPersonaRpcSchemas.removeAgentPersona.output,
  error: catalogErrors,
});
export const WsJ5RestoreSourceAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.restoreSourceAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.restoreSourceAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.restoreSourceAgentPersona.output,
    error: catalogErrors,
  },
);

export const WsJ5CreateAgentPersonaRpc = Rpc.make(J5_AGENT_PERSONA_WS_METHODS.createAgentPersona, {
  payload: J5AgentPersonaRpcSchemas.createAgentPersona.input,
  success: J5AgentPersonaRpcSchemas.createAgentPersona.output,
  error: catalogErrors,
});

export const WsJ5ReadAgentPersonaRpc = Rpc.make(J5_AGENT_PERSONA_WS_METHODS.readAgentPersona, {
  payload: J5AgentPersonaRpcSchemas.readAgentPersona.input,
  success: J5AgentPersonaRpcSchemas.readAgentPersona.output,
  error: catalogErrors,
});

export const WsJ5GetAgentPersonaUsageRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaUsage,
  {
    payload: J5AgentPersonaRpcSchemas.getAgentPersonaUsage.input,
    success: J5AgentPersonaRpcSchemas.getAgentPersonaUsage.output,
    error: catalogErrors,
  },
);

export const WsJ5GetAgentPersonaLibrarySourcesRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaLibrarySources,
  {
    payload: J5AgentPersonaRpcSchemas.getAgentPersonaLibrarySources.input,
    success: J5AgentPersonaRpcSchemas.getAgentPersonaLibrarySources.output,
    error: catalogErrors,
  },
);

export const WsJ5SetAgentPersonaLibraryFoldersRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaLibraryFolders,
  {
    payload: J5AgentPersonaRpcSchemas.setAgentPersonaLibraryFolders.input,
    success: J5AgentPersonaRpcSchemas.setAgentPersonaLibraryFolders.output,
    error: catalogErrors,
  },
);

export const WsJ5SetAgentPersonaEnabledRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaEnabled,
  {
    payload: J5AgentPersonaRpcSchemas.setAgentPersonaEnabled.input,
    success: J5AgentPersonaRpcSchemas.setAgentPersonaEnabled.output,
    error: catalogErrors,
  },
);

export const WsJ5GetAgentHandoffsRpc = Rpc.make(J5_AGENT_PERSONA_WS_METHODS.getAgentHandoffs, {
  payload: J5AgentPersonaRpcSchemas.getAgentHandoffs.input,
  success: J5AgentPersonaRpcSchemas.getAgentHandoffs.output,
  error: catalogErrors,
});

export const WsJ5SubscribeAgentHandoffRefreshesRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.subscribeAgentHandoffRefreshes,
  {
    payload: J5AgentPersonaRpcSchemas.subscribeAgentHandoffRefreshes.input,
    success: J5AgentPersonaRpcSchemas.subscribeAgentHandoffRefreshes.output,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

/** Merged into `WsRpcGroup` by one appended call; no other upstream registration exists. */
export const J5AgentPersonaRpcGroup = RpcGroup.make(
  WsJ5GetAgentPersonaCatalogRpc,
  WsJ5ImportAgentPersonasRpc,
  WsJ5ListAgentPersonaImportFilesRpc,
  WsJ5ReadAgentPersonaImportFilesRpc,
  WsJ5EditImportedAgentPersonaRpc,
  WsJ5SetImportedAgentPersonaEnabledRpc,
  WsJ5RemoveImportedAgentPersonaRpc,
  WsJ5RemoveSourceAgentPersonaRpc,
  WsJ5RemoveAgentPersonaRpc,
  WsJ5RestoreSourceAgentPersonaRpc,
  WsJ5CreateAgentPersonaRpc,
  WsJ5ReadAgentPersonaRpc,
  WsJ5GetAgentPersonaUsageRpc,
  WsJ5GetAgentPersonaLibrarySourcesRpc,
  WsJ5SetAgentPersonaLibraryFoldersRpc,
  WsJ5SetAgentPersonaEnabledRpc,
  WsJ5GetAgentHandoffsRpc,
  WsJ5SubscribeAgentHandoffRefreshesRpc,
);
