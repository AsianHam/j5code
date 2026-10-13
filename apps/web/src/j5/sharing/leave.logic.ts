import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SharingOwnGrant, SharingGrantTarget } from "@t3tools/contracts/j5";

/** What a guest gives up to stop reaching one thread, and how the confirmation words it. */
export type LeaveChoice =
  | { readonly kind: "thread"; readonly target: SharingGrantTarget }
  | { readonly kind: "project"; readonly target: SharingGrantTarget }
  /**
   * The thread is shared on its own and its project is shared too. Leaving the thread's own grant
   * would change nothing the guest can see, so both go together, the project's first.
   */
  | {
      readonly kind: "thread-and-project";
      readonly targets: readonly [SharingGrantTarget, SharingGrantTarget];
    }
  /** The thread is reached through another thread, an agent's parent, that was shared. */
  | { readonly kind: "through-another-thread" };

/**
 * A guest leaves a grant, not a thread (Shared server AC25). A grant on the thread itself is the
 * one to leave, unless a grant on its project covers the thread as well: then the thread would
 * stay in the guest's list, so leaving it means leaving the project too, and the confirmation
 * says so. With no grant on the thread, the project's grant covers it, and leaving that takes
 * every thread in the project. A thread covered by neither is an agent beneath a thread that
 * was shared, and goes when that thread is left.
 */
export function leaveChoiceFor(
  grants: ReadonlyArray<SharingOwnGrant>,
  thread: { readonly threadId: ThreadId; readonly projectId: ProjectId | null },
): LeaveChoice {
  const onThread = grants.find(
    (grant) => grant.target.kind === "thread" && grant.target.threadId === thread.threadId,
  );
  const onProject = grants.find(
    (grant) => grant.target.kind === "project" && grant.target.projectId === thread.projectId,
  );
  if (onThread !== undefined && onProject !== undefined) {
    return { kind: "thread-and-project", targets: [onProject.target, onThread.target] };
  }
  if (onThread !== undefined) return { kind: "thread", target: onThread.target };
  if (onProject !== undefined) return { kind: "project", target: onProject.target };
  return { kind: "through-another-thread" };
}

export function leaveWording(
  choice: LeaveChoice,
  titles: { readonly thread: string; readonly project: string | null },
): { readonly title: string; readonly description: string } {
  switch (choice.kind) {
    case "thread":
      return {
        title: `Leave ${titles.thread}?`,
        description:
          "It disappears from your list. To get it back, ask a member to share it again.",
      };
    case "project":
      return {
        title: `Leave ${titles.project ?? "this project"}?`,
        description:
          "This thread was shared with you as part of its project. Every thread in the project disappears from your list. To get them back, ask a member to share the project again.",
      };
    case "thread-and-project":
      return {
        title: `Leave ${titles.project ?? "this project"}?`,
        description: `${titles.thread} is shared with you on its own and as part of its project, so it stays in your list for as long as the project is shared with you. Leaving the project takes every thread in it from your list, this one included. To get them back, ask a member to share them again.`,
      };
    case "through-another-thread":
      return {
        title: `${titles.thread} cannot be left by itself`,
        description:
          "You reach it through the thread it works for, which was shared with you. Leave that thread and this one goes with it.",
      };
  }
}

/** The grants a confirmed choice gives up, in the order they are left. */
export function grantsToLeave(choice: LeaveChoice): ReadonlyArray<SharingGrantTarget> {
  switch (choice.kind) {
    case "thread":
    case "project":
      return [choice.target];
    case "thread-and-project":
      return choice.targets;
    case "through-another-thread":
      return [];
  }
}
