import { assert, it } from "@effect/vitest";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../auth/McpOAuth.ts";
import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { Access } from "./Access.ts";
import * as AccessGate from "./AccessGate.ts";
import { gateMcpOAuth } from "./McpApproval.ts";
import { PairingIntents } from "./PairingIntents.ts";
import type { Person } from "./PersonAccess.ts";
import { accessLayer, device, person } from "./test-support/accessHarness.ts";

const urls = { issuer: "https://j5.test", resource: "https://j5.test/mcp" };
const redirectUri = "http://localhost/callback";
const verifier = `${"a".repeat(43)}-verifier-for-tests`;
const challenge = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";
const request = HttpServerRequest.fromWeb(new Request("https://j5.test/oauth/mcp/token"));

/**
 * Upstream's own MCP sign-in behind J5's gate, over the real stores, with upstream's
 * `EnvironmentAuth` checks as the two approval paths run them. `beforeCodeSpent` runs once the
 * pairing-code path has passed its checks.
 */
const signIn = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const intents = yield* PairingIntents;
  const hooks = {
    beforeCodeSpent: Effect.void as Effect.Effect<void>,
    browser: undefined as EnvironmentAuth.AuthenticatedSession | undefined,
  };
  const upstreamAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    consumeMcpApprovalCode: (code) =>
      Effect.gen(function* () {
        const grant = yield* grants.consume(code).pipe(Effect.orDie);
        assert.isTrue(yield* intents.approvesMcpClient(grant, code).pipe(Effect.orDie));
        yield* hooks.beforeCodeSpent;
      }),
    authenticateBrowserSession: () =>
      hooks.browser === undefined
        ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
        : Effect.succeed(hooks.browser),
    issueMcpClientSession: (input) =>
      sessions
        .issue({
          subject: "mcp-client",
          method: "bearer-access-token",
          scopes: EnvironmentAuth.mcpClientScopes(input.access),
        })
        .pipe(Effect.orDie),
  });
  const oauth = yield* McpOAuth.McpOAuth.pipe(
    Effect.provide(
      gateMcpOAuth(McpOAuth.layer).pipe(
        Layer.provide(AccessGate.layerGatedEnvironmentAuth.pipe(Layer.provide(upstreamAuth))),
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
          }),
        ),
      ),
    ),
  );
  const client = yield* oauth.register({ client_name: "Agent", redirect_uris: [redirectUri] });
  const authorization = yield* oauth.validateAuthorization({
    urls,
    request: {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: urls.resource,
    },
  });
  const codeOf = (redirect: string) => new URL(redirect).searchParams.get("code")!;
  const approveWithCode = Effect.fn(function* (approver: Person) {
    const link = yield* grants.issueOneTimeToken({
      subject: "one-time-token",
      scopes: LEVEL_PERMISSIONS.owner,
    });
    yield* intents.record({
      pairingLinkId: link.id,
      credential: link.credential,
      personId: approver.personId,
      linkId: null,
      ceiling: null,
    });
    return codeOf(
      yield* oauth.approve({
        request,
        authorization,
        decision: { _tag: "pairing-code", access: "full-access", code: link.credential },
      }),
    );
  });
  const approveWithBrowser = Effect.fn(function* (approver: Person) {
    const laptop = yield* device(approver.personId, LEVEL_PERMISSIONS.owner);
    hooks.browser = {
      sessionId: laptop.sessionId,
      subject: "one-time-token",
      method: "browser-session-cookie",
      scopes: LEVEL_PERMISSIONS.owner,
    };
    const session = yield* oauth.approvingBrowserSession(request, authorization);
    assert.isDefined(session);
    return codeOf(
      yield* oauth.approve({
        request,
        authorization,
        decision: {
          _tag: "browser-session",
          access: "full-access",
          csrfToken: session?.csrfToken ?? "",
        },
      }),
    );
  });
  const exchange = (code: string) =>
    oauth.exchangeCode({
      request,
      urls,
      token: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
        resource: urls.resource,
      },
    });
  return { hooks, approveWithCode, approveWithBrowser, exchange };
});

const isRevoked = (token: string) =>
  SessionStore.SessionStore.use((sessions) =>
    sessions
      .verify(token)
      .pipe(
        Effect.as(false),
        Effect.catchTags({ SessionTokenRevokedError: () => Effect.succeed(true) }),
      ),
  );

it.layer(accessLayer)("MCP approval", (it) => {
  it.effect("refuses a code an Owner approved just before they were lowered", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const sessions = yield* SessionStore.SessionStore;
      const { hooks, approveWithCode, exchange } = yield* signIn;
      const owner = yield* person("Owner approving an agent", [
        { scope: { kind: "server" }, level: "owner" },
      ]);

      const issued = yield* exchange(yield* approveWithCode(owner));
      assert.strictEqual((yield* sessions.verify(issued.access_token)).subject, "mcp-client");

      // The approval passes its checks, the Owner is lowered, the code is minted 10ms later and
      // exchanged just inside its life.
      hooks.beforeCodeSpent = Effect.gen(function* () {
        yield* access
          .setLevel({ personId: owner.personId, scope: { kind: "server" }, level: "viewer" })
          .pipe(Effect.orDie);
        yield* TestClock.adjust("10 millis");
      });
      const raced = yield* approveWithCode(owner);
      yield* TestClock.adjust("59995 millis");
      assert.strictEqual((yield* exchange(raced).pipe(Effect.flip)).error, "invalid_grant");
    }),
  );

  it.effect("ends the clients an Owner approved, by code or browser, when they are lowered", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const { approveWithCode, approveWithBrowser, exchange } = yield* signIn;
      const owner = (name: string) => person(name, [{ scope: { kind: "server" }, level: "owner" }]);
      const lowered = yield* owner("Owner who is lowered");
      const staying = yield* owner("Owner who stays");

      const byCode = yield* exchange(yield* approveWithCode(lowered));
      const byBrowser = yield* exchange(yield* approveWithBrowser(lowered));
      const others = yield* exchange(yield* approveWithBrowser(staying));
      yield* access.setLevel({
        personId: lowered.personId,
        scope: { kind: "server" },
        level: "collaborator",
      });

      assert.isTrue(yield* isRevoked(byCode.access_token));
      assert.isTrue(yield* isRevoked(byBrowser.access_token));
      assert.isFalse(yield* isRevoked(others.access_token));
    }),
  );
});
