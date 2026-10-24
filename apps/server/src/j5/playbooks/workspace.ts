import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PlaybookError } from "@t3tools/contracts/j5";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { playbookError } from "./PlaybookStore.ts";

const isPlaybookError = Schema.is(PlaybookError);

/** The directory a thread's playbooks live under: its worktree, else its project's root. */
export const playbookWorkspaceRoot = Effect.fn("j5.playbooks.workspace.playbookWorkspaceRoot")(
  function* (threadId: ThreadId) {
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const { thread } = yield* threads.getThreadProjection(threadId);
    if (thread.deletedAt !== null)
      return yield* playbookError("thread_not_found", "The owner thread was deleted.");
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project))
      return yield* playbookError("project_not_found", "The thread's project was not found.");
    return thread.worktreePath ?? project.value.workspaceRoot;
  },
  Effect.mapError((error) =>
    isPlaybookError(error) ? error : playbookError("workspace_unavailable", error.message),
  ),
);
