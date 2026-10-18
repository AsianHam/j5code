// @effect-diagnostics nodeBuiltinImport:off - a project directory name is a synchronous hash.
import type { ArtifactContent, ArtifactEntry, ProjectId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerConfig } from "../../config.ts";

export const ARTIFACT_DIRECTORY_NAME = "artifacts";
export const MAX_ARTIFACT_COUNT = 500;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export const artifactProjectDirectoryName = (projectId: ProjectId): string =>
  NodeCrypto.createHash("sha256").update(projectId).digest("hex");

export class ArtifactWorkspaceError extends Schema.TaggedError<ArtifactWorkspaceError>()(
  "ArtifactWorkspaceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    /**
     * Set when the failure is the caller's target, not the workspace: routes map `not_found` to
     * 404. The others are deterministic facts about the target a reader can report as such: a
     * file over `MAX_ARTIFACT_BYTES`, a path that is not a regular file, or a link that leaves
     * the artifacts directory.
     */
    reason: Schema.optional(
      Schema.Literals(["not_found", "too_large", "not_a_file", "outside_root"]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ArtifactWorkspaceShape {
  readonly prepare: (projectId: ProjectId) => Effect.Effect<void, ArtifactWorkspaceError>;
  readonly list: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ArtifactEntry>, ArtifactWorkspaceError>;
  readonly read: (input: {
    readonly projectId: ProjectId;
    readonly relativePath: string;
  }) => Effect.Effect<ArtifactContent, ArtifactWorkspaceError>;
  readonly delete: (input: {
    readonly projectId: ProjectId;
    readonly relativePath: string;
  }) => Effect.Effect<string, ArtifactWorkspaceError>;
  readonly write: (input: {
    readonly projectId: ProjectId;
    readonly relativePath: string;
    readonly content: string;
  }) => Effect.Effect<ArtifactEntry, ArtifactWorkspaceError>;
  /**
   * Like `write`, but every earlier body of the file is kept inside it, newest first, so a
   * reviewer can compare a revised handoff with the one before it. Used for `handoffs/` paths.
   */
  readonly writeVersioned: (input: {
    readonly projectId: ProjectId;
    readonly relativePath: string;
    readonly content: string;
  }) => Effect.Effect<ArtifactEntry, ArtifactWorkspaceError>;
  readonly exportPlan: (input: {
    readonly projectId: ProjectId;
    readonly markdown: string;
  }) => Effect.Effect<void, ArtifactWorkspaceError>;
  readonly watch: (projectId: ProjectId) => Stream.Stream<void, ArtifactWorkspaceError>;
}

export class ArtifactWorkspace extends Context.Service<ArtifactWorkspace, ArtifactWorkspaceShape>()(
  "t3/j5/artifacts/ArtifactWorkspace",
) {}

const workspaceError = (operation: string, detail: string) => (cause: unknown) =>
  new ArtifactWorkspaceError({ operation, detail, cause });

export const watchArtifactDirectory = (
  fileSystem: Pick<FileSystem.FileSystem, "watch">,
  artifactRoot: string,
) =>
  fileSystem.watch(artifactRoot, { recursive: true }).pipe(
    Stream.debounce(Duration.millis(100)),
    Stream.map(() => undefined),
    Stream.mapError(
      workspaceError("watch-artifacts", "The artifacts directory could not be watched."),
    ),
  );

const normalizeText = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);
const normalizeArtifactRelativePath = (value: string) => value.replaceAll("\\", "/");

const isPathWithin = (path: Path.Path, parent: string, candidate: string) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const looksBinary = (bytes: Uint8Array) => {
  const inspected = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  return inspected.some((byte) => byte === 0);
};

// Versioned files. The whole file is rendered from the versions it holds, so a retried write
// converges and a hand-edited or pre-existing file is simply treated as version 1. The marker on
// the first line lists every kept version as `<number>@<timestamp>`, and the parser only treats a
// line as a boundary when it equals the heading rendered for one of those entries. Bodies are
// never trimmed of separators, so a handoff may quote an earlier heading or end with `---`.

const VERSIONED_MARKER = /^<!-- j5-artifact-versions: .*?; (.*?) -->\s*$/;

export interface ArtifactVersion {
  readonly number: number;
  readonly timestamp: string;
  readonly content: string;
}

export const artifactVersionedMarker = (
  relativePath: string,
  versions: ReadonlyArray<Pick<ArtifactVersion, "number" | "timestamp">>,
) =>
  `<!-- j5-artifact-versions: ${relativePath}; ${versions
    .map((version) => `${version.number}@${version.timestamp}`)
    .join(" ")} -->`;

const artifactVersionHeading = (
  version: Pick<ArtifactVersion, "number" | "timestamp">,
  current: boolean,
) => `## Version ${version.number} · ${version.timestamp}${current ? " · current" : ""}`;

/**
 * Versions newest first. A file without the marker, or one whose marker and headings no longer
 * agree (hand-edited), is one unnumbered version of everything it holds; nothing is discarded.
 */
export function parseArtifactVersions(
  existing: string | null,
  now: string,
): ReadonlyArray<ArtifactVersion> {
  if (existing === null || existing.trim() === "") return [];
  const adopt = [{ number: 1, timestamp: now, content: existing.trim() }];
  const lines = existing.split("\n");
  const marker = VERSIONED_MARKER.exec(lines[0] ?? "");
  if (marker === null) return adopt;
  const boundaries = marker[1]!
    .split(" ")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const at = entry.indexOf("@");
      return { number: Number(entry.slice(0, at)), timestamp: entry.slice(at + 1) };
    });
  if (
    boundaries.length === 0 ||
    boundaries.some((boundary) => !Number.isInteger(boundary.number) || boundary.timestamp === "")
  ) {
    return adopt;
  }
  // Locate headings from the oldest (bottom) upward. A body can only quote a heading that already
  // existed when it was written, so a quoted heading always sits above the real one; the last
  // matching line in the remaining region is therefore the boundary.
  const versions: Array<ArtifactVersion> = [];
  let end = lines.length;
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index]!;
    const heading = artifactVersionHeading(boundary, index === 0);
    let at = -1;
    for (let line = end - 1; line > 0; line -= 1) {
      if (lines[line] === heading) {
        at = line;
        break;
      }
    }
    if (at === -1) return adopt;
    versions.unshift({
      ...boundary,
      content: lines
        .slice(at + 1, end)
        .join("\n")
        .trim(),
    });
    end = at;
  }
  return versions;
}

const artifactNameFromPath = (relativePath: string) => {
  const file = relativePath.split("/").at(-1) ?? relativePath;
  const stem = file.replace(/\.md$/i, "");
  const dash = stem.lastIndexOf("-");
  return dash > 0 ? stem.slice(0, dash) : stem;
};

const firstHeading = (content: string) =>
  content
    .split("\n")
    .map((line) => /^#\s+(.+?)\s*$/.exec(line)?.[1])
    .find((title): title is string => title !== undefined);

/** Render the file from its versions, newest first. */
export function renderArtifactVersions(input: {
  readonly relativePath: string;
  readonly versions: ReadonlyArray<ArtifactVersion>;
  readonly dropped: number;
}): string {
  const newest = input.versions[0];
  const title =
    (newest && firstHeading(newest.content)) ?? artifactNameFromPath(input.relativePath);
  const count = input.versions.length;
  const summary =
    `${count} ${count === 1 ? "version" : "versions"}, newest first` +
    (input.dropped > 0
      ? `; ${input.dropped} older ${input.dropped === 1 ? "version" : "versions"} dropped to stay under the size limit`
      : "");
  const sections = input.versions.map(
    (version, index) => `${artifactVersionHeading(version, index === 0)}\n\n${version.content}\n`,
  );
  return `${artifactVersionedMarker(input.relativePath, input.versions)}\n# ${title}\n\n${summary}\n\n${sections.join("\n")}`;
}

/**
 * Stack `content` on top of the versions already in `existing`. An identical newest body leaves
 * the file untouched; oldest versions drop until the rendering fits the artifact size limit.
 */
export function stackArtifactVersion(input: {
  readonly relativePath: string;
  readonly existing: string | null;
  readonly content: string;
  readonly now: string;
  readonly maxBytes: number;
}): { readonly rendered: string; readonly changed: boolean } {
  const previous = parseArtifactVersions(input.existing, input.now);
  const body = input.content.trim();
  if (previous[0] !== undefined && previous[0].content === body && input.existing !== null) {
    return { rendered: input.existing, changed: false };
  }
  const next = (previous[0]?.number ?? 0) + 1;
  let versions: ReadonlyArray<ArtifactVersion> = [
    { number: next, timestamp: input.now, content: body },
    ...previous,
  ];
  let dropped = 0;
  const encoder = new TextEncoder();
  let rendered = renderArtifactVersions({ relativePath: input.relativePath, versions, dropped });
  while (encoder.encode(rendered).byteLength > input.maxBytes && versions.length > 1) {
    versions = versions.slice(0, -1);
    dropped += 1;
    rendered = renderArtifactVersions({ relativePath: input.relativePath, versions, dropped });
  }
  return { rendered, changed: true };
}

export const layer = Layer.effect(
  ArtifactWorkspace,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const artifactsDir = path.join(serverConfig.stateDir, ARTIFACT_DIRECTORY_NAME);

    const artifactRootFor = (projectId: ProjectId) =>
      path.join(artifactsDir, artifactProjectDirectoryName(projectId));

    const resolveNearestExistingAncestor = Effect.fn(
      "ArtifactWorkspace.resolveNearestExistingAncestor",
    )(function* (candidate: string, boundary: string) {
      let current = candidate;
      while (
        !(yield* fileSystem
          .exists(current)
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The artifact directory could not be inspected."),
            ),
          ))
      ) {
        const parent = path.dirname(current);
        if (parent === current || !isPathWithin(path, boundary, parent)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact paths cannot leave the artifacts directory.",
          });
        }
        current = parent;
      }
      return yield* fileSystem
        .realPath(current)
        .pipe(
          Effect.mapError(
            workspaceError("write-artifact", "The artifact directory could not be resolved."),
          ),
        );
    });

    const resolveArtifactsBase = Effect.fn("ArtifactWorkspace.resolveArtifactsBase")(function* () {
      yield* fileSystem
        .makeDirectory(artifactsDir, { recursive: true })
        .pipe(
          Effect.mapError(
            workspaceError(
              "create-artifacts",
              "The application artifacts directory could not be created.",
            ),
          ),
        );
      return yield* fileSystem
        .realPath(artifactsDir)
        .pipe(
          Effect.mapError(
            workspaceError(
              "resolve-artifacts",
              "The application artifacts directory could not be resolved.",
            ),
          ),
        );
    });

    const resolveExistingArtifactRoot = Effect.fn("ArtifactWorkspace.resolveExistingArtifactRoot")(
      function* (projectId: ProjectId) {
        const artifactsBase = yield* resolveArtifactsBase();
        const artifactRoot = artifactRootFor(projectId);
        const exists = yield* fileSystem
          .exists(artifactRoot)
          .pipe(
            Effect.mapError(
              workspaceError(
                "resolve-artifacts",
                "The artifacts directory could not be inspected.",
              ),
            ),
          );
        if (!exists) return { artifactRoot, realArtifactRoot: null };
        const realArtifactRoot = yield* fileSystem
          .realPath(artifactRoot)
          .pipe(
            Effect.mapError(
              workspaceError("resolve-artifacts", "The artifacts directory could not be resolved."),
            ),
          );
        if (!isPathWithin(path, artifactsBase, realArtifactRoot)) {
          return yield* new ArtifactWorkspaceError({
            operation: "resolve-artifacts",
            detail: "The project artifacts directory cannot link outside application storage.",
          });
        }
        return { artifactRoot, realArtifactRoot };
      },
    );

    const prepare: ArtifactWorkspaceShape["prepare"] = Effect.fn("ArtifactWorkspace.prepare")(
      function* (projectId) {
        yield* resolveArtifactsBase();
        yield* fileSystem
          .makeDirectory(artifactRootFor(projectId), { recursive: true })
          .pipe(
            Effect.mapError(
              workspaceError(
                "create-artifacts",
                "The project artifacts directory could not be created.",
              ),
            ),
          );
      },
    );

    const list: ArtifactWorkspaceShape["list"] = Effect.fn("ArtifactWorkspace.list")(
      function* (projectId) {
        yield* prepare(projectId);
        const workspace = yield* resolveExistingArtifactRoot(projectId);
        if (workspace.realArtifactRoot === null) return [];
        const names = yield* fileSystem
          .readDirectory(workspace.realArtifactRoot, { recursive: true })
          .pipe(
            Effect.mapError(
              workspaceError("list-artifacts", "The artifacts directory could not be listed."),
            ),
          );
        // Fail fast on an absurd directory rather than stat and sort tens of thousands of entries
        // for a 500-row page; the cap below still sorts before it truncates.
        if (names.length > MAX_ARTIFACT_COUNT * 4) {
          return yield* new ArtifactWorkspaceError({
            operation: "list-artifacts",
            detail: `The artifacts directory is too large to browse (maximum ${MAX_ARTIFACT_COUNT} files).`,
          });
        }
        const entries = yield* Effect.forEach(
          names,
          (name) =>
            Effect.gen(function* () {
              const absolutePath = path.join(workspace.realArtifactRoot!, name);
              const realPath = yield* Effect.result(fileSystem.realPath(absolutePath));
              if (
                Result.isFailure(realPath) ||
                !isPathWithin(path, workspace.realArtifactRoot!, realPath.success)
              ) {
                return null;
              }
              const info = yield* Effect.result(fileSystem.stat(realPath.success));
              if (Result.isFailure(info) || info.success.type !== "File") return null;
              return {
                path: name.replaceAll("\\", "/"),
                byteLength: Number(info.success.size),
                modifiedAt: Option.match(info.success.mtime, {
                  onNone: () => null,
                  onSome: (value) => value.toISOString(),
                }),
              } satisfies ArtifactEntry;
            }),
          { concurrency: 16 },
        );
        // Sort first so a directory past the cap shows its first entries by path, not whichever
        // files the filesystem happened to enumerate first.
        return entries
          .filter((entry): entry is ArtifactEntry => entry !== null)
          .toSorted((left, right) => left.path.localeCompare(right.path))
          .slice(0, MAX_ARTIFACT_COUNT);
      },
    );

    const read: ArtifactWorkspaceShape["read"] = Effect.fn("ArtifactWorkspace.read")(
      function* (input) {
        const workspace = yield* resolveExistingArtifactRoot(input.projectId);
        if (workspace.realArtifactRoot === null) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "The artifact does not exist.",
            reason: "not_found",
          });
        }
        const relativePath = normalizeArtifactRelativePath(input.relativePath);
        if (relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Artifact paths must be relative to the artifacts directory.",
          });
        }
        const requestedPath = path.resolve(workspace.realArtifactRoot, relativePath);
        if (!isPathWithin(path, workspace.realArtifactRoot, requestedPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Artifact paths cannot leave the artifacts directory.",
          });
        }
        const realPath = yield* fileSystem.realPath(requestedPath).pipe(
          Effect.mapError(
            (cause) =>
              new ArtifactWorkspaceError({
                operation: "read-artifact",
                detail: "The artifact does not exist.",
                reason: "not_found",
                cause,
              }),
          ),
        );
        if (!isPathWithin(path, workspace.realArtifactRoot, realPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Artifact links cannot leave the artifacts directory.",
            reason: "outside_root",
          });
        }
        const info = yield* fileSystem
          .stat(realPath)
          .pipe(
            Effect.mapError(
              workspaceError("read-artifact", "The artifact could not be inspected."),
            ),
          );
        if (info.type !== "File") {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Only artifact files can be opened.",
            reason: "not_a_file",
          });
        }
        if (Number(info.size) > MAX_ARTIFACT_BYTES) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: `This artifact is larger than the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB preview limit.`,
            reason: "too_large",
          });
        }
        const bytes = yield* fileSystem
          .readFile(realPath)
          .pipe(
            Effect.mapError(workspaceError("read-artifact", "The artifact could not be read.")),
          );
        const binary = looksBinary(bytes);
        return {
          path: relativePath,
          byteLength: bytes.byteLength,
          encoding: binary ? "base64" : "utf8",
          content: binary ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes),
        } satisfies ArtifactContent;
      },
    );

    const deleteArtifact: ArtifactWorkspaceShape["delete"] = Effect.fn("ArtifactWorkspace.delete")(
      function* (input) {
        const workspace = yield* resolveExistingArtifactRoot(input.projectId);
        if (workspace.realArtifactRoot === null) {
          return yield* new ArtifactWorkspaceError({
            operation: "delete-artifact",
            detail: "The artifact does not exist.",
            reason: "not_found",
          });
        }
        const relativePath = normalizeArtifactRelativePath(input.relativePath);
        if (relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "delete-artifact",
            detail: "Artifact paths must be relative to the artifacts directory.",
          });
        }
        const requestedPath = path.resolve(workspace.realArtifactRoot, relativePath);
        if (!isPathWithin(path, workspace.realArtifactRoot, requestedPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "delete-artifact",
            detail: "Artifact paths cannot leave the artifacts directory.",
          });
        }
        const realPath = yield* fileSystem.realPath(requestedPath).pipe(
          Effect.mapError(
            (cause) =>
              new ArtifactWorkspaceError({
                operation: "delete-artifact",
                detail: "The artifact does not exist.",
                reason: "not_found",
                cause,
              }),
          ),
        );
        if (!isPathWithin(path, workspace.realArtifactRoot, realPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "delete-artifact",
            detail: "Artifact links cannot leave the artifacts directory.",
          });
        }
        if (realPath !== requestedPath) {
          return yield* new ArtifactWorkspaceError({
            operation: "delete-artifact",
            detail: "Artifact links cannot be deleted.",
          });
        }
        const info = yield* fileSystem
          .stat(realPath)
          .pipe(
            Effect.mapError(
              workspaceError("delete-artifact", "The artifact could not be inspected."),
            ),
          );
        if (info.type !== "File") {
          return yield* new ArtifactWorkspaceError({
            operation: "delete-artifact",
            detail: "Only artifact files can be deleted.",
          });
        }
        // Remove only the validated file; never recursively remove artifact directories.
        yield* fileSystem
          .remove(realPath)
          .pipe(
            Effect.mapError(
              workspaceError("delete-artifact", "The artifact could not be deleted."),
            ),
          );
        return path.relative(workspace.realArtifactRoot, realPath).replaceAll("\\", "/");
      },
    );

    const write: ArtifactWorkspaceShape["write"] = Effect.fn("ArtifactWorkspace.write")(
      function* (input) {
        const relativePath = normalizeArtifactRelativePath(input.relativePath);
        if (relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact paths must be relative to the artifacts directory.",
          });
        }
        const byteLength = new TextEncoder().encode(input.content).byteLength;
        if (byteLength > MAX_ARTIFACT_BYTES) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: `This artifact is larger than the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB limit.`,
          });
        }

        yield* prepare(input.projectId);
        const workspace = yield* resolveExistingArtifactRoot(input.projectId);
        if (workspace.realArtifactRoot === null) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "The project artifacts directory could not be resolved.",
          });
        }
        const requestedPath = path.resolve(workspace.realArtifactRoot, relativePath);
        if (!isPathWithin(path, workspace.realArtifactRoot, requestedPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact paths cannot leave the artifacts directory.",
          });
        }

        const parent = path.dirname(requestedPath);
        const realExistingAncestor = yield* resolveNearestExistingAncestor(
          parent,
          workspace.realArtifactRoot,
        );
        if (!isPathWithin(path, workspace.realArtifactRoot, realExistingAncestor)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact links cannot leave the artifacts directory.",
          });
        }
        yield* fileSystem
          .makeDirectory(parent, { recursive: true })
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The artifact directory could not be created."),
            ),
          );
        const realParent = yield* fileSystem
          .realPath(parent)
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The artifact directory could not be resolved."),
            ),
          );
        if (!isPathWithin(path, workspace.realArtifactRoot, realParent)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact links cannot leave the artifacts directory.",
          });
        }

        yield* writeFileStringAtomically({
          filePath: requestedPath,
          contents: input.content,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(workspaceError("write-artifact", "The artifact could not be written.")),
        );
        const info = yield* fileSystem
          .stat(requestedPath)
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The written artifact could not be inspected."),
            ),
          );
        return {
          path: relativePath,
          byteLength: Number(info.size),
          modifiedAt: Option.match(info.mtime, {
            onNone: () => null,
            onSome: (value) => value.toISOString(),
          }),
        } satisfies ArtifactEntry;
      },
    );

    const writeVersioned: ArtifactWorkspaceShape["writeVersioned"] = Effect.fn(
      "ArtifactWorkspace.writeVersioned",
    )(function* (input) {
      const relativePath = normalizeArtifactRelativePath(input.relativePath);
      const existing = yield* Effect.result(read({ projectId: input.projectId, relativePath }));
      const existingText =
        Result.isSuccess(existing) && existing.success.encoding === "utf8"
          ? existing.success.content
          : null;
      const now = DateTime.formatIso(yield* DateTime.now);
      const stacked = stackArtifactVersion({
        relativePath,
        existing: existingText,
        content: input.content,
        now,
        maxBytes: MAX_ARTIFACT_BYTES,
      });
      return yield* write({
        projectId: input.projectId,
        relativePath,
        content: stacked.changed ? stacked.rendered : (existingText ?? stacked.rendered),
      });
    });

    const exportPlan: ArtifactWorkspaceShape["exportPlan"] = Effect.fn(
      "ArtifactWorkspace.exportPlan",
    )(function* (input) {
      yield* prepare(input.projectId);
      const workspace = yield* resolveExistingArtifactRoot(input.projectId);
      if (workspace.realArtifactRoot === null) {
        return yield* new ArtifactWorkspaceError({
          operation: "resolve-artifacts",
          detail: "The project artifacts directory could not be resolved.",
        });
      }
      const realArtifactRoot = yield* fileSystem
        .realPath(workspace.artifactRoot)
        .pipe(
          Effect.mapError(
            workspaceError("resolve-artifacts", "The artifacts directory could not be resolved."),
          ),
        );
      const realArtifactsBase = yield* fileSystem
        .realPath(artifactsDir)
        .pipe(
          Effect.mapError(
            workspaceError(
              "resolve-artifacts",
              "The application artifacts directory could not be resolved.",
            ),
          ),
        );
      if (!isPathWithin(path, realArtifactsBase, realArtifactRoot)) {
        return yield* new ArtifactWorkspaceError({
          operation: "resolve-artifacts",
          detail: "The project artifacts directory cannot link outside application storage.",
        });
      }

      const planPath = path.join(realArtifactRoot, "plan.md");
      const contents = normalizeText(input.markdown);
      const current = yield* Effect.result(fileSystem.readFileString(planPath));
      if (Result.isSuccess(current) && current.success === contents) return;
      yield* writeFileStringAtomically({ filePath: planPath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          workspaceError("write-plan", "The completed plan could not be saved as an artifact."),
        ),
      );
    });

    const watch: ArtifactWorkspaceShape["watch"] = (projectId) =>
      Stream.unwrap(
        prepare(projectId).pipe(
          Effect.andThen(resolveExistingArtifactRoot(projectId)),
          Effect.flatMap((workspace) =>
            workspace.realArtifactRoot === null
              ? Effect.fail(
                  new ArtifactWorkspaceError({
                    operation: "watch-artifacts",
                    detail: "The artifacts directory does not exist.",
                    reason: "not_found",
                  }),
                )
              : Effect.succeed(watchArtifactDirectory(fileSystem, workspace.realArtifactRoot)),
          ),
        ),
      );

    return ArtifactWorkspace.of({
      prepare,
      list,
      read,
      delete: deleteArtifact,
      write,
      writeVersioned,
      exportPlan,
      watch,
    });
  }),
);
