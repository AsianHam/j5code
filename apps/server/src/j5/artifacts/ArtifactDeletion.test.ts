import { ProjectId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { AgentHandoffArtifactDelete } from "../agents/agentHandoffArtifactDelete.ts";
import { ArtifactDeletion, layer } from "./ArtifactDeletion.ts";
import { ArtifactWorkspace, ArtifactWorkspaceError } from "./ArtifactWorkspace.ts";
import * as Workspace from "./ArtifactWorkspace.ts";

const projectId = ProjectId.make("project:artifact-deletion");
const goneProjectId = ProjectId.make("project:artifact-deletion-gone");

const deletionWith = (seen: { deleted: Array<string>; reconciled: Array<string> }) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(id === goneProjectId ? Option.none() : Option.some({ id } as never)),
        }),
        Layer.mock(ArtifactWorkspace)({
          delete: ({ relativePath }) =>
            relativePath === "missing.md"
              ? Effect.fail(
                  new ArtifactWorkspaceError({
                    operation: "delete",
                    detail: "Artifact missing.md does not exist.",
                    reason: "not_found",
                  }),
                )
              : Effect.sync(() => {
                  seen.deleted.push(relativePath);
                  return "plan.md";
                }),
        }),
        Layer.mock(AgentHandoffArtifactDelete)({
          reconcile: ({ path }) =>
            path === "plan.md" && seen.reconciled.length > 0
              ? Effect.die("handoff table unavailable")
              : Effect.sync(() => void seen.reconciled.push(path)),
        }),
      ),
    ),
  );

it.effect("deletes the file, then marks a handoff that pointed at its stored path", () => {
  const seen = { deleted: [] as Array<string>, reconciled: [] as Array<string> };
  return Effect.gen(function* () {
    const deletion = yield* ArtifactDeletion;
    yield* deletion.delete({ projectId, path: "./plan.md" });
    assert.deepStrictEqual(seen.deleted, ["./plan.md"]);
    // The handoff is matched by the path the workspace resolved, not the one the client sent.
    assert.deepStrictEqual(seen.reconciled, ["plan.md"]);
    // The file is already gone, so a failed handoff update does not fail the delete.
    yield* deletion.delete({ projectId, path: "plan.md" });
    assert.deepStrictEqual(seen.deleted, ["./plan.md", "plan.md"]);
  }).pipe(Effect.provide(deletionWith(seen)));
});

it.effect(
  "refuses an unknown project before touching the workspace, and reports a missing file",
  () => {
    const seen = { deleted: [] as Array<string>, reconciled: [] as Array<string> };
    return Effect.gen(function* () {
      const deletion = yield* ArtifactDeletion;
      const gone = yield* deletion
        .delete({ projectId: goneProjectId, path: "plan.md" })
        .pipe(Effect.flip);
      assert.equal(gone._tag, "ArtifactProjectUnavailableError");
      const missing = yield* deletion.delete({ projectId, path: "missing.md" }).pipe(Effect.flip);
      assert.deepInclude(missing, { _tag: "ArtifactWorkspaceError", reason: "not_found" });
      assert.deepStrictEqual(seen, { deleted: [], reconciled: [] });
    }).pipe(Effect.provide(deletionWith(seen)));
  },
);

it.effect(
  "deletes over 2,000 artifacts without following links, preserves other projects, and reconciles handoffs",
  () => {
    const reconciled: Array<string> = [];
    const testLayer = layer.pipe(
      Layer.provideMerge(Workspace.layer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "j5-artifacts-delete-all-" }),
      ),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(id === goneProjectId ? Option.none() : Option.some({ id } as never)),
        }),
      ),
      Layer.provide(
        Layer.mock(AgentHandoffArtifactDelete)({
          reconcile: ({ path }) =>
            Effect.sync(() => {
              reconciled.push(path);
            }),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const deletion = yield* ArtifactDeletion;
      const artifacts = yield* ArtifactWorkspace;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const otherProject = ProjectId.make("project:other");
      yield* artifacts.write({
        projectId: otherProject,
        relativePath: "keep.md",
        content: "Keep this",
      });
      yield* artifacts.write({ projectId, relativePath: "handoffs/review.md", content: "Handoff" });
      const root = path.join(
        config.stateDir,
        Workspace.ARTIFACT_DIRECTORY_NAME,
        Workspace.artifactProjectDirectoryName(projectId),
      );
      yield* Effect.forEach(
        Array.from({ length: Workspace.MAX_ARTIFACT_COUNT * 4 }, (_, index) => index),
        (index) => fs.writeFileString(path.join(root, `${index}.md`), "Plan"),
        { concurrency: 16, discard: true },
      );
      const link = path.join(root, "000-link.md");
      const linkTarget = path.join(root, "handoffs/review.md");
      if (symlinksSupported) yield* fs.symlink(linkTarget, link);
      assert.equal(
        (yield* artifacts.list(projectId).pipe(Effect.flip))._tag,
        "ArtifactListTooLargeError",
      );

      yield* deletion.deleteAll({ projectId });
      assert.deepStrictEqual(yield* artifacts.list(projectId), []);
      assert.equal(reconciled.length, Workspace.MAX_ARTIFACT_COUNT * 4 + 1);
      assert.include(reconciled, "handoffs/review.md");
      assert.notInclude(reconciled, "000-link.md");
      if (symlinksSupported) assert.equal(yield* fs.readLink(link), linkTarget);
      assert.equal(
        (yield* artifacts.read({ projectId: otherProject, relativePath: "keep.md" })).content,
        "Keep this",
      );
      // An empty project is a successful no-op; a removed project is refused.
      yield* deletion.deleteAll({ projectId });
      assert.equal(
        (yield* deletion.deleteAll({ projectId: goneProjectId }).pipe(Effect.flip))._tag,
        "ArtifactProjectUnavailableError",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  },
);

it.effect("reports a bulk failure after reconciling files that were already deleted", () => {
  const deleted: Array<string> = [];
  const reconciled: Array<string> = [];
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ id: projectId } as never),
        }),
        Layer.mock(ArtifactWorkspace)({
          list: () =>
            Effect.succeed([
              { path: "plan.md", byteLength: 1, modifiedAt: null },
              { path: "locked.md", byteLength: 1, modifiedAt: null },
            ]),
          delete: ({ relativePath }) =>
            relativePath === "locked.md"
              ? Effect.fail(
                  new ArtifactWorkspaceError({
                    operation: "delete-artifact",
                    detail: "File could not be deleted.",
                  }),
                )
              : Effect.sync(() => {
                  deleted.push(relativePath);
                  return relativePath;
                }),
        }),
        Layer.mock(AgentHandoffArtifactDelete)({
          reconcile: ({ path }) =>
            Effect.sync(() => {
              reconciled.push(path);
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const deletion = yield* ArtifactDeletion;
    const error = yield* deletion.deleteAll({ projectId }).pipe(Effect.flip);
    assert.equal(error._tag, "ArtifactWorkspaceError");
    assert.deepStrictEqual(deleted, ["plan.md"]);
    assert.deepStrictEqual(reconciled, ["plan.md"]);
  }).pipe(Effect.provide(testLayer));
});
