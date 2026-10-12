import type { PeerPollRequest, PeerPollResponse } from "@t3tools/contracts/j5";
import { ownPeerCapabilities } from "./peerProtocol.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import { A2ADeliveryWorker, type A2ADeliveryWorkerError } from "./DeliveryWorker.ts";
import { A2ALedger } from "./LedgerService.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import type { StoredCommEvent } from "./contracts.ts";

/**
 * The storing side of poll mode. A peer that cannot be reached polls this
 * server: each poll acknowledges what the last one handed out, refreshes what
 * the poller tells about itself (its name, capabilities, protocol version and,
 * when it changed, its roster), and takes the next batch of messages stored
 * for it. With nothing waiting the poll is held until a message for this peer
 * is committed or the hold ends, which stays under typical office-proxy idle
 * timeouts. A poll is taken in two steps, so the route can answer its status
 * at once and hold only the body: `startPoll` records the poll, and the answer
 * it returns is the held batch.
 */

export const PEER_POLL_HOLD = Duration.seconds(25);

export interface PeerPollInput {
  readonly environmentId: string;
  readonly request: PeerPollRequest;
  /** The peer protocol version the poller stated. */
  readonly protocolVersion: number;
}

export type PeerStoreError = A2ADeliveryWorkerError | SqlError;

export interface PeerStoreServiceShape {
  /** Records the poll's acks and what the poller told; the effect it returns holds for the batch. */
  readonly startPoll: (
    input: PeerPollInput,
  ) => Effect.Effect<Effect.Effect<PeerPollResponse, PeerStoreError>, PeerStoreError>;
  /** Both steps of a poll in one. */
  readonly poll: (input: PeerPollInput) => Effect.Effect<PeerPollResponse, PeerStoreError>;
}

export class PeerStoreService extends Context.Service<PeerStoreService, PeerStoreServiceShape>()(
  "t3/j5/a2a/PeerStoreService",
) {}

/** A committed send whose receiver lives on this peer: the only fact that gives a held poll something new. */
const isStoredFor = (environmentId: string) => (event: StoredCommEvent) =>
  event.kind === "message.sent" &&
  typeof event.payload === "object" &&
  event.payload !== null &&
  "receiverEnvironmentId" in event.payload &&
  event.payload.receiverEnvironmentId === environmentId;

export const layer: Layer.Layer<
  PeerStoreService,
  never,
  A2ADeliveryWorker | PeerRegistryService | A2ALedger
> = Layer.effect(
  PeerStoreService,
  Effect.gen(function* () {
    const worker = yield* A2ADeliveryWorker;
    const peers = yield* PeerRegistryService;
    const ledger = yield* A2ALedger;

    /** Hands out what is waiting, or holds until something is recorded or the hold ends. */
    const nextBatch = (environmentId: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Subscribed before the first look, so a message recorded in between
          // still wakes us; only a message for this peer does.
          const committed = yield* ledger.subscribeCommitted;
          const nextForThisPeer = committed.pipe(
            Stream.filter(isStoredFor(environmentId)),
            Stream.runHead,
          );
          const deadline = DateTime.addDuration(yield* DateTime.now, PEER_POLL_HOLD);
          while (true) {
            const batch = yield* worker.handOutToPeer(environmentId);
            if (batch.deliveries.length > 0) return batch;
            const remaining = DateTime.distance(yield* DateTime.now, deadline);
            if (Duration.toMillis(remaining) <= 0) return batch;
            yield* nextForThisPeer.pipe(Effect.timeoutOption(remaining));
          }
        }),
      );

    const startPoll: PeerStoreServiceShape["startPoll"] = (input) =>
      Effect.gen(function* () {
        yield* worker.acknowledgePeer(input.environmentId, input.request.acks);
        // What the poller tells is recorded at once, so the address book sees a
        // changed roster during the hold, and so is the heartbeat: a poll held
        // here proves the poller is there.
        const receivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const { rosterHash } = yield* peers.recordPoll({
          environmentId: input.environmentId,
          receivedAt,
          protocolVersion: input.protocolVersion,
          label: input.request.label,
          capabilities: input.request.capabilities,
          roster:
            input.request.roster === undefined
              ? undefined
              : { agents: input.request.roster, hash: input.request.rosterHash },
        });
        return nextBatch(input.environmentId).pipe(
          Effect.flatMap((batch) =>
            peers.selfLabel.pipe(
              Effect.map((label): PeerPollResponse => ({
                deliveries: batch.deliveries,
                rosterHash,
                more: batch.more,
                label,
                capabilities: ownPeerCapabilities,
              })),
            ),
          ),
        );
      });

    const poll: PeerStoreServiceShape["poll"] = (input) => Effect.flatten(startPoll(input));

    return PeerStoreService.of({ startPoll, poll });
  }),
);
