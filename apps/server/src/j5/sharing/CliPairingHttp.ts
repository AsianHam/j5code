import { AuthAccessWriteScope } from "@t3tools/contracts";
import {
  CliPairingRequest,
  type CliPairingResponse,
  J5_CLI_PAIRING_PATH,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../../auth/http.ts";
import {
  authenticate,
  jsonError,
  readJsonBody,
  requestFailure,
  requireScope,
  respondableTags,
} from "../a2a/httpSupport.ts";
import { Access } from "./Access.ts";
import { CLI_SESSION_SUBJECT, pairingLinkForPerson } from "./cliPairing.ts";
import { PairingIntents } from "./PairingIntents.ts";
import { PersonAccess } from "./PersonAccess.ts";

const decodeRequest = Schema.decodeUnknownEffect(CliPairingRequest);

/** A refusal the CLI prints as it would print its own, by the refusal's tag. */
const refused = (error: { readonly _tag: string; readonly message: string }, extra = {}) =>
  Effect.succeed(jsonError(400, error._tag, error.message, extra));

const route = Effect.gen(function* () {
  yield* annotateEnvironmentRequest("j5.sharing.cliPairing");
  const session = yield* authenticate;
  yield* requireScope(session, AuthAccessWriteScope);
  if (session.subject !== CLI_SESSION_SUBJECT) {
    return jsonError(403, "cli_session_required", "Only the j5 CLI makes links here.");
  }
  const body = yield* readJsonBody;
  if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
  const decoded = yield* Effect.result(decodeRequest(body.success));
  if (Result.isFailure(decoded)) return requestFailure("The pairing flags are malformed.");
  const request = decoded.success;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* pairingLinkForPerson({
    flags: {
      person: Option.fromUndefinedOr(request.person),
      level: Option.fromUndefinedOr(request.level),
      project: Option.fromUndefinedOr(request.project),
      thread: Option.fromUndefinedOr(request.thread),
    },
    scopes: { scopes: request.scopes, given: request.scopesGiven },
    withoutPerson: request.withoutPerson,
    mint: (scopes) =>
      auth.createPairingLink({
        scopes,
        subject: "one-time-token",
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.ttlMs === undefined ? {} : { ttl: Duration.millis(request.ttlMs) }),
      }),
  }).pipe(
    Effect.map(({ link, said }) =>
      HttpServerResponse.jsonUnsafe({
        id: link.id,
        credential: link.credential,
        scopes: link.scopes,
        ...(link.label === undefined ? {} : { label: link.label }),
        createdAt: DateTime.formatIso(link.createdAt),
        expiresAt: DateTime.formatIso(link.expiresAt),
        said,
      } satisfies CliPairingResponse),
    ),
    Effect.catchTags({
      PairingPersonError: (error) => refused(error),
      PairingPersonUnknownError: (error) => refused(error, { personName: error.personName }),
      PersonNameError: (error) => refused(error),
      PersonNameTakenError: (error) => refused(error),
      OwnerOutsideServerError: (error) => refused(error),
      ScopeNotFoundError: (error) => refused(error),
    }),
    Effect.catch((cause) =>
      Effect.logError("J5 CLI pairing failed", { cause }).pipe(
        Effect.as(jsonError(500, "pairing_failed", "The server could not make the link.")),
      ),
    ),
  );
}).pipe(Effect.catchTags(respondableTags));

/**
 * Where the `j5` CLI makes a pairing link while a server runs for its home (`cliPairing.ts`), so
 * the person, their level and the link are written by the running server and reach open clients
 * as a change made in the app does. It answers only the CLI's own session: one with Manage
 * access, issued by a process that could already write the home's database, and revoked once
 * the command is done. A person's device, Owner or not, makes its changes from the People page.
 */
export const cliPairingHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    // The people services are wired only on a server where sharing is, read once here.
    const wired = Option.all({
      sql: yield* Effect.serviceOption(SqlClient.SqlClient),
      people: yield* Effect.serviceOption(PersonAccess),
      access: yield* Effect.serviceOption(Access),
      intents: yield* Effect.serviceOption(PairingIntents),
    });
    if (Option.isNone(wired)) return Layer.empty;
    const { sql, people, access, intents } = wired.value;
    return HttpRouter.add(
      "POST",
      J5_CLI_PAIRING_PATH,
      route.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(PersonAccess, people),
        Effect.provideService(Access, access),
        Effect.provideService(PairingIntents, intents),
      ),
    );
  }),
);
