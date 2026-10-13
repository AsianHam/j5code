import { AuthA2APeerScope, AuthAccessReadScope, AuthAccessWriteScope } from "@t3tools/contracts";
import {
  AddPeerRequest,
  IssuePeerCredentialRequest,
  J5_PEER_API_PATHS,
  PEER_PROTOCOL_VERSION,
  PeerDeliveryRequest,
  PeerPollRequest,
  RemovePeerRequest,
  environmentIdFromPeerSubject,
  type AddPeerResponse,
  type IssuePeerCredentialResponse,
  type PeerDeliveryResponse,
  type PeerHelloResponse,
  type PeerListResponse,
  type PeerPollResponse,
  type PeerRosterResponse,
  type RemovePeerResponse,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../../package.json" with { type: "json" };
import type * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { PeerAdminService, peerAdminRefusal } from "./PeerAdminService.ts";
import {
  A2APeerNotRecordedError,
  PeerInboundService,
  peerDeliveryRefusal,
} from "./PeerInboundService.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { PeerStoreService } from "./PeerStoreService.ts";
import { RosterService } from "./RosterService.ts";
import { toPeerRoster } from "./peerRoster.ts";
import {
  ownPeerCapabilities,
  peerProtocolHeaders,
  peerProtocolMismatch,
  statedPeerProtocol,
} from "./peerProtocol.ts";
import {
  authenticate,
  jsonError,
  readJsonBody,
  requestFailure,
  requireScope,
  respondableTags,
  tagOf,
} from "./httpSupport.ts";

/**
 * The peering HTTP surface. Another server reaches hello, roster, deliver and poll with its peer
 * credential. `j5 a2a peer` reaches the administrative routes (issue a credential, add, list,
 * remove) with the same `access:*` scopes as Settings → Connections, because a peer is one more
 * authorized session there; a client does the same acts over the WebSocket (`clientActionRpc.ts`),
 * and both call `PeerAdminService`.
 */

const decodeIssueRequest = Schema.decodeUnknownEffect(IssuePeerCredentialRequest);
const decodeAddRequest = Schema.decodeUnknownEffect(AddPeerRequest);
const decodeRemoveRequest = Schema.decodeUnknownEffect(RemovePeerRequest);
const decodeDeliveryRequest = Schema.decodeUnknownEffect(PeerDeliveryRequest);
const decodePollRequest = Schema.decodeUnknownEffect(PeerPollRequest);

/** A peer on another protocol is refused before its request is read; the caller sees why in the 409. */
const protocolRefusal = (peer: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
    const reason = peerProtocolMismatch({ stated: statedPeerProtocol(request.headers), peer });
    return reason === null ? null : jsonError(409, "peer_protocol_mismatch", reason);
  });

/** Every answer on a peer route states this server's protocol, so the caller checks it too. */
const statingPeerProtocol = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => route.pipe(Effect.map(HttpServerResponse.setHeaders(peerProtocolHeaders)));

/** A refused or failed administrative act, as the CLI reads it. */
const adminFailure = (operation: string, error: Parameters<typeof peerAdminRefusal>[0]) => {
  const refusal = peerAdminRefusal(error);
  const response = jsonError(refusal.status, refusal.code, refusal.message);
  return refusal.internal
    ? Effect.logError(`J5 A2A peer ${operation} failed`, { cause: error }).pipe(Effect.as(response))
    : Effect.succeed(response);
};

const isPeerNotRecorded = Schema.is(A2APeerNotRecordedError);

const deliveryFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  // Removed while the delivery was on its way: answered as any unrecorded peer is.
  if (isPeerNotRecorded(error)) {
    return Effect.succeed(jsonError(403, "peer_not_registered", error.message));
  }
  const refusal = peerDeliveryRefusal(error);
  if (refusal !== null) {
    return Effect.succeed(
      jsonError(
        refusal.status,
        refusal.code,
        refusal.message,
        refusal.reason === undefined ? {} : { reason: refusal.reason },
      ),
    );
  }
  return Effect.logError("J5 A2A peer delivery failed", { cause: error }).pipe(
    Effect.as(jsonError(500, tagOf(error), "Delivery failed.")),
  );
};

export const peerHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const peers = yield* PeerRegistryService;
    const admin = yield* PeerAdminService;
    const inbound = yield* PeerInboundService;
    const worker = yield* A2ADeliveryWorker;
    const roster = yield* RosterService;
    const store = yield* PeerStoreService;

    /** Whether the session's environment is a recorded peer, recording a store peer on its first proof. */
    const adoptingStorePeer = (
      session: EnvironmentAuth.AuthenticatedSession,
      environmentId: string,
    ) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          peers.adoptStorePeer({
            environmentId,
            sessionId: session.sessionId,
            at: DateTime.formatIso(now),
          }),
        ),
      );

    /** A credential alone is not enough: the environment it names must be a recorded peer. */
    const registeredPeerForSession = (session: EnvironmentAuth.AuthenticatedSession) =>
      Effect.gen(function* () {
        const environmentId = environmentIdFromPeerSubject(session.subject);
        if (environmentId === null) {
          return Result.fail(
            jsonError(
              403,
              "peer_subject_required",
              `This credential is not bound to a peer environment (subject "${session.subject}").`,
            ),
          );
        }
        const peer = yield* Effect.result(adoptingStorePeer(session, environmentId));
        if (Result.isFailure(peer)) {
          yield* Effect.logError("J5 A2A peer lookup failed", { cause: peer.failure });
          return Result.fail(jsonError(500, tagOf(peer.failure), "Peer lookup failed."));
        }
        return peer.success
          ? Result.succeed(environmentId)
          : Result.fail(
              jsonError(
                403,
                "peer_not_registered",
                `Environment ${environmentId} holds a credential but is not a recorded peer of this server. Record it with \`j5 a2a peer add\` here, or remove the stale credential in Settings → Connections.`,
              ),
            );
      });

    const helloRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.hello,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.hello");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const holder = environmentIdFromPeerSubject(session.subject);
        const refused = yield* protocolRefusal(`Peer ${holder ?? session.subject}`);
        if (refused !== null) return refused;
        // A poller's hello is the first proof of a store credential; it records the poller here.
        if (holder !== null) {
          yield* adoptingStorePeer(session, holder).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("J5 A2A peer hello could not record a polling peer", { cause }),
            ),
          );
        }
        const environmentId = yield* peers.selfEnvironmentId;
        const label = yield* peers.selfLabel;
        // The peer holds this credential, so any earlier one for it is done.
        yield* admin
          .completeRotation(session)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("J5 A2A peer hello could not rotate older sessions", { cause }),
            ),
          );
        return HttpServerResponse.jsonUnsafe({
          environmentId,
          subject: session.subject,
          credentialExpiresAt:
            session.expiresAt === undefined ? null : DateTime.formatIso(session.expiresAt),
          server: { version: packageJson.version },
          label,
          peerProtocolVersion: PEER_PROTOCOL_VERSION,
          capabilities: ownPeerCapabilities,
        } satisfies PeerHelloResponse);
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
    );

    const issueCredentialRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.credentials,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.issueCredential");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeIssueRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "environmentId (the peer that will hold the credential) is required.",
          );
        }
        const issued = yield* Effect.result(admin.issueCredential(decoded.success));
        if (Result.isFailure(issued)) {
          return yield* adminFailure("credential issuance", issued.failure);
        }
        return HttpServerResponse.jsonUnsafe(issued.success satisfies IssuePeerCredentialResponse, {
          status: 201,
        });
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const addRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.peers,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.add");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeAddRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "origin (an http(s) origin with no path) and the credential that server issued are required.",
          );
        }
        const added = yield* Effect.result(admin.add(decoded.success));
        if (Result.isFailure(added)) return yield* adminFailure("add", added.failure);
        return HttpServerResponse.jsonUnsafe(added.success satisfies AddPeerResponse, {
          status: added.success.created ? 201 : 200,
        });
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const listRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.peers,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.list");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessReadScope);
        const listed = yield* Effect.result(admin.list);
        if (Result.isFailure(listed)) {
          yield* Effect.logError("J5 A2A peer list failed", { cause: listed.failure });
          return jsonError(500, tagOf(listed.failure), "Listing peers failed.");
        }
        return HttpServerResponse.jsonUnsafe(listed.success satisfies PeerListResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const removeRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.remove,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.remove");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeRemoveRequest(body.success));
        if (Result.isFailure(decoded)) return requestFailure("environmentId is required.");
        const outcome = yield* Effect.result(admin.remove(decoded.success));
        if (Result.isFailure(outcome)) return yield* adminFailure("remove", outcome.failure);
        return HttpServerResponse.jsonUnsafe(outcome.success satisfies RemovePeerResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const deliverRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.deliver,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.deliver");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const origin = yield* registeredPeerForSession(session);
        if (Result.isFailure(origin)) return origin.failure;
        const refused = yield* protocolRefusal(`Peer ${origin.success}`);
        if (refused !== null) return refused;
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeDeliveryRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "messageId, senderId, receiverId, exchangeId, correlationId, exchangeRole, envelopeChannel, text, originProjectId, and createdAt are required.",
          );
        }
        const received = yield* Effect.result(
          inbound.receive({ ...decoded.success, originEnvironmentId: origin.success }),
        );
        if (Result.isFailure(received)) return yield* deliveryFailure(received.failure);
        yield* worker.notify;
        return HttpServerResponse.jsonUnsafe(
          {
            accepted: true,
            receivedSeq: received.success.receivedSeq,
            replay: received.success.replay,
          } satisfies PeerDeliveryResponse,
          { status: received.success.replay ? 200 : 201 },
        );
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
    );

    // A peer resolves receivers here, and sees only what it could address:
    // agents by project. People, machine participants and liveness stay home.
    const rosterRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.roster,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.roster");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const origin = yield* registeredPeerForSession(session);
        if (Result.isFailure(origin)) return origin.failure;
        const refused = yield* protocolRefusal(`Peer ${origin.success}`);
        if (refused !== null) return refused;
        const listed = yield* Effect.result(roster.list());
        if (Result.isFailure(listed)) {
          yield* Effect.logError("J5 A2A peer roster read failed", { cause: listed.failure });
          return jsonError(500, tagOf(listed.failure), "Roster read failed.");
        }
        return HttpServerResponse.jsonUnsafe({
          label: yield* peers.selfLabel,
          capabilities: ownPeerCapabilities,
          agents: toPeerRoster(listed.success),
        } satisfies PeerRosterResponse);
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
    );

    // A peer this server stores messages for asks for them here, acknowledging
    // what the last poll handed out; the request is held while nothing waits.
    const pollRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.poll,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.poll");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        // As at hello: a peer on another protocol is refused before anything is recorded for it.
        const refused = yield* protocolRefusal(
          `Peer ${environmentIdFromPeerSubject(session.subject) ?? session.subject}`,
        );
        if (refused !== null) return refused;
        const origin = yield* registeredPeerForSession(session);
        if (Result.isFailure(origin)) return origin.failure;
        const record = yield* Effect.result(peers.get(origin.success));
        if (Result.isFailure(record)) {
          yield* Effect.logError("J5 A2A peer lookup failed", { cause: record.failure });
          return jsonError(500, tagOf(record.failure), "Peer lookup failed.");
        }
        if (record.success?.linkMode !== "store") {
          return jsonError(
            409,
            "peer_not_polling",
            `Environment ${origin.success} is recorded here with link mode ${record.success?.linkMode ?? "none"}, so this server sends to it directly and stores nothing for it. To poll instead, remove the peer and peer again.`,
          );
        }
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodePollRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "acks and rosterHash are required; roster, label and capabilities are optional.",
          );
        }
        const started = yield* Effect.result(
          store.startPoll({
            environmentId: origin.success,
            request: decoded.success,
            // The protocol check passed, so the poller runs this server's version.
            protocolVersion: PEER_PROTOCOL_VERSION,
          }),
        );
        if (Result.isFailure(started)) {
          yield* Effect.logError("J5 A2A peer poll failed", { cause: started.failure });
          return jsonError(500, tagOf(started.failure), "The poll failed.");
        }
        // The status and headers go out now and only the body is held, so the
        // poller can tell a held poll cut on the way from one never answered.
        // Node sends headers with the first body bytes, so the body opens with
        // whitespace JSON ignores.
        const answer = started.success.pipe(
          Effect.map((polled) => JSON.stringify(polled satisfies PeerPollResponse)),
          Effect.tapCause((cause) => Effect.logError("J5 A2A peer poll failed", { cause })),
        );
        return HttpServerResponse.stream(
          Stream.concat(Stream.make(" "), Stream.fromEffect(answer)).pipe(Stream.encodeText),
          { contentType: "application/json" },
        );
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
    );

    return Layer.mergeAll(
      pollRoute,
      helloRoute,
      rosterRoute,
      issueCredentialRoute,
      addRoute,
      listRoute,
      removeRoute,
      deliverRoute,
    );
  }),
);
