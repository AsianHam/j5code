import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { vi } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "../../orchestration-v2/ThreadTitleRegenerationService.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";

/**
 * A real ThreadLaunch over a real orchestrator, with git, setup, and project registration faked.
 * It mirrors orchestration-v2/ThreadLaunchService.test.ts so J5 launch cases stay out of the
 * upstream test file (FORK.md). Keep it in sync when that harness moves.
 */
export const projectId = ProjectId.make("project:launch-test");
export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
export const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

export interface HarnessOptions {
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchRemote?: GitWorkflow.GitWorkflowService["Service"]["fetchRemote"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
}

export function makeHarness(options: HarnessOptions = {}) {
  const database = SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const orchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const threadManagement = ThreadManagement.layer.pipe(
    Layer.provide(orchestrator),
    Layer.provide(ServerSettings.layerTest(options.serverSettings)),
    Layer.provide(receipts),
  );
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const externalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchRemote: options.fetchRemote ?? (() => Effect.void),
      hasCommit: () => Effect.succeed(false),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree: () => Effect.void,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    ServerSettings.layerTest(options.serverSettings),
    ProviderRegistryMock.layer(options.providers),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(externalServices, threadManagement, receipts, IdAllocator.layer)),
  );
  const projectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const titleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(Layer.mergeAll(threadManagement, projectedProjects, externalServices)),
  );
  return {
    layer: Layer.mergeAll(launch, threadManagement, titleRegeneration, outbox, database),
    /** The faked project, git, and setup services plus the receipt store ThreadLaunch reads. */
    services: Layer.mergeAll(externalServices, receipts),
    createWorktree,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
  };
}
