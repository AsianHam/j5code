import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerRespondable, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";

/**
 * The J5 route files share one way of authenticating a request, checking a
 * scope, and shaping an error body. Every J5 HTTP surface imports these so an
 * auth or error-shape change is made once.
 */

/** Authenticate the current request against the environment's sessions. */
export const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
});

/** Refuse unless the session holds at least one of the scopes; the first names the requirement. */
export const requireAnyScope = (
  session: EnvironmentAuth.AuthenticatedSession,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) =>
  scopes.some((scope) => session.scopes.includes(scope))
    ? Effect.void
    : failEnvironmentScopeRequired(scopes[0]!);

export const requireScope = (
  session: EnvironmentAuth.AuthenticatedSession,
  scope: AuthEnvironmentScope,
) => requireAnyScope(session, [scope]);

export const jsonError = (
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
) => HttpServerResponse.jsonUnsafe({ error, message, ...extra }, { status });

export const requestFailure = (message: string) => jsonError(400, "invalid_request", message);

export const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Error";

export const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** The auth failures every J5 route turns into their own HTTP responses. */
export const respondableTags = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

/** The request body as JSON, or a failure the route turns into a 400. */
export const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* Effect.result(request.json);
});
