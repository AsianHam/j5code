import { expect, it } from "@effect/vitest";
import { ARTIFACT_READ_PATH, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeJ5Request, J5HttpError } from "./http.ts";

const relayToken = (accessToken: string) =>
  ({ _tag: "Dpop", accessToken, expiresAtEpochMs: 4_102_444_800_000 }) as const;

/** The one J5 read left on HTTP: an artifact's content. */
const read = (connection: PreparedConnection) =>
  executeJ5Request(connection, HttpClientRequest.post(ARTIFACT_READ_PATH), 10_000);

/** Hands out relay credentials the way the live authorization service does, one per request. */
function relayAuthorization(tokens: ReadonlyArray<string>, httpBaseUrl = "https://relay.test") {
  const issued: Array<{ rejectedAccessToken?: string }> = [];
  let next = 0;
  const service: RemoteEnvironmentAuthorization["Service"] = {
    authorizeBearer: () => Effect.die("bearer authorization is not used by relay reads"),
    authorizeDpop: () => Effect.die("socket authorization is not used by HTTP reads"),
    authorizeDpopHttp: (input) => {
      issued.push(
        input.rejectedAccessToken === undefined
          ? {}
          : { rejectedAccessToken: input.rejectedAccessToken },
      );
      return Effect.succeed({
        environmentId: input.expectedEnvironmentId,
        label: "relay",
        httpBaseUrl,
        httpAuthorization: relayToken(tokens[Math.min(next++, tokens.length - 1)]!),
      });
    },
  };
  return { issued, service };
}

function prepared(id: string, authorization: PreparedHttpAuthorization | null): PreparedConnection {
  const environmentId = EnvironmentId.make(id);
  const label = id;
  const httpBaseUrl = `https://${id}.test`;
  const wsBaseUrl = `wss://${id}.test`;
  return {
    environmentId,
    label,
    httpBaseUrl,
    socketUrl: `${wsBaseUrl}/ws`,
    httpAuthorization: authorization,
    target:
      authorization === null
        ? new PrimaryConnectionTarget({ environmentId, label, httpBaseUrl, wsBaseUrl })
        : authorization._tag === "Bearer"
          ? new BearerConnectionTarget({ environmentId, label, connectionId: id })
          : new RelayConnectionTarget({ environmentId, label }),
  };
}

it.effect("sends each server its own bearer credential", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({});
    };
    for (const id of ["alpha", "bravo"]) {
      yield* read(prepared(id, { _tag: "Bearer", token: `${id}-token` })).pipe(
        Effect.provide(layerRemoteHttpClient(fetch)),
      );
    }
    expect(requests.map((request) => [request.url, request.headers.get("authorization")])).toEqual([
      [`https://alpha.test${ARTIFACT_READ_PATH}`, "Bearer alpha-token"],
      [`https://bravo.test${ARTIFACT_READ_PATH}`, "Bearer bravo-token"],
    ]);
  }),
);

it.effect("includes session cookies for the prepared browser environment", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({});
    };
    yield* read(prepared("browser", null)).pipe(Effect.provide(layerRemoteHttpClient(fetch)));
    expect(requests[0]?.credentials).toBe("include");
    expect(requests[0]?.headers.has("authorization")).toBe(false);
  }),
);

it.effect("signs fresh DPoP proofs for the actual method and remote URL", () =>
  Effect.gen(function* () {
    const proofs: Array<{ method: string; url: string; accessToken?: string }> = [];
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({});
    };
    const remote = prepared("relay", relayToken("stale-token"));
    const authorization = relayAuthorization(["relay-token"]);
    yield* Effect.gen(function* () {
      yield* read(remote);
      yield* read(remote);
    }).pipe(
      Effect.provide(layerRemoteHttpClient(fetch)),
      Effect.provideService(RemoteEnvironmentAuthorization, authorization.service),
      Effect.provideService(ManagedRelayDpopSigner, {
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed(`proof-${proofs.length}`);
        },
      }),
    );
    // The token comes from the authorization service at request time, not
    // from the credential captured when the connection was prepared.
    const proof = {
      method: "POST",
      url: `https://relay.test${ARTIFACT_READ_PATH}`,
      accessToken: "relay-token",
    };
    expect(proofs).toEqual([proof, proof]);
    expect(
      requests.map((request) => [
        request.headers.get("authorization"),
        request.headers.get("dpop"),
      ]),
    ).toEqual([
      ["DPoP relay-token", "proof-1"],
      ["DPoP relay-token", "proof-2"],
    ]);
  }),
);

it.effect("refreshes a rejected relay token once and retries the same request", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.headers.get("authorization") === "DPoP fresh-token"
        ? Response.json({})
        : Response.json({ code: "auth_invalid", reason: "invalid_credential" }, { status: 401 });
    };
    const authorization = relayAuthorization(["expired-token", "fresh-token"]);
    const response = yield* read(prepared("relay", relayToken("expired-token"))).pipe(
      Effect.provide(layerRemoteHttpClient(fetch)),
      Effect.provideService(RemoteEnvironmentAuthorization, authorization.service),
      Effect.provideService(ManagedRelayDpopSigner, {
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: () => Effect.succeed("proof"),
      }),
    );
    expect(response.status).toBe(200);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "DPoP expired-token",
      "DPoP fresh-token",
    ]);
    expect(authorization.issued).toEqual([{}, { rejectedAccessToken: "expired-token" }]);
  }),
);

it.effect(
  "reports a refusal as a J5 error with the server's message and code, without retrying",
  () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ error: "unauthorized", message: "Sign in again." }, { status: 401 });
      };
      const error = yield* read(prepared("bravo", { _tag: "Bearer", token: "old" })).pipe(
        Effect.provide(layerRemoteHttpClient(fetch)),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(J5HttpError);
      expect(error).toMatchObject({ status: 401, detail: "Sign in again.", code: "unauthorized" });
      expect(requests).toHaveLength(1);
    }),
);
