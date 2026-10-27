import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

/**
 * A connection J5 places as a person, or as a device it will ask about, has its permissions renewed
 * when that person's level changes, so upstream's "pair again" never applies to it. The notice is
 * held back until the server answers; a server that cannot answer (from before people) keeps
 * upstream's notice.
 */
export function permissionNoticeApplies(
  answer: AsyncResult.AsyncResult<KnownConnectionAccess, unknown>,
): boolean {
  if (answer._tag === "Initial") return false;
  const access = Option.getOrNull(AsyncResult.value(answer));
  return access?.kind !== "person" && access?.kind !== "unknown";
}
