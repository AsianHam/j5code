import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { COALESCE_WINDOW, ReadChanges, layer } from "./ReadChanges.ts";
import { settledReadRevisions } from "./test-support/readRevisions.ts";

it.effect(
  "moves only the revision that was notified, and tells a new subscriber where it stands",
  () =>
    Effect.gen(function* () {
      const changes = yield* ReadChanges;
      assert.deepStrictEqual(yield* settledReadRevisions, {
        inbox: 0,
        crew: 0,
        fleet: 0,
        runtimeRequests: 0,
      });
      yield* changes.notify("inbox");
      yield* changes.notify("crew", "fleet");
      // A subscriber that joins after the writes still learns of them.
      assert.deepStrictEqual(yield* settledReadRevisions, {
        inbox: 1,
        crew: 1,
        fleet: 1,
        runtimeRequests: 0,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("tells a subscriber once about a burst of writes", () =>
  Effect.gen(function* () {
    const changes = yield* ReadChanges;
    const heard = yield* changes.changes.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust(COALESCE_WINDOW);
    yield* changes.notify("inbox");
    yield* changes.notify("inbox");
    yield* changes.notify("runtimeRequests");
    yield* TestClock.adjust(COALESCE_WINDOW);
    assert.deepStrictEqual(yield* Fiber.join(heard), [
      { inbox: 0, crew: 0, fleet: 0, runtimeRequests: 0 },
      { inbox: 2, crew: 0, fleet: 0, runtimeRequests: 1 },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps telling a subscriber while writes never pause", () =>
  Effect.gen(function* () {
    const changes = yield* ReadChanges;
    const heard = yield* changes.changes.pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    // A write every 200 ms never leaves the quiet gap a debounce would wait for.
    for (let write = 0; write < 6; write += 1) {
      yield* TestClock.adjust("200 millis");
      yield* changes.notify("fleet");
    }
    yield* TestClock.adjust(COALESCE_WINDOW);
    assert.deepStrictEqual(
      (yield* Fiber.join(heard)).map((revisions) => revisions.fleet),
      [2, 4, 6],
    );
  }).pipe(Effect.provide(layer)),
);
