import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

/**
 * Whether upstream's "Permissions have changed" notice is for a server, by what it has answered
 * of this connection. A connection J5 places as a person, or as a device it will ask about, has
 * its permissions set from that person's level and renewed when it changes, so "pair again" never
 * applies to it. One not answered yet is held back, so the notice does not show before the
 * answer; a server that cannot answer, one from before people, keeps upstream's notice.
 */
export function permissionNoticeApplies(
  answer: AsyncResult.AsyncResult<KnownConnectionAccess, unknown>,
): boolean {
  if (answer._tag === "Initial") return false;
  const access = Option.getOrNull(AsyncResult.value(answer));
  return access?.kind !== "person" && access?.kind !== "unknown";
}
