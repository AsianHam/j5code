import {
  J5_LINK_DESCRIBE_PATH,
  J5_LINK_JOIN_PATH,
  JoinLinkRequest,
  LinkTokenRequest,
} from "@t3tools/contracts/j5";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { issueGuestProjectIconUrl } from "./GuestProjectIcons.ts";
import { Links } from "./Links.ts";
import { PAIRED_AS_SOMEONE_ELSE_REFUSAL } from "./PairingIntents.ts";

/** What someone joining is told when the name they typed is someone else's (AC42, AC44). */
export const LINK_NAME_TAKEN =
  "Someone on this server already has that name. If it is yours, open the link on the device you paired before, or ask for a link for this device.";

const decodeDescribe = Schema.decodeUnknownEffect(LinkTokenRequest);
const decodeJoin = Schema.decodeUnknownEffect(JoinLinkRequest);

const refusal = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error, message }, { status });

/**
 * Where someone who opens a link is told what it opens, and joins (People and access AC31 to
 * AC43). Neither takes a sign-in, as upstream's pairing does not: the link's token, sent in the
 * body, is all they trust. A browser's cookie is read only to tell what it already is here, which
 * decides whether it may join (AC32, AC33, AC43). Every link that does not work is answered alike.
 * The routes exist only on a server where sharing is wired in, read once when they are built.
 */
export const linkHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const wired = yield* Effect.serviceOption(Links);
    if (Option.isNone(wired)) return Layer.empty;
    const links = wired.value;
    const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    /** The session a browser's cookie carries, when it carries one that works. */
    const sessionOf = (request: HttpServerRequest.HttpServerRequest) =>
      Option.isNone(auth)
        ? Effect.succeed(null)
        : auth.value.authenticateHttpRequest(request).pipe(Effect.orElseSucceed(() => null));

    const describeRoute = HttpRouter.add(
      "POST",
      J5_LINK_DESCRIBE_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const decoded = yield* request.json.pipe(Effect.flatMap(decodeDescribe), Effect.option);
        if (Option.isNone(decoded)) return refusal(400, "invalid_request", "A link is needed.");
        // The name upstream's public descriptor already gives anyone who can reach the server.
        const serverName = Option.isNone(environment)
          ? ""
          : (yield* environment.value.getDescriptor).label;
        const session = yield* sessionOf(request);
        return yield* links.describe(decoded.value.token, session).pipe(
          Effect.flatMap(({ description, faviconProject }) =>
            // The favicon link is the one a narrowed person's own client is given once paired
            // (`GuestProjectIcons.ts`): the holder of a link that works could pair and have it.
            (faviconProject === null
              ? Effect.succeed(null)
              : issueGuestProjectIconUrl(faviconProject).pipe(
                  Effect.map((link) =>
                    link === null ||
                    link.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)
                      ? null
                      : link.relativeUrl,
                  ),
                )
            ).pipe(
              Effect.map((projectFaviconUrl) =>
                HttpServerResponse.jsonUnsafe({
                  ...description,
                  opens:
                    description.opens.kind === "server"
                      ? description.opens
                      : { ...description.opens, projectFaviconUrl },
                  serverName,
                }),
              ),
            ),
          ),
          Effect.catchTags({
            LinkRefusedError: (error) =>
              Effect.succeed(refusal(404, "link_refused", error.message)),
          }),
          Effect.catch((cause) =>
            Effect.logError("J5 link describe failed", { cause }).pipe(
              Effect.as(refusal(500, "describe_failed", "The link could not be read. Try again.")),
            ),
          ),
        );
      }),
    );

    const joinRoute = HttpRouter.add(
      "POST",
      J5_LINK_JOIN_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const decoded = yield* request.json.pipe(Effect.flatMap(decodeJoin), Effect.option);
        if (Option.isNone(decoded)) {
          return refusal(
            400,
            "invalid_request",
            "A link is needed, and any name given is one line of visible characters, up to 80 of them, with no square or angle brackets.",
          );
        }
        const session = yield* sessionOf(request);
        return yield* links
          .join({ token: decoded.value.token, name: decoded.value.name, session })
          .pipe(
            Effect.map((outcome) => HttpServerResponse.jsonUnsafe(outcome)),
            Effect.catchTags({
              LinkRefusedError: (error) =>
                Effect.succeed(refusal(404, "link_refused", error.message)),
              LinkForSomeoneElseError: (error) =>
                Effect.succeed(refusal(409, PAIRED_AS_SOMEONE_ELSE_REFUSAL, error.message)),
              LinkAlreadyYoursError: (error) =>
                Effect.succeed(refusal(409, "already_yours", error.message)),
              LinkNameNeededError: (error) =>
                Effect.succeed(refusal(400, "invalid_request", error.message)),
              PersonNameError: (error) =>
                Effect.succeed(refusal(400, "invalid_request", error.message)),
              // Told only to the holder of a link that works, who is about to be let in. A name
              // is no proof of who someone is, so a person on another device is not let in by it.
              PersonNameTakenError: () =>
                Effect.succeed(refusal(409, "name_taken", LINK_NAME_TAKEN)),
            }),
            Effect.catch((cause) =>
              Effect.logError("J5 link join failed", { cause }).pipe(
                Effect.as(refusal(500, "join_failed", "Joining failed. Try again.")),
              ),
            ),
          );
      }),
    );

    return Layer.mergeAll(describeRoute, joinRoute);
  }),
);
