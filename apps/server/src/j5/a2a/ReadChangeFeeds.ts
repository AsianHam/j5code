/**
 * Turns what the server already publishes into `ReadChanges` revisions, so the writers of those
 * facts stay unaware of the clients reading them: the ledger's committed events, the
 * orchestration event store, and the playbook store's own revision.
 *
 * @module ReadChangeFeeds
 */
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import type { J5ReadRevisionKey } from "@t3tools/contracts/j5";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { isHumanParticipantId, type StoredCommEvent } from "./contracts.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";
import { A2ALedger } from "./LedgerService.ts";
import { ReadChanges } from "./ReadChanges.ts";

/**
 * A person's inbox row is written by the delivery that these events record, so a delivery to an
 * agent changes no Inbox. An event that names no receiver counts, rather than being missed.
 */
const reachesPerson = (event: StoredCommEvent) =>
  event.receiver === null || isHumanParticipantId(event.receiver);

/** Which reads a committed ledger event puts out of date. */
export const readsChangedByLedgerEvent = (
  event: StoredCommEvent,
): ReadonlyArray<J5ReadRevisionKey> => {
  switch (event.kind) {
    // The Fleet counts each agent's open Exchanges; the Inbox lists the ones a person owes.
    case "exchange.closed":
    case "exchange.dropped":
      return ["inbox", "fleet"];
    case "exchange.opened":
      return ["fleet"];
    case "message.delivered":
    case "message.cancelled":
    case "message.delivery_failed":
      return reachesPerson(event) ? ["inbox"] : [];
    case "participant.joined":
    case "participant.left":
    case "participant.archived":
    case "participant.unarchived":
    case "participant.deleted":
      return ["fleet"];
    case "message.sent":
    case "message.received":
    case "silence.notice":
      return [];
  }
};

/** The stored event types that can change a seat's pending approvals. */
const RUNTIME_REQUEST_EVENT_TYPES = [
  "runtime-request.updated",
  "turn-item.updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.metadata-updated",
] as const satisfies ReadonlyArray<OrchestrationV2StoredEvent["event"]["type"]>;

/**
 * Whether a stored event can change the approvals the Inbox lists. Every turn item is stored
 * through `turn-item.updated`; only an approval request is one of these.
 */
export const changesRuntimeRequests = ({ event }: OrchestrationV2StoredEvent) =>
  event.type === "turn-item.updated"
    ? event.payload.type === "approval_request"
    : event.type === "runtime-request.updated" ||
      event.type === "thread.archived" ||
      event.type === "thread.unarchived" ||
      event.type === "thread.deleted" ||
      // The approval's card names its thread by title.
      event.type === "thread.metadata-updated";

/**
 * The daemons that feed `ReadChanges`. They hold nothing a caller could ask for, so the layer
 * provides no service.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const changes = yield* ReadChanges;
    const ledger = yield* A2ALedger;
    const events = yield* EventSinkV2;
    const playbooks = yield* PlaybookStore;

    const committed = yield* ledger.subscribeCommitted;
    yield* committed.pipe(
      Stream.runForEach((event) => changes.notify(...readsChangedByLedgerEvent(event))),
      Effect.forkScoped,
    );

    // The Fleet shows each Crew's playbook run. The store's first value is its current
    // revision, not a change.
    yield* playbooks.changes.pipe(
      Stream.drop(1),
      Stream.runForEach(() => changes.notify("fleet")),
      Effect.forkScoped,
    );

    // Only what happens from here on: the revisions start with the server, and a client reads
    // when it connects. The store filters by type before it queues, so the turn items this
    // daemon drops are the only traffic it sees beyond what it acts on.
    const follow = (resumed: boolean) =>
      Effect.gen(function* () {
        const afterSequence = yield* readEventStoreHighWater("J5 read change feed").pipe(
          Effect.provideService(EventSinkV2, events),
        );
        // Whatever a broken stream did not deliver is at or below this mark and will not be
        // replayed, so one notify covers it. It comes after the mark is read: an event stored
        // any later is past the mark and is streamed.
        if (resumed) yield* changes.notify("runtimeRequests");
        yield* followFrom(afterSequence);
      });
    const followFrom = (afterSequence: number) =>
      Stream.mergeAll(
        RUNTIME_REQUEST_EVENT_TYPES.map((eventType) => events.stream({ afterSequence, eventType })),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.filter(changesRuntimeRequests),
        Stream.runForEach(() => changes.notify("runtimeRequests")),
      );
    const resume = (resumed: boolean): Effect.Effect<never> =>
      follow(resumed).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 read change feed lost the event stream; resuming", { cause }).pipe(
            Effect.andThen(Effect.sleep(Duration.seconds(1))),
          ),
        ),
        Effect.andThen(Effect.suspend(() => resume(true))),
      );
    yield* resume(false).pipe(Effect.forkScoped);
  }),
);
