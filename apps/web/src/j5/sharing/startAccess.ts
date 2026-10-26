import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

// `useCanStartIn`'s answer for code that runs outside a render, handed over by `access.ts` as
// `threadOperability.ts` is. It imports nothing at runtime, so upstream's new-thread helpers can
// ask it without loading the connection runtime. Upstream offers a new thread to any connection,
// so until then nothing is withheld.
let sharingAllowsStart: (
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) => boolean = () => true;

/** Called once by `access.ts` with the read behind `useCanStartIn`. */
export function provideSharingStart(
  read: (environmentId: EnvironmentId, projectId: ProjectId | null) => boolean,
) {
  sharingAllowsStart = read;
}

/** `useCanStartIn` for one project, for code that runs outside a render. */
export function readCanStartThreadIn(project: ScopedProjectRef): boolean {
  return sharingAllowsStart(project.environmentId, project.projectId);
}
