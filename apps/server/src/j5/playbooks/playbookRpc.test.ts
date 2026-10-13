import { seedPlaybookOwners } from "./testFixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import { J5_PLAYBOOK_WS_METHODS, type PlaybookError } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { stringify } from "yaml";

import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import {
  emptyProjection,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makePlaybookStore, playbookError } from "./PlaybookStore.ts";
import { makePlaybookRpcHandlers, PLAYBOOK_RPC_SCOPES } from "./playbookRpc.ts";

const projectId = ProjectId.make("project:playbook-rpc");
const otherProjectId = ProjectId.make("project:playbook-rpc-other");
const missingProjectId = ProjectId.make("project:playbook-rpc-missing");
const deletedProjectId = ProjectId.make("project:playbook-rpc-deleted");
const worktreeThread = ThreadId.make("thread:playbook-rpc-worktree");
const rootThread = ThreadId.make("thread:playbook-rpc-root");
const foreignThread = ThreadId.make("thread:playbook-rpc-foreign");
const deletedThread = ThreadId.make("thread:playbook-rpc-deleted");
const missingThread = ThreadId.make("thread:playbook-rpc-missing");
const unavailableThread = ThreadId.make("thread:playbook-rpc-read-failed");
const owner = ThreadId.make("thread:playbook-rpc:owner");
const otherOwner = ThreadId.make("thread:playbook-rpc:other");
const createdAt = "2026-09-21T09:00:00.000Z";
const TestLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);

const definition = (title: string) => ({
  title,
  description: `Purpose of ${title}.`,
  steps: [{ id: "first", title: "First step", prompt: "Line one\n\nLine three: yes\n" }],
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-rpc-" });
  const projectRoot = path.join(directory, "project");
  const worktree = path.join(directory, "worktree");
  for (const [root, title] of [
    [projectRoot, "Project library"],
    [worktree, "Worktree library"],
  ] as const) {
    yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, ".j5/playbooks/demo.yaml"),
      stringify(definition(title)),
    );
  }
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners(["delete-owner", "rename-owner", owner, otherOwner]);
  const store = yield* makePlaybookStore;
  const projects = Layer.mock(ProjectService)({
    getById: (id) =>
      Effect.succeed(
        id === missingProjectId
          ? Option.none()
          : Option.some({
              id,
              title: "Library project",
              workspaceRoot: projectRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
              deletedAt: id === deletedProjectId ? createdAt : null,
            }),
      ),
  });
  const threads = Layer.mock(ThreadManagementService)({
    getThreadProjection: (threadId) => {
      if (threadId === missingThread || threadId === unavailableThread) {
        return Effect.fail(
          new OrchestratorProjectionError({
            threadId,
            cause:
              threadId === missingThread
                ? new ProjectionStoreThreadNotFoundError({ threadId })
                : new Error("Projection database unavailable"),
          }),
        );
      }
      return Effect.succeed(
        emptyProjection({
          id: EventId.make(`created:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: DateTime.makeUnsafe(createdAt),
          payload: {
            id: threadId,
            projectId: threadId === foreignThread ? otherProjectId : projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Export test",
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: threadId === rootThread ? null : worktree,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: DateTime.makeUnsafe(createdAt),
            updatedAt: DateTime.makeUnsafe(createdAt),
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            lastVisitedAt: null,
            deletedAt: threadId === deletedThread ? DateTime.makeUnsafe(createdAt) : null,
          },
        }),
      );
    },
  });
  const handlersFor = (served: Parameters<typeof makePlaybookRpcHandlers>[0]["store"]) =>
    makePlaybookRpcHandlers({ store: served }).pipe(Effect.provide(Layer.merge(projects, threads)));
  const handlers = yield* handlersFor(store);
  const exportPlaybook = (input: { projectId: ProjectId; threadId?: ThreadId; name: string }) =>
    handlers[J5_PLAYBOOK_WS_METHODS.exportPlaybook](input);
  const deletePlaybook = (input: { projectId: ProjectId; threadId?: ThreadId; name: string }) =>
    handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook](input);
  const renamePlaybook = (input: { projectId: ProjectId; name: string; title: string }) =>
    handlers[J5_PLAYBOOK_WS_METHODS.renamePlaybook](input);
  const filename = (root: string, name = "demo") =>
    path.join(root, ".j5/playbooks", `${name}.yaml`);
  const readLibrary = handlers[J5_PLAYBOOK_WS_METHODS.readLibrary];
  const listThreadRuns = (threadId: ThreadId) =>
    handlers[J5_PLAYBOOK_WS_METHODS.listThreadRuns]({ threadId });
  const listRuns = handlers[J5_PLAYBOOK_WS_METHODS.listRuns];
  /** One run each for two owners of a two-phase playbook whose prompts must never be read out. */
  const startPhasedRuns = Effect.gen(function* () {
    yield* fs.writeFileString(
      filename(projectRoot, "phases"),
      stringify({
        title: "Phased sample",
        description: "Inspect progress from a connected client.",
        steps: [
          { id: "one", title: "First phase", prompt: "PRIVATE_FIRST_PROMPT" },
          { id: "two", title: "Second phase", prompt: "PRIVATE_SECOND_PROMPT" },
        ],
      }),
    );
    return {
      run: yield* store.start(owner, projectRoot, "phases", "start-owner"),
      other: yield* store.start(otherOwner, projectRoot, "phases", "start-other"),
    };
  });
  return {
    exportPlaybook,
    deletePlaybook,
    renamePlaybook,
    readLibrary,
    listThreadRuns,
    listRuns,
    startPhasedRuns,
    handlersFor,
    store,
    fs,
    filename,
    projectRoot,
    worktree,
  };
});

const codeOf = <A>(call: Effect.Effect<A, { readonly code: string }>) =>
  call.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

it("requires operate scope to delete or rename a playbook", () => {
  for (const method of [
    J5_PLAYBOOK_WS_METHODS.deletePlaybook,
    J5_PLAYBOOK_WS_METHODS.renamePlaybook,
  ]) {
    assert.equal(requiredScopeForRpcMethod(method), AuthOrchestrationOperateScope);
    assert.equal(PLAYBOOK_RPC_SCOPES[method], AuthOrchestrationOperateScope);
  }
});

it("requires read scope to read the library and runs, and to export a playbook", () => {
  for (const method of [
    J5_PLAYBOOK_WS_METHODS.readLibrary,
    J5_PLAYBOOK_WS_METHODS.listThreadRuns,
    J5_PLAYBOOK_WS_METHODS.listRuns,
    J5_PLAYBOOK_WS_METHODS.exportPlaybook,
  ]) {
    assert.equal(requiredScopeForRpcMethod(method), AuthOrchestrationReadScope);
    assert.equal(PLAYBOOK_RPC_SCOPES[method], AuthOrchestrationReadScope);
  }
});

/** What a client can see of a read: its JSON, where no step prompt may appear. */
const assertPromptFree = (value: unknown, prompts: ReadonlyArray<string>) => {
  const text = JSON.stringify(value);
  for (const prompt of [...prompts, '"prompt"', '"currentStep"']) assert.notInclude(text, prompt);
};
const phasePrompts = ["PRIVATE_FIRST_PROMPT", "PRIVATE_SECOND_PROMPT"];

it.effect("reads the project's or the thread worktree's library without creating any run", () =>
  Effect.gen(function* () {
    const { projectRoot, worktree, readLibrary } = yield* fixture;
    const project = yield* readLibrary({ projectId });
    assert.equal(project.workspaceRoot, projectRoot);
    assert.equal(project.playbooks[0]?.title, "Project library");
    const thread = yield* readLibrary({ projectId, threadId: worktreeThread });
    assert.equal(thread.workspaceRoot, worktree);
    assert.equal(thread.playbooks[0]?.title, "Worktree library");
    const root = yield* readLibrary({ projectId, threadId: rootThread });
    assert.equal(root.workspaceRoot, projectRoot);
    assert.equal(root.playbooks[0]?.title, "Project library");
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM j5_playbook_run`;
    assert.equal(rows[0]?.count, 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("refuses a library read of a missing, deleted, or mismatched workspace", () =>
  Effect.gen(function* () {
    const { readLibrary } = yield* fixture;
    for (const input of [
      { projectId: missingProjectId },
      { projectId: deletedProjectId },
      { projectId, threadId: missingThread },
      { projectId, threadId: deletedThread },
      { projectId, threadId: foreignThread },
    ]) {
      const error = yield* readLibrary(input).pipe(Effect.flip);
      assert.deepStrictEqual(
        { code: error.code, message: error.message },
        {
          code: "workspace_not_found",
          message: "This project or thread workspace is no longer available.",
        },
        JSON.stringify(input),
      );
    }
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps an unexpected projection failure distinct from a missing workspace", () =>
  Effect.gen(function* () {
    const { readLibrary } = yield* fixture;
    const error = yield* readLibrary({ projectId, threadId: unavailableThread }).pipe(Effect.flip);
    assert.deepStrictEqual(
      { code: error.code, message: error.message },
      { code: "operation_failed", message: "Could not resolve the workspace." },
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("shows invalid definitions and live edits while returning only library metadata", () =>
  Effect.gen(function* () {
    const { fs, filename, projectRoot, readLibrary } = yield* fixture;
    yield* fs.writeFileString(filename(projectRoot, "broken"), "title: [broken");
    const initial = yield* readLibrary({ projectId });
    assert.deepStrictEqual(
      initial.playbooks.map(({ name }) => name),
      ["broken", "demo"],
    );
    assert.equal(initial.playbooks[0]?.issue?.code, "invalid_definition");
    assert.isNull(initial.playbooks[1]?.issue);
    yield* fs.writeFileString(
      filename(projectRoot),
      stringify({
        title: "Renamed live",
        description: "Updated purpose.",
        steps: [
          { id: "revised", title: "Revised phase", prompt: "PRIVATE_REVISED_PROMPT" },
          { id: "finish", title: "Finish phase", prompt: "PRIVATE_FINISH_PROMPT" },
        ],
      }),
    );
    const refreshed = yield* readLibrary({ projectId });
    const changed = refreshed.playbooks.find(({ name }) => name === "demo")!;
    assert.equal(changed.title, "Renamed live");
    assert.equal(changed.description, "Updated purpose.");
    assert.equal(changed.stepCount, 2);
    assert.deepStrictEqual(changed.steps, [
      { id: "revised", title: "Revised phase" },
      { id: "finish", title: "Finish phase" },
    ]);
    assertPromptFree(refreshed, ["PRIVATE_REVISED_PROMPT", "PRIVATE_FINISH_PROMPT"]);
    yield* fs.remove(filename(projectRoot, "broken"));
    yield* fs.remove(filename(projectRoot));
    assert.deepStrictEqual((yield* readLibrary({ projectId })).playbooks, []);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("lists every owner's runs, prompt-free, and only the active ones when asked", () =>
  Effect.gen(function* () {
    const { store, listRuns, startPhasedRuns } = yield* fixture;
    const { run, other } = yield* startPhasedRuns;
    const all = yield* listRuns({});
    assert.equal(all.total, 2);
    assert.deepStrictEqual(
      new Set(all.runs.map((entry) => entry.runId)),
      new Set([run.runId, other.runId]),
    );
    assert.deepStrictEqual(
      new Set(all.runs.map((entry) => entry.ownerThreadId)),
      new Set([owner, otherOwner]),
    );
    assertPromptFree(all, phasePrompts);
    yield* store.mutate(owner, {
      operation: "complete",
      runId: run.runId,
      expectedStepId: "one",
      client_request_id: "finish",
    });
    const active = yield* listRuns({ status: "active", offset: 0 });
    assert.equal(active.total, 1);
    assert.equal(active.runs[0]?.runId, other.runId);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("returns each thread's live phase progress without any prompt bodies", () =>
  Effect.gen(function* () {
    const { store, listThreadRuns, startPhasedRuns } = yield* fixture;
    const { run, other } = yield* startPhasedRuns;
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "one",
      client_request_id: "next",
    });
    const first = yield* listThreadRuns(owner);
    const second = yield* listThreadRuns(otherOwner);
    assert.equal(first.runs.length, 1);
    assert.equal(first.runs[0]?.runId, run.runId);
    assert.equal(first.runs[0]?.currentStepId, "two");
    assert.equal(first.runs[0]?.position, 2);
    assert.deepStrictEqual(first.runs[0]?.steps, [
      { id: "one", title: "First phase" },
      { id: "two", title: "Second phase" },
    ]);
    assert.equal(second.runs.length, 1);
    assert.equal(second.runs[0]?.runId, other.runId);
    assert.equal(second.runs[0]?.currentStepId, "one");
    assert.deepStrictEqual((yield* listThreadRuns(ThreadId.make("thread:unknown"))).runs, []);
    assertPromptFree(first, phasePrompts);

    yield* store.mutate(owner, {
      operation: "complete",
      runId: run.runId,
      expectedStepId: "two",
      client_request_id: "complete",
    });
    assert.equal((yield* listThreadRuns(owner)).runs[0]?.status, "completed");
    assert.equal((yield* listThreadRuns(otherOwner)).runs[0]?.status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps a run whose definition broke visible, and reflects its cancellation", () =>
  Effect.gen(function* () {
    const { fs, filename, projectRoot, store, listThreadRuns, startPhasedRuns } = yield* fixture;
    const { run } = yield* startPhasedRuns;
    yield* fs.writeFileString(filename(projectRoot, "phases"), "title: [invalid");
    const broken = (yield* listThreadRuns(owner)).runs[0]!;
    assert.equal(broken.status, "active");
    assert.equal(broken.currentStepId, "one");
    assert.equal(broken.issue?.code, "invalid_definition");
    assert.deepStrictEqual(broken.steps, []);
    yield* store.mutate(owner, {
      operation: "cancel",
      runId: run.runId,
      client_request_id: "cancel",
    });
    const cancelled = (yield* listThreadRuns(owner)).runs[0]!;
    assert.equal(cancelled.status, "cancelled");
    assert.isNull(cancelled.issue);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("exports the project or thread worktree definition as its stem file", () =>
  Effect.gen(function* () {
    const { exportPlaybook } = yield* fixture;
    const project = yield* exportPlaybook({ projectId, name: "demo" });
    assert.equal(project.fileName, "demo.yaml");
    assert.include(project.yaml, "Project library");
    const worktree = yield* exportPlaybook({ projectId, threadId: worktreeThread, name: "demo" });
    assert.include(worktree.yaml, "Worktree library");
    const root = yield* exportPlaybook({ projectId, threadId: rootThread, name: "demo" });
    assert.include(root.yaml, "Project library");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("rejects missing, foreign, and deleted workspaces and bad names", () =>
  Effect.gen(function* () {
    const { exportPlaybook } = yield* fixture;
    const code = (input: Parameters<typeof exportPlaybook>[0]) =>
      exportPlaybook(input).pipe(
        Effect.flip,
        Effect.map((error) => (error as { code?: string }).code),
      );
    for (const input of [
      { projectId: missingProjectId, name: "demo" },
      { projectId, threadId: foreignThread, name: "demo" },
      { projectId, threadId: deletedThread, name: "demo" },
      { projectId, threadId: missingThread, name: "demo" },
    ])
      assert.equal(yield* code(input), "workspace_not_found");
    assert.equal(yield* code({ projectId, name: "../demo" }), "invalid_name");
    assert.equal(yield* code({ projectId, name: "missing" }), "not_found");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("deletes only the selected workspace's file, and never one a run is using", () =>
  Effect.gen(function* () {
    const { fs, filename, projectRoot, worktree, store, deletePlaybook } = yield* fixture;
    const request = { projectId, name: "demo" };
    assert.equal(yield* codeOf(deletePlaybook({ projectId, name: "../demo" })), "invalid_name");
    assert.equal(yield* codeOf(deletePlaybook({ projectId, name: "demo/other" })), "invalid_name");
    for (const input of [
      { projectId: missingProjectId, name: "demo" },
      { projectId, threadId: foreignThread, name: "demo" },
    ])
      assert.equal(yield* codeOf(deletePlaybook(input)), "workspace_not_found");
    const run = yield* store.start(ThreadId.make("delete-owner"), projectRoot, "demo", "start");
    assert.equal(yield* codeOf(deletePlaybook(request)), "in_use");
    yield* store.mutate(run.ownerThreadId, {
      operation: "cancel",
      runId: run.runId,
      client_request_id: "cancel",
    });
    assert.deepStrictEqual(yield* deletePlaybook(request), { deleted: true });
    assert.isFalse(yield* fs.exists(filename(projectRoot)));
    assert.isTrue(yield* fs.exists(filename(worktree)));
    assert.equal(yield* codeOf(deletePlaybook(request)), "not_found");
    assert.equal((yield* store.listForThread(run.ownerThreadId)).runs[0]?.status, "cancelled");
    assert.deepStrictEqual(yield* deletePlaybook({ ...request, threadId: worktreeThread }), {
      deleted: true,
    });
    assert.isFalse(yield* fs.exists(filename(worktree)));
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("can delete an invalid YAML definition without reading its contents", () =>
  Effect.gen(function* () {
    const { fs, filename, projectRoot, deletePlaybook } = yield* fixture;
    yield* fs.writeFileString(filename(projectRoot), "title: [broken");
    assert.deepStrictEqual(yield* deletePlaybook({ projectId, name: "demo" }), { deleted: true });
    assert.isFalse(yield* fs.exists(filename(projectRoot)));
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("renames the YAML title without changing its stable filename or active run", () =>
  Effect.gen(function* () {
    const { fs, filename, projectRoot, store, renamePlaybook } = yield* fixture;
    const request = { projectId, name: "demo", title: "Renamed playbook" };
    const run = yield* store.start(ThreadId.make("rename-owner"), projectRoot, "demo", "start");
    assert.deepStrictEqual(yield* renamePlaybook(request), { renamed: true });
    assert.isTrue(yield* fs.exists(filename(projectRoot)));
    const [playbook] = (yield* store.discover(projectRoot)).playbooks;
    assert.equal(playbook?.title, "Renamed playbook");
    assert.equal(playbook?.description, "Purpose of Project library.");
    assert.equal(playbook?.steps[0]?.id, "first");
    assert.equal((yield* store.current(run.ownerThreadId, run.runId)).title, "Renamed playbook");
    assert.deepStrictEqual(yield* renamePlaybook(request), { renamed: false });
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("rejects invalid rename inputs and invalid YAML", () =>
  Effect.gen(function* () {
    const { fs, filename, projectRoot, renamePlaybook } = yield* fixture;
    assert.equal(
      yield* codeOf(renamePlaybook({ projectId, name: "../demo", title: "Nope" })),
      "invalid_name",
    );
    assert.equal(
      yield* codeOf(renamePlaybook({ projectId, name: "demo", title: "   " })),
      "invalid_title",
    );
    assert.equal(
      yield* codeOf(renamePlaybook({ projectId, name: "missing", title: "Nope" })),
      "not_found",
    );
    yield* fs.writeFileString(filename(projectRoot), "title: [broken");
    assert.equal(
      yield* codeOf(renamePlaybook({ projectId, name: "demo", title: "Nope" })),
      "invalid_definition",
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("tells a storage failure in the action's general words, never the store's", () =>
  Effect.gen(function* () {
    const { handlersFor, store } = yield* fixture;
    // What the store reports when the filesystem refuses: the underlying error's own text.
    const refused = Effect.fail(
      playbookError(
        "operation_failed",
        "EACCES: permission denied, unlink '/srv/private/.j5/playbooks/demo.yaml'",
      ),
    );
    const handlers = yield* handlersFor({
      changes: store.changes,
      discover: () => refused,
      listForThread: () => refused,
      listAll: () => refused,
      exportDefinition: () => refused,
      removeDefinition: () => refused,
      renameDefinition: () => refused,
    });
    const request = { projectId, name: "demo" };
    const failure = <A>(call: Effect.Effect<A, PlaybookError>) =>
      call.pipe(
        Effect.flip,
        Effect.map(({ code, message }) => ({ code, message })),
      );
    assert.deepStrictEqual(
      yield* failure(handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook](request)),
      { code: "operation_failed", message: "Deleting the playbook failed." },
    );
    assert.deepStrictEqual(
      yield* failure(
        handlers[J5_PLAYBOOK_WS_METHODS.renamePlaybook]({ ...request, title: "Renamed" }),
      ),
      { code: "operation_failed", message: "Renaming the playbook failed." },
    );
    assert.deepStrictEqual(
      yield* failure(handlers[J5_PLAYBOOK_WS_METHODS.exportPlaybook](request)),
      { code: "operation_failed", message: "Exporting the playbook failed." },
    );
    assert.deepStrictEqual(
      yield* failure(handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({ projectId })),
      { code: "operation_failed", message: "Reading the playbook library failed." },
    );
    assert.deepStrictEqual(
      yield* failure(handlers[J5_PLAYBOOK_WS_METHODS.listThreadRuns]({ threadId: owner })),
      { code: "operation_failed", message: "Reading the thread's playbook runs failed." },
    );
    assert.deepStrictEqual(yield* failure(handlers[J5_PLAYBOOK_WS_METHODS.listRuns]({})), {
      code: "operation_failed",
      message: "Reading playbook runs failed.",
    });
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
