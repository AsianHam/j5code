import {
  SHARING_DESCRIBE_PATH,
  SHARING_JOIN_PATH,
  SharingDescribeRequest,
  SharingJoinRequest,
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
import { OpenLinks } from "./OpenLinks.ts";
import { GUEST_SESSION_SUBJECT } from "./PersonAccess.ts";

/** What a member is told on opening an open link in a browser where they are signed in. */
export const MEMBER_OPENED_OPEN_LINK =
  "You are already signed in to this server as a member. This link is for guests: send it to them rather than opening it.";

const decodeJoin = Schema.decodeUnknownEffect(SharingJoinRequest);
const decodeDescribe = Schema.decodeUnknownEffect(SharingDescribeRequest);

const refusal = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error, message }, { status });

/**
 * Where a person who opens an open link joins (#541). It takes no sign-in, as upstream's pairing
 * does not: the link's token is the only thing it trusts. It answers with a single-use pairing
 * credential for the guest it just recorded, which the client pairs with as it does any share
 * link. Every refusal of a link reads the same, whatever is wrong with it. The route exists only on a server where sharing
 * is wired in, which is read once when the routes are built. A browser signed in as a member is
 * told the link is not for them.
 */
export const openLinkHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const wired = yield* Effect.serviceOption(OpenLinks);
    if (Option.isNone(wired)) return Layer.empty;
    const openLinks = wired.value;
    const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);

    /**
     * What a link opens, asked before pairing or joining so the page can say what the person is
     * about to do. It spends and changes nothing. A link that would not work now gets the join
     * route's one refusal, whatever is wrong with it. A member's browser gets the same answer as
     * anyone: it is refused at the next step, where it would pair or join.
     */
    const describeRoute = HttpRouter.add(
      "POST",
      SHARING_DESCRIBE_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const decoded = yield* request.json.pipe(Effect.flatMap(decodeDescribe), Effect.option);
        if (Option.isNone(decoded)) return refusal(400, "invalid_request", "A link is needed.");
        // The name upstream's public descriptor already gives anyone who can reach the server.
        const serverName = Option.isNone(environment)
          ? ""
          : (yield* environment.value.getDescriptor).label;
        return yield* openLinks.describe(decoded.value.link).pipe(
          Effect.flatMap((described) =>
            // Each entry by its titles and icon; its project's id stays here. The favicon link
            // is the one a guest's own client is given once paired (`GuestProjectIcons.ts`):
            // the holder of a link that works could pair and be given it anyway.
            Effect.forEach(described.opens, ({ projectId, ...entry }) =>
              // A chosen icon is what a client draws; a favicon is asked for only without one.
              projectId === null || entry.projectIcon !== null
                ? Effect.succeed(entry)
                : issueGuestProjectIconUrl(projectId).pipe(
                    Effect.map((link) => ({
                      ...entry,
                      projectFaviconUrl:
                        link === null ||
                        link.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)
                          ? null
                          : link.relativeUrl,
                    })),
                  ),
            ).pipe(
              Effect.map((opens) =>
                HttpServerResponse.jsonUnsafe({ ...described, opens, serverName }),
              ),
            ),
          ),
          Effect.catchTags({
            OpenLinkRefusedError: (error) =>
              Effect.succeed(refusal(404, "link_refused", error.message)),
          }),
          Effect.catch((cause) =>
            Effect.logError("J5 share link describe failed", { cause }).pipe(
              Effect.as(refusal(500, "describe_failed", "The link could not be read. Try again.")),
            ),
          ),
        );
      }),
    );

    const joinRoute = HttpRouter.add(
      "POST",
      SHARING_JOIN_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The route asks for no sign-in, but a browser sends its cookie. A member who opens the
        // link would be recorded as a new guest and then paired as one, so they are told
        // instead, and no one is recorded. Anyone else, signed in or not, goes on.
        const member = Option.isNone(auth)
          ? false
          : yield* auth.value.authenticateHttpRequest(request).pipe(
              Effect.map((session) => session.subject !== GUEST_SESSION_SUBJECT),
              Effect.orElseSucceed(() => false),
            );
        if (member) return refusal(409, "signed_in_as_member", MEMBER_OPENED_OPEN_LINK);
        const decoded = yield* request.json.pipe(Effect.flatMap(decodeJoin), Effect.option);
        if (Option.isNone(decoded)) {
          return refusal(
            400,
            "invalid_request",
            "A link is needed, and a name: one line of ordinary characters, up to 80 of them, with no square brackets.",
          );
        }
        return yield* openLinks.join(decoded.value).pipe(
          Effect.map((link) =>
            HttpServerResponse.jsonUnsafe({
              credential: link.credential,
              expiresAt: link.expiresAt,
            }),
          ),
          Effect.catchTags({
            OpenLinkRefusedError: (error) =>
              Effect.succeed(refusal(404, "link_refused", error.message)),
            OpenLinkNameError: (error) =>
              Effect.succeed(refusal(400, "invalid_request", error.message)),
            // Told only to the holder of a link that works, who is about to be let in.
            PersonNameTakenError: (error) =>
              Effect.succeed(refusal(409, "name_taken", error.message)),
          }),
          Effect.catch((cause) =>
            Effect.logError("J5 open link join failed", { cause }).pipe(
              Effect.as(refusal(500, "join_failed", "Joining failed. Try again.")),
            ),
          ),
        );
      }),
    );

    return Layer.mergeAll(describeRoute, joinRoute);
  }),
);
