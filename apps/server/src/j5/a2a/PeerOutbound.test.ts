import { ThreadId } from "@t3tools/contracts";
import {
  J5_PEER_API_PATHS,
  PEER_PROTOCOL_VERSION,
  peerCredentialRejectedReason,
  type PeerDeliveryRequest,
} from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { live as deliveryTransportLive } from "./DeliveryTransport.ts";
import {
  A2ADeliveryHooks,
  A2ADeliveryWorker,
  layerWithHooks as deliveryWorkerLayerWithHooks,
} from "./DeliveryWorker.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerDirectory, type RemoteAgent } from "./PeerDirectory.ts";
import { PeerRegistryService, type PeerConnection } from "./PeerRegistryService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  LIFECYCLE_PARTICIPANT_ID,
  ParticipantId,
  LedgerProjectId,
  type AgentParticipant,
} from "./contracts.ts";

const timestamp = "2026-09-16T12:00:00.000Z";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const localProject = LedgerProjectId.make("project:work-billing");
const billing: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:billing"),
  threadId: ThreadId.make("thread:billing"),
};
const remoteSupport = ParticipantId.make("agent:j5:a2a:thread:support");
const homePeer: PeerConnection = {
  environmentId: "environment-home",
  label: "Home",
  linkMode: "push",
  origin: "https://home.example:3773",
  credential: "home-token",
  credentialExpiresAt: null,
  inboundSession: "active",
  createdAt: timestamp,
  lastPolledAt: null,
  lastError: null,
  waitingCount: 0,
  oldestWaitingAt: null,
  roster: null,
};
const supportOnHome: RemoteAgent = {
  environmentId: homePeer.environmentId,
  environmentLabel: homePeer.label,
  projectId: LedgerProjectId.make("project:home-support"),
  projectTitle: "L2 Support Rotation",
  participantId: remoteSupport,
  threadId: ThreadId.make("thread:support"),
  displayName: "Support triage",
  archived: false,
  canReceiveMessage: true,
  available: true,
  lastAvailableAt: null,
};

const directoryLayer = (agents: ReadonlyArray<RemoteAgent>, unreadPeers: ReadonlyArray<string>) =>
  Layer.succeed(
    PeerDirectory,
    PeerDirectory.of({
      listAgents: () =>
        Effect.succeed({
          agents,
          unreadPeers: unreadPeers.map((label) => ({
            environmentId: `environment-${label}`,
            label,
            reason: "ECONNREFUSED",
          })),
          selfName: "Work",
        }),
      resolveAgent: (id) =>
        Effect.succeed({
          agents: agents.filter((agent) => agent.participantId === id),
          unreadPeers: unreadPeers.map((label) => ({
            environmentId: `environment-${label}`,
            label,
            reason: "ECONNREFUSED",
          })),
          selfName: "Work",
        }),
      snapshotAgent: () => Effect.succeed(null),
      serverStatus: (environmentId) =>
        Effect.succeed({
          name:
            agents.find((agent) => agent.environmentId === environmentId)?.environmentLabel ??
            environmentId,
          available: true,
          lastAvailableAt: null,
        }),
    }),
  );

const makeSendLayer = (
  agents: ReadonlyArray<RemoteAgent>,
  unreadPeers: ReadonlyArray<string> = [],
  directory: Layer.Layer<PeerDirectory> = directoryLayer(agents, unreadPeers),
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(directory),
  );
  return Layer.mergeAll(database, ledger, send);
};

const seedLocal = Effect.fn("test.j5.a2a.peer.outbound.seed")(function* () {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  yield* ledger.ensureProject({ projectId: localProject, createdAt: timestamp });
  // The sender's thread title is the label the peer's people will see.
  const sql = yield* SqlClient.SqlClient;
  // Home as this server records it, for what reads the record directly, such as a notice's name for it.
  yield* sql`
    INSERT INTO j5_a2a_peer (environment_id, label, link_mode, origin, credential, created_at, updated_at)
    VALUES (${homePeer.environmentId}, ${homePeer.label}, 'push', ${homePeer.origin}, 'home-token', ${timestamp}, ${timestamp})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at,
      archived_at, deleted_at, payload_json
    ) VALUES (
      ${billing.threadId}, 'project:billing', 'Billing agent', 'codex', 'full-access',
      'default', NULL, ${timestamp}, ${timestamp}, NULL, NULL, '{}'
    )
  `;
  yield* ledger.append({
    commandId: CommCommandId.make("command:peer-outbound:join"),
    projectId: localProject,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: billing.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: billing },
      createdAt: timestamp,
    },
  });
});

it.effect(
  "resolves a receiver no local project homes through the peer directory and records where it lives",
  () =>
    Effect.gen(function* () {
      yield* seedLocal();
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      const sent = yield* send.send({
        commandId: CommCommandId.make("command:peer-outbound:ask"),
        senderThreadId: billing.threadId,
        to: remoteSupport,
        message: "What is the incident status?",
        expectReply: true,
        intent: "incident status",
        acceptedAt: timestamp,
      });
      assert.equal(sent.exchangeState, "open");
      assert.equal(sent.receiverServer, "Home", "the result names where the receiver lives");
      const replayed = yield* send.send({
        commandId: CommCommandId.make("command:peer-outbound:ask"),
        senderThreadId: billing.threadId,
        to: remoteSupport,
        message: "What is the incident status?",
        expectReply: true,
        intent: "incident status",
        acceptedAt: timestamp,
      });
      assert.equal(replayed.receiverServer, "Home", "a replay names it too");
      const rows = yield* sql<{
        readonly receiver_project_id: string;
        readonly receiver_environment_id: string | null;
        readonly exchange_role: string;
      }>`SELECT receiver_project_id, receiver_environment_id, exchange_role FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`;
      assert.deepStrictEqual(rows, [
        {
          receiver_project_id: supportOnHome.projectId,
          receiver_environment_id: homePeer.environmentId,
          exchange_role: "ask",
        },
      ]);
      const exchange = yield* sql<{ readonly receiver_id: string; readonly project_id: string }>`
      SELECT receiver_id, project_id FROM j5_a2a_exchange WHERE exchange_id = ${sent.exchangeId!}
    `;
      assert.deepStrictEqual(exchange, [{ receiver_id: remoteSupport, project_id: localProject }]);

      const nobody = yield* send
        .send({
          commandId: CommCommandId.make("command:peer-outbound:nobody"),
          senderThreadId: billing.threadId,
          to: ParticipantId.make("agent:j5:a2a:thread:nobody"),
          message: "anyone?",
          acceptedAt: timestamp,
        })
        .pipe(Effect.flip);
      assert.equal(
        nobody._tag,
        "A2AParticipantNotFoundError",
        "a local miss with no peer match stays not found",
      );
    }).pipe(Effect.provide(makeSendLayer([supportOnHome]))),
);

it.effect(
  "refuses an id two peers both carry, an archived remote agent, and names peers it could not read",
  () =>
    Effect.gen(function* () {
      const twice = [
        supportOnHome,
        { ...supportOnHome, environmentId: "environment-mac", environmentLabel: "Mac" },
      ];
      const ambiguous = yield* Effect.gen(function* () {
        yield* seedLocal();
        return yield* (yield* A2ASendService)
          .send({
            commandId: CommCommandId.make("command:peer-outbound:ambiguous"),
            senderThreadId: billing.threadId,
            to: remoteSupport,
            message: "who are you",
            acceptedAt: timestamp,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeSendLayer(twice)));
      assert.equal(ambiguous._tag, "A2AAmbiguousParticipantError");

      const archived = yield* Effect.gen(function* () {
        yield* seedLocal();
        return yield* (yield* A2ASendService)
          .send({
            commandId: CommCommandId.make("command:peer-outbound:archived"),
            senderThreadId: billing.threadId,
            to: remoteSupport,
            message: "still there?",
            acceptedAt: timestamp,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeSendLayer([{ ...supportOnHome, archived: true }])));
      assert.equal(archived._tag, "A2AParticipantArchivedError");

      const unread = yield* Effect.gen(function* () {
        yield* seedLocal();
        return yield* (yield* A2ASendService)
          .send({
            commandId: CommCommandId.make("command:peer-outbound:unread"),
            senderThreadId: billing.threadId,
            to: remoteSupport,
            message: "anyone?",
            acceptedAt: timestamp,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeSendLayer([], ["Home"])));
      assert.equal(unread._tag, "A2APeersUnreadError");
      assert.include(unread.message, "1 peer server(s) could not be read");
      assert.include(
        unread.message,
        "(Home: ECONNREFUSED)",
        "the refusal names the server and why",
      );
    }),
);

interface PostedRequest {
  url: string;
  authorization: string | undefined;
  body: unknown;
  protocol?: string | undefined;
}

/** The live transport's peer branch, with the HTTP hop stubbed and everything else in memory. */
type TransportReply = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
};

/** One reply for every request, or one per request in order; "unreachable" is a refused connection. */
const makeTransportLayer = (
  replies: TransportReply | "unreachable" | Array<TransportReply>,
  posted: Array<PostedRequest>,
  lastErrors: Array<string | null> = [],
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(directoryLayer([supportOnHome], [])),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : null;
        posted.push({
          url: request.url,
          authorization: request.headers.authorization,
          body,
          protocol: request.headers["x-j5-peer-protocol"],
        });
        const reply = Array.isArray(replies) ? replies.shift()! : replies;
        if (reply === "unreachable") {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("connect ECONNREFUSED"),
                description: "connect ECONNREFUSED",
              }),
            }),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson(reply.body), {
              status: reply.status,
              headers: {
                "content-type": "application/json",
                "x-j5-peer-protocol": String(PEER_PROTOCOL_VERSION),
                ...reply.headers,
              },
            }),
          ),
        );
      }),
    ),
  );
  const transport = deliveryTransportLive.pipe(
    Layer.provide(database),
    Layer.provide(http),
    Layer.provide(
      Layer.mock(PeerRegistryService)({
        connections: () => Effect.succeed([homePeer]),
        connection: (environmentId) =>
          Effect.succeed(environmentId === homePeer.environmentId ? homePeer : null),
        recordLastError: (_environmentId, error) =>
          Effect.sync(() => {
            lastErrors.push(error);
          }),
      }),
    ),
    Layer.provide(Layer.mock(ThreadManagementService)({})),
    Layer.provide(Layer.mock(OrchestratorV2)({})),
    Layer.provide(Layer.mock(EffectOutboxV2)({})),
  );
  const worker = deliveryWorkerLayerWithHooks(false).pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
    Layer.provide(
      Layer.succeed(
        A2ADeliveryHooks,
        A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
      ),
    ),
  );
  return Layer.mergeAll(database, ledger, send, transport, worker);
};

const crossingAsk = Effect.fn("test.j5.a2a.peer.outbound.crossing")(function* () {
  yield* seedLocal();
  const send = yield* A2ASendService;
  const sent = yield* send.send({
    commandId: CommCommandId.make("command:peer-outbound:live"),
    senderThreadId: billing.threadId,
    to: remoteSupport,
    message: "What is the incident status?",
    expectReply: true,
    intent: "incident status",
    acceptedAt: timestamp,
  });
  return { sent, deliver: (yield* A2ADeliveryWorker).runOnce };
});

it.effect(
  "posts the message to the peer's deliver route with its credential, the intent, and the correlation id",
  () =>
    Effect.gen(function* () {
      const posted: Array<PostedRequest> = [];
      const lastErrors: Array<string | null> = [];
      yield* Effect.gen(function* () {
        const { sent, deliver } = yield* crossingAsk();
        assert.equal((yield* deliver)?.state, "delivered");
        assert.equal(posted.length, 1);
        assert.equal(posted[0]!.url, `${homePeer.origin}${J5_PEER_API_PATHS.deliver}`);
        assert.equal(posted[0]!.authorization, "Bearer home-token");
        assert.equal(posted[0]!.protocol, String(PEER_PROTOCOL_VERSION), "it states its protocol");
        assert.deepStrictEqual(
          lastErrors,
          [null],
          "a delivery that succeeds clears the row's error",
        );
        const body = posted[0]!.body as PeerDeliveryRequest;
        assert.equal(body.messageId, sent.messageId);
        assert.equal(body.senderId, billing.id);
        assert.equal(body.receiverId, remoteSupport);
        assert.equal(body.exchangeId, sent.exchangeId);
        assert.equal(body.exchangeRole, "ask");
        assert.equal(body.intent, "incident status");
        assert.equal(body.originProjectId, localProject);
        assert.equal(body.senderLabel, "Billing agent");
        assert.match(body.correlationId, /^correlation:j5:a2a:/);
      }).pipe(
        Effect.provide(
          makeTransportLayer(
            { status: 201, body: { accepted: true, receivedSeq: 3, replay: false } },
            posted,
            lastErrors,
          ),
        ),
      );
    }),
);

it.effect(
  "fails a delivery a peer on another protocol accepted, naming which server to update",
  () =>
    Effect.gen(function* () {
      const posted: Array<PostedRequest> = [];
      const lastErrors: Array<string | null> = [];
      const outcome = yield* Effect.gen(function* () {
        const { deliver } = yield* crossingAsk();
        const milestone = yield* deliver;
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ readonly last_error: string | null }>`
        SELECT last_error FROM j5_a2a_delivery
      `;
        return { state: milestone?.state, lastError: row?.last_error ?? "" };
      }).pipe(
        Effect.provide(
          makeTransportLayer(
            {
              // A newer peer that misread the body still answers 201; its stated version gives it away.
              status: 201,
              body: { accepted: true, receivedSeq: 3, replay: false },
              headers: { "x-j5-peer-protocol": "3" },
            },
            posted,
            lastErrors,
          ),
        ),
      );
      assert.deepStrictEqual(
        lastErrors,
        [
          "Home runs peer protocol 3 and this server runs 2. Update J5 on this server, then try again.",
        ],
        "the peer's row shows the mismatch until a later delivery succeeds",
      );
      assert.notEqual(outcome.state, "delivered");
      assert.include(
        outcome.lastError,
        "Home runs peer protocol 3 and this server runs 2. Update J5 on this server",
      );
    }),
);

it.effect(
  "keeps a message for an older peer queued, and names that peer as the one to update",
  () =>
    Effect.gen(function* () {
      const posted: Array<PostedRequest> = [];
      const lastErrors: Array<string | null> = [];
      const outcome = yield* Effect.gen(function* () {
        const { deliver } = yield* crossingAsk();
        const milestone = yield* deliver;
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly status: string; readonly last_error: string | null }>`
          SELECT status, last_error FROM j5_a2a_delivery
        `;
        const exchanges = yield* sql<{ readonly status: string }>`
          SELECT status FROM j5_a2a_exchange
        `;
        return { milestone: milestone?.state, rows, exchanges };
      }).pipe(
        Effect.provide(
          makeTransportLayer(
            {
              // What a server on protocol 1 answers: its own refusal of this server's version.
              status: 409,
              body: { error: "peer_protocol_mismatch", message: "Update J5." },
              headers: { "x-j5-peer-protocol": "1" },
            },
            posted,
            lastErrors,
          ),
        ),
      );
      const reason =
        "Home runs peer protocol 1 and this server runs 2. Update J5 there, then try again.";
      assert.deepStrictEqual(lastErrors, [reason], "the peer's row says which server to update");
      assert.equal(outcome.milestone, "retry_scheduled", "the refusal is not final: it is retried");
      assert.deepStrictEqual(
        outcome.rows.map((row) => row.status),
        ["retry_scheduled"],
      );
      assert.include(outcome.rows[0]?.last_error ?? "", reason);
      assert.deepStrictEqual(
        outcome.exchanges,
        [{ status: "open" }],
        "the ask's Exchange stays open",
      );
    }),
);

it.effect(
  "takes a peer's refusal as final: the ask's Exchange drops and its sender is told why",
  () =>
    Effect.gen(function* () {
      const posted: Array<PostedRequest> = [];
      yield* Effect.gen(function* () {
        const { sent, deliver } = yield* crossingAsk();
        assert.equal((yield* deliver)?.state, "alarmed", "no retry can change the peer's answer");
        const sql = yield* SqlClient.SqlClient;
        const [ask] = yield* sql<{ readonly last_error: string | null }>`
          SELECT last_error FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
        `;
        assert.equal(ask?.last_error, "recipient_not_found: No active agent");
        const [exchange] = yield* sql<{ readonly status: string }>`
          SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${sent.exchangeId}
        `;
        assert.equal(exchange?.status, "dropped", "the asker owes nothing and waits for nothing");
        const notices = yield* sql<{ readonly receiver_id: string; readonly message_text: string }>`
          SELECT receiver_id, message_text FROM j5_a2a_delivery
          WHERE envelope_channel = 'lifecycle_notice'
        `;
        assert.equal(notices.length, 1, "one notice");
        assert.equal(notices[0]!.receiver_id, billing.id);
        assert.include(
          notices[0]!.message_text,
          `Your ask "incident status" (message ${sent.messageId}) to ${remoteSupport} on Home was not delivered: Home has no active participant with that id.`,
        );
        assert.include(
          notices[0]!.message_text,
          "The exchange is closed; nothing is owed and nothing will answer it.",
        );
        assert.include(notices[0]!.message_text, `exchangeId=${sent.exchangeId}`);
        assert.notInclude(notices[0]!.message_text, "retired", "nothing claims an archive");
        const [dropped] = yield* sql<{ readonly cause: string }>`
          SELECT json_extract(payload, '$.cause.kind') AS cause FROM j5_a2a_comm_event
          WHERE kind = 'exchange.dropped'
        `;
        assert.equal(dropped?.cause, "delivery-refused");
        assert.equal(posted.length, 1, "the refused ask was posted once");
      }).pipe(
        Effect.provide(
          makeTransportLayer(
            { status: 404, body: { error: "recipient_not_found", message: "No active agent" } },
            posted,
          ),
        ),
      );
    }),
);

it.effect("never takes a 2xx answer as a refusal, whatever its body says", () =>
  Effect.gen(function* () {
    const posted: Array<PostedRequest> = [];
    yield* Effect.gen(function* () {
      const { sent, deliver } = yield* crossingAsk();
      assert.equal((yield* deliver)?.state, "retry_scheduled");
      const sql = yield* SqlClient.SqlClient;
      const [exchange] = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${sent.exchangeId}
      `;
      assert.equal(exchange?.status, "open", "the ask is not dropped");
    }).pipe(
      Effect.provide(
        makeTransportLayer(
          { status: 202, body: { error: "recipient_not_found", message: "No active agent" } },
          posted,
        ),
      ),
    );
  }),
);

it.effect("retries a bare 403 or 404 that is not the peer's refusal, as any failure", () =>
  Effect.gen(function* () {
    const posted: Array<PostedRequest> = [];
    yield* Effect.gen(function* () {
      const { deliver } = yield* crossingAsk();
      // Such as an older server without the route, or a proxy's page.
      assert.equal((yield* deliver)?.state, "retry_scheduled");
      const sql = yield* SqlClient.SqlClient;
      const notices = yield* sql`
        SELECT 1 FROM j5_a2a_delivery WHERE envelope_channel = 'lifecycle_notice'
      `;
      assert.equal(notices.length, 0, "nothing is final, so nobody is told");
    }).pipe(
      Effect.provide(makeTransportLayer({ status: 404, body: { error: "not_found" } }, posted)),
    );
  }),
);

it.effect("records that the peer ended the peering when it rejects this server's credential", () =>
  Effect.gen(function* () {
    const posted: Array<PostedRequest> = [];
    const lastErrors: Array<string | null> = [];
    yield* Effect.gen(function* () {
      const { deliver } = yield* crossingAsk();
      // The peer removed this server and revoked the credential it issued.
      assert.equal((yield* deliver)?.state, "retry_scheduled", "the send retries and alarms");
      assert.deepStrictEqual(lastErrors, [peerCredentialRejectedReason("Home")]);
    }).pipe(
      Effect.provide(
        makeTransportLayer({ status: 401, body: { error: "invalid_token" } }, posted, lastErrors),
      ),
    );
  }),
);

/** Three attempts to a peer server that refuses every connection: the third alarms. */
const deliverUntilAlarmed = Effect.fn("test.j5.a2a.peer.outbound.untilAlarmed")(function* () {
  const worker = yield* A2ADeliveryWorker;
  assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
  yield* TestClock.adjust("250 millis");
  assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
  yield* TestClock.adjust("500 millis");
  assert.equal((yield* worker.runOnce)?.state, "alarmed");
});

const lifecycleNotices = Effect.fn("test.j5.a2a.peer.outbound.lifecycleNotices")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly receiver_id: string; readonly message_text: string }>`
    SELECT receiver_id, message_text FROM j5_a2a_delivery
    WHERE envelope_channel = 'lifecycle_notice'
  `;
});

it.effect("tells the sender of a plain message once when the peer server can't be reached", () =>
  Effect.gen(function* () {
    const posted: Array<PostedRequest> = [];
    yield* Effect.gen(function* () {
      yield* seedLocal();
      const sent = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:peer-outbound:unreachable-plain"),
        senderThreadId: billing.threadId,
        to: remoteSupport,
        message: "FYI: the incident is closed.",
        acceptedAt: timestamp,
      });
      yield* deliverUntilAlarmed();
      const notices = yield* lifecycleNotices();
      assert.equal(notices.length, 1, "one notice, at the alarm");
      assert.equal(notices[0]!.receiver_id, billing.id);
      assert.include(
        notices[0]!.message_text,
        `Your message ${sent.messageId} to ${remoteSupport} on Home may not have been delivered: this server could not reach Home in 3 attempts, and it will not be tried again.`,
      );
      assert.include(notices[0]!.message_text, "ECONNREFUSED", "it says what the attempt hit");
      assert.notInclude(notices[0]!.message_text, "xchange", "a plain message has no Exchange");
      assert.equal(posted.length, 3);
    }).pipe(Effect.provide(makeTransportLayer("unreachable", posted)));
  }),
);

it.effect(
  "tells the asker once when the peer server can't be reached, and keeps its Exchange open",
  () =>
    Effect.gen(function* () {
      const posted: Array<PostedRequest> = [];
      yield* Effect.gen(function* () {
        const { sent } = yield* crossingAsk();
        yield* deliverUntilAlarmed();
        const sql = yield* SqlClient.SqlClient;
        const [exchange] = yield* sql<{ readonly status: string }>`
          SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${sent.exchangeId}
        `;
        // The peer may hold the ask and answer it; only the asker withdraws it.
        assert.equal(exchange?.status, "open");
        const dropped = yield* sql`SELECT 1 FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped'`;
        assert.equal(dropped.length, 0);
        const notices = yield* lifecycleNotices();
        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.receiver_id, billing.id);
        assert.include(
          notices[0]!.message_text,
          `Your ask "incident status" (message ${sent.messageId}) to ${remoteSupport} on Home may not have been delivered: this server could not reach Home in 3 attempts`,
        );
        assert.include(
          notices[0]!.message_text,
          `Exchange ${sent.exchangeId} is still open; if the ask did arrive, its reply still comes on it. To stop waiting, withdraw it with j5_clear_own_ask`,
        );
        assert.include(
          notices[0]!.message_text,
          `Facts: exchangeId=${sent.exchangeId}; exchangeOpen=true; retryScheduled=false.`,
        );
      }).pipe(Effect.provide(makeTransportLayer("unreachable", posted)));
    }),
);

it.effect("tells the sender of a plain message the peer refused, naming the server and why", () =>
  Effect.gen(function* () {
    const posted: Array<PostedRequest> = [];
    yield* Effect.gen(function* () {
      yield* seedLocal();
      const send = yield* A2ASendService;
      const sent = yield* send.send({
        commandId: CommCommandId.make("command:peer-outbound:refused-plain"),
        senderThreadId: billing.threadId,
        to: remoteSupport,
        message: "FYI: the incident is closed.",
        acceptedAt: timestamp,
      });
      const worker = yield* A2ADeliveryWorker;
      assert.equal((yield* worker.runOnce)?.state, "alarmed");
      const sql = yield* SqlClient.SqlClient;
      const notices = yield* sql<{ readonly receiver_id: string; readonly message_text: string }>`
        SELECT receiver_id, message_text FROM j5_a2a_delivery
        WHERE envelope_channel = 'lifecycle_notice'
      `;
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.receiver_id, billing.id);
      assert.include(
        notices[0]!.message_text,
        `Your message ${sent.messageId} to ${remoteSupport} on Home was not delivered: Home refused it; the recipient is archived or does not accept messages from this sender.`,
      );
      assert.notInclude(
        notices[0]!.message_text,
        "exchange is closed",
        "a plain message has no Exchange",
      );
    }).pipe(
      Effect.provide(
        makeTransportLayer(
          { status: 403, body: { error: "policy_refused", message: "Archived" } },
          posted,
        ),
      ),
    );
  }),
);

it.effect(
  "records a send to a known remote agent while its peer is asleep, from the route the ledger already holds",
  () =>
    Effect.gen(function* () {
      yield* seedLocal();
      const ledger = yield* A2ALedger;
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      // Home is still a peer, asleep: its directory read fails.
      yield* sql`
        INSERT INTO j5_a2a_peer (environment_id, label, link_mode, origin, credential, created_at, updated_at)
        VALUES ('environment-Home', 'Home', 'push', 'https://home.example', 'home-token', ${timestamp}, ${timestamp})
      `;
      // An earlier ask reached this agent on Home; that delivery row is the recorded route.
      yield* ledger.append({
        commandId: CommCommandId.make("command:peer-outbound:earlier"),
        projectId: localProject,
        acceptedAt: timestamp,
        event: {
          kind: "message.sent",
          sender: billing.id,
          receiver: remoteSupport,
          exchangeId: null,
          correlationId: CorrelationId.make("correlation:peer-outbound:earlier"),
          payload: {
            messageId: LedgerMessageId.make("message:peer-outbound:earlier"),
            text: "earlier",
            originProjectId: localProject,
            receiverProjectId: supportOnHome.projectId,
            receiverEnvironmentId: "environment-Home",
            exchangeRole: "none",
            envelopeChannel: "peer",
          },
          createdAt: timestamp,
        },
      });
      const sent = yield* send.send({
        commandId: CommCommandId.make("command:peer-outbound:asleep"),
        senderThreadId: billing.threadId,
        to: remoteSupport,
        message: "Still there?",
        acceptedAt: timestamp,
      });
      const rows = yield* sql<{
        readonly receiver_environment_id: string | null;
        readonly status: string;
      }>`
      SELECT receiver_environment_id, status FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
    `;
      assert.deepStrictEqual(rows, [
        { receiver_environment_id: "environment-Home", status: "pending" },
      ]);
    }).pipe(Effect.provide(makeSendLayer([], ["Home"]))),
);

it.effect("never resolves a machine sender's receiver through peers", () =>
  Effect.gen(function* () {
    yield* seedLocal();
    const ledger = yield* A2ALedger;
    const watchdog = ParticipantId.make("machine:watchdog");
    yield* ledger.append({
      commandId: CommCommandId.make("command:peer-outbound:machine-join"),
      projectId: localProject,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: watchdog,
        exchangeId: null,
        correlationId: null,
        payload: { participant: { kind: "machine", id: watchdog, name: "watchdog" } },
        createdAt: timestamp,
      },
    });
    const refused = yield* (yield* A2ASendService)
      .sendAsMachine({
        commandId: CommCommandId.make("command:peer-outbound:machine-remote"),
        senderParticipantId: watchdog,
        to: remoteSupport,
        message: "canary 42",
        acceptedAt: timestamp,
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "A2AParticipantNotFoundError");
  }).pipe(Effect.provide(makeSendLayer([supportOnHome]))),
);

it.effect(
  "carries the drop fact the notice was written with, so the peer ends its Exchange the same way",
  () =>
    Effect.gen(function* () {
      const posted: Array<PostedRequest> = [];
      yield* Effect.gen(function* () {
        const { sent, deliver } = yield* crossingAsk();
        assert.equal((yield* deliver)?.state, "delivered");
        const ledger = yield* A2ALedger;
        const exchangeId = ExchangeId.make(sent.exchangeId!);
        const noticeMessageId = LedgerMessageId.make("message:j5:a2a:lifecycle:drop:test");
        const cause = {
          kind: "participant-archived" as const,
          participantId: billing.id,
          projectId: localProject,
        };
        yield* ledger.appendEvents({
          commandId: CommCommandId.make("command:peer-outbound:drop"),
          projectId: localProject,
          acceptedAt: timestamp,
          events: [
            {
              kind: "exchange.dropped",
              sender: billing.id,
              receiver: remoteSupport,
              exchangeId,
              correlationId: CorrelationId.make("correlation:peer-outbound:drop"),
              payload: {
                disposition: "sender-retired",
                cause,
                facts: { replyRequired: false, retryAllowed: false, replacementRequired: false },
                noticeMessageId,
              },
              createdAt: timestamp,
            },
            {
              kind: "message.sent",
              sender: LIFECYCLE_PARTICIPANT_ID,
              receiver: remoteSupport,
              exchangeId,
              correlationId: CorrelationId.make("correlation:peer-outbound:drop"),
              payload: {
                messageId: noticeMessageId,
                text: "exchange dropped",
                originProjectId: localProject,
                receiverProjectId: supportOnHome.projectId,
                receiverEnvironmentId: homePeer.environmentId,
                exchangeRole: "terminal_notice",
                envelopeChannel: "lifecycle_notice",
                terminal: { kind: "dropped", cause },
              },
              createdAt: timestamp,
            },
          ],
        });
        assert.equal((yield* deliver)?.state, "delivered");
        const body = posted.at(-1)!.body as PeerDeliveryRequest;
        assert.equal(body.messageId, noticeMessageId);
        assert.equal(body.exchangeRole, "terminal_notice");
        assert.deepStrictEqual(body.terminal, { kind: "dropped", cause });
        assert.isUndefined(body.intent);
      }).pipe(
        Effect.provide(
          makeTransportLayer(
            { status: 201, body: { accepted: true, receivedSeq: 9, replay: false } },
            posted,
          ),
        ),
      );
    }),
);

it.effect("carries a withdrawn ask to the peer as a sender-cleared terminal notice", () =>
  Effect.gen(function* () {
    const posted: Array<PostedRequest> = [];
    yield* Effect.gen(function* () {
      const { sent, deliver } = yield* crossingAsk();
      assert.equal((yield* deliver)?.state, "delivered");
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      const cleared = yield* send.clearOwnAsk({
        commandId: CommCommandId.make("command:peer-outbound:clear"),
        senderThreadId: billing.threadId,
        exchangeId: ExchangeId.make(sent.exchangeId!),
        acceptedAt: timestamp,
      });
      assert.equal(cleared.closureKind, "sender-cleared");
      assert.isTrue(cleared.withdrawalQueued);
      const notice = yield* sql<{
        readonly message_id: string;
        readonly receiver_id: string;
        readonly receiver_environment_id: string | null;
      }>`
        SELECT message_id, receiver_id, receiver_environment_id
        FROM j5_a2a_delivery WHERE exchange_role = 'terminal_notice'
      `;
      assert.equal(notice.length, 1);
      assert.equal(notice[0]!.receiver_id, remoteSupport);
      assert.equal(notice[0]!.receiver_environment_id, homePeer.environmentId);

      assert.equal((yield* deliver)?.state, "delivered");
      const body = posted.at(-1)!.body as PeerDeliveryRequest;
      assert.equal(body.messageId, notice[0]!.message_id);
      assert.equal(body.senderId, LIFECYCLE_PARTICIPANT_ID);
      assert.deepStrictEqual(body.terminal, { kind: "sender-cleared" });

      // Clearing again replays; nothing new waits for the worker.
      const replayed = yield* send.clearOwnAsk({
        commandId: CommCommandId.make("command:peer-outbound:clear"),
        senderThreadId: billing.threadId,
        exchangeId: ExchangeId.make(sent.exchangeId!),
        acceptedAt: timestamp,
      });
      assert.isFalse(replayed.withdrawalQueued);
    }).pipe(
      Effect.provide(
        makeTransportLayer(
          { status: 201, body: { accepted: true, receivedSeq: 11, replay: false } },
          posted,
        ),
      ),
    );
  }),
);

it.effect("keeps a protocol mismatch on the peer's record until a delivery to it succeeds", () =>
  Effect.gen(function* () {
    const posted: Array<PostedRequest> = [];
    const lastErrors: Array<string | null> = [];
    yield* Effect.gen(function* () {
      const { deliver } = yield* crossingAsk();
      yield* deliver;
      assert.equal(lastErrors.length, 1);
      assert.include(lastErrors[0] ?? "", "runs peer protocol 3");
      // The retry reaches a server on the same version that fails anyway: the mismatch stands.
      yield* TestClock.adjust("1 minute");
      yield* deliver;
      assert.equal(lastErrors.length, 1, "a failed delivery clears nothing");
      yield* TestClock.adjust("5 minutes");
      assert.equal((yield* deliver)?.state, "delivered");
      assert.deepStrictEqual(lastErrors.at(-1), null, "a delivery that succeeds clears it");
    }).pipe(
      Effect.provide(
        makeTransportLayer(
          [
            { status: 201, body: {}, headers: { "x-j5-peer-protocol": "3" } },
            { status: 500, body: { error: "internal" } },
            { status: 201, body: { accepted: true, receivedSeq: 3, replay: false } },
          ],
          posted,
          lastErrors,
        ),
      ),
    );
  }),
);

it.effect(
  "refuses a send to a known agent its polling server's snapshot shows archived, without reading any roster",
  () =>
    Effect.gen(function* () {
      yield* seedLocal();
      const ledger = yield* A2ALedger;
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      // An earlier message reached this agent on Home: its route is recorded.
      yield* ledger.append({
        commandId: CommCommandId.make("command:peer-outbound:snapshot:earlier"),
        projectId: localProject,
        acceptedAt: timestamp,
        event: {
          kind: "message.sent",
          sender: billing.id,
          receiver: remoteSupport,
          exchangeId: null,
          correlationId: CorrelationId.make("correlation:peer-outbound:snapshot:earlier"),
          payload: {
            messageId: LedgerMessageId.make("message:peer-outbound:snapshot:earlier"),
            text: "earlier",
            originProjectId: localProject,
            receiverProjectId: supportOnHome.projectId,
            receiverEnvironmentId: homePeer.environmentId,
            exchangeRole: "none",
            envelopeChannel: "peer",
          },
          createdAt: timestamp,
        },
      });
      const refused = yield* Effect.flip(
        send.send({
          commandId: CommCommandId.make("command:peer-outbound:snapshot:follow-up"),
          senderThreadId: billing.threadId,
          to: remoteSupport,
          message: "Still there?",
          acceptedAt: timestamp,
        }),
      );
      assert.equal(refused._tag, "A2AParticipantArchivedError");
      const rows = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM j5_a2a_delivery ORDER BY sent_seq
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.message_id),
        ["message:peer-outbound:snapshot:earlier"],
        "nothing is recorded for the refused follow-up",
      );
    }).pipe(
      Effect.provide(
        makeSendLayer(
          [],
          [],
          Layer.succeed(
            PeerDirectory,
            PeerDirectory.of({
              // A known route never fans out to the peers' rosters.
              listAgents: () => Effect.die("no roster read for a known route"),
              resolveAgent: () => Effect.die("no roster read for a known route"),
              snapshotAgent: (environmentId, participantId) =>
                Effect.succeed(
                  environmentId === homePeer.environmentId && participantId === remoteSupport
                    ? { ...supportOnHome, archived: true, canReceiveMessage: false }
                    : null,
                ),
              serverStatus: () =>
                Effect.succeed({ name: homePeer.label, available: true, lastAvailableAt: null }),
            }),
          ),
        ),
      ),
    ),
);
