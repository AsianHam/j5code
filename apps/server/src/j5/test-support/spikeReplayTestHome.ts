// @effect-diagnostics nodeBuiltinImport:off - throwaway spike, see #546.
/**
 * SPIKE (Jacksondr5/j5code#546), not shipped code. Builds a self-contained
 * test home without a model:
 *
 *   node apps/server/src/j5/test-support/spikeReplayTestHome.ts --base-dir <abs home> [--clock epoch]
 *
 * 1. `<base>/test-repo`: a scratch git repo with one commit and two playbooks.
 * 2. Registers it as a project through the offline `project add` CLI path.
 * 3. Replays recorded Claude and Codex fixtures into `<base>/userdata/statev2.sqlite`
 *    under that project, through upstream's provider replay kit.
 * 4. Writes a persona and default-model settings into the home.
 *
 * Run the delivery seed afterwards (scripts/j5/spike-replay-test-home.sh does).
 * The server that owns `<base>` must be stopped.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ClaudeOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../../orchestration-v2/testkit/fixtures/index.ts";
import {
  materializeFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "../../orchestration-v2/testkit/fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

/** [fixture, driver]. Chosen for variety in what the timeline has to render. */
const SCENARIOS: ReadonlyArray<readonly [string, "claudeAgent" | "codex"]> = [
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

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const baseDir = flag("--base-dir");
if (baseDir === undefined || !NodePath.isAbsolute(baseDir)) {
  throw new Error("Usage: --base-dir <absolute home> [--clock epoch|recent] [--only a,b]");
}
const clockMode = flag("--clock") ?? "recent";
const only = flag("--only")?.split(",");
const repoRoot = NodePath.resolve(import.meta.dirname, "../../../../..");
const serverBin = NodePath.join(repoRoot, "apps/server/src/bin.ts");
const testRepo = NodePath.join(baseDir, "test-repo");
const stateDir = NodePath.join(baseDir, "userdata");
const dbPath = NodePath.join(stateDir, "statev2.sqlite");

const timings: Array<{ step: string; ms: number; note?: string }> = [];
const timed = async <A>(step: string, run: () => Promise<A> | A): Promise<A> => {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    timings.push({ step, ms: Math.round(performance.now() - startedAt) });
  }
};

const git = (...gitArgs: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", gitArgs, { cwd: testRepo, stdio: "pipe" });

function makeTestRepo() {
  NodeFS.mkdirSync(NodePath.join(testRepo, ".j5/playbooks"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(testRepo, "README.md"),
    "# Live test repo\n\nA scratch repo.\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(testRepo, "todo.js"),
    "export const todos = [];\nexport const add = (title) => todos.push({ title, done: false });\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(testRepo, ".j5/playbooks/two-step.yaml"),
    [
      "title: Two step",
      "description: A trivial playbook for live tests.",
      "steps:",
      "  - id: first",
      "    title: First step",
      "    prompt: Say the word FIRST.",
      "  - id: second",
      "    title: Second step",
      "    prompt: Say the word SECOND.",
      "",
    ].join("\n"),
  );
  git("init", "-b", "main");
  git("config", "user.name", "J5 Live Test");
  git("config", "user.email", "live-test@example.com");
  git("add", ".");
  git("commit", "-m", "initial");
}

/** The offline `project add` path: the real ProjectService, no hand-written rows. */
function registerProject(): string {
  NodeChildProcess.execFileSync(
    process.execPath,
    [serverBin, "project", "add", testRepo, "--title", "Live test repo", "--base-dir", baseDir!],
    { cwd: testRepo, stdio: "pipe", env: cleanEnv() },
  );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT project_id FROM projection_projects WHERE workspace_root = ?")
      .get(testRepo) as { project_id: string } | undefined;
    if (row === undefined) throw new Error(`project add did not register ${testRepo}`);
    return row.project_id;
  } finally {
    db.close();
  }
}

function cleanEnv() {
  const { T3CODE_PORT: _port, T3CODE_HOST: _host, J5CODE_HOME: _home, ...env } = process.env;
  return env;
}

// Copied from OrchestratorReplayFixtures.integration.test.ts (runFixtureProvider),
// which is private to the test file. Differences: a file database, the project
// and cwd are ours, the clock can start now, and nothing is asserted.
// The fork and merge-back scenarios live in their own test files and are not
// in ORCHESTRATOR_REPLAY_FIXTURES, so they are not reachable from here.
const replayFixture = Effect.fn("spikeReplayFixture")(function* <
  Transcript extends ProviderReplayTranscript,
  Error,
>(input: {
  readonly fixtureName: string;
  readonly variant: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  readonly projectId: string;
  readonly startAtMs: number | undefined;
}) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === input.fixtureName)!;
  const recorded = yield* readProviderReplayTranscript(input.variant.transcriptFile).pipe(
    Effect.provide(NodeServices.layer),
  );
  const label = input.variant.transcriptEntriesThroughLabel;
  const cut =
    label === undefined
      ? recorded
      : {
          ...recorded,
          entries: recorded.entries.slice(
            0,
            recorded.entries.findIndex(
              (entry) => entry.type === "emit_inbound" && entry.label === label,
            ) + 1,
          ),
        };
  const withInstructions = materializeReplayTranscriptRuntimeInstructions(cut, {
    driver: input.variant.driver,
    model: input.variant.modelSelection.model,
  });
  const transcript = yield* input.harness.decodeTranscript(
    input.variant.driver === "codex"
      ? materializeReplayTranscriptWorkspace(withInstructions, testRepo)
      : withInstructions,
  );
  const materialized = yield* materializeFixtureInput({
    scenario: input.fixtureName,
    fixtureInput: fixture.buildInput(),
    driver: input.variant.driver,
    modelSelection: input.variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  // The fixture allocates a project id nobody creates; point its threads at ours.
  // Both drivers of a fixture share a title, so name the driver too.
  const retarget = <Command extends object>(command: Command): Command =>
    "projectId" in command && "title" in command
      ? {
          ...command,
          projectId: input.projectId,
          title: `${String(command.title)} (${input.variant.driver})`,
        }
      : command;
  const steps = materialized.steps.map((step) =>
    step.type === "dispatch" ? { ...step, command: retarget(step.command) } : step,
  );
  const scenario = {
    name: `${input.fixtureName}/${input.variant.driver}`,
    transcript,
    commands: materialized.commands.map(retarget),
    steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...input.variant.runtimePolicyOverride, cwd: testRepo },
  };
  const databaseLayer = SqlitePersistence.layerFromPath(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const result = yield* Effect.gen(function* () {
    if (input.startAtMs !== undefined) yield* TestClock.setTime(input.startAtMs);
    return yield* runOrchestratorV2ProviderReplayScenario(scenario, input.harness, {
      databaseLayer,
      ...(input.variant.runContinuationWorker === true ? { runContinuationWorker: true } : {}),
    });
  }).pipe(provideDeterministicTestRuntime);
  // The fixture's own assertOutput expects a database holding only its thread,
  // so it is not run here.
  const projection = result.projections.get(materialized.projectionThreadIds[0]!);
  const assertion = `runs: ${projection?.runs.map((run) => run.status).join(",") ?? "none"}`;
  return { threadIds: materialized.projectionThreadIds, assertion };
});

async function main() {
  const totalStartedAt = performance.now();
  NodeFS.mkdirSync(stateDir, { recursive: true });
  if (NodeFS.existsSync(dbPath)) throw new Error(`${dbPath} exists; start from an empty home.`);
  await timed("test repo", makeTestRepo);
  const projectId = await timed("project add (CLI, offline)", registerProject);

  const wanted = SCENARIOS.filter(([name]) => only === undefined || only.includes(name));
  const now = Date.now();
  const failures: Array<string> = [];
  for (const [index, [fixtureName, driver]] of wanted.entries()) {
    const variant = ORCHESTRATOR_REPLAY_FIXTURES.find(
      (entry) => entry.name === fixtureName,
    )?.providers.find((provider) => provider.driver === driver);
    if (variant === undefined) {
      failures.push(`${fixtureName}/${driver}: no such fixture variant`);
      continue;
    }
    // Spread the threads over the last few hours, oldest first.
    const startAtMs =
      clockMode === "epoch" ? undefined : now - (wanted.length - index) * 20 * 60 * 1000;
    const run = (
      driver === "codex"
        ? replayFixture({
            fixtureName,
            variant,
            harness: CodexOrchestratorReplayHarness,
            projectId,
            startAtMs,
          })
        : replayFixture({
            fixtureName,
            variant,
            harness: ClaudeOrchestratorReplayHarness,
            projectId,
            startAtMs,
          })
    ).pipe(Effect.scoped);
    const startedAt = performance.now();
    try {
      const outcome = await Effect.runPromise(run as Effect.Effect<{ assertion: string }, unknown>);
      timings.push({
        step: `replay ${fixtureName}/${driver}`,
        ms: Math.round(performance.now() - startedAt),
        note: outcome.assertion,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      failures.push(`${fixtureName}/${driver}: ${message.split("\n")[0]}`);
      timings.push({
        step: `replay ${fixtureName}/${driver}`,
        ms: Math.round(performance.now() - startedAt),
        note: "FAILED",
      });
    }
  }

  await timed("persona and settings", () => {
    // The server-wide default for new threads; a project can override it.
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "settings.json"),
      `${JSON.stringify(
        { defaultModelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5" } },
        null,
        2,
      )}\n`,
    );
    // With no agent-personas.json the library reads <stateDir>/personas/*.yaml.
    NodeFS.mkdirSync(NodePath.join(stateDir, "personas"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "personas/haiku-helper.yaml"),
      [
        "id: haiku-helper",
        "version: 1",
        "displayName: Haiku helper",
        "description: A light persona for live tests, pinned to Claude Haiku.",
        "authority:",
        "  defaultPolicy: full-access",
        "  allowedPolicies: [full-access]",
        "modelRoute:",
        "  - { driver: claudeAgent, model: claude-haiku-4-5, reasoningEffort: low }",
        "  - { driver: codex, model: gpt-6-luna, reasoningEffort: low }",
        "instructions: Answer in one short sentence.",
        "",
      ].join("\n"),
    );
  });

  const totalMs = Math.round(performance.now() - totalStartedAt);
  process.stdout.write(
    `${JSON.stringify({ baseDir, testRepo, projectId, clockMode, totalMs, timings, failures }, null, 2)}\n`,
  );
  // Replay runtimes leave daemon fibers behind; the work is committed.
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
