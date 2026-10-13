import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
  type WsRpcGroup,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  GUEST_SESSION_SUBJECT,
  type GrantLevel,
  PersonAccess,
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
 * from the payload. `narrowed`: for anything, because its handler answers a guest through
 * `GuestView`, with a reduced or filtered answer in place of upstream's.
 */
type GuestRpcRule =
  | {
      readonly kind: "thread";
      readonly level: GrantLevel;
      readonly threadId: (payload: unknown) => string | undefined;
    }
  | { readonly kind: "narrowed" };

const payloadThreadId = (payload: unknown) =>
  typeof payload === "object" &&
  payload !== null &&
  "threadId" in payload &&
  typeof payload.threadId === "string"
    ? payload.threadId
    : undefined;

const viewThread: GuestRpcRule = { kind: "thread", level: "view", threadId: payloadThreadId };
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
};

/** `open`: the route decides what a guest gets. `thread`: allowed when a grant covers the thread. */
export type GuestHttpRule =
  | { readonly kind: "open" }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
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
 * `GUEST_RPC_RULES` decides one by one; the sidebar snapshot is filtered in its handler by
 * `GuestView`. A route that reads no permission at all, such as the one
 * that issues a WebSocket ticket for the caller's own session, is unaffected by the gate and is
 * not listed.
 */
export const guestHttpRule = (method: string, pathname: string): GuestHttpRule => {
  if (method !== "GET") return { kind: "refuse" };
  if (pathname === "/ws" || pathname === "/api/orchestration/shell") return { kind: "open" };
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
 * request in. A guest's session comes back with its permissions only on a route `guestHttpRule`
 * allows, and for a thread route only when a grant covers that thread; anywhere else it comes back
 * with none, so the route's own permission check refuses it the way it refuses any connection
 * that lacks the permission. If the grant cannot be read, the guest gets none.
 */
export const layerGatedEnvironmentAuth = Layer.effect(
  EnvironmentAuth.EnvironmentAuth,
  Effect.gen(function* () {
    const inner = yield* EnvironmentAuth.EnvironmentAuth;
    const access = yield* PersonAccess;

    const gate = Effect.fn("j5.sharing.guestGate.http")(function* <
      S extends EnvironmentAuth.AuthenticatedSession,
    >(request: HttpServerRequest.HttpServerRequest, session: S) {
      if (session.subject !== GUEST_SESSION_SUBJECT) return session;
      const rule = guestHttpRule(request.method, requestPathname(request));
      if (rule.kind === "open") return session;
      const allowed =
        rule.kind === "thread" &&
        (yield* access.threadAccess(session, rule.threadId).pipe(
          Effect.map((level) => reaches(level, "view")),
          Effect.catch((cause) =>
            Effect.logError("J5 guest gate could not read a grant; refusing", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        ));
      return allowed ? session : { ...session, scopes: [] };
    });

    return EnvironmentAuth.EnvironmentAuth.of({
      ...inner,
      authenticateHttpRequest: (request) =>
        inner.authenticateHttpRequest(request).pipe(Effect.flatMap((s) => gate(request, s))),
      authenticateWebSocketUpgrade: (request) =>
        inner.authenticateWebSocketUpgrade(request).pipe(Effect.flatMap((s) => gate(request, s))),
    });
  }),
);

/** Upstream's auth layer with the guest gate in front of it, and `PersonAccess` beside it. */
export const gateEnvironmentAuth = <A, E, R>(
  upstream: Layer.Layer<A | EnvironmentAuth.EnvironmentAuth, E, R>,
) =>
  layerGatedEnvironmentAuth.pipe(
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
 * unless its answer is narrowed for a guest it must name a thread the guest's grants cover at the
 * rule's level. Only then does upstream's permission check run, and the request is ended if the
 * grants stop covering the thread while it is still running.
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
          const reachesThread = (threadId: ThreadId, level: GrantLevel) =>
            access.threadAccess(session, threadId).pipe(
              Effect.map((held) => reaches(held, level)),
              Effect.catch((cause) =>
                Effect.logError("J5 guest gate could not read a grant; refusing", { cause }).pipe(
                  Effect.as(false),
                ),
              ),
            );
          return RpcScopeAuthorization.of((effect, options) => {
            const rule = GUEST_RPC_RULES[options.rpc._tag as WsRpcMethod];
            if (rule?.kind === "narrowed") return inner(effect, options);
            const named = rule?.threadId(options.payload);
            if (rule === undefined || named === undefined) return Effect.fail(notSharedError());
            const threadId = ThreadId.make(named);
            return Effect.gen(function* () {
              // Subscribed before the first check, so no change between the two is missed.
              const grantChanges = yield* access.subscribeGrantChanges;
              if (!(yield* reachesThread(threadId, rule.level))) return yield* notSharedError();
              // `effect` runs a streaming request to its end, so a feed opened while the grant
              // held would outlive it. It ends, refused as a new request would be, on the first
              // change to anyone's grants that leaves this thread out of reach (AC10, AC11).
              const lostAccess = Stream.fromSubscription(grantChanges).pipe(
                Stream.mapEffect(() => reachesThread(threadId, rule.level)),
                Stream.filter((stillReaches) => !stillReaches),
                Stream.runHead,
                Effect.andThen(Effect.fail(notSharedError())),
              );
              return yield* Effect.raceFirst(inner(effect, options), lostAccess);
            });
          });
        }),
      ).pipe(Layer.provide(upstream));
