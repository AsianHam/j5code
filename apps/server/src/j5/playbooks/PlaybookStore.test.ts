import { seedPersonas, seedPlaybookOwners } from "./testFixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
import {
  J5_PLAYBOOK_WS_METHODS,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_RUNS_PAGE_SIZE,
  type PlaybookDefinition,
  type PlaybookProgress,
} from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { parse, stringify } from "yaml";

import { ServerConfig } from "../../config.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makePlaybookStore, type PlaybookMutation } from "./PlaybookStore.ts";
import { makePlaybookRpcHandlers, PLAYBOOK_RPC_SCOPES } from "./playbookRpc.ts";

const owner = ThreadId.make("thread:playbook:owner");
const otherOwner = ThreadId.make("thread:playbook:other");
const MemoryLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);
const definition = (ids = ["research", "implement", "review"]): PlaybookDefinition => ({
  title: "Test playbook",
  description: "Verify that an agent receives live ordered prompts.",
  steps: ids.map((id) => ({ id, title: `Step ${id}`, prompt: `Follow ${id}.` })),
});

const makeWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-test-" });
  const directory = path.join(workspaceRoot, ".j5", "playbooks");
  yield* fs.makeDirectory(directory, { recursive: true });
  const filename = (name: string) => path.join(directory, `${name}.yaml`);
  const write = (name: string, value = definition()) =>
    fs.writeFileString(filename(name), stringify(value));
  yield* write("demo");
  return { fs, path, workspaceRoot, filename, write };
});

const initializeStore = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([
    owner,
    otherOwner,
    "healthy-owner",
    ...Array.from({ length: PLAYBOOK_RUNS_PAGE_SIZE + 1 }, (_, index) => `owner-${index}`),
  ]);
  return yield* makePlaybookStore;
});

const makeFixture = Effect.gen(function* () {
  const workspace = yield* makeWorkspace;
  const store = yield* initializeStore;
  return { ...workspace, store };
});

it.effect(
  "publishes committed playbook changes during a turn and ignores failures and retries",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const snapshots = yield* Queue.unbounded<{
        revision: number;
        runs: ReadonlyArray<PlaybookProgress>;
      }>();
      const handlers = yield* makePlaybookRpcHandlers({
        store,
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.mock(ProjectService)({}), Layer.mock(ThreadManagementService)({})),
        ),
      );
      assert.equal(
        PLAYBOOK_RPC_SCOPES[J5_PLAYBOOK_WS_METHODS.subscribeChanges],
        AuthOrchestrationReadScope,
      );
      yield* handlers[J5_PLAYBOOK_WS_METHODS.subscribeChanges]().pipe(
        Stream.runForEach((revision) =>
          Effect.gen(function* () {
            const { runs } = yield* store.listForThread(owner);
            yield* Queue.offer(snapshots, { revision, runs });
          }),
        ),
        Effect.forkScoped,
      );
      assert.deepStrictEqual(yield* Queue.take(snapshots), { revision: 0, runs: [] });
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      const started = yield* Queue.take(snapshots);
      assert.equal(started.revision, 1);
      assert.equal(started.runs[0]?.runId, run.runId);
      assert.equal(started.runs[0]?.status, "active");
      yield* store.start(owner, workspaceRoot, "demo", "start");
      yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "duplicate"));
      yield* Effect.flip(
        store.mutate(otherOwner, {
          operation: "cancel",
          runId: run.runId,
          client_request_id: "foreign",
        }),
      );
      assert.deepStrictEqual(yield* Stream.runHead(store.changes), Option.some(1));

      const moves = [
        { operation: "next", expectedStepId: "research", step: "implement", status: "active" },
        { operation: "back", expectedStepId: "implement", step: "research", status: "active" },
        {
          operation: "reselect",
          expectedStepId: "research",
          stepId: "review",
          step: "review",
          status: "active",
        },
        { operation: "complete", expectedStepId: "review", step: "review", status: "completed" },
      ] as const;
      for (const [index, { step, status, ...movement }] of moves.entries()) {
        const input = { ...movement, runId: run.runId, client_request_id: `move-${index}` };
        yield* store.mutate(owner, input);
        const changed = yield* Queue.take(snapshots);
        assert.equal(changed.revision, index + 2);
        assert.equal(changed.runs[0]?.currentStepId, step);
        assert.equal(changed.runs[0]?.status, status);
        yield* store.mutate(owner, input);
        assert.deepStrictEqual(yield* Stream.runHead(store.changes), Option.some(index + 2));
      }
      const second = yield* store.start(owner, workspaceRoot, "demo", "second");
      assert.equal((yield* Queue.take(snapshots)).revision, 6);
      yield* store.mutate(owner, {
        operation: "cancel",
        runId: second.runId,
        client_request_id: "cancel",
      });
      const cancelled = yield* Queue.take(snapshots);
      assert.equal(cancelled.revision, 7);
      assert.equal(cancelled.runs[0]?.status, "cancelled");
      // A new subscriber receives the latest revision even if it missed the mutation.
      assert.deepStrictEqual(yield* Stream.runHead(store.changes), Option.some(7));
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "lists owners together, filters active runs, and reads shared live definitions once per page",
  () =>
    Effect.gen(function* () {
      const { workspaceRoot, fs, write, filename } = yield* makeFixture;
      let reads = 0;
      const store = yield* makePlaybookStore.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) => {
            reads += 1;
            return fs.readFileString(file, encoding);
          },
        }),
      );
      const first = yield* store.start(owner, workspaceRoot, "demo", "first");
      const second = yield* store.start(otherOwner, workspaceRoot, "demo", "second");
      yield* store.mutate(otherOwner, {
        operation: "complete",
        runId: second.runId,
        expectedStepId: "research",
        client_request_id: "finish",
      });
      reads = 0;
      const all = yield* store.listAll({});
      assert.equal(reads, 1);
      assert.equal(all.total, 2);
      assert.deepStrictEqual(
        all.runs.map((run) => run.runId),
        [first.runId, second.runId],
      );
      assert.deepStrictEqual(
        all.runs.map((run) => run.ownerThreadId),
        [owner, otherOwner],
      );
      assert.isFalse(all.runs.some((run) => "currentStep" in run || "replayed" in run));
      assert.isFalse(all.runs.some((run) => run.steps.some((step) => "prompt" in step)));
      const active = yield* store.listAll({ status: "active" });
      assert.equal(active.total, 1);
      assert.deepStrictEqual(
        active.runs.map((run) => run.runId),
        [first.runId],
      );
      yield* write("demo", { ...definition(), title: "Edited live" });
      assert.isTrue((yield* store.listAll({})).runs.every((run) => run.title === "Edited live"));
      yield* write("healthy");
      yield* store.start(ThreadId.make("healthy-owner"), workspaceRoot, "healthy", "healthy");
      yield* fs.writeFileString(filename("demo"), "title: [invalid");
      reads = 0;
      const broken = yield* store.listAll({});
      assert.equal(reads, 2);
      assert.equal(broken.runs.length, 3);
      assert.equal(broken.runs.filter((run) => run.issue?.code === "invalid_definition").length, 1);
      assert.equal(broken.runs.filter((run) => run.issue === null).length, 2);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("reads one definition for twenty thread runs on each request", () =>
  Effect.gen(function* () {
    const { workspaceRoot, fs, write, filename } = yield* makeFixture;
    let reads = 0;
    const store = yield* makePlaybookStore.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (file, encoding) => {
          reads += 1;
          return fs.readFileString(file, encoding);
        },
      }),
    );
    for (let index = 0; index < 20; index++) {
      const run = yield* store.start(owner, workspaceRoot, "demo", `start-${index}`);
      yield* store.mutate(owner, {
        operation: "complete",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: `complete-${index}`,
      });
    }
    reads = 0;
    const first = yield* store.listForThread(owner);
    assert.equal(first.runs.length, 20);
    assert.equal(reads, 1);
    assert.isFalse(first.runs.some((run) => "currentStep" in run));
    yield* write("demo", { ...definition(), title: "Changed title" });
    const second = yield* store.listForThread(owner);
    assert.equal(reads, 2);
    assert.isTrue(second.runs.every((run) => run.title === "Changed title"));
    yield* fs.writeFileString(filename("demo"), "title: [invalid");
    const broken = yield* store.listForThread(owner);
    assert.equal(reads, 3);
    assert.isTrue(broken.runs.every((run) => run.issue === null));
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("pages beyond 100 runs without losing older active owners", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const runs = yield* Effect.forEach(
      Array.from({ length: PLAYBOOK_RUNS_PAGE_SIZE + 1 }, (_, index) => index),
      (index) =>
        store.start(ThreadId.make(`owner-${index}`), workspaceRoot, "demo", `start-${index}`),
    );
    const first = yield* store.listAll({ status: "active" });
    const second = yield* store.listAll({ status: "active", offset: PLAYBOOK_RUNS_PAGE_SIZE });
    assert.equal(first.total, runs.length);
    assert.equal(second.total, runs.length);
    assert.equal(first.runs.length, PLAYBOOK_RUNS_PAGE_SIZE);
    assert.equal(second.runs.length, 1);
    assert.equal(
      new Set([...first.runs, ...second.runs].map((run) => run.runId)).size,
      runs.length,
    );
    assert.deepStrictEqual((yield* store.listAll({ offset: runs.length })).runs, []);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("retains sequential runs and permits a new run after completion or cancellation", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const first = yield* store.start(owner, workspaceRoot, "demo", "start-a");
    assert.equal(first.currentStep?.prompt, "Follow research.");
    assert.equal(first.position, 1);
    assert.equal(first.total, 3);
    assert.equal(first.ownerThreadId, owner);

    const replay = yield* store.start(owner, workspaceRoot, "demo.yaml", "start-a");
    assert.equal(replay.runId, first.runId);
    assert.isTrue(replay.replayed);
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "start-overlap"))).code,
      "already_active",
    );

    const completed = yield* store.mutate(owner, {
      operation: "complete",
      runId: first.runId,
      expectedStepId: "research",
      client_request_id: "complete-a",
    });
    assert.equal(completed.status, "completed");
    const second = yield* store.start(owner, workspaceRoot, "demo", "start-b");
    assert.notEqual(second.runId, first.runId);
    assert.equal((yield* store.current(owner)).runId, second.runId);
    const cancelled = yield* store.mutate(owner, {
      operation: "cancel",
      runId: second.runId,
      client_request_id: "cancel-b",
    });
    assert.equal(cancelled.status, "cancelled");
    const third = yield* store.start(owner, workspaceRoot, "demo", "start-c");
    assert.notEqual(third.runId, second.runId);
    assert.deepStrictEqual(
      (yield* store.listForThread(owner)).runs.map(({ runId, status }) => ({ runId, status })),
      [
        { runId: third.runId, status: "active" },
        { runId: second.runId, status: "cancelled" },
        { runId: first.runId, status: "completed" },
      ],
    );
    assert.equal((yield* store.current(owner, first.runId)).status, "completed");
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, {
          operation: "next",
          runId: first.runId,
          expectedStepId: "research",
          client_request_id: "next-terminal",
        }),
      )).code,
      "run_terminal",
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("reports each run's start and its end once, with how far it got", () =>
  Effect.gen(function* () {
    const recorded: Array<Readonly<Record<string, unknown>>> = [];
    yield* Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const finished = yield* store.start(owner, workspaceRoot, "demo", "start-a");
      // A retried start is the same run.
      yield* store.start(owner, workspaceRoot, "demo", "start-a");
      yield* store.mutate(owner, {
        operation: "next",
        runId: finished.runId,
        expectedStepId: "research",
        client_request_id: "next-a",
      });
      const complete = {
        operation: "complete",
        runId: finished.runId,
        expectedStepId: "implement",
        client_request_id: "complete-a",
      } as const;
      yield* store.mutate(owner, complete);
      yield* store.mutate(owner, complete);
      const abandoned = yield* store.start(owner, workspaceRoot, "demo", "start-b");
      yield* store.mutate(owner, {
        operation: "cancel",
        runId: abandoned.runId,
        client_request_id: "cancel-b",
      });
    }).pipe(
      Effect.provide(
        Layer.succeed(
          AnalyticsService,
          AnalyticsService.of({
            record: (event, properties = {}) =>
              Effect.sync(() => void recorded.push({ event, ...properties })),
            flush: Effect.void,
          }),
        ),
      ),
    );
    const started = {
      event: "j5.playbook.run.started",
      stepCount: 3,
      stepsWithPersona: 0,
      crewBound: false,
    };
    const ended = { event: "j5.playbook.run.finished", cause: "agent", crewBound: false };
    assert.deepStrictEqual(recorded, [
      started,
      // Completed from the second of three steps: moving between steps records nothing.
      { ...ended, outcome: "completed", stepCount: 3, position: 2, durationMs: 0 },
      started,
      { ...ended, outcome: "cancelled", stepCount: 3, position: 1, durationMs: 0 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "reads prompt edits live and navigates the latest order without changing the current ID",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, write } = yield* makeFixture;
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "next",
      });
      const edited = definition(["review", "implement", "research"]);
      yield* write("demo", {
        ...edited,
        description: "Updated purpose.",
        steps: edited.steps.map((step) =>
          step.id === "implement"
            ? { ...step, prompt: "Use the revised implementation instructions." }
            : step,
        ),
      });
      const current = yield* store.current(owner, run.runId);
      assert.equal(current.currentStepId, "implement");
      assert.equal(current.position, 2);
      assert.equal(current.description, "Updated purpose.");
      assert.equal(current.currentStep?.prompt, "Use the revised implementation instructions.");

      const next = yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "implement",
        client_request_id: "next-edited",
      });
      assert.equal(next.currentStepId, "research");
      assert.equal(next.position, 3);
      const back = yield* store.mutate(owner, {
        operation: "back",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "back-edited",
      });
      assert.equal(back.currentStep?.prompt, "Use the revised implementation instructions.");
      const board = (yield* store.listForThread(owner)).runs[0]!;
      assert.deepStrictEqual(
        board.steps.map(({ id }) => id),
        ["review", "implement", "research"],
      );
      assert.notProperty(board, "currentStep");
      assert.isFalse(board.steps.some((step) => "prompt" in step));
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("requires explicit recovery when the current step disappears", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    yield* write("demo", definition(["implement", "review"]));
    const missing = yield* Effect.flip(store.current(owner));
    assert.equal(missing.code, "step_missing");
    assert.include(missing.message, run.runId);
    assert.include(missing.message, "research");
    assert.include(missing.message, "j5_playbook_reselect");
    assert.deepStrictEqual(missing.availableStepIds, ["implement", "review"]);
    for (const operation of ["next", "back", "complete"] as const) {
      assert.equal(
        (yield* Effect.flip(
          store.mutate(owner, {
            operation,
            runId: run.runId,
            expectedStepId: "research",
            client_request_id: operation,
          }),
        )).code,
        "step_missing",
      );
    }
    const before = (yield* store.listForThread(owner)).runs[0]!;
    assert.equal(before.currentStepId, "research");
    assert.equal(before.status, "active");
    assert.isNull(before.position);
    assert.equal(before.issue?.code, "step_missing");
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, {
          operation: "reselect",
          runId: run.runId,
          expectedStepId: "research",
          stepId: "unknown",
          client_request_id: "invalid-reselect",
        }),
      )).code,
      "step_missing",
    );
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, {
          operation: "reselect",
          runId: run.runId,
          expectedStepId: "implement",
          stepId: "review",
          client_request_id: "stale-reselect",
        }),
      )).code,
      "step_conflict",
    );
    const recovered = yield* store.mutate(owner, {
      operation: "reselect",
      runId: run.runId,
      expectedStepId: "research",
      stepId: "review",
      client_request_id: "recover",
    });
    assert.equal(recovered.currentStepId, "review");
    assert.equal(recovered.position, 2);
    assert.equal(recovered.currentStep?.prompt, "Follow review.");
    assert.isNull(recovered.issue);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("preserves progress for invalid or missing YAML and always permits cancellation", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, fs, filename, write } = yield* makeFixture;
    for (const broken of ["invalid", "missing"] as const) {
      yield* write("demo");
      const run = yield* store.start(owner, workspaceRoot, "demo", `start-${broken}`);
      if (broken === "invalid") yield* fs.writeFileString(filename("demo"), "title: [broken");
      else yield* fs.remove(filename("demo"));
      assert.equal(
        (yield* Effect.flip(store.current(owner, run.runId))).code,
        "invalid_definition",
      );
      for (const operation of ["next", "back", "complete"] as const) {
        assert.equal(
          (yield* Effect.flip(
            store.mutate(owner, {
              operation,
              runId: run.runId,
              expectedStepId: "research",
              client_request_id: `${operation}-${broken}`,
            }),
          )).code,
          "invalid_definition",
        );
      }
      const board = (yield* store.listForThread(owner)).runs[0]!;
      assert.equal(board.currentStepId, "research");
      assert.equal(board.status, "active");
      assert.equal(board.issue?.code, "invalid_definition");
      const cancelled = yield* store.mutate(owner, {
        operation: "cancel",
        runId: run.runId,
        client_request_id: `cancel-${broken}`,
      });
      assert.equal(cancelled.status, "cancelled");
      assert.isNull(cancelled.issue);
      assert.equal((yield* store.current(owner, run.runId)).status, "cancelled");
    }
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "discovers malformed definitions without hiding valid files or creating invalid runs",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, fs, filename, path } = yield* makeFixture;
      const invalidFiles = {
        duplicate: stringify(definition(["research", "research"])),
        empty: stringify(definition([])),
        malformed: "title: [broken",
        "missing-prompt":
          "title: Missing prompt\ndescription: Invalid\nsteps:\n  - id: first\n    title: First\n",
      };
      for (const [name, content] of Object.entries(invalidFiles)) {
        yield* fs.writeFileString(filename(name), content);
      }
      const discovered = yield* store.discover(workspaceRoot);
      assert.deepStrictEqual(
        discovered.playbooks.map(({ name }) => name),
        ["demo", "duplicate", "empty", "malformed", "missing-prompt"],
      );
      assert.equal(discovered.playbooks[0]?.stepCount, 3);
      assert.isNull(discovered.playbooks[0]?.issue);
      for (const name of Object.keys(invalidFiles)) {
        assert.equal(
          discovered.playbooks.find((entry) => entry.name === name)?.issue?.code,
          "invalid_definition",
        );
        assert.equal(
          (yield* Effect.flip(store.start(owner, workspaceRoot, name, name))).code,
          "invalid_definition",
        );
      }
      assert.deepStrictEqual((yield* store.listForThread(owner)).runs, []);
      assert.deepStrictEqual(yield* store.discover(path.join(workspaceRoot, "empty-workspace")), {
        playbooks: [],
      });
      assert.equal(
        (yield* Effect.flip(store.start(owner, workspaceRoot, "../demo", "outside"))).code,
        "invalid_name",
      );
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "lists a misnamed file with a rename hint, refuses to start it, and still deletes it",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, fs, filename, write } = yield* makeFixture;
      yield* write("Release Plan");
      const entry = (yield* store.discover(workspaceRoot)).playbooks.find(
        ({ name }) => name === "Release Plan",
      );
      assert.equal(entry?.title, "Test playbook");
      assert.equal(entry?.issue?.code, "invalid_name");
      assert.include(entry?.issue?.message, "release-plan.yaml");
      assert.equal(
        (yield* Effect.flip(store.start(owner, workspaceRoot, "Release Plan", "misnamed"))).code,
        "invalid_name",
      );
      yield* store.removeDefinition(workspaceRoot, "Release Plan");
      assert.isFalse(yield* fs.exists(filename("Release Plan")));
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("rejects first and last step movement and stale back or completion requests", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    const firstBoundary = yield* Effect.flip(
      store.mutate(owner, {
        operation: "back",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "before-first",
      }),
    );
    assert.equal(firstBoundary.code, "step_boundary");
    assert.equal((yield* store.current(owner, run.runId)).currentStepId, "research");
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next-1",
    });
    for (const operation of ["next", "back", "complete"] as const) {
      assert.equal(
        (yield* Effect.flip(
          store.mutate(owner, {
            operation,
            runId: run.runId,
            expectedStepId: "research",
            client_request_id: `stale-${operation}`,
          }),
        )).code,
        "step_conflict",
      );
    }
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "next-2",
    });
    const lastBoundary = yield* Effect.flip(
      store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "review",
        client_request_id: "after-last",
      }),
    );
    assert.equal(lastBoundary.code, "step_boundary");
    assert.include(lastBoundary.message, "j5_playbook_complete");
    assert.equal((yield* store.current(owner, run.runId)).currentStepId, "review");
    assert.equal(
      (yield* store.mutate(owner, {
        operation: "complete",
        runId: run.runId,
        expectedStepId: "review",
        client_request_id: "complete",
      })).status,
      "completed",
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("serializes concurrent starts and advancement without double-advancing", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const starts = yield* Effect.all(
      ["start-1", "start-2"].map((key) =>
        store.start(owner, workspaceRoot, "demo", key).pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(starts.filter(Result.isSuccess).length, 1);
    assert.deepStrictEqual(
      starts.filter(Result.isFailure).map(({ failure }) => failure.code),
      ["already_active"],
    );
    const run = yield* store.current(owner);
    const results = yield* Effect.all(
      ["next-1", "next-2"].map((key) =>
        store
          .mutate(owner, {
            operation: "next",
            runId: run.runId,
            expectedStepId: "research",
            client_request_id: key,
          })
          .pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(results.filter(Result.isSuccess).length, 1);
    assert.deepStrictEqual(
      results.filter(Result.isFailure).map(({ failure }) => failure.code),
      ["step_conflict"],
    );
    assert.equal((yield* store.current(owner)).currentStepId, "implement");
    const retryInput = {
      operation: "next",
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "same-next",
    } as const;
    const retries = yield* Effect.all(
      [store.mutate(owner, retryInput), store.mutate(owner, retryInput)],
      {
        concurrency: "unbounded",
      },
    );
    assert.deepStrictEqual(retries.map(({ replayed }) => replayed).sort(), [false, true]);
    assert.equal((yield* store.current(owner)).currentStepId, "review");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("serializes concurrent back and completion requests", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    for (const operation of ["back", "complete"] as const) {
      const run = yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`);
      yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: `advance-${operation}`,
      });
      const results = yield* Effect.all(
        ["one", "two"].map((key) =>
          store
            .mutate(owner, {
              operation,
              runId: run.runId,
              expectedStepId: "implement",
              client_request_id: `${operation}-${key}`,
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Result.isSuccess).length, 1);
      assert.deepStrictEqual(
        results.filter(Result.isFailure).map(({ failure }) => failure.code),
        [operation === "back" ? "step_conflict" : "run_terminal"],
      );
      const current = yield* store.current(owner, run.runId);
      assert.equal(current.currentStepId, operation === "back" ? "research" : "implement");
      assert.equal(current.status, operation === "back" ? "active" : "completed");
      if (operation === "back") {
        yield* store.mutate(owner, {
          operation: "cancel",
          runId: run.runId,
          client_request_id: "cancel-back-run",
        });
      }
    }
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "isolates owners for every operation including another owner's successful request key",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "owned-next",
      });
      assert.equal((yield* Effect.flip(store.current(otherOwner, run.runId))).code, "not_owner");
      const mutations: ReadonlyArray<PlaybookMutation> = [
        {
          operation: "next",
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: "owned-next",
        },
        {
          operation: "back",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: "foreign-back",
        },
        {
          operation: "complete",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: "foreign-complete",
        },
        {
          operation: "reselect",
          runId: run.runId,
          expectedStepId: "implement",
          stepId: "review",
          client_request_id: "foreign-reselect",
        },
        { operation: "cancel", runId: run.runId, client_request_id: "foreign-cancel" },
      ];
      for (const input of mutations) {
        assert.equal((yield* Effect.flip(store.mutate(otherOwner, input))).code, "not_owner");
      }
      assert.deepStrictEqual((yield* store.listForThread(otherOwner)).runs, []);
      assert.equal((yield* store.current(owner, run.runId)).currentStepId, "implement");
      assert.equal((yield* store.current(owner, run.runId)).status, "active");
      const separate = yield* store.start(otherOwner, workspaceRoot, "demo", "start");
      assert.notEqual(separate.runId, run.runId);
      assert.equal(separate.ownerThreadId, otherOwner);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "persists progress and consumed request keys across back navigation and database restart",
  () =>
    Effect.gen(function* () {
      const { workspaceRoot, path, write } = yield* makeWorkspace;
      const databasePath = path.join(workspaceRoot, "state.sqlite");
      const runId = yield* Effect.gen(function* () {
        const store = yield* initializeStore;
        const run = yield* store.start(owner, workspaceRoot, "demo", "start");
        const next = {
          operation: "next",
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: "next",
        } as const;
        yield* store.mutate(owner, next);
        yield* store.mutate(owner, {
          operation: "back",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: "back",
        });
        const retried = yield* store.mutate(owner, next);
        assert.isTrue(retried.replayed);
        assert.equal(retried.currentStepId, "research");
        assert.equal((yield* store.current(owner, run.runId)).currentStepId, "research");
        assert.equal(
          (yield* Effect.flip(
            store.mutate(owner, {
              operation: "complete",
              runId: run.runId,
              expectedStepId: "research",
              client_request_id: "next",
            }),
          )).code,
          "request_conflict",
        );
        return run.runId;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

      yield* write("demo", {
        ...definition(),
        steps: definition().steps.map((step) => ({ ...step, prompt: `After restart: ${step.id}` })),
      });
      yield* Effect.gen(function* () {
        const store = yield* initializeStore;
        const current = yield* store.current(owner);
        assert.equal(current.runId, runId);
        assert.equal(current.currentStepId, "research");
        assert.equal(current.currentStep?.prompt, "After restart: research");
        const retry = yield* store.mutate(owner, {
          operation: "next",
          runId,
          expectedStepId: "research",
          client_request_id: "next",
        });
        assert.isTrue(retry.replayed);
        assert.equal(retry.currentStepId, "research");
        assert.equal(retry.currentStep?.prompt, "After restart: research");
        assert.equal((yield* store.current(owner)).currentStepId, "research");
        assert.equal((yield* store.listForThread(owner)).runs.length, 1);
        const moved = yield* store.mutate(owner, {
          operation: "next",
          runId,
          expectedStepId: "research",
          client_request_id: "new-next",
        });
        assert.equal(moved.currentStepId, "implement");
        const newStore = yield* makePlaybookStore;
        assert.equal((yield* newStore.current(owner, runId)).currentStepId, "implement");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "cancels deleted and missing owners before reads or deletion, while archived owners remain active",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, write, fs, filename } = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      yield* write("archived");
      const archived = yield* store.start(otherOwner, workspaceRoot, "archived", "archived");
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-09-23' WHERE thread_id = ${otherOwner}`;
      for (const entry of ["current", "thread", "active", "delete"] as const) {
        for (const missing of [false, true]) {
          yield* seedPlaybookOwners([owner]);
          yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${owner}`;
          yield* write("demo");
          const run = yield* store.start(owner, workspaceRoot, "demo", `${entry}-${missing}`);
          if (missing)
            yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${owner}`;
          else
            yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-09-23' WHERE thread_id = ${owner}`;
          if (entry === "current")
            assert.equal((yield* store.current(owner, run.runId)).status, "cancelled");
          if (entry === "thread")
            assert.equal((yield* store.listForThread(owner)).runs[0]?.status, "cancelled");
          if (entry === "active")
            assert.deepStrictEqual(
              (yield* store.listAll({ status: "active" })).runs.map((run) => run.runId),
              [archived.runId],
            );
          yield* store.removeDefinition(workspaceRoot, "demo");
          assert.isFalse(yield* fs.exists(filename("demo")));
          const history = yield* store.current(owner, run.runId);
          assert.equal(history.status, "cancelled");
          assert.isNull(history.issue);
          yield* write("demo");
          assert.equal(
            (yield* Effect.flip(
              store.start(owner, workspaceRoot, "demo", `deleted-${entry}-${missing}`),
            )).code,
            "thread_not_found",
          );
        }
      }
      assert.equal((yield* store.current(otherOwner, archived.runId)).status, "active");
      assert.equal(
        (yield* Effect.flip(store.removeDefinition(workspaceRoot, "archived"))).code,
        "in_use",
      );
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("keeps completed and cancelled history warning-free after steps or files disappear", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write, fs, filename } = yield* makeFixture;
    for (const operation of ["complete", "cancel"] as const) {
      yield* write("demo");
      const run = yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`);
      yield* store.mutate(owner, {
        operation,
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: operation,
      });
      yield* write("demo", definition(["review"]));
      assert.isNull((yield* store.current(owner, run.runId)).issue);
      yield* fs.remove(filename("demo"));
      assert.isNull((yield* store.current(owner, run.runId)).issue);
      assert.isTrue((yield* store.listForThread(owner)).runs.every((run) => run.issue === null));
      assert.isTrue((yield* store.listAll({})).runs.every((run) => run.issue === null));
    }
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "prunes movement receipts only after termination and preserves start and finish retries",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      for (const operation of ["complete", "cancel"] as const) {
        const run = yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`);
        const next = {
          operation: "next",
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: `next-${operation}`,
        } as const;
        yield* store.mutate(owner, next);
        yield* store.mutate(owner, {
          operation: "back",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: `back-${operation}`,
        });
        assert.isTrue((yield* store.mutate(owner, next)).replayed);
        assert.equal(
          (yield* sql`SELECT * FROM j5_playbook_request WHERE run_id = ${run.runId}`).length,
          3,
        );
        const finish = {
          operation,
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: operation,
        } as const;
        yield* store.mutate(owner, finish);
        assert.equal(
          (yield* sql`SELECT * FROM j5_playbook_request WHERE run_id = ${run.runId}`).length,
          2,
        );
        assert.isTrue((yield* store.mutate(owner, finish)).replayed);
        assert.equal(
          (yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`)).runId,
          run.runId,
        );
        assert.equal((yield* Effect.flip(store.mutate(owner, next))).code, "run_terminal");
      }
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("reads YAML outside SQL transactions and rechecks the pointer after the read", () =>
  Effect.gen(function* () {
    const { workspaceRoot, fs } = yield* makeFixture;
    const sql = yield* SqlClient.SqlClient;
    let moveDuringRead = false;
    const store = yield* makePlaybookStore.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (file, encoding) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
            if (moveDuringRead) {
              moveDuringRead = false;
              yield* sql`UPDATE j5_playbook_run SET current_step_id = 'review' WHERE owner_thread_id = ${owner}`;
            }
            return yield* fs.readFileString(file, encoding);
          }),
      }),
    );
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    yield* store.start(owner, workspaceRoot, "demo", "start");
    const next = {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next",
    } as const;
    yield* store.mutate(owner, next);
    yield* store.mutate(owner, next);
    moveDuringRead = true;
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, { ...next, expectedStepId: "implement", client_request_id: "stale" }),
      )).code,
      "step_conflict",
    );
    assert.equal((yield* store.current(owner)).currentStepId, "review");
    yield* store.mutate(owner, {
      operation: "cancel",
      runId: run.runId,
      client_request_id: "cancel",
    });
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("enforces the shared byte and step limits at their boundaries", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, fs, filename, write } = yield* makeFixture;
    const ids = Array.from({ length: PLAYBOOK_MAX_STEPS }, (_, index) => `step-${index}`);
    yield* write("demo", definition(ids));
    assert.isNull((yield* store.discover(workspaceRoot)).playbooks[0]?.issue);
    yield* write("demo", definition([...ids, "too-many"]));
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "steps"))).code,
      "invalid_definition",
    );
    const yaml = stringify(definition()) + "#";
    yield* fs.writeFileString(filename("demo"), yaml.padEnd(PLAYBOOK_MAX_BYTES, " "));
    assert.isNull((yield* store.discover(workspaceRoot)).playbooks[0]?.issue);
    yield* fs.writeFileString(filename("demo"), yaml.padEnd(PLAYBOOK_MAX_BYTES + 1, " "));
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "bytes"))).code,
      "invalid_definition",
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("exports the stem file name and a YAML body that imports back unchanged", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename, write } = yield* makeFixture;
    const original: PlaybookDefinition = {
      title: "Title that is not the file name",
      description: "Colons: quotes \" and 'apostrophes' # not a comment",
      steps: [
        { id: "b-first", title: "Second alphabetically", prompt: "  leading and trailing  \n" },
        { id: "a-second", title: "Multiline", prompt: "Line one\n\nLine three: yes\n- not a list" },
      ],
    };
    yield* write("stem", original);
    const exported = yield* store.exportDefinition(workspaceRoot, "stem");
    assert.equal(exported.fileName, "stem.yaml");
    assert.notInclude(exported.fileName, "Title");
    // Importing writes the exported bytes under the file's stem, so the copy must decode identically.
    yield* fs.writeFileString(filename("copy"), exported.yaml);
    assert.deepStrictEqual(parse(exported.yaml), original);
    assert.deepStrictEqual(
      parse(yield* fs.readFileString(filename("copy"))),
      parse(yield* fs.readFileString(filename("stem"))),
    );
    const copy = (yield* store.discover(workspaceRoot)).playbooks.find(
      ({ name }) => name === "copy",
    );
    assert.isNull(copy?.issue);
    assert.deepStrictEqual(
      copy?.steps.map(({ id }) => id),
      ["b-first", "a-second"],
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("rejects exports of missing, misnamed, and invalid definitions", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename } = yield* makeFixture;
    const code = (name: string) =>
      store.exportDefinition(workspaceRoot, name).pipe(
        Effect.flip,
        Effect.map((error) => (error as { code?: string }).code),
      );
    assert.equal(yield* code("missing"), "not_found");
    assert.equal(yield* code("../demo"), "invalid_name");
    yield* fs.writeFileString(filename("broken"), "title: [broken");
    assert.equal(yield* code("broken"), "invalid_definition");
    yield* fs.writeFileString(
      filename("dupes"),
      stringify({
        ...definition(["same", "same"]),
      }),
    );
    assert.equal(yield* code("dupes"), "invalid_definition");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("keeps the workspace path out of export read failures", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename } = yield* makeFixture;
    yield* fs.writeFileString(filename("broken"), "title: [broken");
    const error = yield* store.exportDefinition(workspaceRoot, "broken").pipe(Effect.flip);
    assert.equal((error as { code?: string }).code, "invalid_definition");
    assert.notInclude(error.message, workspaceRoot);
    assert.notInclude(error.message, "cancellation");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("exports a near-limit definition byte-for-byte so it stays importable", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename } = yield* makeFixture;
    const source = `title: Demo\ndescription: Demo\nsteps:\n- id: one\n  title: One\n  prompt: "${"word ".repeat(50000)}end"\n`;
    assert.isBelow(Buffer.byteLength(source), PLAYBOOK_MAX_BYTES);
    yield* fs.writeFileString(filename("big"), source);
    const exported = yield* store.exportDefinition(workspaceRoot, "big");
    assert.equal(exported.yaml, source);
    assert.isAtMost(Buffer.byteLength(exported.yaml), PLAYBOOK_MAX_BYTES);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("refuses to export a playbook symlinked outside the workspace", () =>
  Effect.gen(function* () {
    const { fs, path, store, workspaceRoot, filename } = yield* makeFixture;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-outside-" });
    const target = path.join(outside, "secret.yaml");
    yield* fs.writeFileString(target, stringify(definition()));
    yield* fs.symlink(target, filename("leak"));
    const error = yield* store.exportDefinition(workspaceRoot, "leak").pipe(Effect.flip);
    assert.equal((error as { code?: string }).code, "invalid_path");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

// A real environment catalog on a temp state directory, as the running server reads it.
const CatalogLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "j5-playbook-personas-",
}).pipe(Layer.provideMerge(MemoryLayer));
const staffed = (): PlaybookDefinition => ({
  ...definition(),
  steps: [
    { id: "research", title: "Research", prompt: "Follow research.", persona: "planner" },
    { id: "implement", title: "Implement", prompt: "Follow implement.", persona: "builder-bot" },
    { id: "review", title: "Review", prompt: "Follow review." },
  ],
});

it.effect("reads a definition without personas exactly as before, with no warnings", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.deepStrictEqual(entry?.warnings, []);
    assert.deepStrictEqual(entry?.steps, [
      { id: "research", title: "Step research" },
      { id: "implement", title: "Step implement" },
      { id: "review", title: "Step review" },
    ]);
    const read = yield* store.read(workspaceRoot, "demo.yaml");
    assert.deepStrictEqual(read, { name: "demo", ...definition(), warnings: [] });
    assert.isFalse(read.steps.some((step) => "persona" in step));
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("returns step personas from discover, read, and every step tool", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    yield* seedPersonas([
      { id: "planner", enabled: true },
      { id: "builder-bot", enabled: true },
    ]);
    yield* write("demo", staffed());
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.deepStrictEqual(entry?.steps, [
      { id: "research", title: "Research", persona: "planner" },
      { id: "implement", title: "Implement", persona: "builder-bot" },
      { id: "review", title: "Review" },
    ]);
    assert.deepStrictEqual(entry?.warnings, []);
    assert.deepStrictEqual((yield* store.read(workspaceRoot, "demo")).steps, staffed().steps);

    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    assert.equal(run.currentStep?.persona, "planner");
    assert.equal((yield* store.current(owner)).currentStep?.persona, "planner");
    const next = yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next",
    });
    assert.equal(next.currentStep?.persona, "builder-bot");
    const back = yield* store.mutate(owner, {
      operation: "back",
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "back",
    });
    assert.equal(back.currentStep?.persona, "planner");
    const reselected = yield* store.mutate(owner, {
      operation: "reselect",
      runId: run.runId,
      expectedStepId: "research",
      stepId: "implement",
      client_request_id: "reselect",
    });
    assert.equal(reselected.currentStep?.persona, "builder-bot");
    // Progress on the board stays titles only.
    assert.deepStrictEqual(reselected.steps[0], { id: "research", title: "Research" });
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("warns about a disabled or missing persona without invalidating the definition", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    yield* seedPersonas([{ id: "planner", enabled: false }]);
    yield* write("demo", staffed());
    const expected = [
      {
        code: "persona_disabled",
        stepId: "research",
        persona: "planner",
        message: `Step "research" names persona "planner", which is turned off.`,
      },
      {
        code: "persona_missing",
        stepId: "implement",
        persona: "builder-bot",
        message: `Step "implement" names persona "builder-bot", which is not in this environment's library.`,
      },
    ];
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.isNull(entry?.issue);
    assert.deepStrictEqual(entry?.warnings, expected);
    const read = yield* store.read(workspaceRoot, "demo");
    assert.deepStrictEqual(read.warnings, expected);
    assert.equal((yield* store.start(owner, workspaceRoot, "demo", "start")).status, "active");
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("reports personas as unverified when the catalog cannot be read", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write, fs, path } = yield* makeFixture;
    const { stateDir } = yield* ServerConfig;
    // An invalid file in the default persona folder fails every catalog read.
    yield* fs.makeDirectory(path.join(stateDir, "personas"));
    yield* fs.writeFileString(path.join(stateDir, "personas/broken.yaml"), "id: [");
    yield* write("demo", staffed());
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.isNull(entry?.issue);
    assert.deepStrictEqual(
      entry?.warnings?.map(({ code, stepId }) => [code, stepId]),
      [
        ["persona_unverified", "research"],
        ["persona_unverified", "implement"],
      ],
    );
    assert.include(entry?.warnings?.[0]?.message, "could not be checked");
    assert.lengthOf((yield* store.read(workspaceRoot, "demo")).warnings, 2);
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("reads a playbook without creating a run or moving an active one", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next",
    });
    const revision = yield* Stream.runHead(store.changes);
    const runs = (yield* store.listForThread(owner)).runs.length;
    const read = yield* store.read(workspaceRoot, "demo");
    assert.deepStrictEqual(
      read.steps.map(({ prompt }) => prompt),
      ["Follow research.", "Follow implement.", "Follow review."],
    );
    assert.equal((yield* store.current(owner)).currentStepId, "implement");
    assert.lengthOf((yield* store.listForThread(owner)).runs, runs);
    assert.deepStrictEqual(yield* Stream.runHead(store.changes), revision);
    assert.equal((yield* Effect.flip(store.read(workspaceRoot, "absent"))).code, "not_found");
    assert.equal((yield* Effect.flip(store.read(workspaceRoot, "../demo"))).code, "invalid_name");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "moves its revision for each change a run's views show, and for no read that changed nothing",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, path, write } = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      const revision = store.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      /** Runs a store call and says how far it moved the revision. */
      const moved = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const before = yield* revision;
          yield* effect;
          return (yield* revision) - before;
        });

      // A playbook's title is shown on every run of it, active or finished.
      assert.equal(yield* moved(store.renameDefinition(workspaceRoot, "demo", "Renamed")), 1);
      assert.equal(yield* moved(store.renameDefinition(workspaceRoot, "demo", "Renamed")), 0);
      yield* write("unused");
      assert.equal(yield* moved(store.removeDefinition(workspaceRoot, "unused")), 1);
      assert.equal(yield* moved(Effect.flip(store.removeDefinition(workspaceRoot, "unused"))), 0);

      // A Crew-linked run's landing gets its target once; Fleet shows the seat it is headed to.
      assert.deepStrictEqual(yield* store.activeDefinitionDirectories(), []);
      const run = yield* store.start(owner, workspaceRoot, "demo", "start", {
        crewInstanceId: "crew:watch",
      });
      assert.deepStrictEqual(yield* store.activeDefinitionDirectories(), [
        path.join(workspaceRoot, ".j5", "playbooks"),
      ]);
      const target = { seat: "builder", threadId: "thread:builder" };
      assert.equal(yield* moved(store.targetLanding(run.runId, "start", target)), 1);
      assert.equal(
        yield* moved(store.targetLanding(run.runId, "start", { seat: null, threadId: "thread:x" })),
        0,
        "a later call keeps the first target",
      );

      // Reads cancel a run whose owner is gone. One that cancelled nothing moves nothing, or every
      // read would cause the next.
      assert.equal(yield* moved(store.listAll({})), 0);
      assert.equal(yield* moved(store.listForThread(owner)), 0);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-09-23' WHERE thread_id = ${owner}`;
      assert.equal(yield* moved(store.listAll({})), 1);
      assert.equal(yield* moved(store.listAll({})), 0);
      assert.deepStrictEqual(yield* store.activeDefinitionDirectories(), []);

      // A file changed on disk is said by whoever watches it.
      assert.equal(yield* moved(store.definitionsChanged), 1);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);
