import type { ThreadId } from "@t3tools/contracts";
import { J5ActionError } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { PersonAccess, type SessionIdentity, isWide } from "./PersonAccess.ts";
import { SharedThreads } from "./SharedThreads.ts";

const unreadable = () =>
  new J5ActionError({ code: "storage", message: "Could not read what you can write to." });

/**
 * Refuses a request about a thread the connection cannot write to, for a request that is not a
 * command upstream checks: answering a Crew seat's approval, deciding a roster, stopping a Crew
 * (Crews AC23). A service session and someone who writes to every thread pass without the thread
 * being looked up; anyone else passes where they can write; a device no one has claimed nowhere.
 * `thread` names the thread, or `null` for a request naming nothing that exists, which goes on
 * for its own action to refuse as not found.
 */
export const requireWrites = <E>(
  session: SessionIdentity,
  thread: Effect.Effect<ThreadId | null, E>,
) =>
  Effect.gen(function* () {
    const people = yield* PersonAccess;
    const reach = yield* people.sessionReach(session).pipe(Effect.mapError(unreadable));
    if (isWide(reach)) return;
    const threadId = yield* thread.pipe(Effect.mapError(unreadable));
    if (threadId === null) return;
    const level =
      reach.kind === "person"
        ? yield* (yield* SharedThreads)
            .writerLevel(reach.person.personId, threadId)
            .pipe(Effect.mapError(unreadable))
        : null;
    if (level === null) {
      return yield* new J5ActionError({
        code: "NotShared",
        message: "You cannot write to this Crew's Captain, so this is not yours to answer.",
      });
    }
  });

/**
 * For a read that lists what belongs to many threads: whether the connection writes to the thread
 * an entry names. A service session and someone who writes to every thread write to all of them,
 * read once, and the thread is not looked up; a thread that is `null` is no one's.
 */
export const connectionWrites = (session: SessionIdentity) =>
  Effect.gen(function* () {
    const people = yield* PersonAccess;
    const shared = yield* SharedThreads;
    const reach = yield* people.sessionReach(session).pipe(Effect.mapError(unreadable));
    return <E>(thread: Effect.Effect<ThreadId | null, E>) =>
      isWide(reach)
        ? Effect.succeed(true)
        : reach.kind !== "person"
          ? Effect.succeed(false)
          : thread.pipe(
              Effect.mapError(unreadable),
              Effect.flatMap((threadId) =>
                threadId === null
                  ? Effect.succeed(false)
                  : shared.writerLevel(reach.person.personId, threadId).pipe(
                      Effect.map((level) => level !== null),
                      Effect.mapError(unreadable),
                    ),
              ),
            );
  });

/** The same for reading: whether the connection reaches a thread at all. */
export const connectionReads = (session: SessionIdentity) =>
  Effect.gen(function* () {
    const people = yield* PersonAccess;
    const reach = yield* people.sessionReach(session).pipe(Effect.mapError(unreadable));
    return (threadId: ThreadId) =>
      isWide(reach) || (reach.kind === "person" && reach.serverLevel !== null)
        ? Effect.succeed(true)
        : reach.kind !== "person"
          ? Effect.succeed(false)
          : people.threadLevel(reach.person.personId, threadId).pipe(
              Effect.map((level) => level !== null),
              Effect.mapError(unreadable),
            );
  });
