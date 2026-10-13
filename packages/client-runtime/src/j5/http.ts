import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentRawHttpRequest } from "../state/environmentHttpAuth.ts";

const ErrorResponse = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class J5HttpError extends Schema.TaggedError<J5HttpError>()("J5HttpError", {
  status: Schema.Number,
  detail: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Authorizes against this prepared environment only, through the same
 * request-time credential resolution the client uses for its other
 * authenticated HTTP reads: cookies for the browser's own server, a static
 * bearer token, or a relay access token with a fresh DPoP proof per request.
 * A relay token the server rejects gets one refresh and retry.
 */
export const executeJ5Request = Effect.fn("j5.http.executeRequest")(function* (
  prepared: PreparedConnection,
  request: HttpClientRequest.HttpClientRequest,
  timeoutMs: number,
) {
  const client = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  // `request.url` is a path plus optional query; the origin is resolved per
  // attempt because a relay refresh can move the environment to a new one.
  const path = new URL(request.url, "http://environment.invalid");
  const resolveUrl = (httpBaseUrl: string) => {
    const url = new URL(environmentEndpointUrl(httpBaseUrl, path.pathname));
    url.search = path.search;
    return url.toString();
  };
  let requestUrl = resolveUrl(prepared.httpBaseUrl);
  const response = yield* executeAuthenticatedEnvironmentRawHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: request.method,
    url: (httpBaseUrl) => (requestUrl = resolveUrl(httpBaseUrl)),
    timeoutMs,
    request: ({ headers }) =>
      client.execute(
        HttpClientRequest.setHeaders(HttpClientRequest.setUrl(request, requestUrl), {
          ...headers,
        }),
      ),
    isUnauthorizedResponse: (response) => response.status === 401,
  });
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new J5HttpError({
    status: response.status,
    detail: decoded?.message ?? `J5 request failed (HTTP ${response.status}).`,
    ...(decoded?.error === undefined ? {} : { code: decoded.error }),
  });
});
