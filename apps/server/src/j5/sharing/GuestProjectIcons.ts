// @effect-diagnostics nodeBuiltinImport:off - names a link's file without the favicon's own name.
import * as NodeCrypto from "node:crypto";

import { type AssetCreateUrlResult, ProjectId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "../../assets/AssetAccess.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../../auth/utils.ts";
import { assetFileResponse } from "../../http.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";

/**
 * A project's favicon for a guest (Shared server, Jackson 2026-10-12: "have J5 serve the
 * favicon"). Upstream's client asks for a favicon by the project's folder on the host, and the
 * link upstream signs for it carries that folder in readable base64, so a guest can be given
 * neither. Here the project is named by its id from end to end:
 *
 * - a guest's reduced project carries `guestIconPath(projectId)` where upstream's has the path of
 *   a favicon override, which upstream's client sends back as the request's `path`;
 * - the guest gate answers that request itself with a link to J5's own route, signed by J5,
 *   naming the project id and an expiry and nothing else;
 * - the route finds the project by id and serves what upstream's own favicon resolution and
 *   asset serving give for it, with upstream's response headers.
 *
 * Nothing here is a service: it runs in whichever fiber calls it, on the services upstream's own
 * asset request and asset route already run on there.
 */

/** Where a guest's client fetches a project's favicon. The link carries its own proof. */
export const GUEST_PROJECT_ICON_ROUTE_PREFIX = "/api/j5/sharing/project-icon";

const SIGNING_SECRET_NAME = "j5-guest-project-icon-signing-key";
const ICON_PATH_PREFIX = "j5-shared-project/";
const ICON_PATH_SUFFIX = ".png";

/**
 * What a guest's reduced project carries as its favicon path: the project's id, in the shape of
 * a relative image path so that upstream's client and its `ProjectFaviconPath` check take it. It
 * is no path on the host, and it differs per project, which also keeps upstream's client from
 * caching every guest project's icon under one key.
 */
export const guestIconPath = (projectId: ProjectId) =>
  `${ICON_PATH_PREFIX}${encodeURIComponent(projectId)}${ICON_PATH_SUFFIX}`;

/** The project a `guestIconPath` names; nothing for any other path. */
export const projectIdOfGuestIconPath = (path: unknown): ProjectId | undefined => {
  if (
    typeof path !== "string" ||
    !path.startsWith(ICON_PATH_PREFIX) ||
    !path.endsWith(ICON_PATH_SUFFIX)
  ) {
    return undefined;
  }
  const encoded = path.slice(ICON_PATH_PREFIX.length, -ICON_PATH_SUFFIX.length);
  try {
    const projectId = decodeURIComponent(encoded);
    return projectId.length === 0 || projectId !== projectId.trim()
      ? undefined
      : ProjectId.make(projectId);
  } catch {
    return undefined;
  }
};

const IconClaims = Schema.Struct({
  version: Schema.Literal(1),
  projectId: Schema.String,
  expiresAt: Schema.Number,
});
const IconClaimsJson = Schema.fromJsonString(IconClaims);
const encodeClaims = Schema.encodeSync(IconClaimsJson);
const decodeClaims = Schema.decodeUnknownOption(IconClaimsJson);

/**
 * Runs an effect on the services already in the calling fiber. Upstream's asset code names a
 * dozen of them; they are there wherever upstream's own asset request and route run, which is
 * where this is called from. If one is missing the effect dies, and the callers below turn any
 * failure into "no icon".
 */
const onAmbientServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
  Effect.flatMap(Effect.context<never>(), (context) =>
    Effect.provideContext(effect, context as Context.Context<R>),
  );

const signingSecret = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return yield* secrets.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

/**
 * Upstream's own answer for a project's favicon, asked the way upstream's request handler asks
 * it, with the project found by id. `null` when there is no such project.
 */
const upstreamFavicon = Effect.fn("j5.sharing.guestProjectIcons.upstreamFavicon")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
  const project = yield* projects.get(projectId);
  if (Option.isNone(project)) return null;
  const clone = yield* clones.get(projectId);
  return yield* issueAssetUrl({
    resource: { _tag: "project-favicon", cwd: project.value.workspaceRoot },
    ...(project.value.faviconPath ? { projectFaviconPath: project.value.faviconPath } : {}),
    projectCheckoutPending:
      clone !== null &&
      clone.phase !== "done" &&
      clone.destinationPath === project.value.workspaceRoot,
  });
});

const lastSegment = (relativeUrl: string) => relativeUrl.slice(relativeUrl.lastIndexOf("/") + 1);

/**
 * The answer to a guest's request for a project's favicon: a link to J5's route. Its last
 * segment is upstream's own "no favicon" marker when the project has none, which upstream's
 * client reads as "draw the default icon" and never fetches. Otherwise it is a name made from
 * the project and the favicon's revision, so the client's cache follows the file when it changes,
 * and it keeps the file's extension and none of its name.
 */
export const issueGuestProjectIconUrl = (
  projectId: ProjectId,
): Effect.Effect<AssetCreateUrlResult | null> =>
  onAmbientServices(
    Effect.gen(function* () {
      const upstream = yield* upstreamFavicon(projectId);
      if (upstream === null) return null;
      const upstreamName = lastSegment(upstream.relativeUrl);
      const extension = /\.[a-z0-9]{2,5}$/i.exec(upstreamName)?.[0].toLowerCase() ?? "";
      const name =
        upstreamName === PROJECT_FAVICON_FALLBACK_MARKER
          ? PROJECT_FAVICON_FALLBACK_MARKER
          : `icon-${NodeCrypto.createHash("sha256")
              .update(`${projectId}\n${upstreamName}`)
              .digest("hex")
              .slice(0, 32)}${extension}`;
      const expiresAt = (yield* Clock.currentTimeMillis) + GUEST_PROJECT_ICON_TTL_MS;
      const payload = base64UrlEncode(encodeClaims({ version: 1, projectId, expiresAt }));
      const token = `${payload}.${signPayload(payload, yield* signingSecret)}`;
      return {
        relativeUrl: `${GUEST_PROJECT_ICON_ROUTE_PREFIX}/${token}/${name}`,
        expiresAt,
      } satisfies AssetCreateUrlResult;
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("J5 could not make a guest's project icon link", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

/** How long a guest's icon link works for, as long as upstream's own asset links. */
export const GUEST_PROJECT_ICON_TTL_MS = 60 * 60 * 1000;

/** The project a link's token was signed for, while it is in date; nothing for any other token. */
const projectOfToken = Effect.fn("j5.sharing.guestProjectIcons.projectOfToken")(function* (
  token: string,
) {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return undefined;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, yield* signingSecret))) {
    return undefined;
  }
  const claims = yield* Effect.try(() => decodeClaims(base64UrlDecodeUtf8(payload))).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(claims) || claims.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
    return undefined;
  }
  return ProjectId.make(claims.value.projectId);
});

const notFound = HttpServerResponse.text("Not Found", {
  status: 404,
  headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
});

/**
 * Serves a project's favicon to whoever holds a link J5 signed for that project. It takes no
 * sign-in, as upstream's asset route takes none: an `<img>` cannot send one. The link names the
 * project only, so it resolves that project's favicon and nothing else, whatever path follows
 * it. The file is found and served by upstream's own code: its favicon resolution, its check
 * that the file is inside the project, and its response headers (no sniffing, SVG sandboxed).
 */
export const guestProjectIconRouteLayer = HttpRouter.add(
  "GET",
  `${GUEST_PROJECT_ICON_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = new URL(request.url, "http://environment.invalid").pathname;
    const token = pathname.slice(`${GUEST_PROJECT_ICON_ROUTE_PREFIX}/`.length).split("/")[0] ?? "";
    return yield* onAmbientServices(
      Effect.gen(function* () {
        const projectId = yield* projectOfToken(token);
        if (projectId === undefined) return notFound;
        const upstream = yield* upstreamFavicon(projectId);
        if (upstream === null) return notFound;
        // Upstream's link is `<prefix>/<token>/<file name>`; it is read here and never sent on.
        const [upstreamToken, ...upstreamPath] = upstream.relativeUrl
          .slice(`${ASSET_ROUTE_PREFIX}/`.length)
          .split("/");
        const asset = yield* resolveAsset(upstreamToken ?? "", upstreamPath.join("/"));
        if (!asset || asset.kind !== "file") return notFound;
        return yield* assetFileResponse(asset);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("J5 could not serve a guest's project icon", { cause }).pipe(
          Effect.as(notFound),
        ),
      ),
    );
  }),
);
