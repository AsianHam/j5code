import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";

import { readEnvironmentScope } from "../../state/session";

/**
 * `useCanOperateThread` outside a render, for upstream's thread menu. Kept apart from the hook so
 * it imports nothing of the connection runtime or atom registry: `access.ts` hands it the level
 * read when it loads, and until then the answer is upstream's server-wide permission alone.
 */
let sharingAllowsOperate: (thread: ScopedThreadRef) => boolean = () => true;

/** Called once by `access.ts` with the read of the level the open thread's view holds. */
export function provideSharingThreadOperability(read: (thread: ScopedThreadRef) => boolean) {
  sharingAllowsOperate = read;
}

export function readCanOperateThread(thread: ScopedThreadRef): boolean {
  return (
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) &&
    sharingAllowsOperate(thread)
  );
}
