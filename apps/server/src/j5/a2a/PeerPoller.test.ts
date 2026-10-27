import { ThreadId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import {
  PeerPollRequest,
  peerPollStoppedError,
  peerPollStoppedReason,
  type A2ARosterEntry,
  type PeerDeliveryRequest,
  type PeerPollResponse,
  PEER_PROTOCOL_VERSION,
} from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/http";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2ALedger } from "./LedgerService.ts";
import {
  A2APeerReceiverNotFoundError,
  PeerInboundService,
  type PeerInboundInput,
} from "./PeerInboundService.ts";
import {
  PeerPoller,
  layer as peerPollerLayer,
  manualLayer,
  type PeerPollOutcome,
} from "./PeerPoller.ts";
import {
  PeerRegistryService,
  PeerSessionReadError,
  type PeerConnection,
  type PeerPollFacts,
  type PeerRegistryServiceShape,
} from "./PeerRegistryService.ts";
import { RosterService } from "./RosterService.ts";
import { peerRosterHash, toPeerRoster } from "./peerRoster.ts";
import type { StoredCommEvent } from "./contracts.ts";

/**
 * The polling side alone: one laptop polling one work VM. The VM is a scripted
 * HTTP answer per poll, so each case states exactly what the VM said.
 */

const vmOrigin = "https://vm.example:3773";
const vm = "environment-vm";
const vmPeer: PeerConnection = {
  environmentId: vm,
  label: "Work VM",
  linkMode: "poll",
  origin: vmOrigin,
  credential: "vm-issued",
  credentialExpiresAt: null,
  inboundSession: "missing",
  createdAt: "2026-10-02T12:00:00.000Z",
  lastPolledAt: null,
  lastError: null,
  waitingCount: 0,
  oldestWaitingAt: null,
  roster: null,
};

type Answer =
  | {
      readonly status: number;
      readonly body: unknown;
      /** The version header it states; null states none, as a proxy or a non-J5 server answers. */
      readonly protocol?: string | null;
      /** Sent as is instead of JSON, such as a proxy's HTML error page. */
      readonly raw?: string;
    }
  | {
      readonly unreachable: string;
      /** The code fetch's cause carries, such as `UND_ERR_SOCKET` for a connection closed under the request. */
      readonly code?: string;
      readonly after?: Duration.Input;
    }
  /** A 200's status and headers at once, and a body held until the poll is abandoned. */
  | { readonly hold: true }
  /** A 200's status and headers, then the connection cut before the body, as a proxy cuts it. */
  | { readonly cut: true }
  /** A status and headers whose body never arrives. */
  | { readonly status: number; readonly stalledBody: true; readonly protocol?: string }
  /** No status or headers at all. */
  | { readonly silent: true }
  /** An answer that comes only after the request was open this long. */
  | { readonly after: Duration.Input; readonly answer: Answer };

const decodePollRequest = Schema.decodeUnknownSync(Schema.fromJsonString(PeerPollRequest));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const pollAnswer = (overrides: Partial<PeerPollResponse> = {}): Answer => ({
  status: 200,
  body: {
    deliveries: [],
    rosterHash: null,
    more: false,
    label: "Work VM",
    capabilities: { poll: true },
    ...overrides,
  } satisfies PeerPollResponse,
});

const delivery = (
  name: string,
  receiverId = "agent:j5:a2a:thread:ios-build",
): PeerDeliveryRequest => ({
  messageId: `message:${name}`,
  senderId: "agent:j5:a2a:thread:billing",
  receiverId,
  exchangeId: null,
  correlationId: `correlation:${name}`,
  exchangeRole: "none",
  envelopeChannel: "peer",
  text: `${name} text`,
  originProjectId: "project:vm-billing",
  createdAt: "2026-10-02T12:00:00.000Z",
});

const rosterEntry = (archived: boolean): A2ARosterEntry => ({
  participantId: "agent:j5:a2a:thread:ios-build",
  kind: "agent",
  projectId: "project:laptop-ios",
  projectTitle: "iOS",
  displayName: "iOS build",
  threadId: ThreadId.make("thread:ios-build"),
  archived,
  canReceiveMessage: !archived,
  acceptsUrgency: false,
  liveness: null,
});

interface Harness {
  readonly answers: Array<Answer>;
  readonly requests: Array<PeerPollRequest>;
  readonly received: Array<PeerInboundInput>;
  readonly lastErrors: Array<string | null>;
  readonly polls: Array<PeerPollFacts>;
  readonly roster: Ref.Ref<ReadonlyArray<A2ARosterEntry>>;
  readonly notified: { count: number };
  readonly subscriptions: { active: number; peak: number };
  /** When the VM's record was made here; removing and peering again makes a new one. */
  readonly peerCreatedAt: { value: string };
  /** Each heartbeat stamped, for a test to wait on. */
  readonly heartbeats: Queue.Queue<string>;
  /** Each poll request as it is sent, for a test to wait on. */
  readonly sent: Queue.Queue<PeerPollRequest>;
  /** When each request was sent, on the test clock. */
  readonly sentAtMs: Array<number>;
  /** Ledger facts, and thread metadata updates, as this server commits them. */
  readonly committed: PubSub.PubSub<StoredCommEvent>;
  readonly threadUpdates: {
    readonly published: Array<OrchestrationV2StoredEvent>;
    readonly live: PubSub.PubSub<OrchestrationV2StoredEvent>;
  };
}

const makeHarness = Effect.gen(function* () {
  const harness: Harness = {
    answers: [],
    requests: [],
    received: [],
    lastErrors: [],
    polls: [],
    roster: yield* Ref.make<ReadonlyArray<A2ARosterEntry>>([rosterEntry(false)]),
    notified: { count: 0 },
    subscriptions: { active: 0, peak: 0 },
    peerCreatedAt: { value: vmPeer.createdAt },
    sent: yield* Queue.unbounded<PeerPollRequest>(),
    sentAtMs: [],
    heartbeats: yield* Queue.unbounded<string>(),
    committed: yield* PubSub.unbounded<StoredCommEvent>(),
    threadUpdates: { published: [], live: yield* PubSub.unbounded<OrchestrationV2StoredEvent>() },
  };
  return harness;
});

/** A thread update as the event store records it; only its sequence matters here. */
const publishThreadUpdate = (harness: Harness) =>
  Effect.suspend(() => {
    const event = {
      sequence: harness.threadUpdates.published.length + 1,
    } as OrchestrationV2StoredEvent;
    harness.threadUpdates.published.push(event);
    return PubSub.publish(harness.threadUpdates.live, event);
  });

const respond = (
  request: HttpClientRequest.HttpClientRequest,
  answer: Answer,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    if ("silent" in answer) return yield* Effect.never;
    if ("stalledBody" in answer) {
      return HttpClientResponse.fromWeb(
        request,
        new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          status: answer.status,
          headers: {
            "content-type": "application/json",
            "x-j5-peer-protocol": answer.protocol ?? String(PEER_PROTOCOL_VERSION),
          },
        }),
      );
    }
    if ("hold" in answer || "cut" in answer) {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          if ("cut" in answer) {
            controller.error(
              new TypeError("terminated", {
                cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
              }),
            );
          }
        },
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-j5-peer-protocol": String(PEER_PROTOCOL_VERSION),
          },
        }),
      );
    }
    if ("answer" in answer) {
      yield* Effect.sleep(answer.after);
      return yield* respond(request, answer.answer);
    }
    if ("unreachable" in answer) {
      if (answer.after !== undefined) yield* Effect.sleep(answer.after);
      // Shaped as fetch reports it: a TypeError whose cause names the system error.
      const cause = new TypeError("fetch failed", {
        cause: Object.assign(new Error(answer.unreachable), { code: answer.code }),
      });
      return yield* new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: answer.unreachable,
          cause,
        }),
      });
    }
    return HttpClientResponse.fromWeb(
      request,
      new Response(answer.raw ?? encodeJson(answer.body), {
        status: answer.status,
        headers: {
          "content-type": "application/json",
          ...(answer.protocol === null
            ? {}
            : { "x-j5-peer-protocol": answer.protocol ?? String(PEER_PROTOCOL_VERSION) }),
        },
      }),
    );
  });

const makeTestLayer = (
  harness: Harness,
  options: {
    readonly daemon?: boolean;
    /** Stands in for the registry's poll peers, read again on each change. */
    readonly connections?: PeerRegistryServiceShape["connections"];
    readonly changes?: Stream.Stream<void>;
  } = {},
) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const sent = decodePollRequest(body);
        harness.requests.push(sent);
        harness.sentAtMs.push(DateTime.toEpochMillis(yield* DateTime.now));
        yield* Queue.offer(harness.sent, sent);
        const answer = harness.answers.shift() ?? { hold: true };
        return yield* respond(request, answer);
      }),
    ),
  );
  const dependencies = Layer.mergeAll(
    http,
    Layer.mock(PeerRegistryService)({
      connection: (environmentId) =>
        Effect.succeed(
          environmentId === vm ? { ...vmPeer, createdAt: harness.peerCreatedAt.value } : null,
        ),
      connections: options.connections ?? (() => Effect.succeed([vmPeer])),
      subscribeChanges: Effect.succeed(options.changes ?? Stream.never),
      selfLabel: Effect.succeed("JM-LT-04213"),
      recordLastError: (_environmentId, error) =>
        Effect.sync(() => {
          harness.lastErrors.push(error);
        }),
      recordPolled: (_environmentId, at) => Queue.offer(harness.heartbeats, at),
      recordPoll: (facts) =>
        Effect.sync(() => {
          harness.polls.push(facts);
          return { rosterHash: null };
        }),
    }),
    Layer.mock(PeerInboundService)({
      receive: (input) =>
        input.receiverId === "agent:j5:a2a:thread:gone"
          ? Effect.fail(new A2APeerReceiverNotFoundError({ participantId: input.receiverId }))
          : input.receiverId === "agent:j5:a2a:thread:broken"
            ? Effect.die("the ledger is down")
            : Effect.sync(() => {
                harness.received.push(input);
                return { receivedSeq: harness.received.length, replay: false };
              }),
    }),
    Layer.mock(A2ADeliveryWorker)({
      notify: Effect.sync(() => {
        harness.notified.count += 1;
      }),
    }),
    Layer.mock(RosterService)({ list: () => Ref.get(harness.roster) }),
    Layer.mock(A2ALedger)({
      // Each subscription is counted while it is held, so a loop that keeps them open shows.
      subscribeCommitted: Effect.acquireRelease(
        Effect.sync(() => {
          harness.subscriptions.active += 1;
          harness.subscriptions.peak = Math.max(
            harness.subscriptions.peak,
            harness.subscriptions.active,
          );
        }),
        () =>
          Effect.sync(() => {
            harness.subscriptions.active -= 1;
          }),
      ).pipe(
        Effect.andThen(PubSub.subscribe(harness.committed)),
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    // Like the event store: what was recorded after the sequence replays, then live updates follow.
    Layer.mock(EventSinkV2)({
      latestSequence: () => Effect.sync(() => harness.threadUpdates.published.length),
      stream: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const live = yield* PubSub.subscribe(harness.threadUpdates.live);
            const after = input?.afterSequence ?? 0;
            const replayed = harness.threadUpdates.published.slice(after);
            const through = after + replayed.length;
            return Stream.concat(
              Stream.fromIterable(replayed),
              Stream.fromSubscription(live).pipe(
                Stream.filter((event) => event.sequence > through),
              ),
            );
          }),
        ),
    }),
  );
  return (options.daemon === true ? peerPollerLayer : manualLayer).pipe(
    Layer.provide(dependencies),
  );
};

const pollOnce = Effect.flatMap(PeerPoller, (poller) => poller.pollOnce(vm));

it.effect("sends its roster only when it changed, and carries and refreshes both names", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      harness.answers.push(pollAnswer());
      assert.deepStrictEqual(yield* pollOnce, { kind: "polled", received: 0, more: false });
      const first = harness.requests[0]!;
      assert.equal(first.label, "JM-LT-04213", "the poll names the polling server");
      assert.deepStrictEqual(
        first.roster?.map((agent) => agent.participantId),
        ["agent:j5:a2a:thread:ios-build"],
        "the VM holds no snapshot yet, so the roster goes out",
      );
      assert.equal(harness.polls[0]!.label, "Work VM", "the VM's own name is recorded");
      assert.isUndefined(harness.polls[0]!.roster);

      // The VM now holds this roster: it is not sent again.
      harness.answers.push(pollAnswer({ rosterHash: first.rosterHash }));
      yield* pollOnce;
      harness.answers.push(pollAnswer({ rosterHash: first.rosterHash }));
      yield* pollOnce;
      assert.isUndefined(harness.requests[2]!.roster, "an unchanged roster is not resent");

      // An archive here changes the roster, and the next poll carries it.
      yield* Ref.set(harness.roster, [rosterEntry(true)]);
      harness.answers.push(pollAnswer({ rosterHash: first.rosterHash }));
      yield* pollOnce;
      const changed = harness.requests[3]!;
      assert.notEqual(changed.rosterHash, first.rosterHash);
      assert.isTrue(changed.roster?.[0]?.archived);
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect(
  "records deliveries in order, acknowledges receipts and refusals in the next poll, and backs off on one it could not record",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        harness.answers.push(
          pollAnswer({
            deliveries: [
              delivery("first"),
              delivery("refused", "agent:j5:a2a:thread:gone"),
              delivery("third"),
              delivery("broken", "agent:j5:a2a:thread:broken"),
              delivery("after-broken"),
            ],
            more: true,
          }),
        );
        const outcome = yield* pollOnce;
        assert.equal(outcome.kind, "failed", "the rest come straight back, so the loop backs off");
        assert.include(harness.lastErrors.at(-1) ?? "", "could not be recorded on this server");
        assert.deepStrictEqual(
          harness.received.map((input) => [input.messageId, input.originEnvironmentId]),
          [
            ["message:first", vm],
            ["message:third", vm],
          ],
          "recorded in order, each as the VM's",
        );
        assert.equal(harness.notified.count, 1, "the worker is woken for what was recorded");

        harness.answers.push(pollAnswer());
        yield* pollOnce;
        assert.deepStrictEqual(harness.requests[1]!.acks, [
          { messageId: "message:first", outcome: "received", receivedSeq: 1, replay: false },
          {
            messageId: "message:refused",
            outcome: "refused",
            code: "recipient_not_found",
            message: "No active agent agent:j5:a2a:thread:gone is homed on this server.",
          },
          { messageId: "message:third", outcome: "received", receivedSeq: 2, replay: false },
        ]);
        assert.deepStrictEqual(
          harness.requests[2]?.acks ?? [],
          [],
          "acks go once; what was not acknowledged is handed out again",
        );
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect("stops on a rejected credential, sets a protocol mismatch aside, and says why", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      harness.answers.push({ status: 401, body: { error: "invalid_token" } });
      const rejected = yield* pollOnce;
      assert.equal(rejected.kind, "stopped");
      assert.include(harness.lastErrors.at(-1) ?? "", "rejected this server's credential");
      assert.include(harness.lastErrors.at(-1) ?? "", "it ended this peering");

      harness.answers.push({ ...pollAnswer(), protocol: "3" } as Answer);
      const mismatched = yield* pollOnce;
      assert.equal(mismatched.kind, "mismatched");
      assert.equal(
        harness.lastErrors.at(-1),
        peerPollStoppedError(
          "Work VM runs peer protocol 3 and this server runs 2. Update J5 on this server, then try again.",
        ),
      );

      // A storing server from before the wire named projects is the one to update.
      harness.answers.push({ ...pollAnswer(), protocol: "1" } as Answer);
      assert.equal((yield* pollOnce).kind, "mismatched");
      assert.equal(
        harness.lastErrors.at(-1),
        peerPollStoppedError(
          "Work VM runs peer protocol 1 and this server runs 2. Update J5 there, then try again.",
        ),
      );
      assert.isEmpty(harness.polls, "neither is a heartbeat");
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect(
  "counts a poll its peer never answered as an error, and a 200 cut on the way as not",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const after = (answer: Answer, wait: Duration.Input) =>
          Effect.gen(function* () {
            harness.answers.push(answer);
            const fiber = yield* Effect.forkChild(pollOnce);
            yield* TestClock.adjust(wait);
            return yield* Fiber.join(fiber);
          });
        // No headers came: however the request ended, and however long it took.
        const unanswered: ReadonlyArray<Answer> = [
          { unreachable: "connect ECONNREFUSED", code: "ECONNREFUSED" },
          {
            unreachable: "getaddrinfo ENOTFOUND vm.example",
            code: "ENOTFOUND",
            after: "10 seconds",
          },
          {
            unreachable: "Connect Timeout Error",
            code: "UND_ERR_CONNECT_TIMEOUT",
            after: "10 seconds",
          },
          { unreachable: "other side closed", code: "UND_ERR_SOCKET", after: "10 seconds" },
          { silent: true },
        ];
        for (const answer of unanswered) {
          assert.equal((yield* after(answer, "15 seconds")).kind, "failed");
          assert.include(harness.lastErrors.at(-1) ?? "", "could not reach Work VM");
        }
        assert.equal(harness.lastErrors.length, unanswered.length);

        // A 200's headers came, then the body was cut, or lost across a sleep.
        harness.answers.push({ cut: true });
        assert.equal((yield* pollOnce).kind, "cut");
        assert.equal((yield* after({ hold: true }, "40 seconds")).kind, "cut");
        assert.equal(harness.lastErrors.length, unanswered.length, "neither is shown as an error");

        // A body that arrived whole but is not an answer is an error, however long it took.
        const proxyPage: Answer = { status: 200, body: null, raw: "<html>proxy</html>" };
        assert.equal(
          (yield* after({ after: "10 seconds", answer: proxyPage }, "10 seconds")).kind,
          "failed",
        );
        assert.include(harness.lastErrors.at(-1) ?? "", "a body that is not JSON");
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect("abandons a held poll when told to, so a changed roster goes out at once", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const rosterChanged = yield* Deferred.make<void>();
      harness.answers.push({ hold: true });
      const held = yield* Effect.forkChild(
        Effect.flatMap(PeerPoller, (poller) => poller.pollOnce(vm, Deferred.await(rosterChanged))),
      );
      // The request is out and held before the roster changes.
      yield* Queue.take(harness.sent);
      yield* Deferred.succeed(rosterChanged, undefined);
      assert.deepStrictEqual(yield* Fiber.join(held), { kind: "abandoned" });
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect(
  "backs off from one second while the peer cannot be reached, and stops on a rejection",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.answers.push(
        { unreachable: "ECONNREFUSED" },
        { unreachable: "ECONNREFUSED" },
        { unreachable: "ECONNREFUSED" },
        { status: 401, body: { error: "invalid_token" } },
      );
      yield* Effect.gen(function* () {
        // The loop starts with the server, from the registry's poll peers.
        yield* PeerPoller;
        yield* Queue.take(harness.sent);
        for (const wait of ["1 second", "2 seconds", "4 seconds"] as const) {
          yield* TestClock.adjust(wait);
          yield* Queue.take(harness.sent);
        }
        const [first, second, third, fourth] = harness.sentAtMs;
        assert.deepStrictEqual(
          [second! - first!, third! - second!, fourth! - third!],
          [1_000, 2_000, 4_000],
          "each retry waits twice as long as the last",
        );
        // The fourth answer rejected the credential, which ends the loop.
        yield* TestClock.adjust("10 minutes");
        assert.equal(harness.requests.length, 4, "nothing polls until the peer is recorded again");
      }).pipe(Effect.provide(makeTestLayer(harness, { daemon: true })), Effect.scoped);
    }),
);

it.effect(
  "polls a peer moved to a new origin at once, not after the backoff against the old one",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const changes = yield* Queue.unbounded<void>();
      let current = vmPeer;
      harness.answers.push({ unreachable: "ECONNREFUSED" }, { unreachable: "ECONNREFUSED" });
      yield* Effect.gen(function* () {
        yield* PeerPoller;
        yield* Queue.take(harness.sent);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(harness.sent);
        // The loop now waits two seconds before trying the old origin again.
        current = { ...vmPeer, origin: "https://vm-moved.example:9444" };
        yield* Queue.offer(changes, undefined);
        yield* Queue.take(harness.sent);
        assert.equal(
          harness.sentAtMs[2],
          harness.sentAtMs[1],
          "no time passed before the new poll",
        );
      }).pipe(
        Effect.provide(
          makeTestLayer(harness, {
            daemon: true,
            connections: () => Effect.sync(() => [current]),
            changes: Stream.fromQueue(changes),
          }),
        ),
        Effect.scoped,
      );
    }),
);

it.effect(
  "retries a proxy's error page that states no protocol, rather than reading a mismatch",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        for (const status of [502, 503, 500]) {
          harness.answers.push({
            status,
            body: null,
            raw: "<html>Bad Gateway</html>",
            protocol: null,
          });
          assert.equal((yield* pollOnce).kind, "failed", String(status));
          assert.include(
            harness.lastErrors.at(-1) ?? "",
            `answered the poll with HTTP ${String(status)}`,
          );
        }
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect("reads a mismatch or a rejected credential even when the answer is not JSON", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      harness.answers.push({ status: 502, body: null, raw: "<html>proxy</html>", protocol: "3" });
      assert.equal((yield* pollOnce).kind, "mismatched", "the version is read before the body");
      assert.include(harness.lastErrors.at(-1) ?? "", "runs peer protocol 3");
      harness.answers.push({ status: 401, body: null, raw: "Unauthorized" });
      const rejected = yield* pollOnce;
      assert.equal(rejected.kind, "stopped");
      assert.include(harness.lastErrors.at(-1) ?? "", "rejected this server's credential");
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect("starts fresh for a peer removed and recorded again", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      harness.answers.push(pollAnswer());
      yield* pollOnce;
      const held = harness.requests[0]!.rosterHash;
      // The VM now holds the roster, and hands out one delivery the next poll will ack.
      harness.answers.push(pollAnswer({ rosterHash: held, deliveries: [delivery("pending-ack")] }));
      yield* pollOnce;
      harness.answers.push(pollAnswer({ rosterHash: held }));
      yield* pollOnce;
      assert.equal(harness.requests[2]!.acks.length, 1, "the ack goes with the next poll");
      assert.isUndefined(harness.requests[2]!.roster, "the roster the VM holds is not resent");

      harness.answers.push(pollAnswer({ rosterHash: held, deliveries: [delivery("old-record")] }));
      yield* pollOnce;
      // Removed and peered again: a new record, and nothing of the old one carries over.
      harness.peerCreatedAt.value = "2026-10-02T13:00:00.000Z";
      harness.answers.push(pollAnswer());
      yield* pollOnce;
      const fresh = harness.requests[4]!;
      assert.deepStrictEqual(fresh.acks, [], "no ack for the old record's batch");
      assert.isDefined(fresh.roster, "the new record holds no roster, so it goes out");
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect("holds one roster-change subscription at a time, however many polls the loop makes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    harness.answers.push(pollAnswer(), pollAnswer(), pollAnswer(), pollAnswer());
    yield* Effect.gen(function* () {
      yield* PeerPoller;
      // Four answered polls, and a fifth held: each subscribes before it sends.
      for (let index = 0; index < 5; index += 1) yield* Queue.take(harness.sent);
      assert.equal(harness.subscriptions.peak, 1, "each poll lets go of its subscription");
      assert.equal(harness.subscriptions.active, 1, "only the held poll listens now");
    }).pipe(Effect.provide(makeTestLayer(harness, { daemon: true })), Effect.scoped);
    assert.equal(harness.subscriptions.active, 0, "stopping the server lets go of the last one");
  }),
);

it.effect("stamps the heartbeat when a 200's headers arrive, while its body is still held", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      harness.answers.push({ status: 500, body: { message: "the ledger is down" } });
      assert.equal((yield* pollOnce).kind, "failed");
      assert.equal(yield* Queue.size(harness.heartbeats), 0, "an error answer is no heartbeat");

      harness.answers.push({ hold: true });
      const held = yield* Effect.forkChild(pollOnce);
      yield* Queue.take(harness.heartbeats);
      assert.isUndefined(held.pollUnsafe(), "stamped while the body is held");
      yield* Fiber.interrupt(held);
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect(
  "sends the roster at once when an agent is renamed or archived while a poll is held",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      // The VM answers the first poll holding that roster, so the second is held without it.
      harness.answers.push(
        pollAnswer({ rosterHash: peerRosterHash(toPeerRoster([rosterEntry(false)])) }),
      );
      yield* Effect.gen(function* () {
        yield* PeerPoller;
        assert.isDefined((yield* Queue.take(harness.sent)).roster);
        assert.isUndefined((yield* Queue.take(harness.sent)).roster, "held without the roster");

        // Renaming the agent's thread is a thread metadata update, not a ledger fact.
        yield* Ref.set(harness.roster, [{ ...rosterEntry(false), displayName: "iOS release" }]);
        yield* publishThreadUpdate(harness);
        const renamed = yield* Queue.take(harness.sent);
        assert.equal(renamed.roster?.[0]?.displayName, "iOS release");

        yield* Ref.set(harness.roster, [{ ...rosterEntry(true), displayName: "iOS release" }]);
        yield* PubSub.publish(harness.committed, {
          kind: "participant.archived",
        } as unknown as StoredCommEvent);
        const archived = yield* Queue.take(harness.sent);
        assert.isTrue(archived.roster?.[0]?.archived);
      }).pipe(Effect.provide(makeTestLayer(harness, { daemon: true })), Effect.scoped);
    }),
);

it.effect(
  "polls again a fixed second after each cut, without a growing back-off, and shows the fifth in a row",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.answers.push(...Array.from({ length: 5 }, () => ({ cut: true }) as const));
      yield* Effect.gen(function* () {
        yield* PeerPoller;
        // Each answer is cut as soon as it is sent.
        yield* Queue.take(harness.sent);
        for (let cut = 2; cut <= 4; cut += 1) {
          yield* TestClock.adjust("1 second");
          yield* Queue.take(harness.sent);
        }
        assert.deepStrictEqual(harness.lastErrors, [], "four cuts are not shown as an error");
        yield* TestClock.adjust("1 second");
        yield* Queue.take(harness.sent);
        // Each poll after a cut went out a second after the last, never at once and never later.
        assert.deepStrictEqual(
          harness.sentAtMs.slice(1).map((at, index) => at - harness.sentAtMs[index]!),
          [1_000, 1_000, 1_000, 1_000],
        );
        assert.deepStrictEqual(harness.lastErrors, [
          "polls to Work VM keep being cut off before their answer arrives",
        ]);
      }).pipe(Effect.provide(makeTestLayer(harness, { daemon: true })), Effect.scoped);
    }),
);

it.effect("backs off while a delivery keeps failing to be recorded here", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    // The VM hands the same unrecordable delivery back each time it is not acknowledged.
    const broken = pollAnswer({ deliveries: [delivery("broken", "agent:j5:a2a:thread:broken")] });
    harness.answers.push(broken, broken, broken, broken);
    yield* Effect.gen(function* () {
      yield* PeerPoller;
      yield* Queue.take(harness.sent);
      for (const wait of ["1 second", "2 seconds", "4 seconds"] as const) {
        yield* TestClock.adjust(wait);
        yield* Queue.take(harness.sent);
      }
      const [first, second, third, fourth] = harness.sentAtMs;
      assert.deepStrictEqual(
        [second! - first!, third! - second!, fourth! - third!],
        [1_000, 2_000, 4_000],
        "never at once",
      );
    }).pipe(Effect.provide(makeTestLayer(harness, { daemon: true })), Effect.scoped);
  }),
);

it.effect("retries a protocol mismatch once a minute, and polls normally once it is fixed", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const mismatch = { ...pollAnswer(), protocol: "3" } as Answer;
    harness.answers.push(mismatch, mismatch, pollAnswer());
    yield* Effect.gen(function* () {
      yield* PeerPoller;
      yield* Queue.take(harness.sent);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(harness.sent);
      assert.equal(yield* Queue.size(harness.heartbeats), 0, "a mismatch is no heartbeat");
      assert.include(harness.lastErrors.at(-1) ?? "", "runs peer protocol 3");
      // Work VM is updated: the next retry is answered and clears the error with its heartbeat.
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(harness.sent);
      yield* Queue.take(harness.heartbeats);
      const [first, second, third] = harness.sentAtMs;
      assert.deepStrictEqual([second! - first!, third! - second!], [60_000, 60_000]);
      // Answered, so the loop polls again at once and is held.
      yield* Queue.take(harness.sent);
    }).pipe(Effect.provide(makeTestLayer(harness, { daemon: true })), Effect.scoped);
  }),
);

it.effect("leaves every loop running when the poll peers cannot be read", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const changes = yield* Queue.unbounded<void>();
    const reads = yield* Queue.unbounded<void>();
    let calls = 0;
    const connections: PeerRegistryServiceShape["connections"] = () =>
      Effect.suspend(() => {
        calls += 1;
        return calls === 1
          ? Effect.succeed([vmPeer])
          : Queue.offer(reads, undefined).pipe(
              Effect.andThen(Effect.fail(new PeerSessionReadError({ cause: "locked" }))),
            );
      });
    yield* Effect.gen(function* () {
      yield* PeerPoller;
      yield* Queue.take(harness.sent);
      // Two changes are read in turn, so the second read means the first was fully handled.
      yield* Queue.offerAll(changes, [undefined, undefined]);
      yield* Queue.take(reads);
      yield* Queue.take(reads);
      assert.equal(harness.subscriptions.active, 1, "the held poll was not interrupted");
      assert.equal(harness.requests.length, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer(harness, {
          daemon: true,
          connections,
          changes: Stream.fromQueue(changes),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect(
  "decides a refusal from its headers, and waits at most two seconds for a stalled body to word it",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        // The headers decide; a stalled body is given only two seconds to word the reason.
        const answers: ReadonlyArray<readonly [string, Answer, PeerPollOutcome["kind"]]> = [
          ["a protocol mismatch", { status: 200, stalledBody: true, protocol: "3" }, "mismatched"],
          ["HTTP 401", { status: 401, stalledBody: true }, "stopped"],
          ["HTTP 403", { status: 403, stalledBody: true }, "stopped"],
          ["HTTP 409", { status: 409, stalledBody: true }, "stopped"],
          ["HTTP 502", { status: 502, stalledBody: true }, "failed"],
        ];
        for (const [name, answer, kind] of answers) {
          harness.answers.push(answer);
          const fiber = yield* Effect.forkChild(pollOnce);
          yield* TestClock.adjust("2 seconds");
          assert.equal((yield* Fiber.join(fiber)).kind, kind, name);
        }
        assert.include(harness.lastErrors[0] ?? "", "runs peer protocol 3");
        assert.include(harness.lastErrors.at(-1) ?? "", "answered the poll with HTTP 502");
        // Every stop reads as stopped wherever peers are shown; the retried 502 does not.
        assert.deepStrictEqual(
          harness.lastErrors.map(
            (lastError) => peerPollStoppedReason({ linkMode: "poll", lastError }) !== null,
          ),
          [true, true, true, true, false],
        );
        // A body that does arrive words the reason.
        harness.answers.push({
          status: 409,
          body: { error: "peer_not_polling", message: "Work VM sends to this server directly." },
        });
        assert.equal((yield* pollOnce).kind, "stopped");
        assert.equal(
          harness.lastErrors.at(-1),
          peerPollStoppedError("Work VM sends to this server directly."),
        );
        assert.equal(
          peerPollStoppedReason({ linkMode: "poll", lastError: harness.lastErrors.at(-1) ?? null }),
          "Work VM sends to this server directly.",
          "shown without the mark",
        );
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
);

it.effect("bounds the whole held poll at forty seconds, though its headers came late", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      // Headers ten seconds in, then a body that never ends: lost, as across a sleep.
      harness.answers.push({ after: "10 seconds", answer: { hold: true } });
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const fiber = yield* Effect.forkChild(
        pollOnce.pipe(
          Effect.flatMap((outcome) =>
            DateTime.now.pipe(
              Effect.map((now) => ({ outcome, atMs: DateTime.toEpochMillis(now) })),
            ),
          ),
        ),
      );
      yield* TestClock.adjust("1 minute");
      const { outcome, atMs } = yield* Fiber.join(fiber);
      assert.equal(outcome.kind, "cut");
      assert.equal(
        atMs - startedAt,
        40_000,
        "forty seconds from the start, not forty after the headers",
      );
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);
