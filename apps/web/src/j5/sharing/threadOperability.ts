import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";

import { readEnvironmentScope } from "../../state/session";

/**
 * `useCanOperateThread` for code that runs outside a render: upstream's thread action menu builds
 * its items when it is opened. It is kept apart from the hook so that it imports nothing of the
 * app's connection runtime or atom registry: `guestAccess.ts`, which owns those, hands it the
 * read of a guest's level when it loads. Until then, and for every connection that is not a
 * guest's, the answer is upstream's server-wide permission and nothing more.
 */
let sharingAllowsOperate: (thread: ScopedThreadRef) => boolean = () => true;

/** Called once by `guestAccess.ts` with the read of the level the open thread's view holds. */
export function provideSharingThreadOperability(read: (thread: ScopedThreadRef) => boolean) {
  sharingAllowsOperate = read;
}

export function readCanOperateThread(thread: ScopedThreadRef): boolean {
  return (
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) &&
    sharingAllowsOperate(thread)
  );
}
