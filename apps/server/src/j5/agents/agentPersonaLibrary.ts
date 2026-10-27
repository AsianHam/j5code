// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing for deterministic ids and digests.
import * as NodeCrypto from "node:crypto";
import {
  AgentPersonaId,
  isAgentPersonaDefinitionFile,
  AgentPersonaImportConflictError,
  AGENT_PERSONA_IMPORT_MAX_BYTES,
  AGENT_PERSONA_IMPORT_MAX_FILES,
  type AgentPersonaImportInput,
  type AgentPersonaCreateInput,
  type AgentPersonaLibraryFoldersInput,
  type AgentPersonaEditInput,
  type OrchestrationV2AgentPersonaAssignment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parseDocument } from "yaml";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerConfig } from "../../config.ts";
import {
  decodeAgentPersonaDefinition,
  getBuiltInAgentPersona,
  AgentPersonaDefinition,
} from "./agentPersonas.ts";

export class AgentPersonaLibraryError extends Schema.TaggedError<AgentPersonaLibraryError>()(
  "AgentPersonaLibraryError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const decodeDefinitionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentPersonaDefinition),
);
/** Launch snapshots are server-written JSON, never user files. */
const decodeSnapshot = Effect.fn("AgentPersonaLibrary.decodeSnapshot")(function* (text: string) {
  const definition = yield* decodeDefinitionJson(text);
  return yield* Effect.try(() => decodeAgentPersonaDefinition(definition));
});
/** User-authored definitions (source folders and imports) are YAML documents. */
const decodeDefinition = Effect.fn("AgentPersonaLibrary.decodeDefinition")(function* (
  text: string,
) {
  const definition = yield* Effect.try((): unknown => {
    const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
    const issue = document.errors[0] ?? document.warnings[0];
    if (issue) throw issue;
    return document.toJS({ maxAliasCount: 0 });
  });
  return yield* Effect.try(() => decodeAgentPersonaDefinition(definition));
});
const ImportedDefinition = Schema.Struct({
  ...AgentPersonaDefinition.fields,
  enabled: Schema.optional(Schema.Boolean),
});
const ImportedDefinitions = Schema.Array(ImportedDefinition);
const decodeImports = Schema.decodeUnknownEffect(Schema.fromJsonString(ImportedDefinitions));
const encodeImports = Schema.encodeEffect(Schema.fromJsonString(ImportedDefinitions));
const RemovedSourceIds = Schema.Array(AgentPersonaId);
const decodeRemovedSourceIds = Schema.decodeUnknownEffect(Schema.fromJsonString(RemovedSourceIds));
const encodeRemovedSourceIds = Schema.encodeEffect(Schema.fromJsonString(RemovedSourceIds));
/** Folder agents switched off in this environment; imported copies carry their own flag. */
const DISABLED_SOURCES_FILE = "disabled-source-agent-personas.json";
// RPC layers are session-local; serialize library mutations across all sessions in this process.
const importPermit = Semaphore.makeUnsafe(1);
const encodeDefinition = Schema.encodeEffect(Schema.fromJsonString(AgentPersonaDefinition));
const LibraryConfig = Schema.Struct({
  folders: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
});
const decodeLibraryConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryConfig));
const encodeLibraryConfig = Schema.encodeEffect(Schema.fromJsonString(LibraryConfig));
const DEFAULT_FOLDER = "personas";
const MAX_FOLDER_DEPTH = 16;
export const definitionDigest = (definition: AgentPersonaDefinition): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(definition)).digest("hex");

/** Why a catalog cannot staff `id`, or null when it can; j5_propose_crew and playbooks share this. */
export const personaCatalogProblem = (
  catalog: {
    readonly definitions: ReadonlyArray<{ readonly id: string }>;
    readonly disabledIds: ReadonlyArray<string>;
  },
  id: string,
): "missing" | "disabled" | null =>
  !catalog.definitions.some((definition) => definition.id === id)
    ? "missing"
    : catalog.disabledIds.includes(id)
      ? "disabled"
      : null;

/** Source folders are read on catalog requests and launches; running tasks use immutable snapshots. */
export function createAgentPersonaLibrary(storage?: {
  readonly stateDir: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  /** Configured folders, or the default folder when agent-personas.json is absent. */
  const resolveFolders = Effect.fn("AgentPersonaLibrary.resolveFolders")(function* () {
    if (storage === undefined) return { configured: false, folders: [] };
    const { stateDir, fs, path } = storage;
    const configText = yield* fs.readFileString(path.join(stateDir, "agent-personas.json")).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    );
    const configuredPaths = Option.isSome(configText)
      ? (yield* decodeLibraryConfig(configText.value)).folders
      : [DEFAULT_FOLDER];
    return {
      configured: Option.isSome(configText),
      folders: configuredPaths.map((configuredPath) => ({
        configuredPath,
        path: path.resolve(stateDir, configuredPath),
      })),
    };
  });

  /**
   * Every definition file under a folder, walking subfolders in sorted order like the
   * import picker does. Dot-directories such as .git and `node_modules` are skipped, and so is
   * an entry that vanished or is a dangling link; depth is capped so a symlink cycle cannot spin
   * forever. With a `limit`, the walk stops once it has found more files than that, so a caller
   * refusing an oversized selection need not scan the rest of the tree. Returns null when the
   * root does not exist.
   */
  const listDefinitionFiles = Effect.fn("AgentPersonaLibrary.listDefinitionFiles")(function* (
    root: string,
    limit = Number.POSITIVE_INFINITY,
  ) {
    if (storage === undefined) return null;
    const { fs, path } = storage;
    const files: string[] = [];
    const walk: (folder: string, depth: number) => Effect.Effect<void, PlatformError> = Effect.fn(
      "AgentPersonaLibrary.walk",
    )(function* (folder, depth) {
      const names = yield* fs.readDirectory(folder);
      for (const name of [...names].sort()) {
        if (files.length > limit) return;
        const entry = path.join(folder, name);
        const stat = yield* fs.stat(entry).pipe(
          Effect.asSome,
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeedNone,
          ),
        );
        if (Option.isNone(stat)) continue;
        if (stat.value.type === "Directory") {
          if (!name.startsWith(".") && name !== "node_modules" && depth < MAX_FOLDER_DEPTH)
            yield* walk(entry, depth + 1);
        } else if (stat.value.type === "File" && isAgentPersonaDefinitionFile(name)) {
          files.push(entry);
        }
      }
    });
    const exists = yield* fs.exists(root);
    if (!exists) return null;
    yield* walk(root, 0);
    return files;
  });

  /** YAML files directly inside a folder, listed for the import picker. Unreadable entries are skipped. */
  const listImportFiles = Effect.fn("AgentPersonaLibrary.listImportFiles")(function* (
    directory: string,
  ) {
    if (storage === undefined) return [];
    const { fs, path } = storage;
    const files: Array<{ name: string; fullPath: string }> = [];
    for (const name of [...(yield* fs.readDirectory(directory))].sort()) {
      if (!isAgentPersonaDefinitionFile(name)) continue;
      const fullPath = path.join(directory, name);
      const stat = yield* fs.stat(fullPath).pipe(Effect.option);
      if (Option.isSome(stat) && stat.value.type === "File") files.push({ name, fullPath });
    }
    return files;
  });

  /**
   * One YAML file, or every YAML file under a folder (walked like a source folder), read
   * from this machine for import. Names keep the chosen folder's name as their first
   * segment, the way a browser folder selection reports them.
   */
  const readImportFiles = Effect.fn("AgentPersonaLibrary.readImportFiles")(function* (
    target: string,
  ) {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "This environment cannot read persona files.",
      });
    const { fs, path } = storage;
    if (!path.isAbsolute(target))
      return yield* new AgentPersonaLibraryError({ message: `Choose an absolute path: ${target}` });
    const stat = yield* fs.stat(target);
    // Only regular files and folders: a FIFO would block the read, and a device can report a
    // size of 0 and slip past the size check.
    if (
      (stat.type !== "File" && stat.type !== "Directory") ||
      (stat.type === "File" && !isAgentPersonaDefinitionFile(target))
    )
      return yield* new AgentPersonaLibraryError({
        message: `Unsupported persona file: ${path.basename(target)}`,
      });
    const paths =
      stat.type === "Directory"
        ? ((yield* listDefinitionFiles(target, AGENT_PERSONA_IMPORT_MAX_FILES)) ?? [])
        : [target];
    if (paths.length === 0)
      return yield* new AgentPersonaLibraryError({
        message: "No YAML persona definitions found in the selection.",
      });
    if (paths.length > AGENT_PERSONA_IMPORT_MAX_FILES)
      return yield* new AgentPersonaLibraryError({
        message: `Select at most ${AGENT_PERSONA_IMPORT_MAX_FILES} persona definitions at a time.`,
      });
    const files: Array<{ name: string; content: string }> = [];
    for (const file of paths) {
      const name = path.relative(path.dirname(target), file);
      if (Number((yield* fs.stat(file)).size) > AGENT_PERSONA_IMPORT_MAX_BYTES)
        return yield* new AgentPersonaLibraryError({ message: `${name} exceeds 64 KiB.` });
      files.push({ name, content: yield* fs.readFileString(file) });
    }
    return files;
  });

  const loadSources = Effect.fn("AgentPersonaLibrary.loadSources")(function* () {
    if (storage === undefined) return { definitions: [], paths: new Map<string, string>() };
    const { fs } = storage;
    const { configured, folders } = yield* resolveFolders();
    const definitions = new Map<string, AgentPersonaDefinition>();
    const paths = new Map<string, string>();
    for (const folder of folders.map(({ path }) => path)) {
      const files = yield* listDefinitionFiles(folder).pipe(
        Effect.catchIf(
          (error) => !configured && error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (files === null) {
        if (configured)
          return yield* new AgentPersonaLibraryError({
            message: `Configured persona folder does not exist: ${folder}`,
          });
        continue;
      }
      for (const file of files) {
        const stat = yield* fs.stat(file);
        if (Number(stat.size) > 65536)
          return yield* new AgentPersonaLibraryError({
            message: `Persona file exceeds 64 KiB: ${file}`,
          });
        const text = yield* fs.readFileString(file);
        const definition = yield* decodeDefinition(text).pipe(
          Effect.mapError(
            (cause) =>
              new AgentPersonaLibraryError({ message: `Invalid persona file ${file}`, cause }),
          ),
        );
        if (definitions.has(definition.id))
          return yield* new AgentPersonaLibraryError({
            message: `Duplicate persona id: ${definition.id}`,
          });
        definitions.set(definition.id, definition);
        paths.set(definition.id, file);
      }
    }
    return { definitions: [...definitions.values()], paths };
  });

  /** Folder inventory for Settings; counts YAML files in the folder tree without decoding them. */
  const sources = Effect.fn("AgentPersonaLibrary.sources")(function* () {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona library storage is unavailable.",
      });
    const { path, stateDir } = storage;
    const { configured, folders } = yield* resolveFolders();
    const inventory = [];
    for (const folder of folders) {
      const files = yield* listDefinitionFiles(folder.path).pipe(Effect.orElseSucceed(() => null));
      inventory.push({
        ...folder,
        exists: files !== null,
        definitionCount: files?.length ?? 0,
      });
    }
    return {
      configPath: path.join(stateDir, "agent-personas.json"),
      configured,
      folders: inventory,
    };
  });

  /**
   * Replace the configured folder list. Folders inside the state directory are created
   * on demand; any other folder must already exist because a missing configured folder
   * fails every catalog read.
   */
  const setFolders = Effect.fn("AgentPersonaLibrary.setFolders")(function* (
    input: AgentPersonaLibraryFoldersInput,
  ) {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona library storage is unavailable.",
      });
    const { fs, path, stateDir } = storage;
    const folders: string[] = [];
    const resolved = new Set<string>();
    for (const raw of input.folders) {
      const configuredPath = raw.trim();
      const absolute = path.resolve(stateDir, configuredPath);
      if (resolved.has(absolute)) continue;
      resolved.add(absolute);
      const insideStateDir = !path.relative(stateDir, absolute).startsWith("..");
      const stat = yield* fs.stat(absolute).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(stat)) {
        if (!insideStateDir)
          return yield* new AgentPersonaLibraryError({
            message: `Folder does not exist on this environment: ${absolute}`,
          });
        yield* fs.makeDirectory(absolute, { recursive: true });
      } else if (stat.value.type !== "Directory") {
        return yield* new AgentPersonaLibraryError({
          message: `Not a folder: ${absolute}`,
        });
      }
      folders.push(configuredPath);
    }
    yield* writeFileStringAtomically({
      filePath: path.join(stateDir, "agent-personas.json"),
      contents: yield* encodeLibraryConfig({ folders }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  }, importPermit.withPermit);

  const readImports = Effect.fn("AgentPersonaLibrary.readImports")(function* () {
    if (storage === undefined) return [];
    const text = yield* storage.fs
      .readFileString(storage.path.join(storage.stateDir, "imported-agent-personas.json"))
      .pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed("[]"),
        ),
      );
    const definitions = yield* decodeImports(text);
    const ids = new Set<string>();
    for (const definition of definitions) {
      yield* Effect.try(() => decodeAgentPersonaDefinition(definition));
      if (ids.has(definition.id))
        return yield* new AgentPersonaLibraryError({
          message: `Duplicate imported persona id: ${definition.id}`,
        });
      ids.add(definition.id);
    }
    return definitions;
  });

  const readRemovedSourceIds = Effect.fn("AgentPersonaLibrary.readRemovedSourceIds")(function* () {
    if (storage === undefined) return [];
    const text = yield* storage.fs
      .readFileString(storage.path.join(storage.stateDir, "removed-source-agent-personas.json"))
      .pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed("[]"),
        ),
      );
    return yield* decodeRemovedSourceIds(text);
  });

  const readDisabledSourceIds = Effect.fn("AgentPersonaLibrary.readDisabledSourceIds")(
    function* () {
      if (storage === undefined) return [];
      const text = yield* storage.fs
        .readFileString(storage.path.join(storage.stateDir, DISABLED_SOURCES_FILE))
        .pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed("[]"),
          ),
        );
      return yield* decodeRemovedSourceIds(text);
    },
  );

  const writeDisabledSourceIds = Effect.fn("AgentPersonaLibrary.writeDisabledSourceIds")(function* (
    ids: ReadonlyArray<string>,
  ) {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona library storage is unavailable.",
      });
    yield* writeFileStringAtomically({
      filePath: storage.path.join(storage.stateDir, DISABLED_SOURCES_FILE),
      contents: yield* encodeRemovedSourceIds([...ids]),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, storage.fs),
      Effect.provideService(Path.Path, storage.path),
    );
  });

  const catalog = Effect.fn("AgentPersonaLibrary.catalog")(function* () {
    const loaded = yield* loadSources();
    const imported = yield* readImports();
    const removed = new Set(yield* readRemovedSourceIds());
    const disabledSources = new Set(yield* readDisabledSourceIds());
    const definitions = new Map(
      loaded.definitions
        .filter(({ id }) => !removed.has(id))
        .map((definition) => [definition.id, definition]),
    );
    for (const { enabled: _enabled, ...definition } of imported)
      definitions.set(definition.id, definition);
    const importedIds = new Set(imported.map(({ id }) => id));
    return {
      definitions: [...definitions.values()],
      importedIds: [...importedIds],
      disabledIds: [
        ...imported.filter(({ enabled }) => enabled === false).map(({ id }) => id),
        // An imported copy overrides its source, so only sources without one honor the disabled list.
        ...[...definitions.keys()].filter((id) => disabledSources.has(id) && !importedIds.has(id)),
      ],
      /** Excluded source definitions with no imported override; listed so they can be restored. */
      removedSources: loaded.definitions.filter(
        ({ id }) => removed.has(id) && !definitions.has(id),
      ),
      /** Source file per folder-loaded id; ids absent here are imported. */
      sourcePaths: loaded.paths as ReadonlyMap<string, string>,
    };
  });
  const load = Effect.fn("AgentPersonaLibrary.load")(function* () {
    const library = yield* catalog();
    const disabled = new Set(library.disabledIds);
    return library.definitions.filter(({ id }) => !disabled.has(id));
  });

  const writeImports = Effect.fn("AgentPersonaLibrary.writeImports")(function* (
    definitions: ReadonlyArray<typeof ImportedDefinition.Type>,
  ) {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona import storage is unavailable.",
      });
    yield* writeFileStringAtomically({
      filePath: storage.path.join(storage.stateDir, "imported-agent-personas.json"),
      contents: yield* encodeImports(definitions),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, storage.fs),
      Effect.provideService(Path.Path, storage.path),
    );
  });

  const importFiles = Effect.fn("AgentPersonaLibrary.importFiles")(function* (
    input: AgentPersonaImportInput,
  ) {
    if (input.files.length === 0 || input.files.length > AGENT_PERSONA_IMPORT_MAX_FILES)
      return yield* new AgentPersonaLibraryError({
        message: `Select between 1 and ${AGENT_PERSONA_IMPORT_MAX_FILES} YAML files.`,
      });
    const incoming = new Map<string, AgentPersonaDefinition>();
    for (const file of input.files) {
      if (!isAgentPersonaDefinitionFile(file.name))
        return yield* new AgentPersonaLibraryError({
          message: `Unsupported agent file: ${file.name}`,
        });
      if (new TextEncoder().encode(file.content).byteLength > AGENT_PERSONA_IMPORT_MAX_BYTES)
        return yield* new AgentPersonaLibraryError({ message: `${file.name} exceeds 64 KiB.` });
      const definition = yield* decodeDefinition(file.content).pipe(
        Effect.mapError(
          (cause) =>
            new AgentPersonaLibraryError({
              message: `Invalid persona definition: ${file.name}`,
              cause,
            }),
        ),
      );
      if (incoming.has(definition.id))
        return yield* new AgentPersonaLibraryError({
          message: `Multiple selected files use the id "${definition.id}". Each agent needs a unique id.`,
        });
      incoming.set(definition.id, definition);
    }
    for (const id of input.skippedPersonaIds ?? []) incoming.delete(id);
    if (incoming.size === 0) return { importedIds: [] };
    const existing = (yield* catalog()).definitions;
    const conflicts = existing
      .filter(({ id }) => incoming.has(id))
      .map((definition) => ({
        personaId: definition.id,
        displayName: definition.displayName,
        definitionDigest: definitionDigest(definition),
      }));
    const confirmationChanged =
      input.confirmedConflicts !== undefined &&
      conflicts.some(
        (conflict) =>
          !input.confirmedConflicts?.some(
            (confirmed) =>
              confirmed.personaId === conflict.personaId &&
              confirmed.definitionDigest === conflict.definitionDigest,
          ),
      );
    if (conflicts.length > 0 && (!input.replaceExisting || confirmationChanged))
      return yield* new AgentPersonaImportConflictError({
        message: confirmationChanged
          ? "Existing agents changed. Review the replacement again."
          : "Agents with these IDs already exist.",
        conflicts,
      });
    const imported = new Map(
      (yield* readImports()).map((definition) => [definition.id, definition]),
    );
    for (const [id, definition] of incoming)
      imported.set(id, {
        ...definition,
        enabled: imported.get(id)?.enabled ?? true,
      });
    yield* writeImports([...imported.values()]);
    return { importedIds: [...incoming.keys()] };
  }, importPermit.withPermit);

  const editImported = Effect.fn("AgentPersonaLibrary.editImported")(function* (
    input: AgentPersonaEditInput,
  ) {
    const imported = yield* readImports();
    const current = imported.find(({ id }) => id === input.personaId);
    if (current === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Imported agent no longer exists. Refresh the library.",
      });
    const original = yield* Effect.try(() => decodeAgentPersonaDefinition(current));
    if (definitionDigest(original) !== input.expectedDigest)
      return yield* new AgentPersonaLibraryError({
        message:
          "This agent changed in another session. Close the editor, refresh the library, and try again.",
      });
    const updated = yield* Effect.try(() =>
      decodeAgentPersonaDefinition({
        ...original,
        version: original.version + 1,
        displayName: input.displayName,
        description: input.description,
        instructions: input.instructions,
        authority:
          input.authorityPolicy === original.authority.defaultPolicy
            ? original.authority
            : {
                defaultPolicy: input.authorityPolicy,
                allowedPolicies: [input.authorityPolicy],
              },
        modelRoute: input.modelRoute,
      }),
    ).pipe(
      Effect.mapError(
        (cause) => new AgentPersonaLibraryError({ message: "Invalid agent details.", cause }),
      ),
    );
    const encoded = yield* encodeDefinition(updated);
    if (new TextEncoder().encode(encoded).byteLength > AGENT_PERSONA_IMPORT_MAX_BYTES)
      return yield* new AgentPersonaLibraryError({ message: "Persona definition exceeds 64 KiB." });
    yield* writeImports(
      imported.map((definition) =>
        definition.id === input.personaId
          ? {
              ...updated,
              enabled: current.enabled ?? true,
            }
          : definition,
      ),
    );
  }, importPermit.withPermit);

  /** Personal agents become imported definitions: editable, switchable, and removable like any import. */
  const createPersona = Effect.fn("AgentPersonaLibrary.createPersona")(function* (
    input: AgentPersonaCreateInput,
  ) {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona import storage is unavailable.",
      });
    const current = yield* catalog();
    if (
      current.definitions.some(({ id }) => id === input.id) ||
      current.removedSources.some(({ id }) => id === input.id)
    ) {
      return yield* new AgentPersonaLibraryError({
        message: `An agent with the ID "${input.id}" already exists. Choose another ID.`,
      });
    }
    const definition = yield* Effect.try(() =>
      decodeAgentPersonaDefinition({
        id: input.id,
        version: 1,
        displayName: input.displayName,
        description: input.description,
        instructions: input.instructions,
        authority: {
          defaultPolicy: input.authorityPolicy,
          allowedPolicies: [input.authorityPolicy],
        },
        modelRoute: input.modelRoute,
      }),
    ).pipe(
      Effect.mapError(
        (cause) => new AgentPersonaLibraryError({ message: "Invalid agent details.", cause }),
      ),
    );
    const encoded = yield* encodeDefinition(definition);
    if (new TextEncoder().encode(encoded).byteLength > AGENT_PERSONA_IMPORT_MAX_BYTES)
      return yield* new AgentPersonaLibraryError({ message: "Persona definition exceeds 64 KiB." });
    yield* writeImports([...(yield* readImports()), { ...definition, enabled: true }]);
    return { personaId: definition.id };
  }, importPermit.withPermit);

  const setImportedEnabled = Effect.fn("AgentPersonaLibrary.setImportedEnabled")(function* (
    id: string,
    enabled: boolean,
  ) {
    const imported = yield* readImports();
    if (!imported.some((definition) => definition.id === id))
      return yield* new AgentPersonaLibraryError({
        message: "Imported agent no longer exists in this environment.",
      });
    yield* writeImports(
      imported.map((definition) =>
        definition.id === id ? { ...definition, enabled } : definition,
      ),
    );
  }, importPermit.withPermit);

  /** On/off for any listed agent. Imported copies keep their own flag; other ids use the disabled list. */
  const setEnabled = Effect.fn("AgentPersonaLibrary.setEnabled")(function* (
    id: string,
    enabled: boolean,
  ) {
    const imported = yield* readImports();
    if (imported.some((definition) => definition.id === id)) {
      yield* writeImports(
        imported.map((definition) =>
          definition.id === id ? { ...definition, enabled } : definition,
        ),
      );
      return;
    }
    const current = yield* catalog();
    if (!current.definitions.some((definition) => definition.id === id))
      return yield* new AgentPersonaLibraryError({
        message: "Agent no longer exists in this environment. Refresh the library.",
      });
    const disabled = new Set(yield* readDisabledSourceIds());
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    yield* writeDisabledSourceIds([...disabled]);
  }, importPermit.withPermit);

  const removeImported = Effect.fn("AgentPersonaLibrary.removeImported")(function* (id: string) {
    const imported = yield* readImports();
    yield* writeImports(imported.filter((definition) => definition.id !== id));
  }, importPermit.withPermit);

  const excludeSource = Effect.fn("AgentPersonaLibrary.excludeSource")(function* (id: string) {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona library storage is unavailable.",
      });
    const removed = new Set(yield* readRemovedSourceIds());
    removed.add(id);
    yield* writeFileStringAtomically({
      filePath: storage.path.join(storage.stateDir, "removed-source-agent-personas.json"),
      contents: yield* encodeRemovedSourceIds([...removed]),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, storage.fs),
      Effect.provideService(Path.Path, storage.path),
    );
  });

  const removeSource = Effect.fn("AgentPersonaLibrary.removeSource")(function* (id: string) {
    if ((yield* readImports()).some((definition) => definition.id === id))
      return yield* new AgentPersonaLibraryError({
        message: "This agent was imported. Refresh the library and use Remove import.",
      });
    yield* excludeSource(id);
  }, importPermit.withPermit);

  const restoreSource = Effect.fn("AgentPersonaLibrary.restoreSource")(function* (id: string) {
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona library storage is unavailable.",
      });
    const removed = new Set(yield* readRemovedSourceIds());
    if (!removed.has(id))
      return yield* new AgentPersonaLibraryError({
        message: "This agent is not removed in this environment. Refresh the library.",
      });
    removed.delete(id);
    yield* writeFileStringAtomically({
      filePath: storage.path.join(storage.stateDir, "removed-source-agent-personas.json"),
      contents: yield* encodeRemovedSourceIds([...removed]),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, storage.fs),
      Effect.provideService(Path.Path, storage.path),
    );
  }, importPermit.withPermit);

  const removeAgent = Effect.fn("AgentPersonaLibrary.removeAgent")(function* (id: string) {
    const imported = yield* readImports();
    // Persist source exclusion first so deleting an override cannot reveal its source again.
    yield* excludeSource(id);
    if (imported.some((definition) => definition.id === id))
      yield* writeImports(imported.filter((definition) => definition.id !== id));
  }, importPermit.withPermit);

  /** The stored definition of any listed agent, including removed sources, for edit, duplicate, and export. */
  const read = Effect.fn("AgentPersonaLibrary.read")(function* (id: string) {
    const current = yield* catalog();
    const definition =
      current.definitions.find((candidate) => candidate.id === id) ??
      current.removedSources.find((candidate) => candidate.id === id);
    if (definition === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Unknown agent in this environment. Refresh the library.",
      });
    return definition;
  });

  const snapshot = Effect.fn("AgentPersonaLibrary.snapshot")(function* (
    definition: AgentPersonaDefinition,
  ) {
    if (storage === undefined) return undefined;
    const { fs, path, stateDir } = storage;
    const digest = definitionDigest(definition);
    yield* writeFileStringAtomically({
      filePath: path.join(stateDir, "agent-persona-snapshots", `${digest}.json`),
      contents: yield* encodeDefinition(definition),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return digest;
  });

  const readSnapshot = Effect.fn("AgentPersonaLibrary.readSnapshot")(function* (
    assignment: OrchestrationV2AgentPersonaAssignment,
  ) {
    if (assignment.definitionDigest === undefined) {
      const definition = yield* Effect.try(() => getBuiltInAgentPersona(assignment.personaId));
      if (definition.version !== assignment.definitionVersion)
        return yield* new AgentPersonaLibraryError({ message: "Unknown legacy persona version." });
      return definition;
    }
    if (storage === undefined)
      return yield* new AgentPersonaLibraryError({
        message: "Persona snapshot storage is unavailable.",
      });
    const digest = assignment.definitionDigest;
    if (!/^[a-f0-9]{64}$/.test(digest))
      return yield* new AgentPersonaLibraryError({ message: "Invalid persona snapshot digest." });
    const text = yield* storage.fs.readFileString(
      storage.path.join(storage.stateDir, "agent-persona-snapshots", `${digest}.json`),
    );
    const definition = yield* decodeSnapshot(text);
    if (
      definitionDigest(definition) !== digest ||
      definition.id !== assignment.personaId ||
      definition.version !== assignment.definitionVersion ||
      definition.displayName !== assignment.displayName
    ) {
      return yield* new AgentPersonaLibraryError({
        message: "Persona snapshot does not match its assignment.",
      });
    }
    return definition;
  });

  return {
    load,
    catalog,
    sources,
    setFolders,
    importFiles,
    listImportFiles,
    readImportFiles,
    createPersona,
    read,
    editImported,
    setImportedEnabled,
    setEnabled,
    removeImported,
    removeSource,
    removeAgent,
    restoreSource,
    snapshot,
    readSnapshot,
  };
}

/** Capture the environment at service construction; no storage means an empty library. */
export const makeAgentPersonaLibrary = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  if (Option.isNone(config)) return createAgentPersonaLibrary();
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(fs) || Option.isNone(path))
    return yield* Effect.die(new Error("Persona library requires filesystem and path services."));
  return createAgentPersonaLibrary({
    stateDir: config.value.stateDir,
    fs: fs.value,
    path: path.value,
  });
});
