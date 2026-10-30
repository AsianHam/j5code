import type {
  PlaybookDeleteRequest,
  PlaybookError,
  PlaybookExportRequest,
  PlaybookLibraryRequest,
  PlaybookRenameRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { playbookError, type PlaybookStore } from "./PlaybookStore.ts";
import { resolvePlaybookWorkspaceRoot } from "./workspaceRoot.ts";

/**
 * The effective playbooks for a project/worktree, or an explicitly selected environment source.
 * A thread that is gone or in another project is refused in the store's words. A storage failure
 * can name a server path, so it is logged here and the client gets the method's general words.
 */
export const makeWorkspacePlaybooks = Effect.fn("makeWorkspacePlaybooks")(function* (
  store: Pick<
    PlaybookStore["Service"],
    "discover" | "exportDefinition" | "removeDefinition" | "renameDefinition"
  >,
) {
  const projects = yield* ProjectService;
  const threads = yield* ThreadManagementService;
  const inWorkspace = <A>(
    input: PlaybookLibraryRequest,
    failed: string,
    run: (workspaceRoot: string) => Effect.Effect<A, PlaybookError>,
  ) =>
    resolvePlaybookWorkspaceRoot(projects, threads, input).pipe(
      Effect.catch((cause) =>
        Effect.logError("Resolving a playbook workspace failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(playbookError("operation_failed", "Could not resolve the workspace.")),
          ),
        ),
      ),
      Effect.flatMap((root) =>
        root === null
          ? Effect.fail(
              playbookError(
                "workspace_not_found",
                "This project or thread workspace is no longer available.",
              ),
            )
          : run(root).pipe(
              Effect.catchIf(
                (error) => error.code === "operation_failed",
                (error) =>
                  Effect.logError(failed, { cause: error }).pipe(
                    Effect.andThen(Effect.fail(playbookError("operation_failed", failed))),
                  ),
              ),
            ),
      ),
    );
  return {
    /** Every definition in the workspace, valid or not, with the workspace's root. */
    library: (input: PlaybookLibraryRequest) =>
      inWorkspace(input, "Reading the playbook library failed.", (root) =>
        store
          .discover(root, input.source)
          .pipe(Effect.map((library) => ({ workspaceRoot: root, ...library }))),
      ),
    exportDefinition: (input: PlaybookExportRequest) =>
      inWorkspace(input, "Exporting the playbook failed.", (root) =>
        store.exportDefinition(root, input.name, input.source),
      ),
    removeDefinition: (input: PlaybookDeleteRequest) =>
      inWorkspace(input, "Deleting the playbook failed.", (root) =>
        store.removeDefinition(root, input.name, input.source),
      ),
    renameDefinition: (input: PlaybookRenameRequest) =>
      inWorkspace(input, "Renaming the playbook failed.", (root) =>
        store.renameDefinition(root, input.name, input.title, input.source),
      ),
  };
});
