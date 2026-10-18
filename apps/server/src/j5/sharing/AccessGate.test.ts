import { assert, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  ORCHESTRATION_V2_WS_METHODS,
  RpcScopeAuthorization,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  J5_ACCESS_WS_METHODS,
  J5_CLIENT_READ_WS_METHODS,
  LEVEL_PERMISSIONS,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as AccessGate from "./AccessGate.ts";
import { PAIRED_AS_SOMEONE_ELSE, PairingIntents } from "./PairingIntents.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { accessLayer, device, person, thread } from "./test-support/accessHarness.ts";

it("names the few routes a narrowed connection keeps permissions on", () => {
  assert.deepStrictEqual(AccessGate.accessHttpRule("GET", "/ws"), { kind: "open" });
  assert.strictEqual(
    AccessGate.accessHttpRule("GET", "/api/orchestration/threads/t1").kind,
    "thread",
  );
  assert.strictEqual(
    AccessGate.accessHttpRule("GET", "/api/orchestration/threads/t1/bounded").kind,
    "thread",
  );
  for (const [method, path] of [
    ["GET", "/api/orchestration/shell"],
    ["GET", "/api/projects"],
    ["GET", "/api/auth/pairing-links"],
    ["GET", "/api/orchestration/threads/t1/anything-else"],
    ["POST", "/api/orchestration/threads/t1"],
    ["POST", "/ws"],
  ] as const) {
    assert.strictEqual(AccessGate.accessHttpRule(method, path).kind, "refuse", path);
  }
});

/** A session as upstream signs one in, carried by a header the stub reads. */
type Signed = EnvironmentAuth.AuthenticatedSession;
const signedIn = new Map<string, Signed>();

const upstreamAuth = Layer.succeed(
  EnvironmentAuth.EnvironmentAuth,
  // The gate decorates these and passes the rest through untouched.
  {
    authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(signedIn.get(request.headers["x-test-session"] ?? "")!),
    authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(signedIn.get(request.headers["x-test-session"] ?? "")!),
    createBrowserSession: () => Effect.succeed({ paired: true }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"],
);

const testLayer = AccessGate.layerGatedEnvironmentAuth.pipe(
  Layer.provideMerge(upstreamAuth),
  Layer.provideMerge(accessLayer),
);

/** A device of a new person holding the levels given, signed in with its level's permissions. */
const signed = Effect.fn("test.signed")(function* (
  name: string,
  levels: Parameters<typeof person>[1],
  scopes: ReadonlyArray<AuthEnvironmentScope> = LEVEL_PERMISSIONS.collaborator,
) {
  const created = yield* person(name, levels);
  const issued = yield* device(created.personId, scopes);
  const session: Signed = {
    sessionId: issued.sessionId,
    subject: "one-time-token",
    method: "browser-session-cookie",
    scopes,
  };
  signedIn.set(name, session);
  return { person: created, session, token: issued.token };
});

const scopesFor = Effect.fn("test.scopesFor")(function* (who: string, method: string, url: string) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const request = {
    method,
    url,
    headers: { "x-test-session": who },
  } as unknown as HttpServerRequest.HttpServerRequest;
  return (yield* auth.authenticateHttpRequest(request)).scopes;
});

/** Runs one request through a connection's authorization and reports whether its handler ran. */
const call = Effect.fn("test.call")(function* (
  who: Signed,
  method: string,
  payload: unknown,
  handler: Effect.Effect<string> = Effect.succeed("ran"),
) {
  const authorize = yield* RpcScopeAuthorization.pipe(
    Effect.provide(AccessGate.layerRpcAuthorization(who, RpcAuthorization.layer(who.scopes))),
  );
  type Handler = Parameters<typeof authorize>[0];
  const outcome = yield* authorize(
    handler as unknown as Handler,
    { rpc: { _tag: method }, payload } as unknown as Parameters<typeof authorize>[1],
  ).pipe(
    Effect.catchTags({
      EnvironmentAuthorizationError: (error) => Effect.succeed(`refused: ${error.message}`),
    }),
  );
  return String(outcome);
});

it.layer(testLayer)("access gate", (it) => {
  it.effect("leaves a session that writes to the whole server alone", () =>
    Effect.gen(function* () {
      const { session } = yield* signed("Wide", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      for (const url of ["/ws", "/api/projects", "/api/orchestration/threads/thread:any"]) {
        assert.deepStrictEqual(yield* scopesFor("Wide", "GET", url), session.scopes, url);
      }
      assert.strictEqual(yield* call(session, WS_METHODS.projectsReadFile, {}), "ran");
      assert.strictEqual(yield* call(session, J5_CLIENT_READ_WS_METHODS.readFleet, {}), "ran");
    }),
  );

  it.effect(
    "gives a narrowed person their thread's loads and the socket, and follows a change at once",
    () =>
      Effect.gen(function* () {
        const people = yield* PersonAccess.PersonAccess;
        const mine = yield* thread("thread:http-mine");
        yield* thread("thread:http-other");
        const { person: viewer, session } = yield* signed(
          "Thread viewer",
          [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
          LEVEL_PERMISSIONS.viewer,
        );
        assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", "/ws"), session.scopes);
        const own = "/api/orchestration/threads/thread%3Ahttp-mine";
        assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", own), session.scopes);
        for (const url of [
          "/api/orchestration/threads/thread%3Ahttp-other",
          "/api/orchestration/shell",
          "/api/projects",
        ]) {
          assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", url), [], url);
        }
        yield* people.removeLevel({
          personId: viewer.personId,
          scope: { kind: "thread", threadId: mine },
        });
        assert.deepStrictEqual(yield* scopesFor("Thread viewer", "GET", own), []);
      }),
  );

  it.effect("holds a Viewer to reading their scope and refuses them every folder", () =>
    Effect.gen(function* () {
      const mine = yield* thread("thread:rpc-viewer");
      const other = yield* thread("thread:rpc-viewer-other");
      const { session } = yield* signed(
        "Reader",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      for (const method of [
        ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
        WS_METHODS.previewList,
      ]) {
        assert.strictEqual(yield* call(session, method, { threadId: mine }), "ran", method);
        assert.match(yield* call(session, method, { threadId: other }), /^refused/, method);
      }
      for (const method of [
        WS_METHODS.previewOpen,
        WS_METHODS.terminalOpen,
        WS_METHODS.projectsReadFile,
        WS_METHODS.filesystemBrowse,
        WS_METHODS.vcsPull,
        J5_CLIENT_READ_WS_METHODS.readFleet,
        ORCHESTRATION_V2_WS_METHODS.searchThreads,
      ]) {
        assert.match(yield* call(session, method, { threadId: mine }), /^refused/, method);
      }
    }),
  );

  it.effect("lets a narrowed Collaborator open any folder and write only within their scope", () =>
    Effect.gen(function* () {
      const mine = yield* thread("thread:rpc-collaborator");
      const other = yield* thread("thread:rpc-collaborator-other");
      const { session } = yield* signed("Builder", [
        { scope: { kind: "thread", threadId: mine }, level: "collaborator" },
      ]);
      for (const method of [
        WS_METHODS.projectsReadFile,
        WS_METHODS.vcsPull,
        WS_METHODS.filesystemBrowse,
      ]) {
        assert.strictEqual(yield* call(session, method, { cwd: "/anywhere" }), "ran", method);
      }
      assert.strictEqual(yield* call(session, WS_METHODS.terminalOpen, { threadId: mine }), "ran");
      assert.match(yield* call(session, WS_METHODS.terminalOpen, { threadId: other }), /^refused/);
      // The server's own surfaces are not theirs.
      assert.match(yield* call(session, J5_CLIENT_READ_WS_METHODS.readFleet, {}), /^refused/);
      // Upstream's own check still runs: a Collaborator holds no access management.
      assert.match(yield* call(session, WS_METHODS.subscribeAuthAccess, {}), /^refused/);
    }),
  );

  it.effect("gives a server-scope Viewer the server's surfaces to read and no folders", () =>
    Effect.gen(function* () {
      const anywhere = yield* thread("thread:rpc-server-viewer");
      const { session } = yield* signed(
        "Auditor",
        [{ scope: { kind: "server" }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      assert.strictEqual(yield* call(session, J5_CLIENT_READ_WS_METHODS.readFleet, {}), "ran");
      assert.strictEqual(
        yield* call(session, ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId: anywhere }),
        "ran",
      );
      assert.match(yield* call(session, WS_METHODS.projectsReadFile, {}), /^refused/);
    }),
  );

  it.effect("lets a device no one claimed do no more than connect and say whose it is", () =>
    Effect.gen(function* () {
      const anywhere = yield* thread("thread:rpc-unknown");
      const issued = yield* device(null, LEVEL_PERMISSIONS.owner, { subject: "cloud-connect" });
      const session: Signed = {
        sessionId: issued.sessionId,
        subject: "cloud-connect",
        method: "browser-session-cookie",
        scopes: LEVEL_PERMISSIONS.owner,
      };
      for (const method of [
        WS_METHODS.serverGetConfig,
        J5_ACCESS_WS_METHODS.getConnectionAccess,
        J5_ACCESS_WS_METHODS.listClaimablePeople,
        J5_ACCESS_WS_METHODS.claimDevice,
      ]) {
        assert.strictEqual(yield* call(session, method, {}), "ran", method);
      }
      for (const method of [
        ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        WS_METHODS.projectsReadFile,
        J5_ACCESS_WS_METHODS.leave,
      ]) {
        assert.match(yield* call(session, method, { threadId: anywhere }), /^refused/, method);
      }
    }),
  );

  it.effect("ends a feed already open when the person loses what it shows", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const mine = yield* thread("thread:rpc-feed");
      const { person: viewer, session } = yield* signed(
        "Watcher",
        [{ scope: { kind: "thread", threadId: mine }, level: "viewer" }],
        LEVEL_PERMISSIONS.viewer,
      );
      const feed = yield* Effect.forkChild(
        call(
          session,
          ORCHESTRATION_V2_WS_METHODS.subscribeThread,
          { threadId: mine },
          Effect.never,
        ),
      );
      yield* Effect.yieldNow;
      yield* people.removeLevel({
        personId: viewer.personId,
        scope: { kind: "thread", threadId: mine },
      });
      assert.match(yield* Fiber.join(feed), /^refused/);
    }),
  );

  it.effect("refuses a browser paired as one person a link made for another", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const intents = yield* PairingIntents;
      const marco = yield* person("Marco");
      const { person: priya, token } = yield* signed("Priya B", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      for (const [credential, personId] of [
        ["for-marco", marco.personId],
        ["for-priya", priya.personId],
      ] as const) {
        yield* intents.record({
          pairingLinkId: credential,
          credential,
          personId,
          linkId: null,
          ceiling: null,
        });
      }
      const metadata = { deviceType: "desktop" } as const;
      const refused = yield* auth
        .createBrowserSession("for-marco", metadata, token)
        .pipe(Effect.flip);
      assert.strictEqual(
        "diagnostic" in refused ? refused.diagnostic : null,
        PAIRED_AS_SOMEONE_ELSE,
      );
      // The link is still Marco's to use.
      assert.isNotNull(yield* intents.intentOf("for-marco"));
      // Her own link, or a browser with no session, pairs as upstream has it.
      yield* auth.createBrowserSession("for-priya", metadata, token);
      yield* auth.createBrowserSession("for-marco", metadata, undefined);
    }),
  );
});
