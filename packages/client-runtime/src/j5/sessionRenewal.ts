import { J5_SESSION_RENEW_PATH, SessionRenewal } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { BearerConnectionCredential, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { credentialConnectionId, routeHttpBaseUrl } from "../connection/routes.ts";

/**
 * Renews the session of a server a client reaches with a saved bearer token, when J5 ended it for
 * a change of its person's level (People and access AC17). The connection is then refused for
 * authentication; this asks that server's renewal route with the old token, stores the new one
 * and connects again, once. A token the server will not renew is left as it is, and the person
 * pairs that server again by hand, as upstream has it.
 *
 * The browser's own server renews through its cookie instead, in the web client's sign-in gate.
 */

const decodeRenewal = HttpClientResponse.schemaBodyJson(SessionRenewal);

/**
 * The bearer connection a saved entry stores its token under, and where it is reached. A T3
 * Connect route proves itself with DPoP, whose sessions are never renewed.
 */
const bearerOf = (entry: ConnectionCatalogEntry) =>
  entry.target._tag === "BearerConnectionTarget" &&
  Option.getOrNull(entry.profile)?._tag === "BearerConnectionProfile" &&
  (Option.getOrNull(entry.profile) as { readonly authorization?: string }).authorization ===
    undefined
    ? {
        connectionId: credentialConnectionId(entry.target.connectionId),
        httpBaseUrl: routeHttpBaseUrl({ target: entry.target, profile: entry.profile }),
      }
    : null;

/** Renews a saved server's session with its stored token; `true` when a new one was stored. */
export const renewSavedSession = Effect.fn("j5.sessionRenewal.renewSavedSession")(function* (
  entry: ConnectionCatalogEntry,
) {
  const bearer = bearerOf(entry);
  if (bearer === null || bearer.httpBaseUrl === null) return false;
  const credentials = yield* ConnectionCredentialStore;
  const stored = yield* credentials.get(bearer.connectionId);
  if (Option.isNone(stored)) return false;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(new URL(J5_SESSION_RENEW_PATH, bearer.httpBaseUrl).toString()).pipe(
      HttpClientRequest.bearerToken(stored.value.token),
    ),
  );
  if (response.status !== 200) return false;
  const renewal = yield* decodeRenewal(response);
  if (!renewal.renewed || renewal.token === undefined) return false;
  yield* credentials.put(
    bearer.connectionId,
    new BearerConnectionCredential({ token: renewal.token }),
  );
  return true;
});

/**
 * Follows one saved server's connection, renewing each time it is refused for authentication. It
 * ends when the server is removed, which frees its place among those followed.
 */
const follow = Effect.fn("j5.sessionRenewal.follow")(function* (
  environmentId: Parameters<EnvironmentRegistry["Service"]["stateChanges"]>[0],
) {
  const registry = yield* EnvironmentRegistry;
  yield* registry.stateChanges(environmentId).pipe(
    Stream.filter(
      (state) =>
        state.phase === "blocked" &&
        state.lastFailure?._tag === "ConnectionBlockedError" &&
        state.lastFailure.reason === "authentication",
    ),
    Stream.mapEffect(() =>
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        if (entry === undefined) return;
        if (yield* renewSavedSession(entry)) yield* registry.retryNow(environmentId);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("J5 could not renew a saved server's session", {
            environmentId,
            cause,
          }),
        ),
      ),
    ),
    Stream.runDrain,
    Effect.catch(() => Effect.void),
  );
});

/**
 * For the web client's connection runtime: follows every saved server reached with a bearer token
 * while the runtime lives.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const following = yield* FiberMap.make<string>();
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          for (const [environmentId, entry] of entries) {
            if (bearerOf(entry) === null) continue;
            yield* FiberMap.run(following, environmentId, follow(environmentId), {
              onlyIfMissing: true,
            });
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
