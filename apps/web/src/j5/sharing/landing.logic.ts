import { type KnownConnectionAccess, reachesServer } from "@t3tools/client-runtime/j5/sharing";
import type { ProjectId, ThreadId } from "@t3tools/contracts";

/**
 * The first screen for someone who reaches less than the whole server (People and access AC30,
 * design §4): the one thread they hold, opened; a list when they hold several things; and
 * "Nothing is shared with you" when they hold nothing, because they left or lost the last thing.
 * Everyone else gets upstream's own first screen, at once, without waiting for the server.
 */
export type Landing =
  | { readonly kind: "upstream" }
  | { readonly kind: "open"; readonly threadId: ThreadId }
  | {
      readonly kind: "list";
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly projectIds: ReadonlyArray<ProjectId>;
    }
  | { readonly kind: "nothing" };

export function landingFor(access: KnownConnectionAccess): Landing {
  if (access?.kind !== "person" || reachesServer(access)) return { kind: "upstream" };
  const threadIds = access.levels.flatMap((held) =>
    held.scope.kind === "thread" ? [held.scope.threadId] : [],
  );
  const projectIds = access.levels.flatMap((held) =>
    held.scope.kind === "project" ? [held.scope.projectId] : [],
  );
  if (threadIds.length === 0 && projectIds.length === 0) return { kind: "nothing" };
  if (threadIds.length === 1 && projectIds.length === 0) {
    return { kind: "open", threadId: threadIds[0]! };
  }
  return { kind: "list", threadIds, projectIds };
}
