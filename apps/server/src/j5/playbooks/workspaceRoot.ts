import type { PlaybookLibraryRequest } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { ProjectService } from "../../project/ProjectService.ts";

const isMissingThread = Schema.is(ProjectionStoreThreadNotFoundError);

/**
 * Resolves the workspace a playbook request targets: the project root, or the thread's
 * worktree when a thread is given. Environment-only requests use an empty workspace root. Returns null when the project or thread is gone or
 * belongs to another project; other failures pass through unchanged for the caller to map.
 */
export const resolvePlaybookWorkspaceRoot = (
  projects: Pick<ProjectService["Service"], "getById">,
  threads: Pick<ThreadManagementService["Service"], "getThreadProjection">,
  input: PlaybookLibraryRequest,
) =>
  Effect.gen(function* () {
    if (input.projectId === undefined) return input.threadId === undefined ? "" : null;
    const project = yield* projects.getById(input.projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null) return null;
    let root = project.value.workspaceRoot;
    if (input.threadId !== undefined) {
      const projection = yield* threads.getThreadProjection(input.threadId).pipe(
        Effect.catchTags({
          OrchestratorProjectionError: (error) =>
            isMissingThread(error.cause) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (
        !projection ||
        projection.thread.deletedAt !== null ||
        projection.thread.projectId !== project.value.id
      )
        return null;
      root = projection.thread.worktreePath ?? root;
    }
    return root;
  });
