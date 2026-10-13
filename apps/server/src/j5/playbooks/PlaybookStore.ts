import { ThreadId } from "@t3tools/contracts";
import {
  PlaybookDefinition,
  PlaybookError,
  PLAYBOOK_RUNS_PAGE_SIZE,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_NAME_PATTERN,
  suggestPlaybookName,
  type PlaybookReadResponse,
  type PlaybookRun,
  type PlaybookRunsRequest,
  type PlaybookStep,
  type PlaybookStepResponse,
  type PlaybookWarning,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import { parseDocument } from "yaml";

import { makeAgentPersonaLibrary, personaCatalogProblem } from "../agents/agentPersonaLibrary.ts";
import { durationMsBetween, j5AnalyticsRecorder } from "../analytics/recorder.ts";

const isPlaybookError = Schema.is(PlaybookError);
// Any file stem that stays inside the playbook directory; such files are listed and deletable
// even when their name is invalid, so a misnamed file never disappears without a way out.
const PLAYBOOK_FILE_STEM = /^[^/\\\p{Cc}]+$/u;
const invalidNameIssue = (file: string) => {
  const suggestion = suggestPlaybookName(file.slice(0, -5));
  return playbookError(
    "invalid_name",
    suggestion
      ? `Rename ${file} to ${suggestion}.yaml. Playbook names use lowercase letters, digits, and hyphens.`
      : `Rename ${file} using lowercase letters, digits, and hyphens.`,
  );
};
const decodeDefinition = Schema.decodeUnknownEffect(PlaybookDefinition);

export const playbookError = (
  code: string,
  message: string,
  availableStepIds: ReadonlyArray<string> = [],
) => new PlaybookError({ code, message, availableStepIds });
const storageError = (error: unknown) =>
  isPlaybookError(error)
    ? error
    : playbookError("operation_failed", error instanceof Error ? error.message : String(error));
const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
type NamedStep = PlaybookStep & { readonly persona: string };
const namedSteps = (steps: ReadonlyArray<PlaybookStep>) =>
  steps.filter((step): step is NamedStep => step.persona !== undefined);
const stepSummary = ({ id, title, persona }: PlaybookStep) =>
  persona === undefined ? { id, title } : { id, title, persona };

/** Warnings for steps whose persona the catalog lacks or has turned off, in step order. */
export const stepPersonaWarnings = (
  steps: ReadonlyArray<PlaybookStep>,
  catalog: Parameters<typeof personaCatalogProblem>[0],
): Array<PlaybookWarning> =>
  namedSteps(steps).flatMap((step): Array<PlaybookWarning> => {
    const problem = personaCatalogProblem(catalog, step.persona);
    if (problem === null) return [];
    return [
      {
        code: problem === "missing" ? "persona_missing" : "persona_disabled",
        stepId: step.id,
        persona: step.persona,
        message:
          problem === "missing"
            ? `Step "${step.id}" names persona "${step.persona}", which is not in this environment's library.`
            : `Step "${step.id}" names persona "${step.persona}", which is turned off.`,
      },
    ];
  });

type RunRow = {
  run_id: string;
  owner_thread_id: string;
  definition_path: string;
  current_step_id: string;
  status: PlaybookRun["status"];
  created_at: string;
  updated_at: string;
  crew_instance_id: string | null;
};
const fromRow = (row: RunRow): PlaybookRun => ({
  runId: row.run_id,
  ownerThreadId: ThreadId.make(row.owner_thread_id),
  definitionPath: row.definition_path,
  currentStepId: row.current_step_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.crew_instance_id === null ? {} : { crewInstanceId: row.crew_instance_id }),
});

/** One step landing of a Crew-linked run and how its hand-off resolved. */
export type PlaybookLanding = {
  readonly runId: string;
  readonly requestId: string;
  readonly stepId: string;
  readonly landedAt: string;
  /** Set once, at first resolution; null with a target thread means the Captain. */
  readonly targetSeat: string | null;
  readonly targetThreadId: string | null;
  readonly outcome: "delivered" | "captain" | "skipped" | null;
  readonly resolvedAt: string | null;
};
type LandingRow = {
  run_id: string;
  request_id: string;
  step_id: string;
  landed_at: string;
  target_seat: string | null;
  target_thread_id: string | null;
  outcome: PlaybookLanding["outcome"];
  resolved_at: string | null;
};
const landingFromRow = (row: LandingRow): PlaybookLanding => ({
  runId: row.run_id,
  requestId: row.request_id,
  stepId: row.step_id,
  landedAt: row.landed_at,
  targetSeat: row.target_seat,
  targetThreadId: row.target_thread_id,
  outcome: row.outcome,
  resolvedAt: row.resolved_at,
});
export type PlaybookMutation = {
  readonly runId: string;
  readonly client_request_id: string;
} & (
  | { readonly operation: "next" | "back" | "complete"; readonly expectedStepId: string }
  | { readonly operation: "reselect"; readonly expectedStepId: string; readonly stepId: string }
  | { readonly operation: "cancel" }
);

export const makePlaybookStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const personas = yield* makeAgentPersonaLibrary;
  const revision = yield* SubscriptionRef.make(0);
  const bumpRevision = SubscriptionRef.update(revision, (value) => value + 1);
  const notifyChange = (result: PlaybookStepResponse) =>
    result.replayed ? Effect.void : bumpRevision;
  // Serialize definition edits and run mutations within this environment.
  const permit = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const recordAnalytics = yield* j5AnalyticsRecorder;

  /** `unreadable` replaces the default read-failure message, which names the file's absolute path. */
  const readDefinitionDocument = Effect.fn("PlaybookStore.readDefinitionDocument")(
    function* (definitionPath: string, _unreadable?: string) {
      const root = path.resolve(definitionPath, "../../..");
      const realRoot = yield* fs.realPath(root);
      const realFile = yield* fs.realPath(definitionPath);
      const relative = path.relative(realRoot, realFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return yield* playbookError(
          "invalid_path",
          "Playbook definitions must remain inside the thread workspace.",
        );
      }
      const info = yield* fs.stat(realFile);
      if (info.type !== "File" || info.size > BigInt(PLAYBOOK_MAX_BYTES)) {
        return yield* playbookError(
          "invalid_definition",
          `Use a YAML file no larger than ${PLAYBOOK_MAX_BYTES / 1024} KiB.`,
        );
      }
      const text = yield* fs.readFileString(realFile);
      const { document, raw } = yield* Effect.try(() => {
        const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
        const issue = document.errors[0] ?? document.warnings[0];
        if (issue) throw issue;
        return { document, raw: document.toJS({ maxAliasCount: 0 }) as unknown };
      });
      const definition = yield* decodeDefinition(raw);
      const ids = definition.steps.map((step) => step.id);
      if (new Set(ids).size !== ids.length) {
        return yield* playbookError(
          "invalid_definition",
          "Every playbook step must have a unique stable ID.",
          ids,
        );
      }
      return { definition, document, text };
    },
    (effect, _definitionPath: string, unreadable?: string) =>
      Effect.mapError(effect, (error) =>
        isPlaybookError(error)
          ? error
          : playbookError(
              "invalid_definition",
              unreadable ??
                `Cannot read the live playbook. Restore or fix its YAML and retry; cancellation remains available. ${error instanceof Error ? error.message : String(error)}`,
            ),
      ),
  );
  const readDefinition = Effect.fn("PlaybookStore.readDefinition")(function* (
    definitionPath: string,
  ) {
    return (yield* readDefinitionDocument(definitionPath)).definition;
  });

  /** Runs inside reads, so it moves the revision only when it cancelled a run: a read that changed nothing must not cause another. */
  const cancelOrphans = Effect.fn("PlaybookStore.cancelOrphans")(function* () {
    const timestamp = yield* now;
    const cancelled =
      yield* sql`UPDATE j5_playbook_run SET status = 'cancelled', updated_at = ${timestamp}
      WHERE status = 'active' AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id = owner_thread_id AND thread.deleted_at IS NULL
      )
      RETURNING run_id`;
    if (cancelled.length > 0) yield* bumpRevision;
  });
  const requireOwner = Effect.fn("PlaybookStore.requireOwner")(function* (owner: ThreadId) {
    const rows = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${owner} AND deleted_at IS NULL`;
    if (!rows[0]) return yield* playbookError("thread_not_found", "The owner thread was deleted.");
  });

  const readRun = Effect.fn("PlaybookStore.readRun")(function* (owner: ThreadId, runId?: string) {
    const rows =
      runId === undefined
        ? yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE owner_thread_id = ${owner}
          ORDER BY (status = 'active') DESC, rowid DESC LIMIT 1`
        : yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE run_id = ${runId}`;
    const row = rows[0];
    if (!row)
      return yield* playbookError(
        "run_not_found",
        "No playbook run was found. Use j5_playbook_list and j5_playbook_start.",
      );
    if (row.owner_thread_id !== owner)
      return yield* playbookError(
        "not_owner",
        "Only the run's owner thread can access its agent tools.",
      );
    return fromRow(row);
  });

  const present = (
    run: PlaybookRun,
    definition: PlaybookDefinition,
    replayed = false,
  ): PlaybookStepResponse => {
    const index = definition.steps.findIndex((step) => step.id === run.currentStepId);
    return {
      ...run,
      title: definition.title,
      description: definition.description,
      steps: definition.steps.map(({ id, title }) => ({ id, title })),
      position: index < 0 ? null : index + 1,
      total: definition.steps.length,
      currentStep: definition.steps[index] ?? null,
      replayed,
      issue:
        run.status === "active" && index < 0
          ? playbookError(
              "step_missing",
              `Step '${run.currentStepId}' no longer exists. Call j5_playbook_reselect with expectedStepId '${run.currentStepId}' and one of the available step IDs, or cancel.`,
              definition.steps.map((step) => step.id),
            )
          : null,
    };
  };
  const view = Effect.fn("PlaybookStore.view")(function* (
    run: PlaybookRun,
    replayed = false,
    definition: ReturnType<typeof readDefinition> = readDefinition(run.definitionPath),
  ) {
    return yield* definition.pipe(
      Effect.map((definition) => present(run, definition, replayed)),
      Effect.catch((issue) =>
        Effect.succeed({
          ...run,
          title: path.basename(run.definitionPath, ".yaml"),
          description: "",
          steps: [],
          position: null,
          total: 0,
          currentStep: null,
          issue: run.status === "active" ? issue : null,
          replayed,
        } satisfies PlaybookStepResponse),
      ),
    );
  });
  const replay = Effect.fn("PlaybookStore.replay")(function* (
    owner: ThreadId,
    key: string,
    request: string,
  ) {
    const rows = yield* sql<{ request_json: string; run_id: string }>`SELECT request_json, run_id
      FROM j5_playbook_request WHERE owner_thread_id = ${owner} AND request_id = ${key}`;
    const receipt = rows[0];
    if (!receipt) return null;
    if (receipt.request_json !== request)
      return yield* playbookError(
        "request_conflict",
        "This client_request_id belongs to a different operation. Use a new key for a new operation.",
      );
    return yield* readRun(owner, receipt.run_id);
  });
  const remember = (owner: ThreadId, key: string, request: string, runId: string) =>
    sql`INSERT INTO j5_playbook_request (owner_thread_id, request_id, request_json, run_id)
      VALUES (${owner}, ${key}, ${request}, ${runId})`;
  // Keyed by the request that caused the landing; a retried request is replayed before this runs.
  const land = (runId: string, requestId: string, stepId: string, landedAt: string) =>
    sql`INSERT INTO j5_playbook_step_delivery (run_id, request_id, step_id, landed_at)
      VALUES (${runId}, ${requestId}, ${stepId}, ${landedAt})`;
  const skipPending = (runId: string, resolvedAt: string) =>
    sql`UPDATE j5_playbook_step_delivery SET outcome = 'skipped', resolved_at = ${resolvedAt}
      WHERE run_id = ${runId} AND resolved_at IS NULL`;

  /**
   * Warnings never fail a read: the catalog is read only when a step names a persona, and an
   * unreadable catalog turns into persona_unverified warnings.
   */
  const personaWarnings = (
    steps: ReadonlyArray<PlaybookStep>,
    catalog: ReturnType<typeof personas.catalog>,
  ): Effect.Effect<Array<PlaybookWarning>> => {
    const named = namedSteps(steps);
    if (named.length === 0) return Effect.succeed([]);
    return catalog.pipe(
      Effect.map((catalog) => stepPersonaWarnings(named, catalog)),
      Effect.catch((error) =>
        Effect.succeed(
          named.map((step): PlaybookWarning => ({
            code: "persona_unverified",
            stepId: step.id,
            persona: step.persona,
            message: `Step "${step.id}" names persona "${step.persona}", which could not be checked: ${error instanceof Error ? error.message : String(error)}`,
          })),
        ),
      ),
    );
  };

  const discover = Effect.fn("PlaybookStore.discover")(function* (workspaceRoot: string) {
    const directory = path.join(workspaceRoot, ".j5/playbooks");
    if (!(yield* fs.exists(directory))) return { playbooks: [] };
    const names = (yield* fs.readDirectory(directory))
      .filter((name) => name.endsWith(".yaml") && PLAYBOOK_FILE_STEM.test(name.slice(0, -5)))
      .sort();
    // One catalog read per listing, shared by every file that names a persona.
    const catalog = yield* Effect.cached(personas.catalog());
    const playbooks = yield* Effect.forEach(names, (file) =>
      readDefinition(path.join(directory, file)).pipe(
        Effect.flatMap((definition) =>
          personaWarnings(definition.steps, catalog).pipe(
            Effect.map((warnings) => ({
              name: file.slice(0, -5),
              title: definition.title,
              description: definition.description,
              stepCount: definition.steps.length,
              steps: definition.steps.map(stepSummary),
              issue: PLAYBOOK_NAME_PATTERN.test(file.slice(0, -5))
                ? (null as PlaybookError | null)
                : invalidNameIssue(file),
              warnings,
            })),
          ),
        ),
        Effect.catch((issue) =>
          Effect.succeed({
            name: file.slice(0, -5),
            title: file,
            description: "",
            stepCount: 0,
            steps: [],
            issue,
            warnings: [],
          }),
        ),
      ),
    );
    return { playbooks };
  }, Effect.mapError(storageError));

  /** The definition file for a name as j5_playbook_start accepts it; a trailing .yaml is allowed. */
  const definitionPathFor = Effect.fn("PlaybookStore.definitionPathFor")(function* (
    workspaceRoot: string,
    name: string,
  ) {
    const stem = name.endsWith(".yaml") ? name.slice(0, -5) : name;
    if (!PLAYBOOK_NAME_PATTERN.test(stem))
      return yield* playbookError(
        "invalid_name",
        "Pass a playbook name from j5_playbook_list: lowercase letters, digits, and hyphens, without directories or spaces.",
      );
    return { stem, definitionPath: path.resolve(workspaceRoot, ".j5/playbooks", `${stem}.yaml`) };
  });

  /** Reads a live definition without touching run state: no permit, no SQL, no revision bump. */
  const readPath = Effect.fn("PlaybookStore.readPath")(function* (definitionPath: string) {
    const stem = path.basename(definitionPath, ".yaml");
    if (!(yield* fs.exists(definitionPath)))
      return yield* playbookError(
        "not_found",
        `No playbook named ${stem} in this workspace. Use j5_playbook_list.`,
      );
    const definition = yield* readDefinition(definitionPath);
    return {
      name: stem,
      title: definition.title,
      description: definition.description,
      steps: definition.steps,
      warnings: yield* personaWarnings(definition.steps, personas.catalog()),
    } satisfies PlaybookReadResponse;
  }, Effect.mapError(storageError));
  const read = Effect.fn("PlaybookStore.read")(function* (workspaceRoot: string, name: string) {
    return yield* readPath((yield* definitionPathFor(workspaceRoot, name)).definitionPath);
  }, Effect.mapError(storageError));

  const removeDefinition = Effect.fn("PlaybookStore.removeDefinition")(function* (
    workspaceRoot: string,
    name: string,
  ) {
    if (!PLAYBOOK_FILE_STEM.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const directory = path.resolve(workspaceRoot, ".j5/playbooks");
    const filename = path.join(directory, `${name}.yaml`);
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filename)))
        return yield* playbookError("not_found", "This playbook no longer exists.");
      const realRoot = yield* fs.realPath(workspaceRoot);
      const realDirectory = yield* fs.realPath(directory);
      const relative = path.relative(realRoot, realDirectory);
      if (relative !== path.join(".j5", "playbooks"))
        return yield* playbookError("invalid_path", "Playbooks must stay inside the workspace.");
      const info = yield* fs.stat(filename);
      if (info.type !== "File")
        return yield* playbookError("invalid_path", "Only playbook YAML files can be deleted.");
      yield* cancelOrphans();
      const active = yield* sql<{ run_id: string }>`SELECT run_id FROM j5_playbook_run
        WHERE definition_path = ${filename} AND status = 'active' LIMIT 1`;
      if (active[0])
        return yield* playbookError(
          "in_use",
          `Run '${active[0].run_id}' is active. Complete or cancel it before deleting this playbook.`,
        );
      yield* fs.remove(filename);
      // A finished run is still shown by its playbook's title, which went with the file.
      yield* bumpRevision;
      return { deleted: true };
    }).pipe(permit.withPermits(1));
  }, Effect.mapError(storageError));

  /** Returns the definition's YAML as a file a user can re-import. */
  const exportDefinition = Effect.fn("PlaybookStore.exportDefinition")(function* (
    workspaceRoot: string,
    name: string,
  ) {
    if (!PLAYBOOK_NAME_PATTERN.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const filename = path.resolve(workspaceRoot, ".j5/playbooks", `${name}.yaml`);
    if (!(yield* fs.exists(filename)))
      return yield* playbookError("not_found", "This playbook no longer exists.");
    // Export the validated source text (less any BOM): re-rendering can grow the file past the import limit.
    const { text } = yield* readDefinitionDocument(
      filename,
      "Cannot read this playbook. Fix its YAML in the library and retry.",
    );
    return { fileName: `${name}.yaml`, yaml: text };
  }, Effect.mapError(storageError));

  const renameDefinition = Effect.fn("PlaybookStore.renameDefinition")(function* (
    workspaceRoot: string,
    name: string,
    title: string,
  ) {
    if (!PLAYBOOK_NAME_PATTERN.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const nextTitle = title.trim();
    if (!nextTitle) return yield* playbookError("invalid_title", "Enter a name for the playbook.");
    const filename = path.resolve(workspaceRoot, ".j5/playbooks", `${name}.yaml`);
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filename)))
        return yield* playbookError("not_found", "This playbook no longer exists.");
      const { definition, document } = yield* readDefinitionDocument(filename);
      if (definition.title === nextTitle) return { renamed: false };
      document.set("title", nextTitle);
      yield* fs.writeFileString(filename, document.toString());
      // Every run of this playbook is shown by its title.
      yield* bumpRevision;
      return { renamed: true };
    }).pipe(permit.withPermits(1));
  }, Effect.mapError(storageError));

  const start = Effect.fn("PlaybookStore.start")(function* (
    owner: ThreadId,
    workspaceRoot: string,
    name: string,
    key: string,
    options: { readonly crewInstanceId?: string } = {},
  ) {
    const { definitionPath } = yield* definitionPathFor(workspaceRoot, name);
    const crewInstanceId = options.crewInstanceId ?? null;
    // A thread run keeps the original request shape, so receipts stored before Crew links replay.
    const request = encodeRequest(
      crewInstanceId === null
        ? ["start", definitionPath]
        : ["start", definitionPath, crewInstanceId],
    );
    return yield* Effect.gen(function* () {
      yield* cancelOrphans();
      const previous = yield* replay(owner, key, request);
      if (previous) return yield* view(previous, true);
      // Capture the live file before taking the shared SQLite write transaction.
      const definition = yield* readDefinition(definitionPath);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* replay(owner, key, request);
          if (previous) return { run: previous, replayed: true };
          yield* requireOwner(owner);
          const active = yield* sql<{ run_id: string }>`SELECT run_id FROM j5_playbook_run
          WHERE owner_thread_id = ${owner} AND status = 'active'`;
          if (active[0])
            return yield* playbookError(
              "already_active",
              `Run '${active[0].run_id}' is active. Retrieve, complete, or cancel it before starting another.`,
            );
          const timestamp = yield* now;
          const run: PlaybookRun = {
            runId: yield* crypto.randomUUIDv4,
            ownerThreadId: owner,
            definitionPath,
            currentStepId: definition.steps[0]!.id,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(crewInstanceId === null ? {} : { crewInstanceId }),
          };
          yield* sql`INSERT INTO j5_playbook_run (run_id, owner_thread_id, definition_path, current_step_id, status, created_at, updated_at, crew_instance_id)
          VALUES (${run.runId}, ${owner}, ${definitionPath}, ${run.currentStepId}, ${run.status}, ${timestamp}, ${timestamp}, ${crewInstanceId})`;
          if (crewInstanceId !== null) yield* land(run.runId, key, run.currentStepId, timestamp);
          yield* remember(owner, key, request, run.runId);
          return { run, replayed: false };
        }),
      );
      if (result.replayed) return yield* view(result.run, true);
      yield* recordAnalytics("j5.playbook.run.started", {
        stepCount: definition.steps.length,
        stepsWithPersona: definition.steps.filter((step) => step.persona !== undefined).length,
        crewBound: crewInstanceId !== null,
      });
      return present(result.run, definition);
    }).pipe(Effect.tap(notifyChange), permit.withPermits(1));
  }, Effect.mapError(storageError));

  /**
   * `j5.playbook.run.finished`, recorded once a run's end has committed. How far it got is read
   * from the live file, and is left out when the file can no longer be read.
   */
  const recordFinished = Effect.fn("PlaybookStore.recordFinished")(function* (
    run: PlaybookRun,
    cause: "agent" | "crew_archive",
    known: PlaybookDefinition | null,
  ) {
    const definition =
      known ?? Option.getOrNull(yield* Effect.option(readDefinition(run.definitionPath)));
    const position =
      definition === null
        ? -1
        : definition.steps.findIndex((step) => step.id === run.currentStepId);
    yield* recordAnalytics("j5.playbook.run.finished", {
      outcome: run.status,
      cause,
      crewBound: run.crewInstanceId !== undefined && run.crewInstanceId !== null,
      ...(definition === null ? {} : { stepCount: definition.steps.length }),
      ...(position < 0 ? {} : { position: position + 1 }),
      ...durationMsBetween(run.createdAt, run.updatedAt),
    });
  });

  const mutate = Effect.fn("PlaybookStore.mutate")(function* (
    owner: ThreadId,
    input: PlaybookMutation,
  ) {
    const request = encodeRequest([
      input.operation,
      input.runId,
      "expectedStepId" in input ? input.expectedStepId : null,
      "stepId" in input ? input.stepId : null,
    ]);
    return yield* Effect.gen(function* () {
      yield* cancelOrphans();
      const previous = yield* replay(owner, input.client_request_id, request);
      if (previous) return yield* view(previous, true);
      const before = yield* readRun(owner, input.runId);
      const definition =
        input.operation === "cancel" || before.status !== "active"
          ? null
          : yield* readDefinition(before.definitionPath);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* replay(owner, input.client_request_id, request);
          if (previous) return { run: previous, replayed: true };
          const run = yield* readRun(owner, input.runId);
          if (run.status !== "active")
            return yield* playbookError(
              "run_terminal",
              `This run is ${run.status}. Start a new run to continue.`,
            );
          yield* requireOwner(owner);
          if ("expectedStepId" in input && input.expectedStepId !== run.currentStepId) {
            return yield* playbookError(
              "step_conflict",
              `Expected '${input.expectedStepId}', but the run is at '${run.currentStepId}'. Retrieve j5_playbook_current and use a new request ID.`,
            );
          }
          let currentStepId = run.currentStepId;
          let status: PlaybookRun["status"] = run.status;
          if (input.operation === "cancel") status = "cancelled";
          else if (definition) {
            const ids = definition.steps.map((step) => step.id);
            const index = ids.indexOf(run.currentStepId);
            if (input.operation === "reselect") {
              if (!ids.includes(input.stepId))
                return yield* playbookError("step_missing", "Choose an available step ID.", ids);
              currentStepId = input.stepId;
            } else {
              if (index < 0) return yield* present(run, definition).issue!;
              if (input.operation === "complete") status = "completed";
              else {
                const target = ids[index + (input.operation === "next" ? 1 : -1)];
                if (!target)
                  return yield* playbookError(
                    "step_boundary",
                    input.operation === "next"
                      ? "This is the last step. Call j5_playbook_complete when the work is finished."
                      : "This is the first step. Retrieve it or choose an available step explicitly.",
                    ids,
                  );
                currentStepId = target;
              }
            }
          }
          const updatedAt = yield* now;
          yield* sql`UPDATE j5_playbook_run SET current_step_id = ${currentStepId}, status = ${status}, updated_at = ${updatedAt}
          WHERE run_id = ${run.runId} AND owner_thread_id = ${owner}`;
          if (run.crewInstanceId !== undefined && run.crewInstanceId !== null) {
            // Every landing is handed to its owner exactly once; a finished run hands off nothing.
            if (status === "active")
              yield* land(run.runId, input.client_request_id, currentStepId, updatedAt);
            else yield* skipPending(run.runId, updatedAt);
          }
          yield* remember(owner, input.client_request_id, request, run.runId);
          return { run: { ...run, currentStepId, status, updatedAt }, replayed: false };
        }),
      );
      if (!result.replayed && result.run.status !== "active")
        yield* recordFinished(result.run, "agent", definition);
      return definition && !result.replayed
        ? present(result.run, definition)
        : yield* view(result.run, result.replayed);
    }).pipe(Effect.tap(notifyChange), permit.withPermits(1));
  }, Effect.mapError(storageError));

  const current = Effect.fn("PlaybookStore.current")(function* (owner: ThreadId, runId?: string) {
    yield* cancelOrphans();
    const result = yield* view(yield* readRun(owner, runId));
    if (result.issue && result.status === "active")
      return yield* playbookError(
        result.issue.code,
        `Run '${result.runId}' is at '${result.currentStepId}'. ${result.issue.message}`,
        result.issue.availableStepIds,
      );
    return result;
  }, Effect.mapError(storageError));
  const progressRows = (rows: ReadonlyArray<RunRow>) =>
    Effect.gen(function* () {
      // Keep the cache inside the request, including failed reads; the next request sees live YAML.
      const definitions = new Map<string, ReturnType<typeof readDefinition>>();
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          let definition = definitions.get(row.definition_path);
          if (!definition) {
            definition = yield* Effect.cached(readDefinition(row.definition_path));
            definitions.set(row.definition_path, definition);
          }
          const {
            currentStep: _prompt,
            replayed: _replayed,
            ...progress
          } = yield* view(fromRow(row), false, definition);
          return progress;
        }),
      );
    });
  const listForThread = Effect.fn("PlaybookStore.listForThread")(function* (owner: ThreadId) {
    yield* cancelOrphans();
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE owner_thread_id = ${owner}
      ORDER BY (status = 'active') DESC, rowid DESC LIMIT 20`;
    const runs = yield* progressRows(rows);
    return { runs };
  }, Effect.mapError(storageError));
  const listAll = Effect.fn("PlaybookStore.listAll")(function* (input: PlaybookRunsRequest) {
    yield* cancelOrphans();
    const filter = input.status === "active" ? sql`status = 'active'` : sql`1 = 1`;
    const counts = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM j5_playbook_run WHERE ${filter}`;
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE ${filter}
      ORDER BY ${input.status === "active" ? sql`updated_at DESC, rowid DESC` : sql`(status = 'active') DESC, updated_at DESC, rowid DESC`}
      LIMIT ${PLAYBOOK_RUNS_PAGE_SIZE} OFFSET ${input.offset ?? 0}`;
    const runs = yield* progressRows(rows);
    return { runs, total: counts[0]?.total ?? 0 };
  }, Effect.mapError(storageError));
  /** A run by id, without the owner check the agent tools apply; null when none. */
  const runById = Effect.fn("PlaybookStore.runById")(function* (runId: string) {
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE run_id = ${runId}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }, Effect.mapError(storageError));
  /** The live step a landing hands off, with its playbook; fails when the YAML can't be read. */
  const liveStep = Effect.fn("PlaybookStore.liveStep")(function* (
    run: PlaybookRun,
    stepId: string,
  ) {
    const definition = yield* readDefinition(run.definitionPath);
    const index = definition.steps.findIndex((step) => step.id === stepId);
    return {
      name: path.basename(run.definitionPath, ".yaml"),
      title: definition.title,
      step: definition.steps[index] ?? null,
      position: index + 1,
      total: definition.steps.length,
    };
  }, Effect.mapError(storageError));
  const landing = Effect.fn("PlaybookStore.landing")(function* (runId: string, requestId: string) {
    const rows = yield* sql<LandingRow>`SELECT * FROM j5_playbook_step_delivery
      WHERE run_id = ${runId} AND request_id = ${requestId}`;
    return rows[0] ? landingFromRow(rows[0]) : null;
  }, Effect.mapError(storageError));
  /** The newest landing of a run, optionally only those on one step. */
  const latestLanding = Effect.fn("PlaybookStore.latestLanding")(function* (
    runId: string,
    stepId?: string,
  ) {
    const rows = yield* sql<LandingRow>`SELECT * FROM j5_playbook_step_delivery
      WHERE run_id = ${runId} AND ${stepId === undefined ? sql`1 = 1` : sql`step_id = ${stepId}`}
      ORDER BY landed_at DESC, rowid DESC LIMIT 1`;
    return rows[0] ? landingFromRow(rows[0]) : null;
  }, Effect.mapError(storageError));
  /** Unresolved landings, oldest first; every run's when no run is named. */
  const pendingLandings = Effect.fn("PlaybookStore.pendingLandings")(function* (
    runId: string | null,
  ) {
    const rows = yield* sql<LandingRow>`SELECT * FROM j5_playbook_step_delivery
      WHERE resolved_at IS NULL AND ${runId === null ? sql`1 = 1` : sql`run_id = ${runId}`}
      ORDER BY landed_at, rowid`;
    return rows.map(landingFromRow);
  }, Effect.mapError(storageError));
  /** Persists a landing's target once; a later call keeps the first target. */
  const targetLanding = Effect.fn("PlaybookStore.targetLanding")(function* (
    runId: string,
    requestId: string,
    target: { readonly seat: string | null; readonly threadId: string },
  ) {
    const targeted = yield* sql`UPDATE j5_playbook_step_delivery
      SET target_seat = ${target.seat}, target_thread_id = ${target.threadId}
      WHERE run_id = ${runId} AND request_id = ${requestId} AND target_thread_id IS NULL
      RETURNING run_id`;
    // Fleet shows the seat a pending hand-off is headed to.
    if (targeted.length > 0) yield* bumpRevision;
    return (yield* landing(runId, requestId))!;
  }, Effect.mapError(storageError));
  const resolveLanding = Effect.fn("PlaybookStore.resolveLanding")(function* (
    runId: string,
    requestId: string,
    outcome: NonNullable<PlaybookLanding["outcome"]>,
  ) {
    const resolvedAt = yield* now;
    const rows = yield* sql<{ run_id: string }>`UPDATE j5_playbook_step_delivery
      SET outcome = ${outcome}, resolved_at = ${resolvedAt}
      WHERE run_id = ${runId} AND request_id = ${requestId} AND resolved_at IS NULL
      RETURNING run_id`;
    // Fleet shows who holds the step, so a resolved hand-off refreshes it.
    if (rows.length > 0) yield* bumpRevision;
    return (yield* landing(runId, requestId))!;
  }, Effect.mapError(storageError));
  /** Archiving a Crew cancels its active run; idempotent, so an archive retry repairs a crash. */
  const cancelForCrew = Effect.fn("PlaybookStore.cancelForCrew")(function* (
    crewInstanceId: string,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const timestamp = yield* now;
          const rows = yield* sql<RunRow>`UPDATE j5_playbook_run
            SET status = 'cancelled', updated_at = ${timestamp}
            WHERE crew_instance_id = ${crewInstanceId} AND status = 'active'
            RETURNING *`;
          for (const { run_id } of rows) yield* skipPending(run_id, timestamp);
          return rows.map(fromRow);
        }),
      )
      .pipe(
        Effect.tap((runs) => (runs.length > 0 ? bumpRevision : Effect.void)),
        Effect.tap((runs) =>
          Effect.forEach(runs, (run) => recordFinished(run, "crew_archive", null), {
            discard: true,
          }),
        ),
        Effect.map((runs) => runs.map((run) => run.runId)),
        permit.withPermits(1),
      );
  }, Effect.mapError(storageError));
  /** A Crew's active run with its live progress, or null. */
  const activeRunForCrew = Effect.fn("PlaybookStore.activeRunForCrew")(function* (
    crewInstanceId: string,
  ) {
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run
      WHERE crew_instance_id = ${crewInstanceId} AND status = 'active' LIMIT 1`;
    return rows[0] ? yield* view(fromRow(rows[0])) : null;
  }, Effect.mapError(storageError));
  /** The directories that hold the definition of an active run, each once. */
  const activeDefinitionDirectories = Effect.fn("PlaybookStore.activeDefinitionDirectories")(
    function* () {
      const rows = yield* sql<{ definition_path: string }>`SELECT DISTINCT definition_path
        FROM j5_playbook_run WHERE status = 'active'`;
      return [...new Set(rows.map((row) => path.dirname(row.definition_path)))];
    },
    Effect.mapError(storageError),
  );
  return {
    // Include the current revision so subscribing after a mutation still refreshes the view.
    changes: SubscriptionRef.changes(revision),
    /**
     * Says a definition file changed outside this store: a run is shown from its live YAML, so
     * its views read again. `PlaybookDefinitionWatch` calls it for the directories it watches.
     */
    definitionsChanged: bumpRevision,
    activeDefinitionDirectories,
    discover,
    definitionPathFor,
    read,
    readPath,
    removeDefinition,
    exportDefinition,
    renameDefinition,
    start,
    current,
    mutate,
    listForThread,
    listAll,
    runById,
    liveStep,
    landing,
    latestLanding,
    pendingLandings,
    targetLanding,
    resolveLanding,
    cancelForCrew,
    activeRunForCrew,
  };
});

export class PlaybookStore extends Context.Service<
  PlaybookStore,
  Effect.Success<typeof makePlaybookStore>
>()("t3/j5/playbooks/PlaybookStore") {}
export const playbookStoreLayer = Layer.effect(PlaybookStore, makePlaybookStore);
