import {
  ARTIFACT_READ_PATH,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  J5_ARTIFACT_WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
  type WsRpcGroup,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import { J5_SHARING_WS_METHODS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { GuestPairing, MEMBER_OPENED_GUEST_LINK } from "./GuestPairing.ts";
import { issueGuestProjectIconUrl, projectIdOfGuestIconPath } from "./GuestProjectIcons.ts";
import { layer as openLinksLayer } from "./OpenLinks.ts";
import { layer as peopleLayer, sameTarget } from "./People.ts";
import {
  GUEST_SESSION_SUBJECT,
  type GrantLevel,
  type GrantTarget,
  type MessageAsset,
  PersonAccess,
  type PersonAccessStorageError,
  layer as personAccessLayer,
} from "./PersonAccess.ts";

/**
 * What a guest's connection may reach (Shared server AC12 to AC15). Both halves refuse by default:
 * a route or a request that is not named here is refused to a guest, so nothing upstream adds
 * later is open to one until it is listed. A member's connection is never slowed: the gate looks
 * at nothing but the session's subject.
 */

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * A request a guest may make. `thread`: for one thread, at the level named, with the thread read
 * from the payload. `project`: for one project the guest holds a grant on as a whole, read from
 * the payload; a grant on one of its threads does not count. `messageAsset`: for an attachment or a tool's image that a thread within the
 * guest's reach holds, by the server's own records. `ownGrant`: for one grant the guest holds
 * itself, on exactly the project or thread the payload names. `narrowed`: for anything, because its handler answers a guest through
 * `GuestView` or `PersonAccess`, with a reduced or filtered answer in place of upstream's.
 */
type GuestRpcRule =
  | {
      readonly kind: "thread";
      readonly level: GrantLevel;
      readonly threadId: (payload: unknown) => string | undefined;
    }
  | {
      readonly kind: "project";
      readonly level: GrantLevel;
      readonly projectId: (payload: unknown) => string | undefined;
    }
  | { readonly kind: "narrowed" }
  | { readonly kind: "ownGrant"; readonly target: (payload: unknown) => GrantTarget | undefined }
  | {
      readonly kind: "messageAsset";
      readonly asset: (payload: unknown) => MessageAsset | undefined;
      /** The project whose favicon the request asks for, when it asks for one by id. */
      readonly projectIcon: (payload: unknown) => ProjectId | undefined;
    };

const payloadThreadId = (payload: unknown) =>
  typeof payload === "object" &&
  payload !== null &&
  "threadId" in payload &&
  typeof payload.threadId === "string"
    ? payload.threadId
    : undefined;

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;

const payloadProjectId = (payload: unknown) => {
  const projectId = field(payload, "projectId");
  return typeof projectId === "string" && projectId.length > 0 ? projectId : undefined;
};

/**
 * The asset kinds a guest may ask a URL for: the two that are part of a conversation and that the
 * server can tie to a thread. Every kind keyed by a path or a folder (workspace, media and draft
 * files, project favicons, GitHub media) and native app icons are not named, so they are refused.
 */
const messageAssetOf = (payload: unknown): MessageAsset | undefined => {
  const resource = field(payload, "resource");
  const tag = field(resource, "_tag");
  const attachmentId = field(resource, "attachmentId");
  const threadId = field(resource, "threadId");
  const itemId = field(resource, "itemId");
  if (tag === "attachment" && typeof attachmentId === "string") {
    return { kind: "attachment", attachmentId };
  }
  if (tag === "tool-output-image" && typeof threadId === "string" && typeof itemId === "string") {
    return { kind: "tool-output-image", threadId: ThreadId.make(threadId), itemId };
  }
  return undefined;
};

/** The project or thread a request names as a grant's target, and nothing looser. */
const grantTargetOf = (payload: unknown): GrantTarget | undefined => {
  const target = field(payload, "target");
  const kind = field(target, "kind");
  const projectId = field(target, "projectId");
  const threadId = field(target, "threadId");
  if (kind === "project" && typeof projectId === "string" && projectId.length > 0) {
    return { kind: "project", projectId: ProjectId.make(projectId) };
  }
  if (kind === "thread" && typeof threadId === "string" && threadId.length > 0) {
    return { kind: "thread", threadId: ThreadId.make(threadId) };
  }
  return undefined;
};

/**
 * The project a favicon request names by id. Upstream's client keys the request by the project's
 * folder, which for a guest is a placeholder and is not read; the id rides where upstream carries
 * the path of a favicon override.
 */
const projectIconOf = (payload: unknown): ProjectId | undefined => {
  const resource = field(payload, "resource");
  return field(resource, "_tag") === "project-favicon"
    ? projectIdOfGuestIconPath(field(resource, "path"))
    : undefined;
};

const viewThread: GuestRpcRule = { kind: "thread", level: "view", threadId: payloadThreadId };
const viewProject: GuestRpcRule = { kind: "project", level: "view", projectId: payloadProjectId };
const narrowed: GuestRpcRule = { kind: "narrowed" };

/**
 * Every WebSocket request a guest may make. Keyed by method so that a method upstream renames or
 * removes fails to compile here. A method that is absent is refused.
 */
export const GUEST_RPC_RULES: Partial<Record<WsRpcMethod, GuestRpcRule>> = {
  [WS_METHODS.serverGetConfig]: narrowed,
  [WS_METHODS.subscribeServerConfig]: narrowed,
  [WS_METHODS.subscribeServerLifecycle]: narrowed,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: narrowed,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: viewThread,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: viewThread,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: viewThread,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: viewThread,
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: viewThread,
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: viewThread,
  // The images and files in a granted thread's messages (AC12); the URL it returns is signed for
  // that one asset and is the only thing `/api/assets` serves for it.
  // A project's favicon too, for a project in the guest's sidebar, named by its id; J5 answers
  // that one itself (`GuestProjectIcons.ts`), since upstream's answer names the host's folder.
  [WS_METHODS.assetsCreateUrl]: {
    kind: "messageAsset",
    asset: messageAssetOf,
    projectIcon: projectIconOf,
  },
  // A granted project's artifacts: listed, and told when they change (AC9). Reading one is an
  // HTTP route (`guestHttpRule`). Deleting one is not listed.
  [J5_ARTIFACT_WS_METHODS.listArtifacts]: viewProject,
  [J5_ARTIFACT_WS_METHODS.subscribeArtifactChanges]: viewProject,
  // A guest asking what it holds: answered for its own session, `none` for a thread out of reach.
  [J5_SHARING_WS_METHODS.getConnectionAccess]: narrowed,
  [J5_SHARING_WS_METHODS.subscribeThreadAccess]: narrowed,
  [J5_SHARING_WS_METHODS.listOwnGrants]: narrowed,
  // Who else is on a thread the guest was granted: their names and levels, no more.
  [J5_SHARING_WS_METHODS.listThreadPeople]: viewThread,
  [J5_SHARING_WS_METHODS.subscribeThreadPeopleChanges]: viewThread,
  // The one thing a guest may change: giving up a grant it holds itself (AC25).
  [J5_SHARING_WS_METHODS.leaveGrant]: { kind: "ownGrant", target: grantTargetOf },
};

/**
 * `open`: the route decides what a guest gets. `thread`: allowed when a grant covers the thread.
 * `projectInBody`: allowed when the guest holds a grant on the project the request's JSON body
 * names.
 */
export type GuestHttpRule =
  | { readonly kind: "open" }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "projectInBody" }
  | { readonly kind: "refuse" };

const THREAD_LOAD = /^\/api\/orchestration\/threads\/([^/]+)(?:\/(?:bounded|history))?$/;

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * Which HTTP routes keep a guest's permissions. `/ws` is the RPC socket, whose requests
 * `GUEST_RPC_RULES` decides one by one. The sidebar snapshot route is refused: a client that is
 * refused it reads the sidebar from the socket's feed, which `GuestView` filters, so there is one
 * filtered path and not two. A route that reads no permission at all, such as the one
 * that issues a WebSocket ticket for the caller's own session, is unaffected by the gate and is
 * not listed.
 */
export const guestHttpRule = (method: string, pathname: string): GuestHttpRule => {
  // Reading one artifact of a project (AC9): a POST that changes nothing.
  if (method === "POST" && pathname === ARTIFACT_READ_PATH) return { kind: "projectInBody" };
  if (method !== "GET") return { kind: "refuse" };
  if (pathname === "/ws") return { kind: "open" };
  const threadLoad = THREAD_LOAD.exec(pathname);
  const threadId = threadLoad?.[1] === undefined ? undefined : decodeSegment(threadLoad[1]);
  return threadId === undefined || threadId.length === 0
    ? { kind: "refuse" }
    : { kind: "thread", threadId: ThreadId.make(threadId) };
};

const reaches = (access: string, level: GrantLevel) =>
  access === "collaborate" || (level === "view" && access === "view");

const requestPathname = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://environment.invalid").pathname;

/**
 * Wraps upstream's `EnvironmentAuth`, through which every HTTP route and WebSocket upgrade signs a
 * request in, and through which every session is ended. A guest's session comes back with its permissions only on a route `guestHttpRule`
 * allows, for a thread route only when a grant covers that thread, and for an artifact read only
 * when a grant is on the project its body names; anywhere else it comes back with none, so the route's own permission check refuses it the way it refuses any connection
 * that lacks the permission. If the grant cannot be read, the guest gets none.
 */
export const layerGatedEnvironmentAuth = Layer.effect(
  EnvironmentAuth.EnvironmentAuth,
  Effect.gen(function* () {
    const inner = yield* EnvironmentAuth.EnvironmentAuth;
    const access = yield* PersonAccess;
    const pairing = yield* GuestPairing;
    // Upstream's own session store, to read whose browser is asking. A test that stands in for
    // upstream's auth has none, and then no browser is taken for a member's.
    const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);

    const gate = Effect.fn("j5.sharing.guestGate.http")(function* <
      S extends EnvironmentAuth.AuthenticatedSession,
    >(request: HttpServerRequest.HttpServerRequest, session: S) {
      if (session.subject !== GUEST_SESSION_SUBJECT) return session;
      const rule = guestHttpRule(request.method, requestPathname(request));
      if (rule.kind === "open") return session;
      if (rule.kind === "refuse") return { ...session, scopes: [] };
      // The body is read once and kept, so the route reads the same bytes this check did.
      const held =
        rule.kind === "thread"
          ? access.threadAccess(session, rule.threadId)
          : request.json.pipe(
              Effect.map(payloadProjectId),
              Effect.orElseSucceed(() => undefined),
              Effect.flatMap((projectId) =>
                projectId === undefined
                  ? Effect.succeed("none" as const)
                  : access.projectAccess(session, ProjectId.make(projectId)),
              ),
            );
      const allowed = yield* held.pipe(
        Effect.map((level) => reaches(level, "view")),
        Effect.catch((cause) =>
          Effect.logError("J5 guest gate could not read a grant; refusing", { cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      return allowed ? session : { ...session, scopes: [] };
    });

    /**
     * Before upstream ends a session, by any of its four ways, a guest's session is cut loose
     * from its guest. Upstream leaves a revoked session's open socket open, and this is what
     * empties it: from here its requests find no grants and its open feeds end. It costs a
     * member's session one delete by primary key that matches nothing; ending every other
     * session is one delete for all of them. If it cannot be done, nothing is revoked, so the
     * member sees the failure and the device is not left half ended.
     */
    const unbound = <A, E, R>(
      unbind: Effect.Effect<unknown, PersonAccessStorageError>,
      revoke: Effect.Effect<A, E, R>,
    ) =>
      unbind.pipe(
        Effect.mapError(
          (cause): EnvironmentAuth.ServerAuthInternalError =>
            new EnvironmentAuth.ServerAuthSessionRevocationError({ cause }),
        ),
        Effect.andThen(revoke),
      );

    /**
     * What to do about the session a browser already holds when it pairs again. Upstream replaces
     * that session with the new one, inside its session store and around the revoke methods
     * wrapped below, which matters twice over.
     *
     * A member's browser opening a guest's share link would turn the member into the guest, so it
     * is refused (`refuse`).
     *
     * A guest's browser is replaced as upstream has it, whatever link it opens. Once upstream
     * has paired it, the old session is cut loose from its guest (`replaced`). Otherwise the old
     * session is revoked and still recorded as the guest's, and a socket already open on it
     * would keep reading as a device no member can see. It is done after upstream succeeds and
     * not before, because upstream replaces the old session only then: a browser that tries a
     * link that does not work keeps its session, its grants and its place on the People page.
     *
     * The cheap things are read first: a browser with no session costs nothing. One with a
     * session costs a read of that session, and for a member's one read more of J5's record of
     * guest links. If a read fails, pairing goes on as upstream has it.
     */
    const previousSession = Effect.fn("j5.sharing.guestGate.previousSession")(
      function* (credential: string, previousSessionToken: string | undefined) {
        const pair = { decision: "pair" as const, replaced: undefined };
        if (previousSessionToken === undefined || Option.isNone(sessions)) return pair;
        // A session that has expired or been revoked is no one's.
        const previous = yield* Effect.option(sessions.value.verify(previousSessionToken));
        if (Option.isNone(previous)) return pair;
        if (previous.value.subject === GUEST_SESSION_SUBJECT) {
          // Upstream replaces a browser's cookie session, and no other kind.
          return previous.value.method === "browser-session-cookie"
            ? { decision: "pair" as const, replaced: previous.value.sessionId }
            : pair;
        }
        return (yield* pairing.isGuestLink(credential))
          ? { decision: "refuse" as const, replaced: undefined }
          : pair;
      },
      Effect.catch((cause) =>
        Effect.logError(
          "J5 guest gate could not read a browser's session; pairing as upstream does",
          { cause },
        ).pipe(Effect.as({ decision: "pair" as const, replaced: undefined })),
      ),
    );

    return EnvironmentAuth.EnvironmentAuth.of({
      ...inner,
      createBrowserSession: (credential, requestMetadata, previousSessionToken) =>
        previousSession(credential, previousSessionToken).pipe(
          Effect.flatMap(({ decision, replaced }) =>
            decision === "refuse"
              ? // Refused before upstream is called, so the link is not used up.
                Effect.fail(
                  new EnvironmentAuth.ServerAuthInvalidCredentialError({
                    diagnostic: MEMBER_OPENED_GUEST_LINK,
                  }),
                )
              : inner.createBrowserSession(credential, requestMetadata, previousSessionToken).pipe(
                  Effect.tap(() =>
                    replaced === undefined
                      ? Effect.void
                      : access.unbindSession(replaced).pipe(
                          // The browser is paired; the old session is revoked upstream either
                          // way. This is logged so a session left recorded can be found.
                          Effect.catch((cause) =>
                            Effect.logError(
                              "J5 guest gate could not cut a replaced session loose",
                              {
                                cause,
                              },
                            ),
                          ),
                        ),
                  ),
                ),
          ),
        ),
      revokeSession: (sessionId) =>
        unbound(access.unbindSession(sessionId), inner.revokeSession(sessionId)),
      revokeOtherSessionsExcept: (sessionId) =>
        unbound(access.unbindOtherSessions(sessionId), inner.revokeOtherSessionsExcept(sessionId)),
      revokeClientSession: (currentSessionId, targetSessionId) =>
        currentSessionId === targetSessionId
          ? inner.revokeClientSession(currentSessionId, targetSessionId)
          : unbound(
              access.unbindSession(targetSessionId),
              inner.revokeClientSession(currentSessionId, targetSessionId),
            ),
      revokeOtherClientSessions: (currentSessionId) =>
        unbound(
          access.unbindOtherSessions(currentSessionId),
          inner.revokeOtherClientSessions(currentSessionId),
        ),
      authenticateHttpRequest: (request) =>
        inner.authenticateHttpRequest(request).pipe(Effect.flatMap((s) => gate(request, s))),
      authenticateWebSocketUpgrade: (request) =>
        inner.authenticateWebSocketUpgrade(request).pipe(Effect.flatMap((s) => gate(request, s))),
    });
  }),
);

/**
 * Upstream's auth layer with the guest gate in front of it, and beside it the two services that
 * say who is a guest and manage them. `upstream` must also give `GuestPairing`, the same layer
 * upstream's pairing code was built over, and the database.
 */
export const gateEnvironmentAuth = <A, E, R>(
  upstream: Layer.Layer<A | EnvironmentAuth.EnvironmentAuth, E, R>,
) =>
  openLinksLayer.pipe(
    Layer.provideMerge(peopleLayer),
    Layer.provideMerge(layerGatedEnvironmentAuth),
    Layer.provideMerge(personAccessLayer),
    Layer.provideMerge(upstream),
  );

const notSharedError = () =>
  new EnvironmentAuthorizationError({
    message: "This is not shared with you on this server.",
    ...authScopeRequiredResponse(AuthOrchestrationReadScope),
  });

/**
 * The per-connection RPC authorization for `ws.ts`. For a member's session it is upstream's own
 * layer, untouched. For a guest's it runs first: a request must be in `GUEST_RPC_RULES`, and
 * unless its answer is narrowed for a guest it must name a thread the guest's grants cover, or a
 * project the guest holds a grant on, at the rule's level. Only then does upstream's permission check run, and the request is ended if the
 * grants stop covering it while it is still running.
 */
export const layerRpcAuthorization = (
  session: Pick<EnvironmentAuth.AuthenticatedSession, "sessionId" | "subject">,
  upstream: Layer.Layer<RpcScopeAuthorization>,
): Layer.Layer<RpcScopeAuthorization, never, PersonAccess> =>
  session.subject !== GUEST_SESSION_SUBJECT
    ? upstream
    : Layer.effect(
        RpcScopeAuthorization,
        Effect.gen(function* () {
          const access = yield* PersonAccess;
          const inner = yield* RpcScopeAuthorization;
          const refuseUnreadable = (cause: unknown) =>
            Effect.logError("J5 guest gate could not read a grant; refusing", { cause }).pipe(
              Effect.as(false),
            );
          /** Whether the guest still holds what a `thread` or `project` rule asks for. */
          const reachesNamed = (
            rule: Extract<GuestRpcRule, { readonly kind: "thread" | "project" }>,
            named: string,
          ) =>
            (rule.kind === "thread"
              ? access.threadAccess(session, ThreadId.make(named))
              : access.projectAccess(session, ProjectId.make(named))
            ).pipe(
              Effect.map((held) => reaches(held, rule.level)),
              Effect.catch(refuseUnreadable),
            );
          return RpcScopeAuthorization.of((effect, options) => {
            const rule = GUEST_RPC_RULES[options.rpc._tag as WsRpcMethod];
            if (rule?.kind === "narrowed") return inner(effect, options);
            if (rule?.kind === "messageAsset") {
              const projectId = rule.projectIcon(options.payload);
              if (projectId !== undefined) {
                // Upstream's handler is not run: its answer would carry the project's folder.
                // J5's own answer goes through upstream's permission check in its place.
                const answer = access.projectInFeed(session, projectId).pipe(
                  Effect.catch(refuseUnreadable),
                  Effect.flatMap((inFeed) =>
                    inFeed ? issueGuestProjectIconUrl(projectId) : Effect.succeed(null),
                  ),
                  Effect.flatMap((link) =>
                    link === null ? Effect.fail(notSharedError()) : Effect.succeed(link),
                  ),
                );
                return inner(answer as unknown as typeof effect, options);
              }
              const asset = rule.asset(options.payload);
              if (asset === undefined) return Effect.fail(notSharedError());
              return access.messageAssetAccess(session, asset).pipe(
                Effect.map((held) => reaches(held, "view")),
                Effect.catch(refuseUnreadable),
                Effect.flatMap((allowed) =>
                  allowed ? inner(effect, options) : Effect.fail(notSharedError()),
                ),
              );
            }
            if (rule === undefined) return Effect.fail(notSharedError());
            if (rule.kind === "ownGrant") {
              const target = rule.target(options.payload);
              if (target === undefined) return Effect.fail(notSharedError());
              return access.sessionPerson(session).pipe(
                Effect.flatMap((person) =>
                  person === null || person.personId === null
                    ? Effect.succeed([])
                    : access.listGrants(person.personId),
                ),
                Effect.map((held) => held.some((grant) => sameTarget(grant.target, target))),
                Effect.catch(refuseUnreadable),
                Effect.flatMap((allowed) =>
                  allowed ? inner(effect, options) : Effect.fail(notSharedError()),
                ),
              );
            }
            const named =
              rule.kind === "thread"
                ? rule.threadId(options.payload)
                : rule.projectId(options.payload);
            if (named === undefined) return Effect.fail(notSharedError());
            return Effect.gen(function* () {
              // Subscribed before the first check, so no change between the two is missed.
              const grantChanges = yield* access.subscribeGrantChanges;
              if (!(yield* reachesNamed(rule, named))) return yield* notSharedError();
              // `effect` runs a streaming request to its end, so a feed opened while the grant
              // held would outlive it. It ends, refused as a new request would be, on the first
              // change to anyone's grants that leaves it out of reach (AC10, AC11).
              const lostAccess = Stream.fromSubscription(grantChanges).pipe(
                Stream.mapEffect(() => reachesNamed(rule, named)),
                Stream.filter((stillReaches) => !stillReaches),
                Stream.runHead,
                Effect.andThen(Effect.fail(notSharedError())),
              );
              return yield* Effect.raceFirst(inner(effect, options), lostAccess);
            });
          });
        }),
      ).pipe(Layer.provide(upstream));
