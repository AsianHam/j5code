import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { J5_SESSION_RENEW_PATH } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import { renewSavedSession } from "./sessionRenewal.ts";

const ENVIRONMENT = EnvironmentId.make("environment:remote");
const ENTRY: ConnectionCatalogEntry = {
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT,
    label: "Team server",
    connectionId: "connection:team",
  }),
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: "connection:team",
      environmentId: ENVIRONMENT,
      label: "Team server",
      httpBaseUrl: "https://team.example/",
      wsBaseUrl: "wss://team.example/",
    }),
  ),
  enabled: true,
};

/** A saved token, and a server that answers the renewal route as given. */
const harness = (answer: { readonly status: number; readonly body: unknown }) => {
  const stored = new Map<string, ConnectionCredential>([
    ["connection:team", new BearerConnectionCredential({ token: "old-token" })],
  ]);
  const asked: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(
      ConnectionCredentialStore.ConnectionCredentialStore,
      ConnectionCredentialStore.make({
        get: (id) => Effect.succeed(Option.fromNullishOr(stored.get(id))),
        put: (id, credential) => Effect.sync(() => void stored.set(id, credential)),
        remove: (id) => Effect.sync(() => void stored.delete(id)),
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          asked.push({ url: request.url, authorization: request.headers.authorization });
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(answer.body), { status: answer.status }),
          );
        }),
      ),
    ),
  );
  return { stored, asked, layer };
};

it.effect("stores the token a saved server renews its session with", () =>
  Effect.gen(function* () {
    const { stored, asked, layer } = harness({
      status: 200,
      body: { renewed: true, token: "new-token", expiresAt: "2026-11-01T00:00:00.000Z" },
    });
    assert.isTrue(yield* renewSavedSession(ENTRY).pipe(Effect.provide(layer)));
    assert.deepStrictEqual(asked, [
      { url: `https://team.example${J5_SESSION_RENEW_PATH}`, authorization: "Bearer old-token" },
    ]);
    assert.strictEqual(stored.get("connection:team")?.token, "new-token");
  }),
);

it.effect("leaves the token as it is when the server will not renew it", () =>
  Effect.gen(function* () {
    for (const answer of [
      { status: 401, body: { error: "not_renewable" } },
      { status: 200, body: { renewed: false } },
    ]) {
      const { stored, layer } = harness(answer);
      assert.isFalse(yield* renewSavedSession(ENTRY).pipe(Effect.provide(layer)));
      assert.strictEqual(stored.get("connection:team")?.token, "old-token");
    }
  }),
);
