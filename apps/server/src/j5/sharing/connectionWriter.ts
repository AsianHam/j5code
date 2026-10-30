import type { ThreadId } from "@t3tools/contracts";
import { J5ActionError, levelReaches } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { PersonAccess, type SessionIdentity, isWide } from "./PersonAccess.ts";
import { SharedThreads } from "./SharedThreads.ts";

/**
 * What a connection may do with the threads a non-command request names: Crew prompts, rosters,
 * stop and archive (Crews AC23). Service sessions and server-wide writers pass without a lookup;
 * others pass where their level allows; an unclaimed device nowhere.
 */

const unreadable = () =>
  new J5ActionError({ code: "storage", message: "Could not read what is shared with you." });

/** Whether the connection writes to, or only reaches, the thread an entry names. */
const connectionAt = Effect.fn("j5.sharing.connectionWriter.connectionAt")(function* (
  session: SessionIdentity,
  needs: "write" | "read",
) {
  const people = yield* PersonAccess;
  const shared = yield* SharedThreads;
  const reach = yield* people.sessionReach(session).pipe(Effect.mapError(unreadable));
  const everywhere =
    isWide(reach) || (needs === "read" && reach.kind === "person" && reach.serverLevel !== null);
  // A thread that is `null` names nothing that exists.
  return <E>(thread: Effect.Effect<ThreadId | null, E>) =>
    everywhere
      ? Effect.succeed(true)
      : reach.kind !== "person"
        ? Effect.succeed(false)
        : thread.pipe(
            Effect.mapError(unreadable),
            Effect.flatMap((threadId) =>
              threadId === null
                ? Effect.succeed(false)
                : needs === "write"
                  ? shared.writerLevel(reach.person.personId, threadId).pipe(
                      Effect.map((level) => level !== null),
                      Effect.mapError(unreadable),
                    )
                  : people.threadLevel(reach.person.personId, threadId).pipe(
                      Effect.map((level) => level !== null),
                      Effect.mapError(unreadable),
                    ),
            ),
          );
});

/** For a read that lists what belongs to many threads: whether the connection writes to one. */
export const connectionWrites = (session: SessionIdentity) => connectionAt(session, "write");

/** The same for reading: whether the connection reaches a thread at all. */
export const connectionReads = (session: SessionIdentity) => connectionAt(session, "read");

const refusal = (needs: "write" | "read") =>
  new J5ActionError({
    code: "NotShared",
    message:
      needs === "write"
        ? "You cannot write to this thread, so this is not yours to answer."
        : "This is not shared with you on this server.",
  });

/**
 * Refuses a request about a thread the connection cannot write to, or reach, as `needs` says. A
 * request naming nothing that exists (`null`) goes on, for its own action to refuse as not found.
 */
const requireAt =
  (needs: "write" | "read") =>
  <E>(session: SessionIdentity, thread: Effect.Effect<ThreadId | null, E>) =>
    Effect.gen(function* () {
      const at = yield* connectionAt(session, needs);
      // The thread is looked up only when the check needs it; a lookup that names nothing
      // passes, and every other refusal stands, a device no one has claimed included.
      let namesNothing = false;
      const allowed = yield* at(
        thread.pipe(
          Effect.tap((threadId) => Effect.sync(() => (namesNothing = threadId === null))),
        ),
      );
      if (!allowed && !namesNothing) return yield* refusal(needs);
    });

export const requireWrites = requireAt("write");
export const requireReaches = requireAt("read");

/**
 * Refuses anyone who is not an Owner of the server, for now, as command admission refuses them
 * archiving or deleting a thread (People and access AC14). A service session passes.
 */
export const requireOwner = Effect.fn("j5.sharing.connectionWriter.requireOwner")(function* (
  session: SessionIdentity,
) {
  const reach = yield* (yield* PersonAccess)
    .sessionReach(session)
    .pipe(Effect.mapError(unreadable));
  const owner =
    reach.kind === "service" ||
    (reach.kind === "person" && levelReaches(reach.serverLevel, "owner"));
  if (!owner) {
    return yield* new J5ActionError({
      code: "OwnersOnly",
      message: "Only an Owner of this server archives a Crew, for now. Ask an Owner to do it.",
    });
  }
});
