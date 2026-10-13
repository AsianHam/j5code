import type { J5ReadRevisionKey, J5ReadRevisions } from "@t3tools/contracts/j5";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * One send commits several events, and a busy fleet commits them without pause. A subscriber
 * hears where the revisions stand once per window: a burst is one message, and steady writes
 * cannot hold a message back the way a debounce would.
 */
export const COALESCE_WINDOW = "500 millis";

/**
 * Says which of J5's client reads went out of date, never what changed. A writer calls `notify`
 * after its commit; every connected client follows `changes` and re-reads what moved. One
 * instance serves the whole server, shared by layer reference between the writers and the
 * WebSocket handler. Its counters start from the time the server started, so a client that
 * reconnects after a restart sees them moved and re-reads what it would not on its own.
 */
export class ReadChanges extends Context.Service<
  ReadChanges,
  {
    /** Call after the write has committed: a client re-reads as soon as it hears. */
    readonly notify: (...keys: ReadonlyArray<J5ReadRevisionKey>) => Effect.Effect<void>;
    /**
     * The revisions as they stand, then each later state. Starting with the current value lets a
     * client that reconnects see a revision that moved while it was away.
     */
    readonly changes: Stream.Stream<J5ReadRevisions>;
  }
>()("t3/j5/a2a/ReadChanges") {}

const make = Effect.gen(function* () {
  const startedAt = yield* Clock.currentTimeMillis;
  const revisions = yield* SubscriptionRef.make<J5ReadRevisions>({
    inbox: startedAt,
    crew: startedAt,
    fleet: startedAt,
    runtimeRequests: startedAt,
    peers: startedAt,
    sharing: startedAt,
  });
  return ReadChanges.of({
    notify: (...keys) =>
      keys.length === 0
        ? Effect.void
        : SubscriptionRef.update(revisions, (current) => {
            const next = { ...current };
            for (const key of new Set(keys)) next[key] += 1;
            return next;
          }),
    changes: SubscriptionRef.changes(revisions).pipe(
      // Only that something moved matters here; what is sent is read after the window.
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.mapEffect(() =>
        Effect.sleep(COALESCE_WINDOW).pipe(Effect.andThen(SubscriptionRef.get(revisions))),
      ),
      Stream.changes,
    ),
  });
});

export const layer = Layer.effect(ReadChanges, make);
