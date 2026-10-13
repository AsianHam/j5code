import { assert, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import type { J5ReadRevisionKey } from "@t3tools/contracts/j5";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { ParticipantId, type CommEventKind, type StoredCommEvent } from "./contracts.ts";
import { A2ALedger } from "./LedgerService.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { changesRuntimeRequests, layer, readsChangedByLedgerEvent } from "./ReadChangeFeeds.ts";
import { ReadChanges } from "./ReadChanges.ts";

const agent = ParticipantId.make("agent:j5:a2a:thread:builder");
const person = ParticipantId.make("human:local-operator");

/** Only the fields the feed reads; the rest of a stored ledger event does not decide anything. */
const ledgerEvent = (
  kind: CommEventKind,
  receiver: ParticipantId | null = agent,
  payload: object = {},
) => ({ kind, receiver, payload }) as unknown as StoredCommEvent;

const storedEvent = (type: string, payload: object = {}) =>
  ({
    sequence: 1,
    commandId: null,
    event: { type, threadId: ThreadId.make("thread:builder"), payload },
  }) as unknown as OrchestrationV2StoredEvent;

it("maps each ledger event to the reads it puts out of date", () => {
  const changed = (kind: CommEventKind, receiver?: ParticipantId | null) =>
    readsChangedByLedgerEvent(ledgerEvent(kind, receiver));
  assert.deepStrictEqual(changed("exchange.opened"), ["fleet"]);
  assert.deepStrictEqual(changed("exchange.closed"), ["inbox", "fleet"]);
  assert.deepStrictEqual(changed("exchange.dropped"), ["inbox", "fleet"]);
  for (const kind of [
    "participant.joined",
    "participant.left",
    "participant.archived",
    "participant.unarchived",
    "participant.deleted",
  ] as const)
    assert.deepStrictEqual(changed(kind), ["fleet"], kind);
  for (const kind of [
    "message.delivered",
    "message.cancelled",
    "message.delivery_failed",
  ] as const) {
    // An outcome does not say whether its message waited for a peer, so each moves the peer list.
    assert.deepStrictEqual(changed(kind, person), ["inbox", "peers"], kind);
    assert.deepStrictEqual(changed(kind, agent), ["peers"], kind);
    // An event that names no receiver is counted rather than missed.
    assert.deepStrictEqual(changed(kind, null), ["inbox", "peers"], kind);
  }
  for (const kind of ["message.sent", "message.received", "silence.notice"] as const)
    assert.deepStrictEqual(changed(kind, person), [], kind);
  // A send to an agent on a peer server waits in that peer's row until it is delivered.
  assert.deepStrictEqual(
    readsChangedByLedgerEvent(
      ledgerEvent("message.sent", agent, { receiverEnvironmentId: "environment-home" }),
    ),
    ["peers"],
  );
});

it("counts an approval among the turn items, and no other turn item", () => {
  assert.isTrue(changesRuntimeRequests(storedEvent("runtime-request.updated")));
  assert.isTrue(
    changesRuntimeRequests(storedEvent("turn-item.updated", { type: "approval_request" })),
  );
  assert.isFalse(
    changesRuntimeRequests(storedEvent("turn-item.updated", { type: "command_execution" })),
  );
  for (const type of ["thread.archived", "thread.unarchived", "thread.deleted"])
    assert.isTrue(changesRuntimeRequests(storedEvent(type)), type);
  assert.isFalse(changesRuntimeRequests(storedEvent("run.updated")));
});

it.effect(
  "notifies from the ledger, the event store, the playbook store and the peer registry",
  () =>
    Effect.gen(function* () {
      const notified = yield* Queue.unbounded<ReadonlyArray<J5ReadRevisionKey>>();
      const committed = yield* Queue.unbounded<StoredCommEvent>();
      const stored = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const playbookRevisions = yield* Queue.unbounded<number>();
      const peerListChanges = yield* Queue.unbounded<void>();
      let recordedPeers = false;
      const followed: Array<{ readonly afterSequence?: number; readonly eventType?: string }> = [];
      yield* Layer.build(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              // Each notify is awaited by the test, so nothing here waits on the coalescing window.
              Layer.succeed(
                ReadChanges,
                ReadChanges.of({
                  notify: (...keys) =>
                    keys.length === 0
                      ? Effect.void
                      : Queue.offer(notified, keys).pipe(Effect.asVoid),
                  changes: Stream.never,
                }),
              ),
              Layer.mock(A2ALedger)({
                subscribeCommitted: Effect.succeed(Stream.fromQueue(committed)),
              }),
              Layer.mock(EventSinkV2)({
                latestSequence: () => Effect.succeed(41),
                stream: (input) => {
                  followed.push({ ...input });
                  return input?.eventType === "turn-item.updated"
                    ? Stream.fromQueue(stored)
                    : Stream.never;
                },
              }),
              Layer.mock(PlaybookStore)({
                changes: Stream.concat(Stream.make(7), Stream.fromQueue(playbookRevisions)),
              }),
              Layer.mock(PeerRegistryService)({
                subscribeListChanges: Effect.succeed(Stream.fromQueue(peerListChanges)),
                // No peer at first; the registry's change below is its first.
                hasPeers: Effect.sync(() => recordedPeers),
              }),
            ),
          ),
        ),
      );

      // A plain send changes no read; the delivery to a person behind it is the first heard.
      // With no peer recorded, a delivery has no peer list to change.
      yield* Queue.offer(committed, ledgerEvent("message.sent", agent));
      yield* Queue.offer(committed, ledgerEvent("message.delivered", person));
      assert.deepStrictEqual(yield* Queue.take(notified), ["inbox"]);
      yield* Queue.offer(committed, ledgerEvent("participant.joined"));
      assert.deepStrictEqual(yield* Queue.take(notified), ["fleet"]);

      // A command's turn item is not an approval; the approval behind it is the first heard.
      yield* Queue.offer(stored, storedEvent("turn-item.updated", { type: "command_execution" }));
      yield* Queue.offer(stored, storedEvent("turn-item.updated", { type: "approval_request" }));
      assert.deepStrictEqual(yield* Queue.take(notified), ["runtimeRequests"]);
      assert.equal(yield* Queue.size(notified), 0);
      // The store is followed from where it stood at boot, one filtered stream per type.
      assert.deepStrictEqual(
        followed.toSorted((left, right) => left.eventType!.localeCompare(right.eventType!)),
        [
          "runtime-request.updated",
          "thread.archived",
          "thread.deleted",
          "thread.metadata-updated",
          "thread.unarchived",
          "turn-item.updated",
        ].map((eventType) => ({ afterSequence: 41, eventType })),
      );

      // The playbook store's standing revision is not a change; its next one is.
      yield* Queue.offer(playbookRevisions, 8);
      assert.deepStrictEqual(yield* Queue.take(notified), ["fleet"]);

      // The registry says one of its writes changed what the peer list reports: a peer was added.
      recordedPeers = true;
      yield* Queue.offer(peerListChanges, undefined);
      assert.deepStrictEqual(yield* Queue.take(notified), ["peers"]);
      // From then on a delivery may change how many messages wait for a peer.
      yield* Queue.offer(committed, ledgerEvent("message.delivered", agent));
      assert.deepStrictEqual(yield* Queue.take(notified), ["peers"]);
    }).pipe(Effect.scoped),
);

it.effect(
  "after losing the event stream, takes a new mark before saying requests may have changed",
  () =>
    Effect.gen(function* () {
      const marksReadAtNotify = yield* Queue.unbounded<number>();
      const broke = yield* Deferred.make<void>();
      const marks = [41, 50];
      let marksRead = 0;
      const followedFrom: Array<number | undefined> = [];
      yield* Layer.build(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                ReadChanges,
                ReadChanges.of({
                  // An event stored after this notify must be past the mark already taken.
                  notify: () => Queue.offer(marksReadAtNotify, marksRead).pipe(Effect.asVoid),
                  changes: Stream.never,
                }),
              ),
              Layer.mock(A2ALedger)({ subscribeCommitted: Effect.succeed(Stream.never) }),
              Layer.mock(EventSinkV2)({
                latestSequence: () => Effect.sync(() => marks[marksRead++]!),
                stream: (input) => {
                  followedFrom.push(input?.afterSequence);
                  return input?.afterSequence === 41 && input.eventType === "turn-item.updated"
                    ? Stream.fromEffect(Deferred.succeed(broke, undefined)).pipe(
                        Stream.flatMap(() => Stream.die("the event stream broke")),
                      )
                    : Stream.never;
                },
              }),
              Layer.mock(PlaybookStore)({ changes: Stream.never }),
              Layer.mock(PeerRegistryService)({
                subscribeListChanges: Effect.succeed(Stream.never),
                hasPeers: Effect.succeed(false),
              }),
            ),
          ),
        ),
      );
      yield* Deferred.await(broke);
      // The follower waits a second before it resumes.
      const heard = yield* Queue.take(marksReadAtNotify).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(heard), 2);
      assert.includeMembers(followedFrom, [41, 50]);
    }),
);
