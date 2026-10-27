import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { ConnectionBlockedError } from "../connection/model.ts";

/**
 * Refuses a J5 server whose ledger predates the re-key to projects: this client's J5 views cannot
 * read it, and the person should update the server rather than see views that quietly show
 * nothing. A server with no J5 ledger (plain T3 Code) connects, its J5 views unsupported.
 */
export function j5ServerCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  const { j5ProjectLedger, j5Squadrons } = descriptor.capabilities;
  if (j5Squadrons !== true || j5ProjectLedger === true) return null;
  return new ConnectionBlockedError({
    reason: "unsupported",
    detail: `This client requires a newer server. Update the server on ${descriptor.label} to connect.`,
  });
}
