import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { COALESCE_WINDOW, ReadChanges } from "../ReadChanges.ts";

/** The revisions a client joining now would be sent, once the coalescing window has passed. */
export const settledReadRevisions = Effect.gen(function* () {
  const changes = yield* ReadChanges;
  const first = yield* changes.changes.pipe(
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* TestClock.adjust(COALESCE_WINDOW);
  return Option.getOrThrow(yield* Fiber.join(first));
});
