import * as NodeOS from "node:os";

import { AuthA2APeerScope, type AuthSessionId } from "@t3tools/contracts";
import {
  peerSubjectForEnvironment,
  type AddPeerRequest,
  type AddPeerResponse,
  type IssuePeerCredentialRequest,
  type IssuePeerCredentialResponse,
  type PeerAddressesResponse,
  type PeerListResponse,
  type PeerLinkMode,
  type PeerProbeRequest,
  type PeerProbeResponse,
  type RemovePeerRequest,
  type RemovePeerResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../../config.ts";
import { type AddPeerError, PeerRegistryService } from "./PeerRegistryService.ts";
import { PeerRemovalService } from "./PeerRemovalService.ts";
import { peerAddressOrigins } from "./peerReachability.ts";

/**
 * A peer session outlives ordinary client sessions: nothing renews it, and a
 * silent thirty-day expiry would end peering with no one told. Ten years is
 * "until removed or rotated"; the expiry is recorded on the holder's peer
 * record and shown in Settings, so it is never a surprise.
 */
const PEER_SESSION_TTL = Duration.days(3650);

export class PeerCredentialForSelfError extends Schema.TaggedError<PeerCredentialForSelfError>()(
  "PeerCredentialForSelfError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is this server; a server cannot peer with itself.`;
  }
}

/** A pair's way of travelling changes only by removing the peer and peering again. */
export class PeerCredentialLinkModeError extends Schema.TaggedError<PeerCredentialLinkModeError>()(
  "PeerCredentialLinkModeError",
  { label: Schema.String, linkMode: Schema.String, store: Schema.Boolean },
) {
  override get message(): string {
    return `Peer ${this.label} is recorded here with link mode ${this.linkMode}, so this server ${this.store ? "sends to it directly" : "stores its messages until it polls"}. To change how messages travel, remove the peer and peer again.`;
  }
}

/** Something under an administrative act failed; the message names the act, the cause stays here. */
export class PeerAdminOperationError extends Schema.TaggedError<PeerAdminOperationError>()(
  "PeerAdminOperationError",
  { operation: Schema.Literals(["lookup", "issue", "remove"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.operation === "lookup"
      ? "Peer lookup failed."
      : this.operation === "issue"
        ? "Issuing the peer credential failed."
        : "Removing the peer failed.";
  }
}

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Error";

/**
 * How a failed administrative act is told to a caller, whichever transport carried it: the stable
 * code, the HTTP status the CLI's route answers with, and whether the failure is the server's own
 * (logged, and told in the act's general words).
 */
export const peerAdminRefusal = (
  error:
    | PeerCredentialForSelfError
    | PeerCredentialLinkModeError
    | PeerAdminOperationError
    | AddPeerError,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly internal: boolean;
} => {
  const refusal = (status: number, code: string) => ({
    status,
    code,
    message: error.message,
    internal: false,
  });
  switch (error._tag) {
    case "PeerCredentialForSelfError":
    case "PeerIsSelfError":
      return refusal(400, "peer_is_self");
    case "PeerCredentialLinkModeError":
    case "PeerLinkModeConflictError":
      return refusal(409, "peer_link_mode_conflict");
    case "PeerUnreachableError":
      return refusal(502, "peer_unreachable");
    case "PeerCredentialRejectedError":
      return refusal(502, "peer_credential_rejected");
    case "PeerCredentialMismatchError":
      return refusal(409, "peer_credential_mismatch");
    case "PeerOriginConflictError":
      return refusal(409, "peer_origin_conflict");
    case "PeerProtocolMismatchError":
      return refusal(409, "peer_protocol_mismatch");
    case "PeerPollUnsupportedError":
      return refusal(409, "peer_poll_unsupported");
    case "PeerAdminOperationError":
      return { status: 500, code: tagOf(error.cause), message: error.message, internal: true };
    default:
      return {
        status: 500,
        code: tagOf(error),
        message: "Adding the peer failed.",
        internal: true,
      };
  }
};

/**
 * Managing this server's peers: what Settings → Connections and `j5 a2a peer` do. A peer is one
 * more authorized session, so issuing, rotating and removing its credential live here with the
 * record of the peer itself.
 */
export class PeerAdminService extends Context.Service<
  PeerAdminService,
  {
    /**
     * Mint the credential the named environment presents when it delivers to this server. The old
     * one keeps working until the peer proves the new one at hello (`completeRotation`), so a
     * rotation that fails between issue and record leaves the peer connected.
     */
    readonly issueCredential: (
      input: IssuePeerCredentialRequest,
    ) => Effect.Effect<
      IssuePeerCredentialResponse,
      PeerCredentialForSelfError | PeerCredentialLinkModeError | PeerAdminOperationError
    >;
    /** Every peer this server has recorded, with the state of its link. */
    readonly list: Effect.Effect<
      PeerListResponse,
      Effect.Error<ReturnType<PeerRegistryService["Service"]["list"]>>
    >;
    /** Prove the credential at the origin, then record the peer. */
    readonly add: (input: AddPeerRequest) => Effect.Effect<AddPeerResponse, AddPeerError>;
    /**
     * End both directions: the session the peer held here first, so it cannot deliver or poll
     * during the wipe, then this server's record of it with everything still waiting on it.
     */
    readonly remove: (
      input: RemovePeerRequest,
    ) => Effect.Effect<RemovePeerResponse, PeerAdminOperationError>;
    /** Where this server thinks others might reach it, for the check before peering. */
    readonly addresses: Effect.Effect<PeerAddressesResponse>;
    /** Whether this server can reach another at an origin. Nothing is recorded. */
    readonly probe: (input: PeerProbeRequest) => Effect.Effect<PeerProbeResponse>;
    /** The peer holds this credential, so any earlier one for its subject is revoked. */
    readonly completeRotation: (session: {
      readonly subject: string;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<number, EnvironmentAuth.ServerAuthInternalError>;
  }
>()("t3/j5/a2a/PeerAdminService") {}

const make = Effect.gen(function* () {
  const peers = yield* PeerRegistryService;
  const removal = yield* PeerRemovalService;
  const config = yield* ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

  // Rotation and removal list sessions and then revoke; one permit keeps them
  // serial so concurrent calls cannot leave two live credentials or revoke a
  // credential that was just issued.
  const rotationPermit = yield* Semaphore.make(1);

  const revokeSessionsForSubject = (subject: string, keep: string | null) =>
    Effect.gen(function* () {
      const sessions = yield* serverAuth.listSessions();
      let revoked = 0;
      for (const session of sessions) {
        if (session.subject !== subject || session.sessionId === keep) continue;
        if (yield* serverAuth.revokeSession(session.sessionId)) revoked += 1;
      }
      return revoked;
    });

  const issueCredential: PeerAdminService["Service"]["issueCredential"] = Effect.fn(
    "j5.a2a.peerAdmin.issueCredential",
  )(function* (input) {
    const ourEnvironmentId = yield* peers.selfEnvironmentId;
    if (input.environmentId === ourEnvironmentId) {
      return yield* new PeerCredentialForSelfError({ environmentId: ourEnvironmentId });
    }
    const subject = peerSubjectForEnvironment(input.environmentId);
    const label = input.label?.trim() || input.environmentId;
    const store = input.store === true;
    const existing = yield* peers
      .get(input.environmentId)
      .pipe(
        Effect.mapError((cause) => new PeerAdminOperationError({ operation: "lookup", cause })),
      );
    if (existing !== null && (existing.linkMode === "store") !== store) {
      return yield* new PeerCredentialLinkModeError({
        label: existing.label,
        linkMode: existing.linkMode satisfies PeerLinkMode,
        store,
      });
    }
    const issuedAt = DateTime.formatIso(yield* DateTime.now);
    const issued = yield* rotationPermit
      .withPermit(
        serverAuth
          .issueSession({
            scopes: [AuthA2APeerScope],
            subject,
            label: `Peer: ${label}`,
            ttl: PEER_SESSION_TTL,
          })
          .pipe(
            // A store peer already recorded rotates as any peer does; only a new one needs the mark.
            Effect.tap((session) =>
              store && existing === null
                ? peers.grantStore({
                    environmentId: input.environmentId,
                    sessionId: session.sessionId,
                    issuedAt,
                  })
                : Effect.void,
            ),
          ),
      )
      .pipe(Effect.mapError((cause) => new PeerAdminOperationError({ operation: "issue", cause })));
    // A recorded peer whose session had gone now holds a live one, which the peer list shows.
    yield* peers.sessionChanged;
    return {
      environmentId: ourEnvironmentId,
      credential: issued.token,
      sessionId: issued.sessionId,
      subject,
      expiresAt: DateTime.formatIso(issued.expiresAt),
    };
  });

  return PeerAdminService.of({
    issueCredential,
    list: peers.list().pipe(Effect.map((listed) => ({ peers: listed }))),
    add: (input) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          peers.add({
            origin: input.origin,
            credential: input.credential,
            linkMode: input.poll === true ? "poll" : "push",
            replaceOrigin: input.replaceOrigin ?? false,
            acceptedAt: DateTime.formatIso(now),
          }),
        ),
      ),
    remove: (input) =>
      rotationPermit
        .withPermit(
          Effect.all({
            revokedSessions: revokeSessionsForSubject(
              peerSubjectForEnvironment(input.environmentId),
              null,
            ),
            removed: removal.remove(input.environmentId),
          }),
        )
        .pipe(
          Effect.map((outcome) => ({
            removed: outcome.removed.removed,
            revokedSessions: outcome.revokedSessions,
          })),
          Effect.mapError((cause) => new PeerAdminOperationError({ operation: "remove", cause })),
        ),
    addresses: Effect.sync(() => ({
      origins: peerAddressOrigins({
        host: config.host,
        port: config.port,
        interfaces: NodeOS.networkInterfaces(),
      }),
    })),
    probe: (input) => peers.probe(input.origin),
    completeRotation: (session) =>
      rotationPermit.withPermit(revokeSessionsForSubject(session.subject, session.sessionId)),
  });
});

export const layer = Layer.effect(PeerAdminService, make);
