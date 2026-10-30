import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";

const retrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * The event store's latest committed sequence, where a J5 daemon starts tailing after its
 * reconciliation sweep. A failed read logs and retries with capped backoff and never falls back to
 * 0, which would replay all history and re-fire old reactions, such as a Captain archive retiring
 * live Crews.
 */
export const readEventStoreHighWater = Effect.fn(
  "j5.a2a.eventStoreHighWater.readEventStoreHighWater",
)(function* (daemon: string) {
  const events = yield* EventSinkV2;
  return yield* events.latestSequence().pipe(
    Effect.tapError((cause) =>
      Effect.logWarning(`${daemon} could not read the event store's latest sequence; retrying`, {
        cause,
      }),
    ),
    Effect.retry(retrySchedule),
  );
});
