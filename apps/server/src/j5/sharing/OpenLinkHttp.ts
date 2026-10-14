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

/** What someone joining is told when the name they typed is someone else's, or their own. */
export const OPEN_LINK_NAME_TAKEN =
  "That name is already in use on this server. If it is yours, open this link on the device you joined with, or ask for a link for this device.";

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
    /** The session a browser's cookie carries, when it carries one that works. */
    const sessionOf = (request: HttpServerRequest.HttpServerRequest) =>
      Option.isNone(auth)
        ? Effect.succeed(null)
        : auth.value.authenticateHttpRequest(request).pipe(Effect.orElseSucceed(() => null));

    /**
     * What a link opens, asked before pairing or joining so the page can say what the person is
     * about to do. It spends and changes nothing. A link that would not work now gets the join
     * route's one refusal, whatever is wrong with it. A member's browser gets the same answer as
     * anyone: it is refused at the next step, where it would pair or join. A guest's browser is
     * also told whom it can join as.
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
        const session = yield* sessionOf(request);
        return yield* openLinks.describe(decoded.value.link, session).pipe(
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
        // instead, and no one is recorded. A guest may join as themselves. Anyone else, signed
        // in or not, gives a name and goes on.
        const session = yield* sessionOf(request);
        if (session !== null && session.subject !== GUEST_SESSION_SUBJECT) {
          return refusal(409, "signed_in_as_member", MEMBER_OPENED_OPEN_LINK);
        }
        const decoded = yield* request.json.pipe(Effect.flatMap(decodeJoin), Effect.option);
        if (Option.isNone(decoded)) {
          return refusal(
            400,
            "invalid_request",
            "A link is needed, and any name given is one line of ordinary characters, up to 80 of them, with no square brackets.",
          );
        }
        const { token, displayName } = decoded.value;
        return yield* openLinks.join({ token, displayName, session }).pipe(
          Effect.map((joined) =>
            joined.kind === "new"
              ? HttpServerResponse.jsonUnsafe({
                  credential: joined.link.credential,
                  expiresAt: joined.link.expiresAt,
                })
              : // Already paired: the browser goes on to the thread it was just given.
                HttpServerResponse.jsonUnsafe({ threadId: joined.threadId }),
          ),
          Effect.catchTags({
            OpenLinkRefusedError: (error) =>
              Effect.succeed(refusal(404, "link_refused", error.message)),
            OpenLinkNameError: (error) =>
              Effect.succeed(refusal(400, "invalid_request", error.message)),
            // Told only to the holder of a link that works, who is about to be let in. A name is
            // no proof of who someone is, so a person on another device is not let in by theirs.
            PersonNameTakenError: () =>
              Effect.succeed(refusal(409, "name_taken", OPEN_LINK_NAME_TAKEN)),
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
