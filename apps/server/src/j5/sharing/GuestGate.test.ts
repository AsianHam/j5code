import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { J5_SHARING_WS_METHODS } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import * as GuestGate from "./GuestGate.ts";
import * as PersonAccess from "./PersonAccess.ts";

const AT = "2026-10-11T00:00:00.000Z";
const PROJECT = ProjectId.make("project:billing-migration");
const GUEST_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

const session = (id: string, subject: string): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make(id),
  subject,
  method: "browser-session-cookie",
  scopes: GUEST_SCOPES,
});
const MEMBER = session("session:member", "one-time-token");
const GUEST = session("session:guest", PersonAccess.GUEST_SESSION_SUBJECT);

/**
 * Upstream's auth, reduced to the two calls every route signs in through. Which session a request
 * carries is read from a header, the way a credential would be.
 */
const sessionsByName: Record<string, EnvironmentAuth.AuthenticatedSession> = {
  member: MEMBER,
  guest: GUEST,
};
const upstreamAuth = Layer.succeed(
  EnvironmentAuth.EnvironmentAuth,
  // The gate decorates these two methods and passes the rest through untouched.
  {
    authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(sessionsByName[request.headers["x-test-session"] ?? ""]!),
    authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(sessionsByName[request.headers["x-test-session"] ?? ""]!),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"],
);

const database = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));

const testLayer = GuestGate.gateEnvironmentAuth(upstreamAuth.pipe(Layer.provideMerge(database)));

const request = (who: "member" | "guest", method: string, url: string) =>
  ({
    method,
    url,
    headers: { "x-test-session": who },
  }) as unknown as HttpServerRequest.HttpServerRequest;

const thread = Effect.fn("test.thread")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at,
      archived_at, deleted_at, payload_json
    ) VALUES (
      ${id}, ${PROJECT}, ${id}, 'codex', 'full-access', 'default', NULL, ${AT}, ${AT},
      NULL, NULL, '{}'
    )
  `;
  return ThreadId.make(id);
});

/** The guest of these tests, with a grant on one thread at the level asked for. */
const grantGuest = Effect.fn("test.grantGuest")(function* (
  threadId: ThreadId,
  level: PersonAccess.GrantLevel,
) {
  const access = yield* PersonAccess.PersonAccess;
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly person_id: string }>`
    SELECT person_id FROM j5_a2a_person_session WHERE session_id = ${GUEST.sessionId}
  `;
  const personId =
    existing[0] === undefined
      ? (yield* access.createGuest({ displayName: "Contractor" })).personId
      : (existing[0].person_id as PersonAccess.Person["personId"]);
  if (existing[0] === undefined) {
    yield* access.bindSession({ sessionId: GUEST.sessionId, personId });
  }
  yield* access.putGrant({ personId, target: { kind: "thread", threadId }, level });
});

const scopesFor = Effect.fn("test.scopesFor")(function* (
  who: "member" | "guest",
  method: string,
  url: string,
) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const http = yield* auth.authenticateHttpRequest(request(who, method, url));
  const upgrade = yield* auth.authenticateWebSocketUpgrade(request(who, method, url));
  // Both entrances are gated alike: a route may sign in through either.
  assert.deepStrictEqual(http.scopes, upgrade.scopes);
  return http.scopes;
});

it("names the few routes a guest keeps permissions on", () => {
  const thread = (id: string): GuestGate.GuestHttpRule => ({
    kind: "thread",
    threadId: ThreadId.make(id),
  });
  assert.deepStrictEqual(GuestGate.guestHttpRule("GET", "/ws"), { kind: "open" });
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/t1"),
    thread("t1"),
  );
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/t1/bounded"),
    thread("t1"),
  );
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/t1/history"),
    thread("t1"),
  );
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/thread%3Aone"),
    thread("thread:one"),
  );
  for (const [method, path] of [
    // The sidebar snapshot: a guest's client reads the sidebar from the socket's filtered feed.
    ["GET", "/api/orchestration/shell"],
    ["GET", "/api/orchestration/shell/archived"],
    ["GET", "/api/orchestration/shell/"],
    ["POST", "/api/orchestration/shell"],
    ["GET", "/api/projects"],
    ["GET", "/api/auth/pairing-links"],
    ["GET", "/api/preview-stream/ws"],
    ["GET", "/api/assets"],
    ["GET", "/api/orchestration/threads/t1/anything-else"],
    ["GET", "/api/orchestration/threads/t1/bounded/extra"],
    ["GET", "/api/orchestration/threads/"],
    ["GET", "/api/orchestration/threads/%E0%A4%A"],
    ["POST", "/api/orchestration/threads/t1"],
    ["POST", "/ws"],
  ] as const) {
    assert.deepStrictEqual(GuestGate.guestHttpRule(method, path), { kind: "refuse" }, path);
  }
});

it.layer(testLayer)("guest gate", (it) => {
  it.effect("leaves a member's session alone on every route", () =>
    Effect.gen(function* () {
      for (const url of ["/ws", "/api/projects", "/api/orchestration/threads/thread:any"]) {
        assert.deepStrictEqual(yield* scopesFor("member", "GET", url), GUEST_SCOPES);
      }
    }),
  );

  it.effect("gives a guest their permissions on a granted thread's loads and the socket only", () =>
    Effect.gen(function* () {
      const granted = yield* thread("thread:http-granted");
      yield* thread("thread:http-other");
      yield* grantGuest(granted, "view");
      for (const url of [
        "/ws",
        "/api/orchestration/threads/thread%3Ahttp-granted",
        "/api/orchestration/threads/thread%3Ahttp-granted/bounded?compactTurnItems=1",
        "/api/orchestration/threads/thread%3Ahttp-granted/history?cursor=abc",
      ]) {
        assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), GUEST_SCOPES, url);
      }
      for (const url of [
        "/api/orchestration/shell",
        "/api/orchestration/threads/thread%3Ahttp-other",
        "/api/orchestration/threads/thread%3Ahttp-other/bounded",
        "/api/orchestration/threads/thread%3Adoes-not-exist",
        "/api/projects",
        "/api/auth/clients",
        "/api/preview-stream/ws?threadId=thread%3Ahttp-granted&tabId=1",
        "/api/assets?token=abc",
        "/api/j5/inbox",
      ]) {
        assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), [], url);
      }
      assert.deepStrictEqual(
        yield* scopesFor("guest", "POST", "/api/orchestration/threads/thread%3Ahttp-granted"),
        [],
      );
    }),
  );

  it.effect("stops giving a guest a thread when the grant is removed", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const threadId = yield* thread("thread:http-removed");
      yield* grantGuest(threadId, "view");
      const url = "/api/orchestration/threads/thread%3Ahttp-removed";
      assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), GUEST_SCOPES);
      const person = yield* access.sessionPerson(GUEST);
      yield* access.removeGrant({
        personId: person!.personId!,
        target: { kind: "thread", threadId },
      });
      assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), []);
    }),
  );
});

/** Runs one request through a connection's authorization and reports whether its handler ran. */
const call = Effect.fn("test.call")(function* (
  who: EnvironmentAuth.AuthenticatedSession,
  method: string,
  payload: unknown,
) {
  const authorize = yield* RpcScopeAuthorization.pipe(
    Effect.provide(GuestGate.layerRpcAuthorization(who, RpcAuthorization.layer(who.scopes))),
  );
  type Handler = Parameters<typeof authorize>[0];
  const outcome = yield* authorize(
    Effect.succeed("ran") as unknown as Handler,
    {
      rpc: { _tag: method },
      payload,
    } as unknown as Parameters<typeof authorize>[1],
  ).pipe(
    Effect.catchTags({
      EnvironmentAuthorizationError: (error) => Effect.succeed(`refused: ${error.message}`),
    }),
    Effect.scoped,
  );
  return String(outcome);
});

it.layer(testLayer)("guest RPC authorization", (it) => {
  it.effect("a member's connection is upstream's check and nothing more", () =>
    Effect.gen(function* () {
      const threadId = yield* thread("thread:rpc-member");
      assert.strictEqual(
        yield* call(MEMBER, ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId }),
        "ran",
      );
      assert.strictEqual(
        yield* call(MEMBER, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {}),
        "ran",
      );
      assert.strictEqual(
        yield* call(MEMBER, ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}),
        "ran",
      );
    }),
  );

  it.effect("a guest reads a granted thread and nothing else", () =>
    Effect.gen(function* () {
      const granted = yield* thread("thread:rpc-granted");
      const other = yield* thread("thread:rpc-other");
      yield* grantGuest(granted, "view");
      for (const method of [
        ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
        ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
        ORCHESTRATION_V2_WS_METHODS.getTurnItem,
        ORCHESTRATION_V2_WS_METHODS.searchThread,
        ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
      ]) {
        assert.strictEqual(yield* call(GUEST, method, { threadId: granted }), "ran", method);
        assert.match(yield* call(GUEST, method, { threadId: other }), /^refused: /, method);
        assert.match(yield* call(GUEST, method, {}), /^refused: /, method);
      }
    }),
  );

  it.effect("a guest may ask for the feeds its client cannot connect without", () =>
    Effect.gen(function* () {
      // `GuestView` narrows what each of these answers; a guest with no grants may ask too.
      const stray = session("session:stray", PersonAccess.GUEST_SESSION_SUBJECT);
      for (const method of [
        WS_METHODS.serverGetConfig,
        WS_METHODS.subscribeServerConfig,
        WS_METHODS.subscribeServerLifecycle,
        ORCHESTRATION_V2_WS_METHODS.subscribeShell,
        // Answered from the guest's own session by `PersonAccess`.
        J5_SHARING_WS_METHODS.getConnectionAccess,
        J5_SHARING_WS_METHODS.subscribeThreadAccess,
      ]) {
        assert.strictEqual(yield* call(GUEST, method, {}), "ran", method);
        assert.strictEqual(yield* call(stray, method, {}), "ran", method);
        // Upstream's own permission check still runs after the guest's.
        assert.match(yield* call({ ...GUEST, scopes: [] }, method, {}), /^refused: /, method);
      }
      assert.deepStrictEqual(
        Object.entries(GuestGate.GUEST_RPC_RULES)
          .flatMap(([method, rule]) => (rule.kind === "narrowed" ? [method] : []))
          .toSorted(),
        [
          ORCHESTRATION_V2_WS_METHODS.subscribeShell,
          WS_METHODS.serverGetConfig,
          WS_METHODS.subscribeServerConfig,
          WS_METHODS.subscribeServerLifecycle,
          J5_SHARING_WS_METHODS.getConnectionAccess,
          J5_SHARING_WS_METHODS.subscribeThreadAccess,
        ].toSorted(),
      );
    }),
  );

  it.effect("a guest gets a URL only for what a granted thread's messages carry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const granted = yield* thread("thread:assets-granted");
      const other = yield* thread("thread:assets-other");
      yield* grantGuest(granted, "view");
      const message = (threadId: ThreadId, attachmentIds: ReadonlyArray<string>) => sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
          payload_json
        ) VALUES (
          ${`message:${threadId}`}, ${threadId}, NULL, NULL, 'user', 0, ${AT}, ${AT},
          ${JSON.stringify({
            // The other thread's attachment id is written in this message's text, where a
            // person could paste it; only the attachment list counts.
            text: "see assets-other-22222222-2222-4222-8222-222222222222",
            attachments: attachmentIds.map((id) => ({ type: "image", id, name: "shot.png" })),
          })}
        )
      `;
      const turnItem = (threadId: ThreadId, itemId: string) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${itemId}, ${threadId}, NULL, NULL, NULL, NULL, NULL, 1, 'dynamic_tool', 'completed',
          ${AT}, '{}'
        )
      `;
      const mine = "assets-granted-11111111-1111-4111-8111-111111111111";
      const theirs = "assets-other-22222222-2222-4222-8222-222222222222";
      yield* message(granted, [mine]);
      yield* message(other, [theirs]);
      yield* turnItem(granted, "item:granted");
      yield* turnItem(other, "item:other");

      const url = (who: EnvironmentAuth.AuthenticatedSession, resource: unknown) =>
        call(who, WS_METHODS.assetsCreateUrl, { resource });
      const attachment = (attachmentId: string) => ({ _tag: "attachment", attachmentId });
      const toolImage = (threadId: ThreadId, itemId: string) => ({
        _tag: "tool-output-image",
        threadId,
        itemId,
        index: 0,
      });

      assert.strictEqual(yield* url(GUEST, attachment(mine)), "ran");
      assert.strictEqual(yield* url(GUEST, toolImage(granted, "item:granted")), "ran");
      for (const [why, resource] of [
        ["an attachment of a thread outside the grant", attachment(theirs)],
        [
          "an id no message carries",
          attachment("assets-granted-33333333-3333-4333-8333-333333333333"),
        ],
        ["a made-up id", attachment("../../etc/passwd")],
        ["another thread's tool image", toolImage(other, "item:other")],
        // The item is real and so is the grant, but the item is not that thread's.
        ["another thread's item named under the granted thread", toolImage(granted, "item:other")],
        ["a workspace file", { _tag: "workspace-file", threadId: granted, path: "README.md" }],
        ["a media file", { _tag: "media-file", threadId: granted, path: "/etc/passwd" }],
        ["a draft workspace file", { _tag: "draft-workspace-file", cwd: "/", path: "etc/passwd" }],
        ["a project favicon", { _tag: "project-favicon", cwd: "/" }],
        ["GitHub media", { _tag: "github-media", cwd: "/", url: "https://github.com/x" }],
        ["a native app icon", { _tag: "native-app-icon", app: {} }],
        ["a kind that does not exist", { _tag: "attachments", attachmentId: mine }],
        ["no resource at all", undefined],
      ] as const) {
        assert.match(yield* url(GUEST, resource), /^refused: /, why);
      }
      // A guest with no person recorded holds nothing, and a member is not looked up at all.
      const stray = session("session:assets-stray", PersonAccess.GUEST_SESSION_SUBJECT);
      assert.match(yield* url(stray, attachment(mine)), /^refused: /);
      assert.strictEqual(yield* url(MEMBER, attachment(theirs)), "ran");

      // Removing the grant ends it for the next request.
      const access = yield* PersonAccess.PersonAccess;
      const bound = yield* sql<{ readonly person_id: string }>`
        SELECT person_id FROM j5_a2a_person_session WHERE session_id = ${GUEST.sessionId}
      `;
      yield* access.removeGrant({
        personId: bound[0]!.person_id as PersonAccess.Person["personId"],
        target: { kind: "thread", threadId: granted },
      });
      assert.match(yield* url(GUEST, attachment(mine)), /^refused: /);
    }),
  );

  it.effect("a guest is refused every request that is not listed, whatever it names", () =>
    Effect.gen(function* () {
      const granted = yield* thread("thread:rpc-unlisted");
      yield* grantGuest(granted, "collaborate");
      for (const method of [
        // Holds the permission upstream asks for, and names the granted thread.
        ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        ORCHESTRATION_V2_WS_METHODS.launchThread,
        // Feeds and reads that carry every thread, the host's settings or the host's files.
        ORCHESTRATION_V2_WS_METHODS.searchThreads,
        ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
        ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
        WS_METHODS.serverGetSettings,
        WS_METHODS.serverProbe,
        WS_METHODS.serverRefreshProviders,
        WS_METHODS.subscribeAuthAccess,
        WS_METHODS.projectsReadFile,
        WS_METHODS.terminalOpen,
        "a.method.upstream.adds.later",
      ]) {
        assert.match(yield* call(GUEST, method, { threadId: granted }), /^refused: /, method);
      }
    }),
  );
});

/**
 * A guest's open `subscribeThread`, as the RPC server runs one: the handler effect is the whole
 * feed, delivering what upstream publishes until something ends it. `checked` reports each time
 * the gate has read the guest's access, so a test can wait for a grant change to be acted on.
 */
const openThreadFeed = Effect.fn("test.openThreadFeed")(function* (threadId: ThreadId) {
  const access = yield* PersonAccess.PersonAccess;
  const published = yield* Queue.unbounded<string>();
  const delivered = yield* Queue.unbounded<string>();
  const checked = yield* Queue.unbounded<PersonAccess.Access>();
  const stopped = yield* Deferred.make<void>();
  const observed = PersonAccess.PersonAccess.of({
    ...access,
    threadAccess: (who, id) =>
      access.threadAccess(who, id).pipe(Effect.tap((level) => Queue.offer(checked, level))),
  });
  const authorize = yield* RpcScopeAuthorization.pipe(
    Effect.provide(GuestGate.layerRpcAuthorization(GUEST, RpcAuthorization.layer(GUEST.scopes))),
    Effect.provideService(PersonAccess.PersonAccess, observed),
  );
  type Handler = Parameters<typeof authorize>[0];
  const feed = Queue.take(published).pipe(
    Effect.flatMap((event) => Queue.offer(delivered, event)),
    Effect.forever,
    Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
  );
  const request = yield* authorize(
    feed as unknown as Handler,
    {
      rpc: { _tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread },
      payload: { threadId },
    } as unknown as Parameters<typeof authorize>[1],
  ).pipe(
    Effect.catchTags({
      EnvironmentAuthorizationError: (error) => Effect.succeed(`refused: ${error.message}`),
    }),
    Effect.scoped,
    Effect.forkScoped({ startImmediately: true }),
  );
  assert.strictEqual(yield* Queue.take(checked), "view");
  /** Publishes one upstream event and waits for the guest's feed to deliver it. */
  const delivers = Effect.fn("test.delivers")(function* (event: string) {
    yield* Queue.offer(published, event);
    assert.strictEqual(yield* Queue.take(delivered), event);
  });
  return { request, published, delivered, checked, stopped, delivers };
});

it.layer(testLayer)("a guest's open thread feed and its grant", (it) => {
  it.effect("ends when the grant on its thread is removed, and delivers nothing after", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const threadId = yield* thread("thread:feed-removed");
      yield* grantGuest(threadId, "view");
      const feed = yield* openThreadFeed(threadId);
      yield* feed.delivers("before");

      const person = yield* access.sessionPerson(GUEST);
      yield* access.removeGrant({
        personId: person!.personId!,
        target: { kind: "thread", threadId },
      });
      assert.strictEqual(
        yield* Fiber.join(feed.request),
        "refused: This is not shared with you on this server.",
      );
      // Upstream's handler was interrupted, so what it publishes next is taken by no one.
      yield* Deferred.await(feed.stopped);
      yield* Queue.offer(feed.published, "after");
      assert.strictEqual(yield* Queue.size(feed.published), 1);
      assert.strictEqual(yield* Queue.size(feed.delivered), 0);
      assert.match(
        yield* call(GUEST, ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId }),
        /^refused: /,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("stays open through grant changes that leave its thread within reach", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const threadId = yield* thread("thread:feed-kept");
      const other = yield* thread("thread:feed-kept-other");
      yield* grantGuest(threadId, "view");
      const personId = (yield* access.sessionPerson(GUEST))!.personId!;
      const feed = yield* openThreadFeed(threadId);
      const stillOpen = Effect.fn("test.stillOpen")(function* (held: PersonAccess.Access) {
        // The gate has acted on the change, and upstream's events still arrive.
        assert.strictEqual(yield* Queue.take(feed.checked), held);
        yield* feed.delivers(`after ${held}`);
        assert.isUndefined(feed.request.pollUnsafe());
      });

      // A different thread's grant, given and removed.
      yield* grantGuest(other, "view");
      yield* stillOpen("view");
      yield* access.removeGrant({ personId, target: { kind: "thread", threadId: other } });
      yield* stillOpen("view");

      // Another guest's grant on this same thread, given and removed.
      const stranger = yield* access.createGuest({ displayName: "Someone else" });
      yield* access.putGrant({
        personId: stranger.personId,
        target: { kind: "thread", threadId },
        level: "view",
      });
      yield* stillOpen("view");
      yield* access.removeGrant({
        personId: stranger.personId,
        target: { kind: "thread", threadId },
      });
      yield* stillOpen("view");

      // The same grant raised from View to Collaborate.
      yield* grantGuest(threadId, "collaborate");
      yield* stillOpen("collaborate");

      // A grant on the project still covers the thread once the thread's own grant is removed.
      yield* access.putGrant({
        personId,
        target: { kind: "project", projectId: PROJECT },
        level: "view",
      });
      yield* stillOpen("collaborate");
      yield* access.removeGrant({ personId, target: { kind: "thread", threadId } });
      yield* stillOpen("view");

      // And it ends when that goes too.
      yield* access.removeGrant({ personId, target: { kind: "project", projectId: PROJECT } });
      assert.match(String(yield* Fiber.join(feed.request)), /^refused: /);
      yield* Deferred.await(feed.stopped);
    }).pipe(Effect.scoped),
  );
});
