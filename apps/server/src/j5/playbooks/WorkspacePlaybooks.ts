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
 * The playbook definitions of the workspace a request names: the project's root, or the thread's
 * worktree. Every method resolves that workspace first and refuses one that is gone or belongs
 * to another project. A refusal keeps the store's words. A storage failure carries the
 * underlying error's text, which can name a path on the server, so it is logged here and told
 * to the client in the method's general words.
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
              Effect.catch((error) =>
                error.code === "operation_failed"
                  ? Effect.logError(failed, { cause: error }).pipe(
                      Effect.andThen(Effect.fail(playbookError("operation_failed", failed))),
                    )
                  : Effect.fail(error),
              ),
            ),
      ),
    );
  return {
    /** Every definition in the workspace, valid or not, with the workspace's root. */
    library: (input: PlaybookLibraryRequest) =>
      inWorkspace(input, "Reading the playbook library failed.", (root) =>
        store.discover(root).pipe(Effect.map((library) => ({ workspaceRoot: root, ...library }))),
      ),
    exportDefinition: (input: PlaybookExportRequest) =>
      inWorkspace(input, "Exporting the playbook failed.", (root) =>
        store.exportDefinition(root, input.name),
      ),
    removeDefinition: (input: PlaybookDeleteRequest) =>
      inWorkspace(input, "Deleting the playbook failed.", (root) =>
        store.removeDefinition(root, input.name),
      ),
    renameDefinition: (input: PlaybookRenameRequest) =>
      inWorkspace(input, "Renaming the playbook failed.", (root) =>
        store.renameDefinition(root, input.name, input.title),
      ),
  };
});
