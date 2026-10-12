// @effect-diagnostics nodeBuiltinImport:off - a build-time generator; plain file writes and one child process.
/**
 * Builds the self-contained home an agent live-tests against, with no model:
 *
 *   node apps/server/src/j5/test-support/liveTestHome.ts --root <absolute directory>
 *
 * Under `<root>` it makes `test-repo` (see liveTestRepo.ts) with its bare
 * origin, and `home`, a J5 home holding one project, replayed Claude and Codex
 * threads from upstream's provider replay kit, J5's delivery seed, two light
 * personas, and Claude Haiku as the default model. It finishes by writing
 * `<root>/manifest.json`, which is what `scripts/j5/setup-agent-live-test.ts`
 * reads. Nothing in the home points outside `<root>`.
 *
 * The replayed threads are for viewing. Their provider sessions never existed,
 * so a turn sent in one fails or starts a fresh provider conversation.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { ClaudeOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../../orchestration-v2/testkit/fixtures/index.ts";
import {
  materializeFixtureInput,
  type OrchestratorReplayFixture,
  type ProviderOrchestratorReplayVariant,
} from "../../orchestration-v2/testkit/fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  runDevDeliverySeed,
  validateIsolatedBaseDir,
} from "../a2a/test-support/devDeliverySeed.ts";
import {
  createLiveTestRepo,
  LIVE_TEST_HOLD_RELEASE_FILE,
  LIVE_TEST_HOLD_SCRIPT,
  LIVE_TEST_PLAYBOOKS,
} from "./liveTestRepo.ts";

type ReplayDriver = "claudeAgent" | "codex";

/** [fixture, driver], oldest first. Chosen for variety in what the timeline has to render. */
const LIVE_TEST_REPLAYS: ReadonlyArray<readonly [fixture: string, driver: ReplayDriver]> = [
  ["multi_turn", "claudeAgent"],
  ["multi_turn", "codex"],
  ["turn_interrupt", "claudeAgent"],
  ["turn_interrupt", "codex"],
  ["claude_result_is_error", "claudeAgent"],
  ["subagent", "claudeAgent"],
  ["subagent", "codex"],
  ["claude_background_task_wake", "claudeAgent"],
  ["tool_call_read_only", "claudeAgent"],
  ["claude_compact_after_peer_turn", "claudeAgent"],
  ["queued_turn", "codex"],
  ["todo_list", "codex"],
  ["proposed_plan", "codex"],
  ["web_search", "codex"],
  ["claude_mcp_tool_presentation", "claudeAgent"],
];

const LIVE_TEST_PROJECT_TITLE = "Live test repo";
/** New threads in the home start on this model, the cheapest Claude. */
const LIVE_TEST_DEFAULT_MODEL = {
  instanceId: "claudeAgent",
  model: "claude-haiku-4-5",
} as const;
const HAIKU_ROUTE = { driver: "claudeAgent", model: "claude-haiku-4-5" } as const;
const LUNA_ROUTE = { driver: "codex", model: "gpt-6-luna" } as const;
/** A persona names exactly two routes; the second is used only when the first is unavailable. */
const LIVE_TEST_PERSONAS = [
  { id: "haiku-helper", displayName: "Haiku helper", routes: [HAIKU_ROUTE, LUNA_ROUTE] },
  { id: "luna-helper", displayName: "Luna helper", routes: [LUNA_ROUTE, HAIKU_ROUTE] },
] as const;
/**
 * The time to build as, in epoch milliseconds, when `J5_LIVE_TEST_NOW` is set.
 * `setup-agent-live-test --base` sets it for both builds, so a base and a head
 * home date their replayed threads identically.
 */
const fixedNow = Config.Int("J5_LIVE_TEST_NOW").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
  Effect.orElseSucceed(() => undefined),
);
/** The replayed threads are spaced this far apart, ending just before the build. */
const REPLAY_SPACING_MS = 20 * 60 * 1000;

class LiveTestHomeReplayError extends Schema.TaggedError<LiveTestHomeReplayError>()(
  "LiveTestHomeReplayError",
  { name: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Replaying ${this.name} into the live-test home failed.`;
  }
}

export interface LiveTestHomeManifest {
  readonly version: 1;
  readonly home: string;
  readonly testRepo: string;
  readonly testRepoOrigin: string;
  readonly project: { readonly id: string; readonly title: string };
  readonly defaultModel: string;
  /** `fallbackModel` is the second route, used when the first is unavailable or the launcher prefers its own provider. */
  readonly personas: ReadonlyArray<{
    readonly id: string;
    readonly model: string;
    readonly fallbackModel: string;
  }>;
  readonly playbooks: ReadonlyArray<string>;
  readonly holdScript: string;
  readonly holdReleaseFile: string;
  readonly replayedThreads: number;
  readonly seedThreads: number;
}

const liveTestHomePaths = (root: string) => ({
  home: NodePath.join(root, "home"),
  testRepo: NodePath.join(root, "test-repo"),
  testRepoOrigin: NodePath.join(root, "test-repo-origin.git"),
  manifest: NodePath.join(root, "manifest.json"),
});

/** Variables an agent's shell inherits from the live server; nothing started here may see them. */
const withoutLiveServerVariables = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const {
    T3CODE_PORT: _port,
    T3CODE_HOST: _host,
    J5CODE_HOME: _home,
    J5CODE_SERVER_NAME: _name,
    ...rest
  } = environment;
  return rest;
};

/** Registers the test repo through the offline `project add` CLI, which also runs the migrations. */
function registerProject(input: {
  readonly home: string;
  readonly testRepo: string;
  readonly databasePath: string;
}): ProjectId {
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(import.meta.dirname, "../../bin.ts"),
      "project",
      "add",
      input.testRepo,
      "--title",
      LIVE_TEST_PROJECT_TITLE,
      "--base-dir",
      input.home,
    ],
    { cwd: input.testRepo, stdio: "pipe", env: withoutLiveServerVariables(process.env) },
  );
  const database = new NodeSqlite.DatabaseSync(input.databasePath, { readOnly: true });
  try {
    const projects = database
      .prepare("SELECT project_id, workspace_root FROM projection_projects")
      .all();
    if (projects.length !== 1 || projects[0]?.workspace_root !== input.testRepo) {
      throw new Error(
        `Expected one project at ${input.testRepo}, found ${JSON.stringify(projects)}.`,
      );
    }
    return ProjectId.make(String(projects[0].project_id));
  } finally {
    database.close();
  }
}

/**
 * Replays one recorded provider transcript into the home's database as a
 * thread of `projectId`.
 *
 * Adapted from `runFixtureProvider` in upstream's
 * `orchestration-v2/testkit/OrchestratorReplayFixtures.integration.test.ts`,
 * which is private to that test file. It differs in writing to a file
 * database, putting the thread in our project with our repository as its cwd,
 * starting the clock at `startAtMs`, and asserting nothing: each fixture's own
 * assertions expect a database that holds only its thread.
 */
const replayFixture = Effect.fn("liveTestHome.replayFixture")(function* <
  Transcript extends ProviderReplayTranscript,
  Error,
>(input: {
  readonly fixture: OrchestratorReplayFixture;
  readonly variant: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  readonly projectId: ProjectId;
  readonly testRepo: string;
  readonly databasePath: string;
  readonly startAtMs: number;
}) {
  const recorded = yield* readProviderReplayTranscript(input.variant.transcriptFile).pipe(
    Effect.provide(NodeServices.layer),
  );
  const lastLabel = input.variant.transcriptEntriesThroughLabel;
  const lastIndex = recorded.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === lastLabel,
  );
  if (lastLabel !== undefined && lastIndex === -1) {
    return yield* Effect.die(`${recorded.scenario} has no inbound entry labelled ${lastLabel}.`);
  }
  const withInstructions = materializeReplayTranscriptRuntimeInstructions(
    lastLabel === undefined
      ? recorded
      : { ...recorded, entries: recorded.entries.slice(0, lastIndex + 1) },
    { driver: input.variant.driver, model: input.variant.modelSelection.model },
  );
  const transcript = yield* input.harness.decodeTranscript(
    input.variant.driver === "codex"
      ? materializeReplayTranscriptWorkspace(withInstructions, input.testRepo)
      : withInstructions,
  );
  const materialized = yield* materializeFixtureInput({
    scenario: input.fixture.name,
    fixtureInput: input.fixture.buildInput(),
    driver: input.variant.driver,
    modelSelection: input.variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  // The fixture allocates a project id that nothing creates; its commands go to
  // ours instead. Both drivers of a fixture share a title, so name the driver.
  const retarget = (command: OrchestrationV2Command): OrchestrationV2Command =>
    command.type === "thread.create"
      ? {
          ...command,
          projectId: input.projectId,
          title: `${command.title} (${input.variant.driver === "codex" ? "Codex" : "Claude"})`,
        }
      : "projectId" in command
        ? { ...command, projectId: input.projectId }
        : command;
  const result = yield* Effect.gen(function* () {
    yield* TestClock.setTime(input.startAtMs);
    return yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${input.fixture.name}/${input.variant.driver}`,
        transcript,
        commands: materialized.commands.map(retarget),
        steps: materialized.steps.map((step) =>
          step.type === "dispatch" ? { ...step, command: retarget(step.command) } : step,
        ),
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...input.variant.runtimePolicyOverride, cwd: input.testRepo },
      },
      input.harness,
      {
        databaseLayer: SqlitePersistence.layerFromPath(input.databasePath).pipe(
          Layer.provide(NodeServices.layer),
        ),
        ...(input.variant.runContinuationWorker === true ? { runContinuationWorker: true } : {}),
      },
    );
  }).pipe(provideDeterministicTestRuntime);
  if (result.projections.size === 0) {
    return yield* Effect.die(`${input.fixture.name}/${input.variant.driver} replayed no thread.`);
  }
});

function writeSettingsAndPersonas(home: string): void {
  const stateDir = NodePath.join(home, "userdata");
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "settings.json"),
    `${JSON.stringify(
      { defaultModelSelection: LIVE_TEST_DEFAULT_MODEL satisfies Pick<ModelSelection, "model"> },
      null,
      2,
    )}\n`,
  );
  // With no agent-personas.json the library reads this folder, in place of the bundled examples.
  NodeFS.mkdirSync(NodePath.join(stateDir, "personas"), { recursive: true });
  for (const persona of LIVE_TEST_PERSONAS) {
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "personas", `${persona.id}.yaml`),
      [
        `id: ${persona.id}`,
        "version: 1",
        `displayName: ${persona.displayName}`,
        `description: A light persona for live tests, pinned to ${persona.routes[0].model}.`,
        "authority:",
        "  defaultPolicy: full-access",
        "  allowedPolicies: [full-access]",
        "modelRoute:",
        ...persona.routes.map(
          (route) => `  - { driver: ${route.driver}, model: ${route.model}, reasoningEffort: low }`,
        ),
        "instructions: Keep every reply to one short sentence unless the task needs more.",
        "",
      ].join("\n"),
    );
  }
}

/** Written last, so its presence means the build finished. */
function writeManifest(manifestPath: string, manifest: LiveTestHomeManifest): void {
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Builds the test repository and home under `root` and returns the manifest
 * it wrote. `root` must not hold a build already. `replays` narrows the
 * replayed threads, for tests.
 */
export const buildLiveTestHome = Effect.fn("buildLiveTestHome")(function* (input: {
  readonly root: string;
  readonly replays?: ReadonlyArray<readonly [fixture: string, driver: ReplayDriver]>;
}) {
  const paths = liveTestHomePaths(input.root);
  for (const existing of Object.values(paths)) {
    if (NodeFS.existsSync(existing)) {
      return yield* Effect.die(`${existing} already exists. Delete ${input.root} to rebuild.`);
    }
  }
  // The same rule as the delivery seed: never the shared home or its state.
  const home = yield* validateIsolatedBaseDir(paths.home).pipe(Effect.provide(NodeServices.layer));
  const root = NodePath.dirname(home);
  const { testRepo, testRepoOrigin, manifest: manifestPath } = liveTestHomePaths(root);
  const databasePath = NodePath.join(home, "userdata", "statev2.sqlite");

  createLiveTestRepo({ repoDir: testRepo, originDir: testRepoOrigin });
  const projectId = registerProject({ home, testRepo, databasePath });

  const replays = input.replays ?? LIVE_TEST_REPLAYS;
  const now = (yield* fixedNow) ?? (yield* Clock.currentTimeMillis);
  const finishReplay = <Error>(name: string, replay: Effect.Effect<void, Error, Scope.Scope>) =>
    replay.pipe(
      Effect.scoped,
      Effect.mapError((cause) => new LiveTestHomeReplayError({ name, cause })),
    );
  for (const [index, [fixtureName, driver]] of replays.entries()) {
    const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === fixtureName);
    const variant = fixture?.providers.find((provider) => provider.driver === driver);
    if (fixture === undefined || variant === undefined) {
      return yield* Effect.die(`No replay fixture ${fixtureName} for ${driver}.`);
    }
    const scenario = {
      fixture,
      variant,
      projectId,
      testRepo,
      databasePath,
      startAtMs: now - (replays.length - index) * REPLAY_SPACING_MS,
    };
    const name = `${fixtureName}/${driver}`;
    yield* driver === "codex"
      ? finishReplay(name, replayFixture({ ...scenario, harness: CodexOrchestratorReplayHarness }))
      : finishReplay(
          name,
          replayFixture({ ...scenario, harness: ClaudeOrchestratorReplayHarness }),
        );
  }

  const seed = yield* runDevDeliverySeed(home, {
    project: { id: projectId, workspaceRoot: testRepo },
  });
  writeSettingsAndPersonas(home);

  const manifest: LiveTestHomeManifest = {
    version: 1,
    home,
    testRepo,
    testRepoOrigin,
    project: { id: projectId, title: LIVE_TEST_PROJECT_TITLE },
    defaultModel: LIVE_TEST_DEFAULT_MODEL.model,
    personas: LIVE_TEST_PERSONAS.map(({ id, routes }) => ({
      id,
      model: routes[0].model,
      fallbackModel: routes[1].model,
    })),
    playbooks: LIVE_TEST_PLAYBOOKS,
    holdScript: LIVE_TEST_HOLD_SCRIPT,
    holdReleaseFile: NodePath.join(testRepo, LIVE_TEST_HOLD_RELEASE_FILE),
    replayedThreads: replays.length,
    seedThreads: Object.keys(seed.threads).length,
  };
  writeManifest(manifestPath, manifest);
  return manifest;
});

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = args[1];
  if (
    args.length !== 2 ||
    args[0] !== "--root" ||
    root === undefined ||
    !NodePath.isAbsolute(root)
  ) {
    process.stderr.write("Usage: liveTestHome.ts --root <absolute directory>\n");
    process.exit(64);
  }
  Effect.runPromise(
    buildLiveTestHome({ root }).pipe(
      Effect.provide(Logger.layer([], { mergeWithExisting: false })),
    ),
  ).then(
    (manifest) => {
      process.stdout.write(`Built ${manifest.home}\n`);
      // The replay runtimes leave daemon fibers behind; everything is committed.
      process.exit(0);
    },
    (cause: unknown) => {
      process.stderr.write(
        `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
      );
      if (cause instanceof Error && cause.cause !== undefined) {
        process.stderr.write(`Caused by: ${String(cause.cause)}\n`);
      }
      process.stderr.write(
        `The build is incomplete. ${root} must be deleted before it runs again.\n`,
      );
      process.exit(1);
    },
  );
}
