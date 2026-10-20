import type { AuthClientMetadata, AuthSessionId } from "@t3tools/contracts";
import { J5_SESSION_RENEW_PATH, devicePermissions, highestLevel } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/http/Cookies";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import { PersonAccess } from "./PersonAccess.ts";

/**
 * Where a device whose session J5 ended for renewal gets a new one (People and access AC17). A
 * session's permissions are fixed in its signed token, so a change of level ends each of the
 * person's sessions (`Access`); the device then comes here with its old token, which still
 * proves which session it was: upstream checks a token's signature before whether it was
 * revoked, and says which session a revoked token belongs to.
 *
 * Renewal is for a session J5 marked when it ended it, and for nothing else. A device an Owner or
 * the person ended has no mark, and never comes back (AC49, AC50). A session that has expired, a
 * DPoP-bound one, and a mark already used are refused, and the device is paired again by hand.
 * The new session holds what the person's level and the device's ceiling give now, and lasts
 * only as long as the old one would have, so renewing never lengthens a device's life.
 *
 * Reading the mark, consuming it, reading the level and issuing the session commit together, so
 * a token presented twice renews once.
 */

/** What upstream says of a browser session presented from another origin. */
const { FOREIGN_ORIGIN_DIAGNOSTIC } = EnvironmentAuth;

// As upstream answers every credential it issues (`auth/http.ts`).
const CREDENTIAL_RESPONSE_HEADERS = { "cache-control": "no-store", pragma: "no-cache" } as const;

class NotRenewableError extends Schema.TaggedError<NotRenewableError>()("NotRenewableError", {}) {
  override get message(): string {
    return "This device's session cannot be renewed. Pair it again.";
  }
}

const StoredCeiling = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeCeiling = Schema.decodeUnknownOption(StoredCeiling);

const refusal = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error, message },
    { status, headers: CREDENTIAL_RESPONSE_HEADERS },
  );

const clientOf = (record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata => ({
  deviceType: record.deviceType,
  ...(record.label === null ? {} : { label: record.label }),
  ...(record.ipAddress === null ? {} : { ipAddress: record.ipAddress }),
  ...(record.userAgent === null ? {} : { userAgent: record.userAgent }),
  ...(record.os === null ? {} : { os: record.os }),
  ...(record.browser === null ? {} : { browser: record.browser }),
});

/**
 * Renews the session a token proves, when J5 ended it for renewal: verifies the token, then reads
 * and consumes the mark, reads the level and issues the new session in one transaction.
 */
export const makeSessionRenewal = (services: {
  readonly sessions: SessionStore.SessionStore["Service"];
  readonly repository: AuthSessionRepository["Service"];
  readonly people: PersonAccess["Service"];
  readonly sql: SqlClient.SqlClient;
}) => {
  const { sessions: store, repository, people, sql } = services;

  const renew = Effect.fn("j5.sharing.sessionRenewal.renew")(function* (sessionId: AuthSessionId) {
    const record = yield* repository.getById({ sessionId });
    if (Option.isNone(record)) return yield* new NotRenewableError({});
    const old = record.value;
    if (old.method === "dpop-access-token") return yield* new NotRenewableError({});
    const remaining = DateTime.distance(yield* DateTime.now, old.expiresAt);
    if (Duration.toMillis(remaining) <= 0) return yield* new NotRenewableError({});
    const consumed = yield* sql<{
      readonly person_id: string;
      readonly ceiling_scopes: string | null;
    }>`
      DELETE FROM j5_a2a_person_session
      WHERE session_id = ${sessionId} AND renew_pending_since IS NOT NULL
      RETURNING person_id, ceiling_scopes
    `;
    const binding = consumed[0];
    if (binding === undefined) return yield* new NotRenewableError({});
    const personId = ParticipantId.make(binding.person_id);
    const ceiling =
      binding.ceiling_scopes === null
        ? null
        : Option.getOrElse(decodeCeiling(binding.ceiling_scopes), () => []);
    const levels = yield* people.listLevels(personId);
    const scopes = devicePermissions(highestLevel(levels.map((held) => held.level)), ceiling);
    const issued = yield* store.issue({
      ttl: remaining,
      subject: old.subject,
      method: old.method,
      scopes,
      client: clientOf(old.client),
    });
    yield* people.bindSession({ sessionId: issued.sessionId, personId, ceiling });
    return issued;
  });

  /** `live` for a token whose session was never ended; the new session for one J5 marked. */
  const renewToken = Effect.fn("j5.sharing.sessionRenewal.renewToken")(function* (token: string) {
    const revoked = yield* store.verify(token).pipe(
      Effect.as("live" as const),
      Effect.catchTags({ SessionTokenRevokedError: (error) => Effect.succeed(error.sessionId) }),
      Effect.orElseSucceed(() => null),
    );
    if (revoked === "live") return "live" as const;
    if (revoked === null) return yield* new NotRenewableError({});
    return yield* sql.withTransaction(renew(revoked));
  });

  return { renewToken };
};

export const sessionRenewalRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
    const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);
    const repository = yield* Effect.serviceOption(AuthSessionRepository);
    const people = yield* Effect.serviceOption(PersonAccess);
    if (
      Option.isNone(auth) ||
      Option.isNone(sessions) ||
      Option.isNone(repository) ||
      Option.isNone(people)
    ) {
      return Layer.empty;
    }
    const store = sessions.value;
    const renewal = makeSessionRenewal({
      sessions: store,
      repository: repository.value,
      people: people.value,
      sql: yield* SqlClient.SqlClient,
    });

    const route = HttpRouter.add(
      "POST",
      J5_SESSION_RENEW_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Upstream's own sign-in decides first: a live session has nothing to renew, and a
        // browser's cookie presented from another origin is refused as upstream refuses it.
        const signedIn = yield* auth.value.authenticateHttpRequest(request).pipe(
          Effect.map(() => "live" as const),
          Effect.catch((error) =>
            Effect.succeed(
              "diagnostic" in error && error.diagnostic === FOREIGN_ORIGIN_DIAGNOSTIC
                ? ("foreign" as const)
                : ("not-live" as const),
            ),
          ),
        );
        if (signedIn === "live") {
          return HttpServerResponse.jsonUnsafe(
            { renewed: false },
            { headers: CREDENTIAL_RESPONSE_HEADERS },
          );
        }
        if (signedIn === "foreign") {
          return refusal(403, "foreign_origin", FOREIGN_ORIGIN_DIAGNOSTIC);
        }
        const credential = EnvironmentAuth.selectRequestCredential(
          request,
          store.cookieName,
          store.legacyCookieName,
        );
        if (credential === undefined) {
          return refusal(401, "not_renewable", new NotRenewableError({}).message);
        }
        return yield* renewal.renewToken(credential.token).pipe(
          Effect.flatMap((issued) => {
            if (issued === "live") {
              return Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { renewed: false },
                  { headers: CREDENTIAL_RESPONSE_HEADERS },
                ),
              );
            }
            const body = {
              renewed: true,
              expiresAt: DateTime.formatIso(issued.expiresAt),
              ...(issued.method === "browser-session-cookie" ? {} : { token: issued.token }),
            };
            const response = HttpServerResponse.jsonUnsafe(body, {
              headers: CREDENTIAL_RESPONSE_HEADERS,
            });
            if (issued.method !== "browser-session-cookie") return Effect.succeed(response);
            return Effect.fromResult(
              Cookies.set(Cookies.empty, store.cookieName, issued.token, {
                expires: DateTime.toDate(issued.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.map((cookies) => HttpServerResponse.mergeCookies(response, cookies)));
          }),
          Effect.catchTags({
            NotRenewableError: (error) =>
              Effect.succeed(refusal(401, "not_renewable", error.message)),
          }),
          Effect.catch((cause) =>
            Effect.logError("J5 could not renew a device's session", { cause }).pipe(
              Effect.as(refusal(500, "renewal_failed", "The session could not be renewed.")),
            ),
          ),
        );
      }),
    );

    return route;
  }),
);
