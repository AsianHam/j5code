// @effect-diagnostics nodeBuiltinImport:off - hashes the credential an intent is found by.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId } from "@t3tools/contracts";
import {
  devicePermissions,
  highestLevel,
  levelReaches,
  samePermissions,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ParticipantId } from "../a2a/contracts.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";
import { PersonAccess, type SessionIdentity, layer as personAccessLayer } from "./PersonAccess.ts";

/**
 * Who a device belongs to, decided as upstream issues its session (People and access AC1 to AC4).
 * Upstream's pairing link carries a subject and permissions and nothing about a person, and J5
 * adds no column to upstream's tables, so the person a pairing credential is for is recorded here
 * beside it, found again by a hash of the credential: that is what upstream's pairing code holds
 * when it issues the session. Upstream's pairing code calls `makePairingSessionIssuer` (FORK.md
 * case 70).
 *
 * A credential with an intent pairs a device as the intent's person, with the intent's ceiling.
 * One without is the first owner's (the startup link, the desktop app), a service's, or a device
 * the server cannot place, which `PersonAccess.sessionReach` tells apart by subject.
 */

/**
 * The subject of the single-use pairing credential J5 mints when a person opens a J5 link. It
 * approves no MCP client: the link's level, not an Owner, decided what it holds.
 */
export const J5_LINK_PAIRING_SUBJECT = "j5:link";

/** The subject of a guest's share link before levels; retired, and pairs nothing now. */
const RETIRED_GUEST_SUBJECT = "j5:guest";

/**
 * What a browser already paired as one person is told on opening a pairing link made for another
 * (People and access AC32). Upstream would replace the browser's session with the new person's,
 * so it is refused before upstream exchanges the credential, and the link stays usable.
 */
export const PAIRED_AS_SOMEONE_ELSE =
  "This device is already paired as someone else on this server. Open the link on the device it is for.";

/** The name the refusal goes by on the wire, where the pairing page reads it. */
export const PAIRED_AS_SOMEONE_ELSE_REFUSAL = "paired_as_someone_else" as const;

/** Whether a rejected credential is J5's refusal of a browser paired as someone else. */
export const isPairedAsSomeoneElse = (error: { readonly diagnostic?: string | undefined }) =>
  error.diagnostic === PAIRED_AS_SOMEONE_ELSE;

export class PairingIntentError extends Schema.TaggedError<PairingIntentError>()(
  "PairingIntentError",
  {
    reason: Schema.Literals(["not_wired", "retired", "scopes", "no_person", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_wired":
        return "This server cannot pair a person's device: sharing is not set up in it.";
      case "retired":
        return "This share link was made before this server's update and no longer works.";
      case "scopes":
        return "This link carries more than its person may hold now, and pairs nothing.";
      case "no_person":
        return "This link was made for someone who is no longer on this server.";
      case "storage":
        return "Could not record whose device this is.";
    }
  }
}

/** What upstream's pairing code knows of a link when it is about to issue a session from it. */
export interface PairingGrant {
  readonly subject: string;
  readonly scopes: ReadonlyArray<string>;
}

export interface PairingIntent {
  readonly pairingLinkId: string;
  readonly personId: ParticipantId;
  /** The J5 link it was minted for, when it was. */
  readonly linkId: string | null;
  readonly ceiling: ReadonlyArray<string> | null;
}

/** Upstream's own failure to issue, carried out of the transaction unchanged. */
class IssueFailed {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}
const issueFailed = (error: unknown) => new IssueFailed(error);
const isPairingIntentError = Schema.is(PairingIntentError);

const hashCredential = (credential: string) =>
  NodeCrypto.createHash("sha256").update(credential).digest("hex");

export interface PairingIntentsShape {
  /** Records the person a pairing credential pairs a device for. */
  readonly record: (input: {
    readonly pairingLinkId: string;
    readonly credential: string;
    readonly personId: ParticipantId;
    readonly linkId: string | null;
    readonly ceiling: ReadonlyArray<string> | null;
  }) => Effect.Effect<void, PairingIntentError>;
  /**
   * Records, for a link made in upstream's Connections settings, that it pairs a device for the
   * person whose device made it, under the permissions chosen there (AC3, AC18). A link made by a
   * session that is no person's records nothing.
   */
  readonly recordForCreator: (input: {
    readonly creator: SessionIdentity;
    readonly pairingLinkId: string;
    readonly credential: string;
    readonly scopes: ReadonlyArray<string>;
  }) => Effect.Effect<void, PairingIntentError>;
  /** The intent a credential carries, read without using it; `null` for none. */
  readonly intentOf: (
    credential: string,
  ) => Effect.Effect<PairingIntent | null, PairingIntentError>;
  /** Forgets an intent, as when its link is revoked; `false` when there was none. */
  readonly forget: (pairingLinkId: string) => Effect.Effect<boolean, PairingIntentError>;
  /**
   * Whether a one-time pairing code may approve an MCP client in place of an Owner's browser
   * (upstream's consent page). Approving one hands out the server, so only a code an Owner's
   * level backs does: not a J5 link's, and not one made for someone who is not an Owner.
   */
  readonly approvesMcpClient: (
    grant: PairingGrant,
    credential: string,
  ) => Effect.Effect<boolean, PairingIntentError>;
  /**
   * Runs `issue`, which issues the session a pairing credential pairs, and ties that session to
   * the person the credential's intent names. The two commit together or not at all.
   */
  readonly issueSession: <
    S extends { readonly sessionId: AuthSessionId; readonly scopes: ReadonlyArray<string> },
    E,
    R,
  >(input: {
    readonly grant: PairingGrant;
    readonly credential: string;
    readonly issue: Effect.Effect<S, E, R>;
  }) => Effect.Effect<S, E | PairingIntentError, R>;
}

export class PairingIntents extends Context.Service<PairingIntents, PairingIntentsShape>()(
  "t3/j5/sharing/PairingIntents",
) {}

const StoredCeiling = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeCeiling = Schema.encodeSync(StoredCeiling);
const decodeCeiling = Schema.decodeUnknownOption(StoredCeiling);

interface IntentRow {
  readonly pairing_link_id: string;
  readonly person_id: string;
  readonly link_id: string | null;
  readonly ceiling_scopes: string | null;
}

const toIntent = (row: IntentRow): PairingIntent => ({
  pairingLinkId: row.pairing_link_id,
  personId: ParticipantId.make(row.person_id),
  linkId: row.link_id,
  ceiling:
    row.ceiling_scopes === null
      ? null
      : Option.getOrElse(decodeCeiling(row.ceiling_scopes), () => []),
});

const make: Layer.Layer<PairingIntents, never, SqlClient.SqlClient | ReadChanges | PersonAccess> =
  Layer.effect(
    PairingIntents,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const people = yield* PersonAccess;
      // The People page lists each person's devices, which are written here.
      const peopleChanged = (yield* ReadChanges).notify("sharing");
      const storage = (cause: unknown) => new PairingIntentError({ reason: "storage", cause });

      const record: PairingIntentsShape["record"] = Effect.fn("j5.sharing.pairingIntents.record")(
        function* (input) {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const ceiling = input.ceiling === null ? null : encodeCeiling(input.ceiling);
          const rows = yield* sql`
          INSERT INTO j5_a2a_pairing_intent (
            pairing_link_id, credential_hash, person_id, link_id, ceiling_scopes, created_at
          )
          SELECT ${input.pairingLinkId}, ${hashCredential(input.credential)}, person_id,
            ${input.linkId}, ${ceiling}, ${createdAt}
          FROM j5_a2a_human_person
          WHERE person_id = ${input.personId} AND removed_at IS NULL
          RETURNING pairing_link_id
        `.pipe(Effect.mapError(storage));
          if (rows.length !== 1) return yield* new PairingIntentError({ reason: "no_person" });
          yield* peopleChanged;
        },
      );

      const intentOf: PairingIntentsShape["intentOf"] = (credential) =>
        sql<IntentRow>`
        SELECT pairing_link_id, person_id, link_id, ceiling_scopes FROM j5_a2a_pairing_intent
        WHERE credential_hash = ${hashCredential(credential)}
      `.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : toIntent(rows[0]))),
          Effect.mapError(storage),
          Effect.withSpan("j5.sharing.pairingIntents.intentOf"),
        );

      return PairingIntents.of({
        record,

        recordForCreator: Effect.fn("j5.sharing.pairingIntents.recordForCreator")(
          function* (input) {
            const reach = yield* people.sessionReach(input.creator).pipe(Effect.mapError(storage));
            if (reach.kind !== "person") return;
            yield* record({
              pairingLinkId: input.pairingLinkId,
              credential: input.credential,
              personId: reach.person.personId,
              linkId: null,
              ceiling: input.scopes,
            });
          },
        ),

        intentOf,

        forget: (pairingLinkId) =>
          sql`
          DELETE FROM j5_a2a_pairing_intent WHERE pairing_link_id = ${pairingLinkId}
          RETURNING pairing_link_id
        `.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.mapError(storage),
            Effect.tap((forgotten) => (forgotten ? peopleChanged : Effect.void)),
            Effect.withSpan("j5.sharing.pairingIntents.forget"),
          ),

        approvesMcpClient: Effect.fn("j5.sharing.pairingIntents.approvesMcpClient")(
          function* (grant, credential) {
            if (
              grant.subject === J5_LINK_PAIRING_SUBJECT ||
              grant.subject === RETIRED_GUEST_SUBJECT
            ) {
              return false;
            }
            const intent = yield* intentOf(credential);
            if (intent === null) return true;
            const levels = yield* people.listLevels(intent.personId).pipe(Effect.mapError(storage));
            return levels.some(
              (held) => held.scope.kind === "server" && levelReaches(held.level, "owner"),
            );
          },
        ),

        issueSession: Effect.fn("j5.sharing.pairingIntents.issueSession")(function* (input) {
          if (input.grant.subject === RETIRED_GUEST_SUBJECT) {
            return yield* new PairingIntentError({ reason: "retired" });
          }
          // Read, checked, issued and bound in one transaction. A transaction holds the database's
          // write lock from its start, so a change of level (`Access`) either commits first, and
          // this reads the new level and refuses a credential that carries more, or waits for
          // this to commit, and then finds the new device and renews it.
          const issued = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const intent = yield* intentOf(input.credential);
                if (intent === null) {
                  // A J5 link's credential always has an intent until it is used; one without
                  // was made for someone since removed, and pairs no one's device.
                  if (input.grant.subject === J5_LINK_PAIRING_SUBJECT) {
                    return yield* new PairingIntentError({ reason: "no_person" });
                  }
                  return { session: yield* input.issue.pipe(Effect.mapError(issueFailed)), intent };
                }
                // An intent outlives its person: one for someone removed refuses the credential,
                // whatever pairing path it came by.
                const person = yield* people.readPerson(intent.personId);
                if (person === null) return yield* new PairingIntentError({ reason: "no_person" });
                const levels = yield* people.listLevels(intent.personId);
                const allowed = devicePermissions(
                  highestLevel(levels.map((held) => held.level)),
                  intent.ceiling,
                );
                // A credential made before its person's level was lowered pairs nothing rather
                // than a device holding more than they may.
                if (!input.grant.scopes.every((scope) => allowed.includes(scope as never))) {
                  return yield* new PairingIntentError({ reason: "scopes" });
                }
                const session = yield* input.issue.pipe(Effect.mapError(issueFailed));
                // A device that asked for fewer permissions than its credential carries keeps to
                // what it asked for; one that took them all follows its level from now on.
                const ceiling = samePermissions(session.scopes, input.grant.scopes)
                  ? intent.ceiling
                  : session.scopes;
                const boundAt = DateTime.formatIso(yield* DateTime.now);
                yield* sql`
                  INSERT INTO j5_a2a_person_session (
                    session_id, person_id, bound_at, ceiling_scopes
                  ) VALUES (
                    ${session.sessionId}, ${intent.personId}, ${boundAt},
                    ${ceiling === null ? null : encodeCeiling(ceiling)}
                  )
                `;
                yield* sql`
                  DELETE FROM j5_a2a_pairing_intent WHERE pairing_link_id = ${intent.pairingLinkId}
                `;
                return { session, intent };
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                error instanceof IssueFailed
                  ? (error.error as Effect.Error<typeof input.issue>)
                  : isPairingIntentError(error)
                    ? error
                    : storage(error),
              ),
            );
          // Committed: the credential is used up and the person has a device.
          if (issued.intent !== null) yield* people.announce(issued.intent.personId);
          return issued.session;
        }),
      });
    }),
  );

// `readChangesLayer` is the one the rest of the server provides, so it is the same instance
// (see `a2a/runtimeLayer.ts`).
export const layer: Layer.Layer<PairingIntents, never, SqlClient.SqlClient | PersonAccess> =
  make.pipe(Layer.provide(readChangesLayer));

/**
 * People and the record of whose each device is, for upstream's auth layer to be built over:
 * its pairing code ties each session to its person through this (FORK.md case 70), and the gate
 * reads the same `PersonAccess`.
 */
export const peopleLayer: Layer.Layer<PairingIntents | PersonAccess, never, SqlClient.SqlClient> =
  layer.pipe(Layer.provideMerge(personAccessLayer));

/**
 * For upstream's pairing code, read once where `EnvironmentAuth` is built: wraps the step that
 * issues a session from a pairing credential, as a step in its pipe. A credential with no intent
 * costs one read by primary key. On a server where sharing is not wired in, the step passes
 * through, and no device is anyone's.
 */
export const makePairingSessionIssuer = Effect.serviceOption(PairingIntents).pipe(
  Effect.map(
    (intents) =>
      (grant: PairingGrant, credential: string) =>
      <
        S extends { readonly sessionId: AuthSessionId; readonly scopes: ReadonlyArray<string> },
        E,
        R,
      >(
        issue: Effect.Effect<S, E, R>,
      ): Effect.Effect<S, E | PairingIntentError, R> =>
        Option.match(intents, {
          onNone: () =>
            grant.subject === RETIRED_GUEST_SUBJECT || grant.subject === J5_LINK_PAIRING_SUBJECT
              ? Effect.fail(new PairingIntentError({ reason: "not_wired" }))
              : issue,
          onSome: (service) => service.issueSession({ grant, credential, issue }),
        }),
  ),
);

/** For upstream's MCP consent: whether a pairing code may approve an MCP client (FORK.md case 70). */
export const makeMcpApprovalCheck = Effect.serviceOption(PairingIntents).pipe(
  Effect.map(
    (intents) =>
      (grant: PairingGrant, credential: string): Effect.Effect<boolean, PairingIntentError> =>
        Option.match(intents, {
          onNone: () =>
            Effect.succeed(
              grant.subject !== RETIRED_GUEST_SUBJECT && grant.subject !== J5_LINK_PAIRING_SUBJECT,
            ),
          onSome: (service) => service.approvesMcpClient(grant, credential),
        }),
  ),
);

/**
 * For upstream's Connections link handler: records that the link it just made pairs a device for
 * the person whose device made it (FORK.md case 70). On a server where sharing is not wired in,
 * nothing is recorded.
 */
export const recordConnectionsLinkCreator = (input: {
  readonly creator: SessionIdentity;
  readonly link: { readonly id: string; readonly credential: string };
  readonly scopes: ReadonlyArray<string>;
}) =>
  Effect.serviceOption(PairingIntents).pipe(
    Effect.flatMap((intents) =>
      Option.match(intents, {
        onNone: () => Effect.void,
        onSome: (service) =>
          service.recordForCreator({
            creator: input.creator,
            pairingLinkId: input.link.id,
            credential: input.link.credential,
            scopes: input.scopes,
          }),
      }),
    ),
  );
