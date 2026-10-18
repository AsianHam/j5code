// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing and ids for catalog paths.
import * as NodeCrypto from "node:crypto";

import {
  type SkillCatalogApplyResult,
  type SkillCatalogReplacement,
  SkillCatalogError,
  SkillCatalogSource,
  type SkillCatalogStatus,
  type SkillCatalogUpdateResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { ProcessRunner } from "../../processRunner.ts";
import {
  IncompleteApplyError,
  loadCatalog,
  loadState,
  runApply,
  skillDescription,
} from "./skillCatalogInstaller.ts";
import { readSkillsConcurrently } from "./skillFileSystem.ts";

/** J5 owns catalog validation, installation, state, and Git updates; catalogs are content only. */

// Serialize complete operations across connections in this process.
// ponytail: process-local permit; use a filesystem lock if cross-process coordination is needed.
export const skillCatalogPermit = Semaphore.makeUnsafe(1);

const TOOL_TIMEOUT = "5 minutes" as const;
const MAX_DIAGNOSTIC_CHARS = 2000;
const isSafeSource = Schema.is(SkillCatalogSource);
const redactGitUrlUserInfo = (value: string) =>
  value.replace(/((?:https?|ssh|git):\/\/)[^\s/?#]*@/gi, "$1");

export interface SkillCatalogToolDeps {
  readonly stateDir: string;
  readonly targets: ReadonlyArray<string>;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly processRunner: ProcessRunner["Service"];
}

type ResolvedSource =
  | { readonly kind: "local"; readonly catalogDir: string }
  | { readonly kind: "managed"; readonly catalogDir: string; readonly recordDir: string };

const isGitUrl = (source: string): boolean =>
  !source.startsWith("-") &&
  (/^(https?|ssh|git):\/\//.test(source) || /^[^@\s]+@[^:\s]+:[^ ]+$/.test(source));

const boundDiagnostic = (value: string): string => {
  const trimmed = redactGitUrlUserInfo(value).trim();
  if (trimmed === "") return "(no output)";
  return trimmed.length > MAX_DIAGNOSTIC_CHARS
    ? `${trimmed.slice(0, MAX_DIAGNOSTIC_CHARS)}…`
    : trimmed;
};

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const installerEffect = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SkillCatalogError({
        message: messageOf(cause),
        ...(cause instanceof IncompleteApplyError ? { result: cause.result } : {}),
      }),
  });

export const createSkillCatalogTool = (deps: SkillCatalogToolDeps) => {
  const { stateDir, targets, fs, path, processRunner } = deps;

  const resolveSource = Effect.fn("j5.skillCatalog.resolveSource")(function* (
    source: string,
  ): Effect.fn.Return<ResolvedSource, SkillCatalogError> {
    const trimmed = source.trim();
    if (trimmed === "") {
      return yield* new SkillCatalogError({
        message: "Skill catalog source is not configured. Set it in Settings → Skills first.",
      });
    }
    if (!isSafeSource(trimmed)) {
      return yield* new SkillCatalogError({
        message: "Skill catalog source must not contain Git URL credentials.",
      });
    }
    if (path.isAbsolute(trimmed)) {
      return { kind: "local", catalogDir: path.normalize(trimmed) };
    }
    if (!isGitUrl(trimmed)) {
      return yield* new SkillCatalogError({
        message: `Skill catalog source must be a Git URL or an absolute path: ${trimmed}`,
      });
    }
    const hash = NodeCrypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
    const recordDir = path.join(stateDir, "skill-catalogs", hash);
    return { kind: "managed", catalogDir: path.join(recordDir, "catalog"), recordDir };
  });

  const describeRunFailure = (operation: string, command: string, cause: unknown): string => {
    const tag = (cause as { readonly _tag?: unknown } | null)?._tag;
    if (tag === "ProcessTimeoutError") {
      return `${operation} timed out after five minutes. Filesystem changes may have occurred; retry to recover.`;
    }
    if (tag === "ProcessSpawnError") {
      return `${operation} could not start ${command} (is Git installed?): ${redactGitUrlUserInfo(String(cause))}`;
    }
    return `${operation} failed: ${redactGitUrlUserInfo(String(cause))}`;
  };

  const runCommand = Effect.fn("j5.skillCatalog.runCommand")(function* (
    operation: string,
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ): Effect.fn.Return<
    { readonly stdout: string; readonly stderr: string; readonly code: number | null },
    SkillCatalogError
  > {
    const output = yield* processRunner
      .run({
        command,
        args: [...args],
        cwd,
        timeout: TOOL_TIMEOUT,
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SkillCatalogError({ message: describeRunFailure(operation, command, cause) }),
        ),
      );
    return { stdout: output.stdout, stderr: output.stderr, code: output.code };
  });

  const cloneCatalog = Effect.fn("j5.skillCatalog.cloneCatalog")(function* (
    source: string,
    recordDir: string,
    catalogDir: string,
  ): Effect.fn.Return<void, SkillCatalogError> {
    const staging = path.join(recordDir, `catalog.clone.${NodeCrypto.randomUUID()}`);
    yield* fs.makeDirectory(recordDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SkillCatalogError({
            message: `Skill catalog clone could not prepare state: ${String(cause)}`,
          }),
      ),
    );
    yield* Effect.flatMap(
      runCommand("Skill catalog clone", "git", ["clone", "--", source, staging], recordDir),
      (result) =>
        result.code === 0
          ? Effect.succeed(result)
          : Effect.fail(
              new SkillCatalogError({
                message:
                  `Skill catalog clone failed for ${redactGitUrlUserInfo(source)} (exit ${result.code ?? "unknown"}). ` +
                  `Stderr: ${boundDiagnostic(result.stderr)}`,
              }),
            ),
    ).pipe(
      Effect.tapError(() =>
        fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
      Effect.mapError(
        (cause) =>
          new SkillCatalogError({
            message: `${cause.message} The operation is retryable; no checkout was published.`,
          }),
      ),
    );
    yield* fs.rename(staging, catalogDir).pipe(
      Effect.mapError(
        (cause) =>
          new SkillCatalogError({
            message: `Skill catalog clone could not publish its checkout: ${String(cause)}`,
          }),
      ),
    );
  });

  const checkout = Effect.fn("j5.skillCatalog.checkout")(function* (source: string) {
    const resolved = yield* resolveSource(source);
    if (
      resolved.kind === "managed" &&
      !(yield* fs.exists(resolved.catalogDir).pipe(
        Effect.mapError(
          (cause) =>
            new SkillCatalogError({
              message: `Skill catalog checkout check failed: ${String(cause)}`,
            }),
        ),
      ))
    ) {
      yield* cloneCatalog(source.trim(), resolved.recordDir, resolved.catalogDir);
    }
    return resolved.catalogDir;
  });

  const readState = () =>
    installerEffect(() => loadState(stateDir)).pipe(
      Effect.mapError(
        (cause) => new SkillCatalogError({ message: `Cannot read state: ${cause.message}` }),
      ),
    );

  const gitStatus = Effect.fn("j5.skillCatalog.gitStatus")(function* (catalogDir: string) {
    const result = yield* runCommand("Git status", "git", ["status", "--porcelain"], catalogDir);
    if (result.code !== 0)
      return yield* new SkillCatalogError({ message: `Not a git checkout: ${catalogDir}` });
    return result.stdout.trim();
  });

  const gitUpstream = Effect.fn("j5.skillCatalog.gitUpstream")(function* (catalogDir: string) {
    const result = yield* runCommand(
      "Git upstream check",
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      catalogDir,
    );
    return result.code === 0 ? result.stdout.trim() || null : null;
  });

  const inspectGit = Effect.fn("j5.skillCatalog.inspectGit")(function* (
    catalogDir: string,
    warnings: string[],
  ) {
    const root = yield* runCommand(
      "Git repository check",
      "git",
      ["rev-parse", "--show-toplevel"],
      catalogDir,
    ).pipe(
      Effect.flatMap((result) => {
        if (result.code === 0) return Effect.succeed(result.stdout.trim());
        if (/not a git repository/i.test(result.stderr)) return Effect.succeed(null);
        return Effect.fail(
          new SkillCatalogError({
            message: `git rev-parse failed in ${catalogDir}: ${boundDiagnostic(result.stderr)}`,
          }),
        );
      }),
      Effect.catch((cause) => {
        warnings.push(`Git repository check failed: ${cause.message}`);
        return Effect.succeed(null);
      }),
    );
    if (!root) return { upstream: null, dirty: false };
    const [status, upstream] = yield* Effect.all(
      [gitStatus(catalogDir).pipe(Effect.result), gitUpstream(catalogDir).pipe(Effect.result)],
      { concurrency: 2 },
    );
    if (Result.isFailure(status)) {
      warnings.push(`Git status failed: ${status.failure.message}`);
      return { upstream: null, dirty: false };
    }
    if (Result.isFailure(upstream))
      warnings.push(`Git upstream check failed: ${upstream.failure.message}`);
    return {
      upstream: Result.isSuccess(upstream) ? upstream.success : null,
      dirty: status.success !== "",
    };
  });

  const status = Effect.fn("j5.skillCatalog.status")(function* (input: {
    readonly source: string;
  }): Effect.fn.Return<SkillCatalogStatus, SkillCatalogError> {
    const catalogDir = yield* checkout(input.source);
    const state = yield* readState();
    const catalog = yield* installerEffect(() =>
      loadCatalog(path.join(catalogDir, "catalog.yaml")),
    );
    const warnings = state.groups
      .filter((name) => !Object.hasOwn(catalog.groups, name))
      .map((name) => `Saved group "${name}" is not in the catalog.`);
    const groups = yield* installerEffect(async () => {
      const descriptions = new Map(
        await readSkillsConcurrently(
          Object.values(catalog.groups).flatMap((group) => group.skills),
          async (skill) => [skill, await skillDescription(catalogDir, skill)] as const,
        ),
      );
      return Object.entries(catalog.groups).map(([name, group]) => ({
        name,
        description: group.description,
        depends: [...(group.depends ?? [])],
        skills: group.skills.map((skill) => ({
          name: skill,
          description: descriptions.get(skill)!,
        })),
      }));
    });
    const git = yield* inspectGit(catalogDir, warnings);
    return {
      catalogDir,
      groups,
      selectedGroups: state.groups,
      targets,
      git,
      warnings,
    };
  }, skillCatalogPermit.withPermit);

  const apply = Effect.fn("j5.skillCatalog.apply")(function* (input: {
    readonly source: string;
    readonly groups: ReadonlyArray<string>;
    readonly replacements?: ReadonlyArray<SkillCatalogReplacement>;
  }): Effect.fn.Return<SkillCatalogApplyResult, SkillCatalogError> {
    const catalogDir = yield* checkout(input.source);
    const state = yield* readState();
    const catalog = yield* installerEffect(() =>
      loadCatalog(path.join(catalogDir, "catalog.yaml")),
    );
    const platform = yield* HostProcess.Platform;
    // A Promise keeps mutating after fiber interruption. Hold the permit through
    // reconciliation and persistence so disconnects cannot overlap another apply
    // or refresh providers before the links have settled.
    return yield* installerEffect(() =>
      runApply({
        catalog,
        catalogDir,
        stateDir,
        targets,
        state,
        selected: input.groups,
        ...(input.replacements ? { replacements: input.replacements } : {}),
        windows: platform === "win32",
      }),
    ).pipe(Effect.uninterruptible);
  }, skillCatalogPermit.withPermit);

  const update = Effect.fn("j5.skillCatalog.update")(function* (input: {
    readonly source: string;
  }): Effect.fn.Return<SkillCatalogUpdateResult, SkillCatalogError> {
    const catalogDir = yield* checkout(input.source);
    if (yield* gitStatus(catalogDir)) {
      return yield* new SkillCatalogError({
        message: `Refusing to update: local changes in ${catalogDir}`,
      });
    }
    const upstream = yield* gitUpstream(catalogDir);
    if (!upstream) {
      return yield* new SkillCatalogError({
        message: `Refusing to update: no upstream branch for ${catalogDir}`,
      });
    }
    const result = yield* runCommand(
      "Skill catalog pull",
      "git",
      ["pull", "--ff-only"],
      catalogDir,
    );
    if (result.code !== 0) {
      return yield* new SkillCatalogError({
        message: `Skill catalog pull failed (exit ${result.code ?? "unknown"}). Stderr: ${boundDiagnostic(result.stderr)}`,
      });
    }
    return { upstream };
  }, skillCatalogPermit.withPermit);

  return { status, apply, update };
};

export type SkillCatalogTool = ReturnType<typeof createSkillCatalogTool>;
