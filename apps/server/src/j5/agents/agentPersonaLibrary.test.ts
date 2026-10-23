// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AgentPersonaEditInput,
  AgentPersonaImportConflictError,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2AgentPersonaAssignment,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { stringify as yaml } from "yaml";

import { prepareAgentPersonaLaunch } from "./agentPersonaLaunch.ts";
import { definitionDigest, createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { BUILT_IN_AGENT_PERSONAS, decodeAgentPersonaDefinition } from "./agentPersonas.ts";
import { validateAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";

const isImportConflict = Schema.is(AgentPersonaImportConflictError);

const json = (value: unknown) => JSON.stringify(value);

const custom = decodeAgentPersonaDefinition({
  ...BUILT_IN_AGENT_PERSONAS.scout,
  id: "team-researcher",
  displayName: "Team Researcher",
  version: 3,
  artifacts: ["TeamBrief"],
  outputArtifact: "TeamBrief",
  instructions: "# Identity\nTeam researcher.\n# Operating principles\nCite your evidence.",
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-persona-library-" });
  const folder = path.join(stateDir, "personas");
  const library = createAgentPersonaLibrary({ fs, path, stateDir });
  const write = (name: string, value: unknown) =>
    fs
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(folder, name), yaml(value))));
  return { fs, path, stateDir, folder, library, write };
});

const assignmentFor = (digest: string | undefined): OrchestrationV2AgentPersonaAssignment => ({
  personaId: custom.id,
  definitionVersion: custom.version,
  displayName: custom.displayName,
  ...(digest === undefined ? {} : { definitionDigest: digest }),
  authorityPolicy: "read-only",
  resolvedRoute: "primary",
  resolvedDriver: ProviderDriverKind.make("codex"),
  resolvedModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: custom.modelRoute[0].model,
    options: [{ id: "reasoningEffort", value: "high" }],
  },
});

describe("folder-backed persona library", () => {
  it.effect("starts empty with no storage or user-authored definitions", () =>
    Effect.gen(function* () {
      const { library, fs, folder, stateDir, path } = yield* fixture;
      assert.deepEqual(yield* createAgentPersonaLibrary().load(), []);
      assert.deepEqual(yield* library.load(), []);
      yield* fs.makeDirectory(folder);
      assert.deepEqual(yield* library.load(), []);
      yield* fs.writeFileString(path.join(stateDir, "agent-personas.json"), json({ folders: [] }));
      assert.deepEqual(yield* library.load(), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps imports available without a default folder and never reveals bundled examples",
    () =>
      Effect.gen(function* () {
        const { library, fs, path, stateDir } = yield* fixture;
        yield* library.importFiles({
          files: [{ name: "scout.yaml", content: yaml({ ...custom, id: "scout" }) }],
          replaceExisting: false,
        });
        const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
        assert.deepEqual(
          (yield* restarted.load()).map(({ id }) => id),
          ["scout"],
        );
        yield* restarted.removeAgent("scout");
        const catalog = yield* restarted.catalog();
        assert.deepEqual(catalog.definitions, []);
        assert.deepEqual(catalog.removedSources, []);
        assert.deepEqual(yield* restarted.load(), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("loads arbitrary persona ids and custom artifacts without adding built-ins", () =>
    Effect.gen(function* () {
      const { library, write } = yield* fixture;
      yield* write("researcher.yaml", custom);
      assert.deepEqual(yield* library.load(), [custom]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads relative and absolute source folders in deterministic order", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir, folder, write } = yield* fixture;
      yield* write("z.yaml", custom);
      const second = path.join(stateDir, "team-library");
      yield* fs.makeDirectory(second);
      yield* fs.writeFileString(path.join(second, "a.yaml"), yaml({ ...custom, id: "another" }));
      yield* fs.writeFileString(
        path.join(stateDir, "agent-personas.json"),
        json({ folders: ["personas", second] }),
      );
      assert.deepEqual(
        (yield* library.load()).map(({ id }) => id),
        [custom.id, "another"],
      );
      yield* fs.writeFileString(path.join(folder, "README.md"), "Not a definition");
      assert.lengthOf(yield* library.load(), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects duplicate ids across files instead of choosing an arbitrary winner", () =>
    Effect.gen(function* () {
      const { library, write } = yield* fixture;
      yield* write("a.yaml", custom);
      yield* write("b.yaml", { ...custom, version: 4 });
      assert.include(String(yield* library.load().pipe(Effect.flip)), "Duplicate persona id");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports invalid files, invalid configuration, and missing configured folders", () =>
    Effect.gen(function* () {
      const { library, write, fs, path, stateDir } = yield* fixture;
      yield* write("invalid.yaml", { ...custom, outputArtifact: "UndefinedArtifact" });
      assert.include(String(yield* library.load().pipe(Effect.flip)), "Invalid persona file");
      yield* fs.writeFileString(path.join(stateDir, "agent-personas.json"), "not json");
      assert.isDefined(yield* library.load().pipe(Effect.flip));
      yield* fs.writeFileString(
        path.join(stateDir, "agent-personas.json"),
        json({ folders: ["missing"] }),
      );
      assert.isDefined(yield* library.load().pipe(Effect.flip));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resumes from the snapshot after source edits and removal, including same-version edits",
    () =>
      Effect.gen(function* () {
        const { library, write, fs, folder } = yield* fixture;
        yield* write("researcher.yaml", custom);
        const assignment = assignmentFor(yield* library.snapshot(custom));
        assert.isDefined(assignment.definitionDigest);
        yield* write("researcher.yaml", { ...custom, instructions: "Changed behavior" });
        assert.equal((yield* library.load())[0]?.instructions, "Changed behavior");
        assert.deepEqual(yield* library.readSnapshot(assignment), custom);
        yield* fs.remove(folder, { recursive: true });
        const freshLibrary = createAgentPersonaLibrary({
          fs,
          path: yield* Path.Path,
          stateDir: (yield* Path.Path).dirname(folder),
        });
        const restored = yield* freshLibrary.readSnapshot(assignment);
        assert.isUndefined(validateAgentPersonaAssignment(assignment, restored));
        const policy = yield* resolveAgentPersonaRuntime(
          { agentPersonaAssignment: assignment, runtimeMode: "full-access" },
          freshLibrary,
        );
        assert.include(
          "agentPersonaInstructions" in policy ? policy.agentPersonaInstructions : "",
          custom.instructions,
        );
        assert.notInclude(
          "agentPersonaInstructions" in policy ? policy.agentPersonaInstructions : "",
          "Changed behavior",
        );
        assert.equal(policy.runtimeMode, "approval-required");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a missing or modified snapshot instead of adopting current source", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      const assignment = assignmentFor(yield* library.snapshot(custom));
      const file = path.join(
        stateDir,
        "agent-persona-snapshots",
        `${assignment.definitionDigest}.json`,
      );
      yield* fs.writeFileString(file, json({ ...custom, instructions: "Replaced" }));
      assert.include(
        String(yield* library.readSnapshot(assignment).pipe(Effect.flip)),
        "does not match",
      );
      yield* fs.remove(file);
      assert.isDefined(yield* library.readSnapshot(assignment).pipe(Effect.flip));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("validates structured references, identifiers, and authority choices", () => {
    assert.throws(() => decodeAgentPersonaDefinition({ ...custom, id: "../escape" }));
    assert.throws(() => decodeAgentPersonaDefinition({ ...custom, inputArtifacts: ["Unknown"] }));
    assert.throws(() =>
      decodeAgentPersonaDefinition({
        ...custom,
        authority: { defaultPolicy: "workspace-write", allowedPolicies: ["read-only"] },
      }),
    );
    assert.equal(
      decodeAgentPersonaDefinition({
        ...custom,
        acceptedInput: "A prompt plus repository evidence",
      }).id,
      custom.id,
    );
  });
});

describe("imported persona library", () => {
  const file = (definition: typeof custom, name = "agent.yaml") => ({
    name,
    content: yaml(definition),
  });

  it.effect("imports a nested folder batch and retains it across library instances", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      const other = { ...custom, id: "second-agent" };
      const result = yield* library.importFiles({
        files: [file(custom, "team/researcher/agent.yaml"), file(other, "team/second/agent.yaml")],
        replaceExisting: false,
      });
      assert.deepEqual(result.importedIds, [custom.id, other.id]);
      const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
      const catalog = yield* restarted.catalog();
      assert.deepEqual(catalog.importedIds, result.importedIds);
      assert.lengthOf(catalog.definitions, 2);
      assert.deepEqual(
        catalog.definitions.find(({ id }) => id === custom.id),
        custom,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads an import file or folder from the environment's filesystem", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      const team = path.join(stateDir, "team");
      yield* fs.makeDirectory(path.join(team, "nested", ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(team, "lead.yaml"), yaml(custom));
      yield* fs.writeFileString(path.join(team, "notes.md"), "not a persona");
      yield* fs.writeFileString(path.join(team, "nested", "second.yml"), yaml(custom));
      yield* fs.writeFileString(path.join(team, "nested", ".git", "hidden.yaml"), yaml(custom));

      assert.deepEqual(yield* library.listImportFiles(team), [
        { name: "lead.yaml", fullPath: path.join(team, "lead.yaml") },
      ]);
      assert.deepEqual(
        (yield* library.readImportFiles(team)).map(({ name }) => name),
        [path.join("team", "lead.yaml"), path.join("team", "nested", "second.yml")],
      );
      const single = yield* library.readImportFiles(path.join(team, "lead.yaml"));
      assert.deepEqual(single, [{ name: "lead.yaml", content: yaml(custom) }]);

      for (const target of [path.join(team, "notes.md"), path.join(team, "missing"), "team"])
        yield* library.readImportFiles(target).pipe(Effect.flip);
      yield* fs.writeFileString(path.join(team, "large.yaml"), "a".repeat(65537));
      assert.include(
        String(yield* library.readImportFiles(team).pipe(Effect.flip)),
        "exceeds 64 KiB",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("walks past a dangling link and skips node_modules when importing a folder", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      const team = path.join(stateDir, "team");
      yield* fs.makeDirectory(path.join(team, "node_modules", "pkg"), { recursive: true });
      yield* fs.writeFileString(path.join(team, "lead.yaml"), yaml(custom));
      yield* fs.writeFileString(path.join(team, "node_modules", "pkg", "dep.yaml"), yaml(custom));
      yield* fs.symlink(path.join(stateDir, "gone"), path.join(team, "broken"));

      assert.deepEqual(
        (yield* library.readImportFiles(team)).map(({ name }) => name),
        [path.join("team", "lead.yaml")],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Needs mkfifo; Windows has no FIFOs to reject.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refuses to import a target that is not a regular file or folder",
    () =>
      Effect.gen(function* () {
        const { library, path, stateDir } = yield* fixture;
        const fifo = path.join(stateDir, "pipe");
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              NodeChildProcess.execFile("mkfifo", [fifo], (error) =>
                error ? reject(error) : resolve(),
              ),
            ),
        );
        assert.include(
          String(yield* library.readImportFiles(fifo).pipe(Effect.flip)),
          "Unsupported persona file: pipe",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a mixed valid/invalid batch without importing any of it", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      yield* library.importFiles({ files: [file(custom)], replaceExisting: false });
      const before = yield* library.load();
      const error = yield* library
        .importFiles({
          files: [
            file({ ...custom, id: "valid-new-agent" }),
            { name: "broken/agent.yaml", content: "{}" },
          ],
          replaceExisting: false,
        })
        .pipe(Effect.flip);
      assert.include(String(error), "broken/agent.yaml");
      assert.deepEqual(yield* library.load(), before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("requires explicit replacement and restores the source on removal", () =>
    Effect.gen(function* () {
      const { library, write } = yield* fixture;
      yield* write("agent.yaml", custom);
      const changed = { ...custom, instructions: "Updated instructions" };
      const input = { files: [file(changed)], replaceExisting: false };
      assert.include(String(yield* library.importFiles(input).pipe(Effect.flip)), "already exist");
      yield* library.importFiles({ ...input, replaceExisting: true });
      assert.deepEqual(yield* library.load(), [changed]);
      yield* library.removeImported(custom.id);
      assert.deepEqual(yield* library.load(), [custom]);
      assert.deepEqual((yield* library.catalog()).importedIds, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects duplicate selected IDs, oversize UTF-8, and empty batches atomically", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      for (const files of [
        [file(custom, "a/agent.yaml"), file(custom, "b/agent.yaml")],
        [{ name: "large.yaml", content: "é".repeat(32769) }],
        [],
        Array.from({ length: 51 }, (_, i) => file({ ...custom, id: `agent-${i}` })),
      ]) {
        yield* library.importFiles({ files, replaceExisting: true }).pipe(Effect.flip);
        assert.deepEqual((yield* library.catalog()).importedIds, []);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves snapshots through import replacement and removal", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      yield* library.importFiles({ files: [file(custom)], replaceExisting: false });
      const assignment = assignmentFor(yield* library.snapshot(custom));
      yield* library.importFiles({
        files: [file({ ...custom, instructions: "New instructions" })],
        replaceExisting: true,
      });
      yield* library.removeImported(custom.id);
      assert.isFalse((yield* library.load()).some(({ id }) => id === custom.id));
      assert.deepEqual(yield* library.readSnapshot(assignment), custom);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("persists disabled imports, rejects new launches, and preserves saved tasks", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      yield* library.importFiles({ files: [file(custom)], replaceExisting: false });
      const assignment = assignmentFor(yield* library.snapshot(custom));
      yield* library.setImportedEnabled(custom.id, false);
      const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
      assert.deepEqual((yield* restarted.catalog()).disabledIds, [custom.id]);
      assert.isTrue((yield* restarted.catalog()).definitions.some(({ id }) => id === custom.id));
      assert.isFalse((yield* restarted.load()).some(({ id }) => id === custom.id));
      const error = yield* prepareAgentPersonaLaunch({ personaId: custom.id }, [], restarted).pipe(
        Effect.flip,
      );
      assert.include(String(error), "disabled");
      assert.deepEqual(yield* restarted.readSnapshot(assignment), custom);
      yield* restarted.setImportedEnabled(custom.id, true);
      assert.deepEqual((yield* restarted.catalog()).disabledIds, []);
      assert.deepEqual(
        (yield* restarted.load()).find(({ id }) => id === custom.id),
        custom,
      );
      const enabledError = yield* prepareAgentPersonaLaunch(
        { personaId: custom.id },
        [],
        restarted,
      ).pipe(Effect.flip);
      assert.notInclude(String(enabledError), "disabled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves disabled state on replacement and clears it on removal", () =>
    Effect.gen(function* () {
      const { library, write } = yield* fixture;
      yield* write("source.yaml", custom);
      yield* library.importFiles({ files: [file(custom)], replaceExisting: true });
      yield* library.setImportedEnabled(custom.id, false);
      yield* library.importFiles({
        files: [file({ ...custom, instructions: "Replacement" })],
        replaceExisting: true,
      });
      assert.deepEqual((yield* library.catalog()).disabledIds, [custom.id]);
      assert.deepEqual(yield* library.load(), []);
      yield* library
        .importFiles({ files: [file(custom)], replaceExisting: false })
        .pipe(Effect.flip);
      yield* library.removeImported(custom.id);
      assert.deepEqual((yield* library.catalog()).disabledIds, []);
      assert.deepEqual(yield* library.load(), [custom]);
      yield* library.setImportedEnabled(custom.id, false).pipe(Effect.flip);
      yield* library.importFiles({ files: [file(custom)], replaceExisting: true });
      assert.deepEqual((yield* library.catalog()).disabledIds, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("treats previously imported definitions without a toggle field as enabled", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      yield* fs.writeFileString(
        path.join(stateDir, "imported-agent-personas.json"),
        json([custom]),
      );
      assert.deepEqual((yield* library.catalog()).disabledIds, []);
      assert.deepEqual(
        (yield* library.load()).find(({ id }) => id === custom.id),
        custom,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes imports from different sessions without losing either batch", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      const secondSession = createAgentPersonaLibrary({ fs, path, stateDir });
      yield* Effect.all(
        [
          library.importFiles({ files: [file(custom)], replaceExisting: false }),
          secondSession.importFiles({
            files: [file({ ...custom, id: "other-agent" })],
            replaceExisting: false,
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual((yield* library.catalog()).importedIds.toSorted(), [
        "other-agent",
        custom.id,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("removing folder-loaded agents", () => {
  it.effect(
    "removes a source agent durably without deleting its file or snapshot, and allows reimport",
    () =>
      Effect.gen(function* () {
        const { library, write, fs, path, stateDir, folder } = yield* fixture;
        const scout = { ...custom, displayName: "My Local Scout" };
        yield* write("local-scout.yaml", scout);
        yield* write("other.yaml", { ...custom, id: "other-agent" });
        const assignment = {
          ...assignmentFor(yield* library.snapshot(scout)),
          displayName: scout.displayName,
        };
        yield* library.removeSource(scout.id);
        const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
        assert.deepEqual(
          (yield* restarted.load()).map(({ id }) => id),
          ["other-agent"],
        );
        assert.equal(yield* fs.readFileString(path.join(folder, "local-scout.yaml")), yaml(scout));
        const error = yield* prepareAgentPersonaLaunch({ personaId: scout.id }, [], restarted).pipe(
          Effect.flip,
        );
        assert.include(String(error), "Unknown persona");
        assert.deepEqual(yield* restarted.readSnapshot(assignment), scout);
        yield* restarted.importFiles({
          files: [{ name: "local-scout.yaml", content: yaml(scout) }],
          replaceExisting: false,
        });
        assert.isTrue((yield* restarted.load()).some(({ id }) => id === scout.id));
        yield* restarted.removeImported(scout.id);
        assert.isFalse((yield* restarted.load()).some(({ id }) => id === scout.id));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "serializes source removals across sessions and refuses stale source actions on imports",
    () =>
      Effect.gen(function* () {
        const { library, fs, path, stateDir } = yield* fixture;
        const second = createAgentPersonaLibrary({ fs, path, stateDir });
        yield* Effect.all([library.removeSource("scout"), second.removeSource("builder")], {
          concurrency: "unbounded",
        });
        const remaining = (yield* library.load()).map(({ id }) => id);
        assert.notInclude(remaining, "scout");
        assert.notInclude(remaining, "builder");
        yield* library.importFiles({
          files: [{ name: "agent.yaml", content: yaml(custom) }],
          replaceExisting: false,
        });
        assert.include(
          String(yield* library.removeSource(custom.id).pipe(Effect.flip)),
          "Remove import",
        );
        assert.isTrue((yield* library.load()).some(({ id }) => id === custom.id));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("complete agent removal", () => {
  it.effect(
    "removes source agents, imports, and disabled overrides without revealing a fallback",
    () =>
      Effect.gen(function* () {
        for (const mode of ["source", "import", "override"] as const) {
          const { library, write, fs, path, stateDir, folder } = yield* fixture;
          if (mode !== "import") yield* write("agent.yaml", custom);
          if (mode !== "source") {
            yield* library.importFiles({
              files: [{ name: "agent.yaml", content: yaml(custom) }],
              replaceExisting: true,
            });
            yield* library.setImportedEnabled(custom.id, false);
          }
          const assignment = assignmentFor(yield* library.snapshot(custom));
          yield* library.removeAgent(custom.id);
          const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
          const catalog = yield* restarted.catalog();
          assert.isFalse(catalog.definitions.some(({ id }) => id === custom.id));
          assert.notInclude(catalog.importedIds, custom.id);
          assert.notInclude(catalog.disabledIds, custom.id);
          assert.deepEqual(yield* restarted.readSnapshot(assignment), custom);
          if (mode !== "import")
            assert.equal(yield* fs.readFileString(path.join(folder, "agent.yaml")), yaml(custom));
          yield* restarted.removeAgent(custom.id);
          yield* restarted.importFiles({
            files: [{ name: "agent.yaml", content: yaml(custom) }],
            replaceExisting: false,
          });
          assert.isTrue((yield* restarted.load()).some(({ id }) => id === custom.id));
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("editing imported agents", () => {
  const edit = (definition = custom): AgentPersonaEditInput => ({
    personaId: definition.id,
    expectedDigest: definitionDigest(definition),
    displayName: definition.displayName,
    instructions: definition.instructions,
    description: definition.description,
    authorityPolicy: definition.authority.defaultPolicy,
    modelRoute: definition.modelRoute,
  });

  it.effect(
    "updates only the imported copy and preserves source, instructions, snapshots, and disabled state",
    () =>
      Effect.gen(function* () {
        const { library, write, fs, path, stateDir, folder } = yield* fixture;
        yield* write("agent.yaml", custom);
        yield* library.importFiles({
          files: [{ name: "agent.yaml", content: yaml(custom) }],
          replaceExisting: true,
        });
        const assignment = assignmentFor(yield* library.snapshot(custom));
        yield* library.setImportedEnabled(custom.id, false);
        const update: AgentPersonaEditInput = {
          ...edit(),
          displayName: "Edited Researcher",
          description: "Edited description",
          authorityPolicy: "workspace-write",
          modelRoute: [
            {
              driver: ProviderDriverKind.make("codex"),
              model: "team-model",
              reasoningEffort: "medium",
            },
            custom.modelRoute[1],
          ],
        };
        yield* library.editImported(update);
        const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
        const catalog = yield* restarted.catalog();
        const changed = catalog.definitions.find(({ id }) => id === custom.id)!;
        assert.deepEqual(changed, {
          ...custom,
          displayName: update.displayName,
          description: update.description,
          version: custom.version + 1,
          authority: { defaultPolicy: "workspace-write", allowedPolicies: ["workspace-write"] },
          modelRoute: update.modelRoute,
        });
        assert.include(catalog.disabledIds, custom.id);
        assert.equal(yield* fs.readFileString(path.join(folder, "agent.yaml")), yaml(custom));
        assert.deepEqual(yield* restarted.readSnapshot(assignment), custom);
        assert.notEqual(definitionDigest(changed), assignment.definitionDigest);
        yield* restarted.setImportedEnabled(custom.id, true);
        assert.deepEqual(
          (yield* restarted.load()).find(({ id }) => id === custom.id),
          changed,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects stale edits, removed imports, invalid details, and oversized definitions without changing stored data",
    () =>
      Effect.gen(function* () {
        const { library } = yield* fixture;
        yield* library.importFiles({
          files: [{ name: "agent.yaml", content: yaml(custom) }],
          replaceExisting: false,
        });
        for (const input of [
          { ...edit(), displayName: " " },
          { ...edit(), description: "x".repeat(65536) },
        ]) {
          yield* library.editImported(input).pipe(Effect.flip);
          assert.deepEqual(
            (yield* library.load()).find(({ id }) => id === custom.id),
            custom,
          );
        }
        yield* library.editImported({ ...edit(), displayName: "First edit" });
        assert.include(
          String(
            yield* library.editImported({ ...edit(), displayName: "Stale edit" }).pipe(Effect.flip),
          ),
          "changed in another session",
        );
        assert.equal(
          (yield* library.load()).find(({ id }) => id === custom.id)?.displayName,
          "First edit",
        );
        yield* library.removeAgent(custom.id);
        assert.include(
          String(yield* library.editImported(edit()).pipe(Effect.flip)),
          "no longer exists",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "requires an imported copy and retains allowed policy choices when the default is unchanged",
    () =>
      Effect.gen(function* () {
        const { library, write } = yield* fixture;
        const definition = decodeAgentPersonaDefinition({
          ...custom,
          authority: {
            defaultPolicy: "read-only",
            allowedPolicies: ["read-only", "workspace-write"],
          },
        });
        yield* write("agent.yaml", definition);
        yield* library.editImported(edit(definition)).pipe(Effect.flip);
        yield* library.importFiles({
          files: [{ name: "agent.yaml", content: yaml(definition) }],
          replaceExisting: true,
        });
        yield* library.editImported({ ...edit(definition), displayName: "New name" });
        assert.deepEqual((yield* library.load())[0]?.authority, definition.authority);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("confirmed import replacement", () => {
  it.effect("reports conflicts before writing the batch and replaces only after confirmation", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yaml(custom) }],
        replaceExisting: false,
      });
      yield* library.setImportedEnabled(custom.id, false);
      const assignment = assignmentFor(yield* library.snapshot(custom));
      const replacement = { ...custom, version: custom.version + 1, displayName: "Company update" };
      const files = [
        { name: "updated/agent.yaml", content: yaml(replacement) },
        { name: "new/agent.yaml", content: yaml({ ...custom, id: "new-agent" }) },
      ];
      const conflict = yield* library
        .importFiles({ files, replaceExisting: false })
        .pipe(Effect.flip);
      if (!isImportConflict(conflict)) return yield* Effect.die("Expected import conflicts");
      assert.deepEqual(conflict.conflicts, [
        {
          personaId: custom.id,
          displayName: custom.displayName,
          definitionDigest: definitionDigest(custom),
        },
      ]);
      assert.deepEqual(
        (yield* library.catalog()).definitions.find(({ id }) => id === custom.id),
        custom,
      );
      assert.isFalse((yield* library.catalog()).definitions.some(({ id }) => id === "new-agent"));
      yield* library.importFiles({
        files,
        replaceExisting: true,
        confirmedConflicts: conflict.conflicts,
      });
      const updated = yield* library.catalog();
      assert.deepEqual(
        updated.definitions.find(({ id }) => id === custom.id),
        replacement,
      );
      assert.isTrue(updated.definitions.some(({ id }) => id === "new-agent"));
      assert.include(updated.disabledIds, custom.id);
      assert.deepEqual(yield* library.readSnapshot(assignment), custom);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("requires fresh confirmation after an edit or a new conflicting ID appears", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yaml(custom) }],
        replaceExisting: false,
      });
      const files = [
        { name: "agent.yaml", content: yaml({ ...custom, version: 10 }) },
        { name: "new.yaml", content: yaml({ ...custom, id: "new-agent" }) },
      ];
      const original = yield* library
        .importFiles({ files, replaceExisting: false })
        .pipe(Effect.flip);
      if (!isImportConflict(original)) return yield* Effect.die("Expected import conflicts");
      yield* library.editImported({
        personaId: custom.id,
        expectedDigest: definitionDigest(custom),
        displayName: "Concurrent edit",
        description: custom.description,
        instructions: custom.instructions,
        authorityPolicy: custom.authority.defaultPolicy,
        modelRoute: custom.modelRoute,
      });
      yield* library.importFiles({
        files: [
          {
            name: "new.yaml",
            content: json({ ...custom, id: "new-agent", displayName: "Another import" }),
          },
        ],
        replaceExisting: false,
      });
      const stale = yield* library
        .importFiles({ files, replaceExisting: true, confirmedConflicts: original.conflicts })
        .pipe(Effect.flip);
      if (!isImportConflict(stale)) return yield* Effect.die("Expected updated conflicts");
      assert.lengthOf(stale.conflicts, 2);
      assert.equal(
        (yield* library.catalog()).definitions.find(({ id }) => id === custom.id)?.displayName,
        "Concurrent edit",
      );
      yield* library.importFiles({
        files,
        replaceExisting: true,
        confirmedConflicts: stale.conflicts,
      });
      assert.equal(
        (yield* library.catalog()).definitions.find(({ id }) => id === custom.id)?.version,
        10,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("selective import replacement", () => {
  it.effect("keeps skipped definitions and imports selected replacements and new agents", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      const kept = { ...custom, id: "keep-agent", displayName: "Local edits" };
      yield* library.importFiles({
        files: [custom, kept].map((value) => ({
          name: `${value.id}/agent.yaml`,
          content: json(value),
        })),
        replaceExisting: false,
      });
      yield* library.setImportedEnabled(kept.id, false);
      const files = [
        { ...custom, version: 10 },
        { ...kept, version: 10, displayName: "Company update" },
        { ...custom, id: "new-agent" },
      ].map((value) => ({ name: `${value.id}/agent.yaml`, content: yaml(value) }));
      const conflict = yield* library
        .importFiles({ files, replaceExisting: false })
        .pipe(Effect.flip);
      if (!isImportConflict(conflict)) return yield* Effect.die("Expected conflicts");
      const result = yield* library.importFiles({
        files,
        replaceExisting: true,
        confirmedConflicts: conflict.conflicts.filter(({ personaId }) => personaId === custom.id),
        skippedPersonaIds: [kept.id],
      });
      assert.deepEqual(result.importedIds, [custom.id, "new-agent"]);
      const catalog = yield* library.catalog();
      assert.deepEqual(
        catalog.definitions.find(({ id }) => id === kept.id),
        kept,
      );
      assert.include(catalog.disabledIds, kept.id);
      assert.equal(catalog.definitions.find(({ id }) => id === custom.id)?.version, 10);
      assert.isTrue(catalog.definitions.some(({ id }) => id === "new-agent"));
      const allSkipped = yield* library.importFiles({
        files,
        replaceExisting: true,
        confirmedConflicts: [],
        skippedPersonaIds: [custom.id, kept.id, "new-agent"],
      });
      assert.deepEqual(allSkipped.importedIds, []);
      assert.deepEqual(yield* library.catalog(), catalog);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not restore a skipped agent removed while confirmation was open", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      const files = [{ name: "agent.yaml", content: yaml(custom) }];
      yield* library.importFiles({ files, replaceExisting: false });
      yield* library.removeAgent(custom.id);
      const result = yield* library.importFiles({
        files,
        replaceExisting: true,
        confirmedConflicts: [],
        skippedPersonaIds: [custom.id],
      });
      assert.deepEqual(result.importedIds, []);
      assert.isFalse((yield* library.catalog()).definitions.some(({ id }) => id === custom.id));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("YAML agent definitions", () => {
  it.effect(
    "imports every YAML extension and preserves literal instructions in JSON storage and snapshots",
    () =>
      Effect.gen(function* () {
        const { library, fs, path, stateDir } = yield* fixture;
        const instructions = '# Researcher\n\nCite "file paths".\nDo not edit files.';
        const { instructions: _instructions, ...fields } = custom;
        const content =
          yaml(fields) +
          'instructions: |-\n  # Researcher\n\n  Cite "file paths".\n  Do not edit files.\n';
        const result = yield* library.importFiles({
          files: [
            { name: "team/agent.YAML", content },
            { name: "team/other.yaml", content: yaml({ ...custom, id: "other" }) },
            { name: "team/third.yml", content: yaml({ ...custom, id: "third" }) },
          ],
          replaceExisting: false,
        });
        assert.deepEqual(result.importedIds, [custom.id, "other", "third"]);
        const definition = (yield* library.load()).find(({ id }) => id === custom.id)!;
        assert.deepEqual(definition, { ...custom, instructions });
        const snapshot = assignmentFor(yield* library.snapshot(definition));
        assert.deepEqual(yield* library.readSnapshot(snapshot), definition);
        const stored = yield* fs.readFileString(
          path.join(stateDir, "imported-agent-personas.json"),
        );
        assert.isTrue(stored.trimStart().startsWith("["));
        const conflict = yield* library
          .importFiles({
            files: [{ name: "agent.yaml", content: yaml(definition) }],
            replaceExisting: false,
          })
          .pipe(Effect.flip);
        if (!isImportConflict(conflict)) return yield* Effect.die("Expected conflict");
        assert.equal(conflict.conflicts[0]?.definitionDigest, definitionDigest(definition));
        yield* library.importFiles({
          files: [{ name: "agent.yml", content: yaml({ ...definition, version: 4 }) }],
          replaceExisting: true,
          confirmedConflicts: conflict.conflicts,
        });
        assert.equal((yield* library.load()).find(({ id }) => id === custom.id)?.version, 4);
        assert.deepEqual(yield* library.readSnapshot(snapshot), definition);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("loads YAML source folders and rejects duplicate IDs across extensions", () =>
    Effect.gen(function* () {
      const { library, fs, path, folder, write } = yield* fixture;
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "agent.yml"), yaml(custom));
      assert.deepEqual(yield* library.load(), [custom]);
      yield* write("agent.yaml", custom);
      assert.include(String(yield* library.load().pipe(Effect.flip)), "Duplicate persona id");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects malformed or invalid YAML and duplicate IDs before writing any files", () =>
    Effect.gen(function* () {
      const { library } = yield* fixture;
      for (const content of [
        "id: [broken",
        "id: one\nid: two",
        yaml({ ...custom, version: "one" }),
        yaml({ ...custom, outputArtifact: "UnknownArtifact" }),
        yaml(custom) + "\n---\n" + yaml(custom),
        "id: !custom researcher",
        "id: &name researcher\ndisplayName: *name",
      ]) {
        const error = yield* library
          .importFiles({
            files: [
              { name: "valid.yaml", content: yaml({ ...custom, id: "valid" }) },
              { name: "invalid.yaml", content },
            ],
            replaceExisting: false,
          })
          .pipe(Effect.flip);
        assert.include(String(error), "invalid.yaml");
        assert.isFalse((yield* library.load()).some(({ id }) => id === "valid"));
      }
      const duplicate = yield* library
        .importFiles({
          files: [
            { name: "agent.yaml", content: yaml(custom) },
            { name: "agent.yaml", content: yaml(custom) },
          ],
          replaceExisting: false,
        })
        .pipe(Effect.flip);
      assert.include(String(duplicate), "Multiple selected files");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects JSON imports and ignores JSON files in source folders", () =>
    Effect.gen(function* () {
      const { library, fs, path, folder } = yield* fixture;
      const error = yield* library
        .importFiles({
          files: [{ name: "team/agent.json", content: json(custom) }],
          replaceExisting: false,
        })
        .pipe(Effect.flip);
      assert.include(String(error), "Unsupported agent file: team/agent.json");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "legacy.json"), json(custom));
      yield* fs.writeFileString(path.join(folder, "agent.yaml"), yaml({ ...custom, id: "kept" }));
      assert.deepEqual(
        (yield* library.load()).map(({ id }) => id),
        ["kept"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("restoring removed agents", () => {
  it.effect("lists removed folder agents for restore and brings them back", () =>
    Effect.gen(function* () {
      const { library, write, fs, path, stateDir } = yield* fixture;
      yield* write("agent.yaml", custom);
      yield* library.removeAgent(custom.id);
      const removedCatalog = yield* library.catalog();
      assert.deepEqual(
        removedCatalog.removedSources.map(({ id }) => id),
        [custom.id],
      );
      assert.isFalse(removedCatalog.definitions.some(({ id }) => id === custom.id));
      assert.isFalse((yield* library.load()).some(({ id }) => id === custom.id));
      yield* library.restoreSource(custom.id);
      const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
      const restored = yield* restarted.catalog();
      assert.deepEqual(restored.removedSources, []);
      assert.isTrue(restored.definitions.some(({ id }) => id === custom.id));
      assert.include(
        String(yield* restarted.restoreSource(custom.id).pipe(Effect.flip)),
        "not removed",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not list a removed source while an imported copy overrides it", () =>
    Effect.gen(function* () {
      const { library, write } = yield* fixture;
      yield* write("agent.yaml", custom);
      yield* library.removeSource(custom.id);
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yaml({ ...custom, version: 9 }) }],
        replaceExisting: false,
      });
      const catalog = yield* library.catalog();
      assert.deepEqual(catalog.removedSources, []);
      assert.equal(catalog.definitions.find(({ id }) => id === custom.id)?.version, 9);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("personal agents", () => {
  it.effect(
    "creates an enabled imported agent from Settings details and rejects duplicate IDs",
    () =>
      Effect.gen(function* () {
        const { library, fs, path, stateDir } = yield* fixture;
        const created = yield* library.createPersona({
          id: "my-reviewer",
          displayName: "My Reviewer",
          description: "Reviews my changes.",
          instructions: "# My Reviewer\n\nReview carefully.",
          authorityPolicy: "read-only",
          modelRoute: custom.modelRoute,
        });
        assert.equal(created.personaId, "my-reviewer");
        const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
        const catalog = yield* restarted.catalog();
        const definition = catalog.definitions.find(({ id }) => id === "my-reviewer");
        assert.isTrue(catalog.importedIds.includes("my-reviewer"));
        assert.isFalse(catalog.disabledIds.includes("my-reviewer"));
        assert.deepEqual(definition?.authority, {
          defaultPolicy: "read-only",
          allowedPolicies: ["read-only"],
        });
        assert.equal(definition?.outputArtifact, undefined);
        assert.equal(definition?.acceptedInput, undefined);
        assert.equal(definition?.version, 1);
        assert.isTrue((yield* restarted.load()).some(({ id }) => id === "my-reviewer"));
        const duplicate = yield* restarted
          .createPersona({
            id: "my-reviewer",
            displayName: "Again",
            description: "Again.",
            instructions: "Again.",
            authorityPolicy: "read-only",
            modelRoute: custom.modelRoute,
          })
          .pipe(Effect.flip);
        assert.include(String(duplicate), "already exists");
        // Former bundled IDs are available to user-authored definitions.
        const scout = yield* restarted.createPersona({
          id: "scout",
          displayName: "Scout",
          description: "My research persona.",
          instructions: "Collect evidence.",
          authorityPolicy: "read-only",
          modelRoute: custom.modelRoute,
        });
        assert.equal(scout.personaId, "scout");
        assert.deepEqual(
          (yield* restarted.load()).map(({ id }) => id),
          ["my-reviewer", "scout"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("reading and editing definitions", () => {
  it.effect("reads any listed definition, including removed sources, and edits instructions", () =>
    Effect.gen(function* () {
      const { library, write } = yield* fixture;
      yield* write("agent.yaml", custom);
      assert.deepEqual(yield* library.read(custom.id), custom);
      yield* library.removeSource(custom.id);
      assert.deepEqual(yield* library.read(custom.id), custom);
      assert.include(
        String(yield* library.read("missing-agent").pipe(Effect.flip)),
        "Unknown agent",
      );
      const created = yield* library.createPersona({
        id: "my-reviewer",
        displayName: "My Reviewer",
        description: "Reviews my changes.",
        instructions: "Review carefully.",
        authorityPolicy: "read-only",
        modelRoute: custom.modelRoute,
      });
      const before = yield* library.read(created.personaId);
      yield* library.editImported({
        personaId: created.personaId,
        expectedDigest: definitionDigest(before),
        displayName: before.displayName,
        description: before.description,
        instructions: "Review carefully.\n\nAlways cite file paths.",
        authorityPolicy: "read-only",
        modelRoute: before.modelRoute,
      });
      const after = yield* library.read(created.personaId);
      assert.equal(after.version, before.version + 1);
      assert.include(after.instructions, "Always cite file paths.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("library sources", () => {
  it.effect("reports the default folder, its file count, and every folder-loaded origin", () =>
    Effect.gen(function* () {
      const { library, write, stateDir, path, fs } = yield* fixture;
      const before = yield* library.sources();
      assert.equal(before.configured, false);
      assert.equal(before.configPath, path.join(stateDir, "agent-personas.json"));
      assert.deepEqual(before.folders, [
        {
          configuredPath: "personas",
          path: path.join(stateDir, "personas"),
          exists: false,
          definitionCount: 0,
        },
      ]);
      assert.equal((yield* library.catalog()).sourcePaths.size, 0);

      yield* write("researcher.yaml", custom);
      yield* fs.writeFileString(path.join(stateDir, "personas", "notes.md"), "ignored");
      const after = yield* library.sources();
      assert.deepEqual(
        after.folders.map(({ exists, definitionCount }) => ({ exists, definitionCount })),
        [{ exists: true, definitionCount: 1 }],
      );
      assert.equal(
        (yield* library.catalog()).sourcePaths.get(custom.id),
        path.join(stateDir, "personas", "researcher.yaml"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes the folder configuration, creating state-directory folders on demand", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      const team = path.join(stateDir, "..", `${path.basename(stateDir)}-team`);
      yield* fs.makeDirectory(team);
      yield* fs.writeFileString(path.join(team, "a.yaml"), yaml({ ...custom, id: "another" }));
      yield* library.setFolders({ folders: ["personas", team, "personas"] });
      const sources = yield* library.sources();
      assert.equal(sources.configured, true);
      assert.deepEqual(
        sources.folders.map(({ configuredPath, exists, definitionCount }) => ({
          configuredPath,
          exists,
          definitionCount,
        })),
        [
          { configuredPath: "personas", exists: true, definitionCount: 0 },
          { configuredPath: team, exists: true, definitionCount: 1 },
        ],
      );
      assert.deepEqual(
        (yield* library.load()).map(({ id }) => id),
        ["another"],
      );

      yield* library.setFolders({ folders: [] });
      assert.deepEqual(yield* library.load(), []);
      assert.deepEqual((yield* library.sources()).folders, []);
      yield* fs.remove(team, { recursive: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects folders that do not exist outside the state directory and non-folders", () =>
    Effect.gen(function* () {
      const { library, fs, path, stateDir } = yield* fixture;
      const missing = path.join(stateDir, "..", `${path.basename(stateDir)}-missing`);
      assert.include(
        String(yield* library.setFolders({ folders: [missing] }).pipe(Effect.flip)),
        "does not exist",
      );
      yield* fs.writeFileString(path.join(stateDir, "file.yaml"), yaml(custom));
      assert.include(
        String(yield* library.setFolders({ folders: ["file.yaml"] }).pipe(Effect.flip)),
        "Not a folder",
      );
      // A rejected update leaves the configuration untouched.
      assert.equal((yield* library.sources()).configured, false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("nested source folders", () => {
  it.effect("loads definitions from subfolders in sorted order and skips dot-directories", () =>
    Effect.gen(function* () {
      const { library, fs, path, folder, write } = yield* fixture;
      yield* write("z-top.yaml", { ...custom, id: "top" });
      yield* fs.makeDirectory(path.join(folder, "team-b", "deep"), { recursive: true });
      yield* fs.makeDirectory(path.join(folder, "team-a"), { recursive: true });
      yield* fs.makeDirectory(path.join(folder, ".git"), { recursive: true });
      yield* fs.writeFileString(
        path.join(folder, "team-a", "agent.yaml"),
        yaml({ ...custom, id: "team-a-agent" }),
      );
      yield* fs.writeFileString(
        path.join(folder, "team-b", "deep", "agent.yaml"),
        yaml({ ...custom, id: "team-b-agent" }),
      );
      yield* fs.writeFileString(
        path.join(folder, ".git", "agent.yaml"),
        yaml({ ...custom, id: "ignored" }),
      );
      yield* fs.writeFileString(path.join(folder, "team-a", "README.md"), "docs");
      assert.deepEqual(
        (yield* library.load()).map(({ id }) => id),
        ["team-a-agent", "team-b-agent", "top"],
      );
      assert.equal(
        (yield* library.catalog()).sourcePaths.get("team-b-agent"),
        path.join(folder, "team-b", "deep", "agent.yaml"),
      );
      assert.deepEqual(
        (yield* library.sources()).folders.map(({ definitionCount }) => definitionCount),
        [3],
      );
      // Duplicate ids across subfolders still fail rather than picking a winner.
      yield* fs.writeFileString(
        path.join(folder, "team-b", "copy.yaml"),
        yaml({ ...custom, id: "team-a-agent" }),
      );
      assert.include(String(yield* library.load().pipe(Effect.flip)), "Duplicate persona id");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("switching source agents off", () => {
  it.effect("disables a folder agent without an import, survives restarts, and re-enables", () =>
    Effect.gen(function* () {
      const { library, write, fs, path, stateDir } = yield* fixture;
      yield* write("researcher.yaml", custom);
      yield* library.setEnabled(custom.id, false);
      assert.deepEqual((yield* library.catalog()).disabledIds, [custom.id]);
      assert.deepEqual(yield* library.load(), []);
      // The exclusion is a file, so a fresh library over the same state directory sees it.
      const reopened = createAgentPersonaLibrary({ fs, path, stateDir });
      assert.deepEqual((yield* reopened.catalog()).disabledIds, [custom.id]);
      yield* reopened.setEnabled(custom.id, true);
      assert.deepEqual((yield* library.catalog()).disabledIds, []);
      assert.deepEqual(yield* library.load(), [custom]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("disables a folder agent and lets an imported copy carry its own flag", () =>
    Effect.gen(function* () {
      const { library, write } = yield* fixture;
      yield* write("scout.yaml", BUILT_IN_AGENT_PERSONAS.scout);
      yield* library.setEnabled("scout", false);
      assert.include((yield* library.catalog()).disabledIds, "scout");
      assert.notInclude(
        (yield* library.load()).map(({ id }) => id),
        "scout",
      );
      // Importing a copy overrides the source; the copy starts enabled and is toggled on its own record.
      yield* library.importFiles({
        files: [
          { name: "scout.yaml", content: yaml({ ...BUILT_IN_AGENT_PERSONAS.scout, version: 2 }) },
        ],
        replaceExisting: true,
      });
      assert.notInclude((yield* library.catalog()).disabledIds, "scout");
      yield* library.setEnabled("scout", false);
      assert.include((yield* library.catalog()).disabledIds, "scout");
      assert.include(
        String(yield* library.setEnabled("no-such-agent", false).pipe(Effect.flip)),
        "no longer exists",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
