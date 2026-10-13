import type { EnvironmentId } from "@t3tools/contracts";
import {
  J5_PEER_API_PATHS,
  PEER_POLL_STOPPED_PREFIX,
  PeerCapabilities,
  PeerHelloResponse,
  PeerRosterAgent,
  peerSubjectForEnvironment,
  type PeerLinkMode,
  type PeerProbeResponse,
  type PeerRecord,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { reportedLabel } from "./peerLabel.ts";
import {
  peerProtocolHeaders,
  peerProtocolMismatch,
  responseProtocolMismatch,
} from "./peerProtocol.ts";

/**
 * The peer registry: the other servers this one exchanges agent messages
 * with. A peer is recorded only after this server has reached it at the
 * stated origin with the credential it issued to us and that credential named
 * us. The credential the peer holds for this server is an ordinary session in
 * the auth database; a record reports whether that session is still live, so
 * a revoked or expired peer shows as such instead of looking healthy.
 */

const PEER_HELLO_TIMEOUT = Duration.seconds(5);
const PEER_PROBE_TIMEOUT = Duration.seconds(4);
const PUBLIC_IDENTITY_PATH = "/.well-known/t3/environment";
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};
const decodePublicIdentity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ environmentId: Schema.String, label: Schema.String })),
);
/** The most of a probed answer this server reads: a public identity is a few hundred bytes. */
const PEER_PROBE_BODY_MAX_BYTES = 64 * 1024;

export interface AddPeerInput {
  readonly origin: string;
  readonly credential: string;
  /** `poll` when this server cannot be reached and polls the peer; `push` sends directly both ways. */
  readonly linkMode: "push" | "poll";
  /** Re-adding a known peer at a different origin is refused unless the caller says so. */
  readonly replaceOrigin: boolean;
  readonly acceptedAt: string;
}

export class PeerUnreachableError extends Schema.TaggedError<PeerUnreachableError>()(
  "PeerUnreachableError",
  { origin: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Could not reach a J5 server at ${this.origin}: ${this.reason}. Confirm the origin this server can use; it may differ from the one your client uses.`;
  }
}

export class PeerCredentialRejectedError extends Schema.TaggedError<PeerCredentialRejectedError>()(
  "PeerCredentialRejectedError",
  { origin: Schema.String, status: Schema.Number },
) {
  override get message(): string {
    return `${this.origin} rejected the credential (HTTP ${String(this.status)}). Issue a fresh one there with the a2a:peer scope for this environment.`;
  }
}

export class PeerCredentialMismatchError extends Schema.TaggedError<PeerCredentialMismatchError>()(
  "PeerCredentialMismatchError",
  { origin: Schema.String, expectedSubject: Schema.String, actualSubject: Schema.String },
) {
  override get message(): string {
    return `The credential ${this.origin} accepted names ${this.actualSubject}, not this environment (${this.expectedSubject}). It was issued for a different server.`;
  }
}

export class PeerIsSelfError extends Schema.TaggedError<PeerIsSelfError>()("PeerIsSelfError", {
  origin: Schema.String,
  environmentId: Schema.String,
}) {
  override get message(): string {
    return `${this.origin} is this server (environment ${this.environmentId}); a server cannot peer with itself.`;
  }
}

/** Hello proves the origin is reachable, not that it is the same server; moving a peer is an explicit act. */
export class PeerOriginConflictError extends Schema.TaggedError<PeerOriginConflictError>()(
  "PeerOriginConflictError",
  {
    environmentId: Schema.String,
    recordedOrigin: Schema.String,
    requestedOrigin: Schema.String,
    /** Whether the recorded origin accepted the new credential, so it replaced the old one. */
    credentialKept: Schema.Boolean,
  },
) {
  override get message(): string {
    const credential = this.credentialKept
      ? `The new credential also works at ${this.recordedOrigin}, so it replaced the old one there.`
      : `The new credential was not accepted at ${this.recordedOrigin}, so the credential recorded for it is unchanged; if ${this.requestedOrigin} is the same server, its hello may have retired that credential, so re-pair at ${this.recordedOrigin}.`;
    return `Peer ${this.environmentId} is recorded at ${this.recordedOrigin}, not ${this.requestedOrigin}, and was not moved. ${credential} Pass replaceOrigin (\`--replace-origin\`) to move it.`;
  }
}

/** A breaking peer protocol change: the older server must update before the two can peer. */
export class PeerProtocolMismatchError extends Schema.TaggedError<PeerProtocolMismatchError>()(
  "PeerProtocolMismatchError",
  { origin: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

class PeerProbeFailure extends Schema.TaggedError<PeerProbeFailure>()("PeerProbeFailure", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class PeerSessionReadError extends Schema.TaggedError<PeerSessionReadError>()(
  "PeerSessionReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the sessions peers hold on this server.";
  }
}

/** A pair's way of travelling changes only by removing the peer and peering again. */
export class PeerLinkModeConflictError extends Schema.TaggedError<PeerLinkModeConflictError>()(
  "PeerLinkModeConflictError",
  { environmentId: Schema.String, recorded: Schema.String, requested: Schema.String },
) {
  override get message(): string {
    return `Peer ${this.environmentId} is recorded here with link mode ${this.recorded}, not ${this.requested}. To change how messages travel, remove the peer and peer again.`;
  }
}

/** A poll pairing needs a storing server that keeps messages for a poller. */
export class PeerPollUnsupportedError extends Schema.TaggedError<PeerPollUnsupportedError>()(
  "PeerPollUnsupportedError",
  { origin: Schema.String },
) {
  override get message(): string {
    return `The server at ${this.origin} does not store messages for a peer that polls. Update J5 there, then peer again.`;
  }
}

export type AddPeerError =
  | SqlError
  | PeerSessionReadError
  | PeerUnreachableError
  | PeerCredentialRejectedError
  | PeerCredentialMismatchError
  | PeerIsSelfError
  | PeerProtocolMismatchError
  | PeerLinkModeConflictError
  | PeerPollUnsupportedError
  | PeerOriginConflictError;

/** A peer record plus what this server needs to reach or read it; never leaves the process. */
export interface PeerConnection extends PeerRecord {
  /** The credential the peer issued to this server; null for a peer that polls, which this server never calls. */
  readonly credential: string | null;
  /** A storing record's roster snapshot from the poller; null before its first poll and for other modes. */
  readonly roster: ReadonlyArray<PeerRosterAgent> | null;
}

/** What a poll tells the storing server about the poller. */
export interface PeerPollFacts {
  readonly environmentId: string;
  /** When the poll arrived; the roster snapshot is dated by it. */
  readonly receivedAt: string;
  readonly protocolVersion: number;
  readonly label: string | undefined;
  readonly capabilities: PeerCapabilities | undefined;
  /** Present only when the poller's roster changed since the snapshot held here. */
  readonly roster:
    | { readonly agents: ReadonlyArray<PeerRosterAgent>; readonly hash: string }
    | undefined;
}

export interface PeerRegistryServiceShape {
  /** This server's environment id, the identity a peer's credential must name. */
  readonly selfEnvironmentId: Effect.Effect<EnvironmentId>;
  /** This server's own name: the label its environment descriptor publishes, which peers record. */
  readonly selfLabel: Effect.Effect<string>;
  /**
   * Every recorded peer with the credential to reach it, for directory reads.
   * A peer whose session here is gone is still listed, marked "missing", so a
   * caller can report it as unreadable rather than forget it exists.
   */
  readonly connections: () => Effect.Effect<
    ReadonlyArray<PeerConnection>,
    SqlError | PeerSessionReadError
  >;
  /** One recorded peer with its credential, for a delivery attempt. */
  readonly connection: (
    environmentId: string,
  ) => Effect.Effect<PeerConnection | null, SqlError | PeerSessionReadError>;
  /** A signal each time a peer is recorded, rotated or removed, for the pollers to follow. */
  readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  /**
   * A signal each time a write changed something `list` reports, for the clients' `peers`
   * revision. It is apart from `subscribeChanges` because a heartbeat moves it and no poller
   * should be reconciled by one.
   */
  readonly subscribeListChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  /**
   * Says a session a peer holds on this server was issued: `list` reports whether one is live,
   * and sessions are the auth database's, which this registry does not watch.
   */
  readonly sessionChanged: Effect.Effect<void>;
  /** Whether any peer is recorded, without reading what `list` reports about each. */
  readonly hasPeers: Effect.Effect<boolean, SqlError>;
  /** Proves the credential at the origin, then upserts; re-adding the same peer rotates its origin and credential. */
  readonly add: (
    input: AddPeerInput,
  ) => Effect.Effect<{ readonly peer: PeerRecord; readonly created: boolean }, AddPeerError>;
  readonly get: (
    environmentId: string,
  ) => Effect.Effect<PeerRecord | null, SqlError | PeerSessionReadError>;
  readonly list: () => Effect.Effect<ReadonlyArray<PeerRecord>, SqlError | PeerSessionReadError>;
  readonly remove: (
    environmentId: string,
  ) => Effect.Effect<{ readonly removed: boolean }, SqlError>;
  /**
   * The name a peer reported for itself when this server last talked to it,
   * written only when it changed. Answers with the name now recorded; a peer
   * that reported none keeps the recorded one.
   */
  readonly recordLabel: (
    environmentId: string,
    reported: string | undefined,
  ) => Effect.Effect<string | null, SqlError>;
  /** What a peer said it can do when this server last heard from it, kept for `capabilities`. */
  readonly recordCapabilities: (
    environmentId: string,
    capabilities: PeerCapabilities,
  ) => Effect.Effect<void, SqlError>;
  /** What a recorded peer last said it can do; nothing for a peer from before capabilities. */
  readonly capabilities: (environmentId: string) => Effect.Effect<PeerCapabilities, SqlError>;
  /**
   * The reachability check: fetch the public identity at an origin, bounded,
   * and say who answered or the error it got. It reads that one fixed path and
   * records nothing.
   */
  readonly probe: (origin: string) => Effect.Effect<PeerProbeResponse>;
  /** Marks a credential just issued as one whose holder will poll this server. */
  readonly grantStore: (input: {
    readonly environmentId: string;
    readonly sessionId: string;
    readonly issuedAt: string;
  }) => Effect.Effect<void, SqlError>;
  /**
   * The first time a store credential is presented, its holder becomes this
   * server's `store` peer: the proof stands in for reaching it at an origin.
   * True when the session's environment is now a recorded peer.
   */
  readonly adoptStorePeer: (input: {
    readonly environmentId: string;
    readonly sessionId: string;
    readonly at: string;
  }) => Effect.Effect<boolean, SqlError>;
  /**
   * Records a poll, and its time as the heartbeat a peer's online and offline
   * are read from, ending any last error. On the storing server it is what
   * the poller told it, at arrival: a poll held there proves the poller is
   * there. On the poller it is what the storing server answered (no roster).
   * Answers with the roster hash held for the poller.
   */
  readonly recordPoll: (
    facts: PeerPollFacts,
  ) => Effect.Effect<{ readonly rosterHash: string | null }, SqlError>;
  /** The heartbeat alone, on the poller: a 200's headers answer its poll before the body arrives. */
  readonly recordPolled: (environmentId: string, at: string) => Effect.Effect<void, SqlError>;
  /**
   * Why the last exchange with a peer failed, or null once one succeeds; a
   * no-op when nothing changes. A poller's stop stands until it polls again
   * or the peer is recorded again: other errors and successes leave it, and
   * only a newer stop replaces it.
   */
  readonly recordLastError: (
    environmentId: string,
    error: string | null,
  ) => Effect.Effect<void, SqlError>;
}

/** A polling peer's heartbeat arrives about every 25 seconds; clients are told of one a minute. */
const HEARTBEAT_SIGNAL_EVERY_MS = 60_000;

export class PeerRegistryService extends Context.Service<
  PeerRegistryService,
  PeerRegistryServiceShape
>()("t3/j5/a2a/PeerRegistryService") {}

interface PeerRow {
  readonly environment_id: string;
  readonly label: string;
  readonly link_mode: PeerLinkMode;
  readonly origin: string | null;
  readonly credential_expires_at: string | null;
  readonly last_polled_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PeerConnectionRow extends PeerRow {
  readonly credential: string | null;
  readonly roster_json: string | null;
}

interface WaitingRow {
  readonly environment_id: string;
  readonly waiting: number;
  readonly oldest: string | null;
}

const decodeRosterSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PeerRosterAgent)),
);
// Encoding a value that already has its type cannot fail.
const encodeRosterSnapshot = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(PeerRosterAgent)),
);
const encodeCapabilities = Schema.encodeSync(Schema.fromJsonString(PeerCapabilities));
const decodeCapabilities = Schema.decodeUnknownOption(Schema.fromJsonString(PeerCapabilities));

const decodeHello = Schema.decodeUnknownEffect(PeerHelloResponse);

/** The message plus the cause chain: a transport error alone never says why the socket failed. */
const reasonOf = (cause: unknown): string => {
  const parts: Array<string> = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.length > 0 && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ");
};

/** GET the peer's hello with the credential it issued; the answer names the peer and whom the credential is for. */
const helloAtOrigin = Effect.fn("j5.a2a.peer.hello")(function* (input: {
  readonly origin: string;
  readonly credential: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${input.origin}${J5_PEER_API_PATHS.hello}`).pipe(
    HttpClientRequest.bearerToken(input.credential),
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeaders(peerProtocolHeaders),
  );
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.mapError(
        (cause) => new PeerUnreachableError({ origin: input.origin, reason: reasonOf(cause) }),
      ),
    );
  // Checked before the status: a server on another protocol may answer 200 to a request it misread.
  const mismatch = responseProtocolMismatch({
    response,
    peer: `The server at ${input.origin}`,
  });
  if (mismatch !== null) {
    return yield* new PeerProtocolMismatchError({ origin: input.origin, reason: mismatch });
  }
  if (response.status === 401 || response.status === 403) {
    return yield* new PeerCredentialRejectedError({
      origin: input.origin,
      status: response.status,
    });
  }
  if (response.status !== 200) {
    return yield* new PeerUnreachableError({
      origin: input.origin,
      reason: `the hello route answered HTTP ${String(response.status)}`,
    });
  }
  const hello = yield* response.json.pipe(
    Effect.flatMap(decodeHello),
    Effect.mapError(
      (cause) =>
        new PeerUnreachableError({
          origin: input.origin,
          reason: `the hello route answered with an unexpected shape: ${reasonOf(cause)}`,
        }),
    ),
  );
  // The body states the version too; a peer is recorded only when both agree with this server.
  const bodyMismatch = peerProtocolMismatch({
    stated: hello.peerProtocolVersion,
    peer: `The server at ${input.origin}`,
  });
  if (bodyMismatch !== null) {
    return yield* new PeerProtocolMismatchError({ origin: input.origin, reason: bodyMismatch });
  }
  return hello;
});

/** The whole exchange is bounded: a peer that answers headers and then stalls the body cannot hold a request open. */
const helloAtOriginBounded = (input: { readonly origin: string; readonly credential: string }) =>
  helloAtOrigin(input).pipe(
    Effect.timeoutOrElse({
      duration: PEER_HELLO_TIMEOUT,
      orElse: () =>
        new PeerUnreachableError({
          origin: input.origin,
          reason: `no complete hello answer within ${Duration.format(PEER_HELLO_TIMEOUT)}`,
        }),
    }),
  );

export const layer: Layer.Layer<
  PeerRegistryService,
  never,
  | SqlClient.SqlClient
  | HttpClient.HttpClient
  | ServerEnvironment.ServerEnvironment
  | EnvironmentAuth.EnvironmentAuth
> = Layer.effect(
  PeerRegistryService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const httpClient = yield* HttpClient.HttpClient;
    const identity = yield* ServerEnvironment.ServerEnvironment;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const changes = yield* PubSub.unbounded<void>();
    const changed = PubSub.publish(changes, undefined);
    // Published by each write below that changes what `list` reports: a peer recorded, rotated,
    // adopted or removed, a heartbeat that shows (`heartbeatShows`), the last error and a peer's name. A write `list` does not
    // show publishes nothing: a store grant, capabilities, and a roster snapshot apart from the
    // heartbeat it arrives with. Waiting messages are deliveries, which `ReadChangeFeeds` follows
    // in the ledger. A session revoked or expired in the auth database by some other path has no
    // signal; a client's read on focus covers it.
    const listChanges = yield* PubSub.unbounded<void>();
    const listChanged = PubSub.publish(listChanges, undefined).pipe(Effect.asVoid);
    const listChangedWhen = (rows: ReadonlyArray<unknown>) =>
      rows.length > 0 ? listChanged : Effect.void;
    /**
     * Whether a heartbeat at `at` will change what a client shows for the peer. A client reads
     * online or offline from the last heartbeat it was given against a two-minute window, so one
     * a minute keeps that right; a heartbeat also shows when it ends an error or brings a new
     * name. Asked before the write, since the update cannot say what it replaced. The minute is
     * counted from the last heartbeat clients were told of, which is kept here and not stored:
     * after a restart the first heartbeat is told.
     */
    const heartbeatToldAt = new Map<string, number>();
    const heartbeatShows = (environmentId: string, at: string, label?: string) =>
      sql<{
        readonly last_polled_at: string | null;
        readonly last_error: string | null;
        readonly label: string;
      }>`
        SELECT last_polled_at, last_error, label FROM j5_a2a_peer
        WHERE environment_id = ${environmentId}
      `.pipe(
        Effect.map(([row]) => {
          if (row === undefined) return false;
          const heartbeatAt = Date.parse(at);
          const toldAt = heartbeatToldAt.get(environmentId);
          const shows =
            row.last_error !== null ||
            row.last_polled_at === null ||
            (label !== undefined && label !== row.label) ||
            toldAt === undefined ||
            !(heartbeatAt - toldAt < HEARTBEAT_SIGNAL_EVERY_MS);
          if (shows) heartbeatToldAt.set(environmentId, heartbeatAt);
          return shows;
        }),
      );

    /** The subjects that currently hold a live session here; a peer without one cannot deliver to us. */
    const liveSubjects = serverAuth.listSessions().pipe(
      Effect.map((sessions) => new Set(sessions.map((session) => session.subject))),
      Effect.mapError((cause) => new PeerSessionReadError({ cause })),
    );

    /** Messages recorded here and not yet delivered to each peer: the backlog a row shows. */
    const waitingByEnvironment = Effect.fn("j5.a2a.peer.waiting")(function* (
      environmentId?: string,
    ) {
      const rows = yield* sql<WaitingRow>`
        SELECT receiver_environment_id AS environment_id, COUNT(*) AS waiting, MIN(created_at) AS oldest
        FROM j5_a2a_delivery
        WHERE receiver_environment_id IS NOT NULL
          AND status IN ('pending', 'retry_scheduled')
          AND ${environmentId === undefined ? sql`1 = 1` : sql`receiver_environment_id = ${environmentId}`}
        GROUP BY receiver_environment_id
      `;
      return new Map(rows.map((row) => [row.environment_id, row] as const));
    });

    const recordFromRow = (
      row: PeerRow,
      live: ReadonlySet<string>,
      waiting: ReadonlyMap<string, WaitingRow>,
    ): PeerRecord => ({
      environmentId: row.environment_id,
      // Cleaned on the way out too, for a name recorded before names were cleaned.
      label: reportedLabel(row.label) ?? row.environment_id,
      linkMode: row.link_mode,
      origin: row.origin,
      credentialExpiresAt: row.credential_expires_at,
      inboundSession: live.has(peerSubjectForEnvironment(row.environment_id))
        ? "active"
        : "missing",
      createdAt: row.created_at,
      lastPolledAt: row.last_polled_at,
      lastError: row.last_error,
      waitingCount: waiting.get(row.environment_id)?.waiting ?? 0,
      oldestWaitingAt: waiting.get(row.environment_id)?.oldest ?? null,
    });

    const connectionFromRow = Effect.fn("j5.a2a.peer.connectionFromRow")(function* (
      row: PeerConnectionRow,
      live: ReadonlySet<string>,
      waiting: ReadonlyMap<string, WaitingRow>,
    ) {
      // A snapshot this server cannot read is no snapshot: the peer reads as not yet polled.
      const roster =
        row.roster_json === null
          ? null
          : yield* decodeRosterSnapshot(row.roster_json).pipe(Effect.orElseSucceed(() => null));
      return {
        ...recordFromRow(row, live, waiting),
        credential: row.credential,
        roster,
      } satisfies PeerConnection;
    });

    const readRow = Effect.fn("j5.a2a.peer.readRow")(function* (environmentId: string) {
      const rows = yield* sql<PeerRow>`
        SELECT environment_id, label, link_mode, origin, credential_expires_at, last_polled_at,
          last_error, created_at, updated_at
        FROM j5_a2a_peer
        WHERE environment_id = ${environmentId}
        LIMIT 1
      `;
      return rows[0] ?? null;
    });

    const add: PeerRegistryServiceShape["add"] = (input) =>
      Effect.gen(function* () {
        const ourEnvironmentId: EnvironmentId = yield* identity.getEnvironmentId;
        const hello = yield* helloAtOriginBounded({
          origin: input.origin,
          credential: input.credential,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        if (hello.environmentId === ourEnvironmentId) {
          return yield* new PeerIsSelfError({
            origin: input.origin,
            environmentId: ourEnvironmentId,
          });
        }
        const expectedSubject = peerSubjectForEnvironment(ourEnvironmentId);
        if (hello.subject !== expectedSubject) {
          return yield* new PeerCredentialMismatchError({
            origin: input.origin,
            expectedSubject,
            actualSubject: hello.subject,
          });
        }
        // Refused before anything is recorded: the dialog never offers it, so this guards the CLI.
        if (input.linkMode === "poll" && hello.capabilities?.poll !== true) {
          return yield* new PeerPollUnsupportedError({ origin: input.origin });
        }
        const existing = yield* readRow(hello.environmentId);
        if (existing !== null && existing.link_mode !== input.linkMode) {
          return yield* new PeerLinkModeConflictError({
            environmentId: hello.environmentId,
            recorded: existing.link_mode,
            requested: input.linkMode,
          });
        }
        if (
          existing !== null &&
          existing.origin !== null &&
          existing.origin !== input.origin &&
          !input.replaceOrigin
        ) {
          // The hello there may have completed a rotation, retiring the credential
          // recorded here, but only if that origin is the same server. Keep the
          // new credential only once the recorded origin accepts it too.
          const recordedHello = yield* helloAtOriginBounded({
            origin: existing.origin,
            credential: input.credential,
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.option);
          const credentialKept =
            Option.isSome(recordedHello) &&
            recordedHello.value.environmentId === hello.environmentId &&
            recordedHello.value.subject === expectedSubject;
          if (credentialKept) {
            yield* sql`
              UPDATE j5_a2a_peer
              SET credential = ${input.credential},
                  credential_expires_at = ${recordedHello.value.credentialExpiresAt ?? null},
                  updated_at = ${input.acceptedAt}
              WHERE environment_id = ${hello.environmentId}
            `;
            yield* listChanged;
          }
          return yield* new PeerOriginConflictError({
            environmentId: hello.environmentId,
            recordedOrigin: existing.origin,
            requestedOrigin: input.origin,
            credentialKept,
          });
        }
        // The peer names itself; a server from before names omits it and the recorded name stands.
        const label = reportedLabel(hello.label) ?? existing?.label ?? hello.environmentId;
        const expiresAt = hello.credentialExpiresAt ?? null;
        // One statement records or rotates; created_at survives an update.
        const rows = yield* sql<PeerRow>`
          INSERT INTO j5_a2a_peer (
            environment_id, label, link_mode, origin, credential, credential_expires_at,
            peer_protocol_version, peer_capabilities, created_at, updated_at
          )
          VALUES (
            ${hello.environmentId}, ${label}, ${input.linkMode}, ${input.origin}, ${input.credential}, ${expiresAt},
            ${hello.peerProtocolVersion ?? 1}, ${encodeCapabilities(hello.capabilities ?? {})},
            ${input.acceptedAt}, ${input.acceptedAt}
          )
          ON CONFLICT(environment_id) DO UPDATE SET
            label = excluded.label,
            origin = excluded.origin,
            credential = excluded.credential,
            credential_expires_at = excluded.credential_expires_at,
            peer_protocol_version = excluded.peer_protocol_version,
            peer_capabilities = excluded.peer_capabilities,
            last_error = NULL,
            updated_at = excluded.updated_at
          RETURNING environment_id, label, link_mode, origin, credential_expires_at, last_polled_at,
            last_error, created_at, updated_at
        `;
        const row = rows[0]!;
        yield* changed;
        yield* listChanged;
        const live = yield* liveSubjects;
        const waiting = yield* waitingByEnvironment(row.environment_id);
        return { peer: recordFromRow(row, live, waiting), created: existing === null };
      });

    const get: PeerRegistryServiceShape["get"] = (environmentId) =>
      Effect.gen(function* () {
        const row = yield* readRow(environmentId);
        if (row === null) return null;
        return recordFromRow(row, yield* liveSubjects, yield* waitingByEnvironment(environmentId));
      });

    const connections: PeerRegistryServiceShape["connections"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<PeerConnectionRow>`
          SELECT environment_id, label, link_mode, origin, credential, credential_expires_at,
            last_polled_at, last_error, roster_json, created_at, updated_at
          FROM j5_a2a_peer
          ORDER BY label, environment_id
        `;
        if (rows.length === 0) return [];
        const live = yield* liveSubjects;
        const waiting = yield* waitingByEnvironment();
        return yield* Effect.forEach(rows, (row) => connectionFromRow(row, live, waiting));
      });

    /** One peer's connection for a delivery attempt: one row and its session status, not the whole registry. */
    const connection: PeerRegistryServiceShape["connection"] = (environmentId) =>
      Effect.gen(function* () {
        const rows = yield* sql<PeerConnectionRow>`
          SELECT environment_id, label, link_mode, origin, credential, credential_expires_at,
            last_polled_at, last_error, roster_json, created_at, updated_at
          FROM j5_a2a_peer
          WHERE environment_id = ${environmentId}
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return null;
        return yield* connectionFromRow(
          row,
          yield* liveSubjects,
          yield* waitingByEnvironment(environmentId),
        );
      });

    const list: PeerRegistryServiceShape["list"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<PeerRow>`
          SELECT environment_id, label, link_mode, origin, credential_expires_at, last_polled_at,
            last_error, created_at, updated_at
          FROM j5_a2a_peer
          ORDER BY label, environment_id
        `;
        if (rows.length === 0) return [];
        const live = yield* liveSubjects;
        const waiting = yield* waitingByEnvironment();
        return rows.map((row) => recordFromRow(row, live, waiting));
      });

    const remove: PeerRegistryServiceShape["remove"] = (environmentId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM j5_a2a_peer_store_grant WHERE environment_id = ${environmentId}`;
            const rows = yield* sql<{ readonly environment_id: string }>`
            DELETE FROM j5_a2a_peer WHERE environment_id = ${environmentId}
            RETURNING environment_id
          `;
            return { removed: rows.length > 0 };
          }),
        )
        .pipe(
          Effect.tap(() => changed),
          Effect.tap(({ removed }) => (removed ? listChanged : Effect.void)),
        );

    const probe: PeerRegistryServiceShape["probe"] = (origin) =>
      Effect.gen(function* () {
        // The probe fetches that one path at that origin: a redirect is an
        // answer to report, never a second fetch somewhere else.
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(`${origin}${PUBLIC_IDENTITY_PATH}`).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        if (response.status !== 200) {
          return yield* new PeerProbeFailure({
            reason: `answered HTTP ${String(response.status)}`,
          });
        }
        // What answered may be anything, so its body is bounded and never repeated.
        const notIdentity = new PeerProbeFailure({ reason: "answered, but not as a J5 server" });
        let read = 0;
        const body = yield* response.stream.pipe(
          Stream.mapEffect((chunk) => {
            read += chunk.byteLength;
            return read > PEER_PROBE_BODY_MAX_BYTES
              ? Effect.fail(notIdentity)
              : Effect.succeed(chunk);
          }),
          Stream.decodeText,
          Stream.mkString,
        );
        const identity = yield* decodePublicIdentity(body).pipe(Effect.mapError(() => notIdentity));
        return {
          outcome: "reached",
          origin,
          environmentId: identity.environmentId,
          label: reportedLabel(identity.label) ?? identity.environmentId,
        } satisfies PeerProbeResponse;
      }).pipe(
        Effect.timeoutOrElse({
          duration: PEER_PROBE_TIMEOUT,
          orElse: () =>
            new PeerProbeFailure({
              reason: `connection timed out after ${Duration.format(PEER_PROBE_TIMEOUT)}`,
            }),
        }),
        Effect.catch((cause) =>
          Effect.succeed<PeerProbeResponse>({
            outcome: "failed",
            origin,
            error: `${hostOf(origin)}: ${reasonOf(cause)}`,
          }),
        ),
      );

    const grantStore: PeerRegistryServiceShape["grantStore"] = (input) =>
      sql`
        INSERT INTO j5_a2a_peer_store_grant (session_id, environment_id, issued_at)
        VALUES (${input.sessionId}, ${input.environmentId}, ${input.issuedAt})
      `.pipe(Effect.asVoid);

    const adoptStorePeer: PeerRegistryServiceShape["adoptStorePeer"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if ((yield* readRow(input.environmentId)) !== null) return "recorded" as const;
            const grant = yield* sql`
              SELECT 1 FROM j5_a2a_peer_store_grant
              WHERE session_id = ${input.sessionId} AND environment_id = ${input.environmentId}
            `;
            if (grant.length === 0) return "refused" as const;
            // Its name is its environment id until its first poll tells this server its own.
            yield* sql`
              INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
              VALUES (${input.environmentId}, ${input.environmentId}, 'store', ${input.at}, ${input.at})
            `;
            yield* sql`DELETE FROM j5_a2a_peer_store_grant WHERE environment_id = ${input.environmentId}`;
            return "adopted" as const;
          }),
        )
        .pipe(
          Effect.tap((outcome) => (outcome === "adopted" ? listChanged : Effect.void)),
          Effect.map((outcome) => outcome !== "refused"),
        );

    const recordPoll: PeerRegistryServiceShape["recordPoll"] = (facts) =>
      Effect.gen(function* () {
        const label = reportedLabel(facts.label);
        const capabilities =
          facts.capabilities === undefined ? null : encodeCapabilities(facts.capabilities);
        const roster =
          facts.roster === undefined ? null : encodeRosterSnapshot(facts.roster.agents);
        const shows = yield* heartbeatShows(facts.environmentId, facts.receivedAt, label);
        // The snapshot and the name change only when the poller sent new ones.
        const rows = yield* sql<{ readonly roster_hash: string | null }>`
          UPDATE j5_a2a_peer SET
            label = COALESCE(${label ?? null}, label),
            peer_protocol_version = ${facts.protocolVersion},
            peer_capabilities = COALESCE(${capabilities}, peer_capabilities),
            roster_json = COALESCE(${roster}, roster_json),
            roster_hash = COALESCE(${facts.roster?.hash ?? null}, roster_hash),
            roster_received_at = CASE WHEN ${roster} IS NULL THEN roster_received_at ELSE ${facts.receivedAt} END,
            last_polled_at = ${facts.receivedAt},
            last_error = NULL,
            updated_at = ${facts.receivedAt}
          WHERE environment_id = ${facts.environmentId} AND link_mode IN ('store', 'poll')
          RETURNING roster_hash
        `;
        if (shows) yield* listChangedWhen(rows);
        return { rosterHash: rows[0]?.roster_hash ?? null };
      });

    const recordPolled: PeerRegistryServiceShape["recordPolled"] = (environmentId, at) =>
      heartbeatShows(environmentId, at).pipe(
        Effect.flatMap((shows) =>
          sql`
            UPDATE j5_a2a_peer SET last_polled_at = ${at}, last_error = NULL
            WHERE environment_id = ${environmentId}
            RETURNING environment_id
          `.pipe(Effect.flatMap((rows) => (shows ? listChangedWhen(rows) : Effect.void))),
        ),
      );

    const recordLastError: PeerRegistryServiceShape["recordLastError"] = (environmentId, error) =>
      sql`
        UPDATE j5_a2a_peer SET last_error = ${error}
        WHERE environment_id = ${environmentId} AND last_error IS NOT ${error}
          AND (
            last_error IS NULL
            OR substr(last_error, 1, ${PEER_POLL_STOPPED_PREFIX.length}) <> ${PEER_POLL_STOPPED_PREFIX}
            OR substr(${error}, 1, ${PEER_POLL_STOPPED_PREFIX.length}) = ${PEER_POLL_STOPPED_PREFIX}
          )
        RETURNING environment_id
      `.pipe(Effect.flatMap(listChangedWhen));

    const recordLabel: PeerRegistryServiceShape["recordLabel"] = (environmentId, reported) =>
      Effect.gen(function* () {
        const label = reportedLabel(reported);
        if (label !== undefined) {
          const renamed = yield* sql`
            UPDATE j5_a2a_peer SET label = ${label}
            WHERE environment_id = ${environmentId} AND label <> ${label}
            RETURNING environment_id
          `;
          yield* listChangedWhen(renamed);
        }
        return (yield* readRow(environmentId))?.label ?? null;
      });

    const recordCapabilities: PeerRegistryServiceShape["recordCapabilities"] = (
      environmentId,
      capabilities,
    ) =>
      sql`
        UPDATE j5_a2a_peer SET peer_capabilities = ${encodeCapabilities(capabilities)}
        WHERE environment_id = ${environmentId}
      `.pipe(Effect.asVoid);

    const capabilities: PeerRegistryServiceShape["capabilities"] = (environmentId) =>
      sql<{ readonly peer_capabilities: string | null }>`
        SELECT peer_capabilities FROM j5_a2a_peer WHERE environment_id = ${environmentId} LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows[0]?.peer_capabilities == null
            ? {}
            : Option.getOrElse(decodeCapabilities(rows[0].peer_capabilities), () => ({})),
        ),
      );

    return PeerRegistryService.of({
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      subscribeListChanges: PubSub.subscribe(listChanges).pipe(Effect.map(Stream.fromSubscription)),
      sessionChanged: listChanged,
      hasPeers: sql`SELECT 1 FROM j5_a2a_peer LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0)),
      selfEnvironmentId: identity.getEnvironmentId,
      // Cleaned and capped as a peer will store it: a long computer name must not fail every exchange.
      selfLabel: identity.getDescriptor.pipe(
        Effect.map(
          (descriptor) => reportedLabel(descriptor.label) ?? String(descriptor.environmentId),
        ),
      ),
      connections,
      connection,
      add,
      get,
      list,
      remove,
      recordLabel,
      recordCapabilities,
      capabilities,
      probe,
      grantStore,
      adoptStorePeer,
      recordPoll,
      recordPolled,
      recordLastError,
    });
  }),
);
