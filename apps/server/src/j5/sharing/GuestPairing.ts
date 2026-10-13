// @effect-diagnostics nodeBuiltinImport:off - hashes the credential a link is found by.
import * as NodeCrypto from "node:crypto";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  type AuthEnvironmentScope,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ParticipantId } from "../a2a/contracts.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";
import { GUEST_SESSION_SUBJECT } from "./PersonAccess.ts";

/**
 * How a guest's share link becomes a guest's session (Shared server AC19). A share link is one of
 * upstream's single-use pairing links carrying the subject `j5:guest`; this module records which
 * guest it was made for, and ties the session upstream issues from it to that guest at the moment
 * it is issued. Upstream's pairing code calls `makePairingSessionIssuer` (FORK.md case 70).
 */

/**
 * Everything a guest's session ever holds. A session's permissions cannot change after it is
 * issued, so a guest holds from the start what the higher level, Collaborate, needs: read, operate
 * and drive a preview. The grants narrow it. Nothing else may be added here without a security
 * review: `access:write` in particular lets a browser session approve an MCP client with the
 * whole toolkit, on a route the guest gate does not cover.
 */
export const GUEST_LINK_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
];

/**
 * How long a link can be used for once made, by the choices the dialogs offer. A share link pairs
 * one device, once, within that time.
 */
export const LINK_LIFETIMES = {
  "1h": Duration.hours(1),
  "24h": Duration.hours(24),
  "7d": Duration.days(7),
  "30d": Duration.days(30),
} as const;
export type LinkLifetime = keyof typeof LINK_LIFETIMES;
export const DEFAULT_LINK_LIFETIME: LinkLifetime = "7d";

/** The time a lifetime stands for; nothing for a word that is not one of the choices. */
export const linkLifetime = (lifetime: string | undefined) =>
  lifetime === undefined
    ? LINK_LIFETIMES[DEFAULT_LINK_LIFETIME]
    : Object.hasOwn(LINK_LIFETIMES, lifetime)
      ? LINK_LIFETIMES[lifetime as LinkLifetime]
      : undefined;

export class GuestPairingError extends Schema.TaggedError<GuestPairingError>()(
  "GuestPairingError",
  {
    reason: Schema.Literals(["not_wired", "scopes", "no_person", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_wired":
        return "This server cannot pair a guest: sharing is not set up in it.";
      case "scopes":
        return "This link carries permissions a guest may not hold, and pairs nothing.";
      case "no_person":
        return "This link was not made for anyone who is still a guest of this server.";
      case "storage":
        return "Could not record which guest this device belongs to.";
    }
  }
}

/** What a member is told on opening a guest's link in a browser where they are signed in. */
export const MEMBER_OPENED_GUEST_LINK =
  "You are already signed in to this server as a member. This link is for a guest: send it to them rather than opening it.";

/** The name the refusal goes by on the wire, where the pairing page reads it. */
export const GUEST_LINK_FOR_MEMBER = "guest_link_for_member" as const;

/** Whether a rejected credential is J5's refusal of a member's browser opening a guest's link. */
export const isMemberOpenedGuestLink = (error: { readonly diagnostic?: string | undefined }) =>
  error.diagnostic === MEMBER_OPENED_GUEST_LINK;

/** What upstream's pairing code knows of a link when it is about to issue a session from it. */
export interface PairingGrant {
  readonly subject: string;
  readonly scopes: ReadonlyArray<string>;
}

export const isGuestPairingGrant = (grant: Pick<PairingGrant, "subject">) =>
  grant.subject === GUEST_SESSION_SUBJECT;

const hashCredential = (credential: string) =>
  NodeCrypto.createHash("sha256").update(credential).digest("hex");

export interface GuestPairingShape {
  /** Records the guest a pairing link was made for. */
  readonly recordLink: (input: {
    readonly pairingLinkId: string;
    readonly credential: string;
    readonly personId: ParticipantId;
  }) => Effect.Effect<void, GuestPairingError>;
  /** Whether a credential is a share link made for a guest. Reading it uses nothing up. */
  readonly isGuestLink: (credential: string) => Effect.Effect<boolean, GuestPairingError>;
  /** The link and guest a credential belongs to, read without using it; `null` for any other. */
  readonly linkOf: (
    credential: string,
  ) => Effect.Effect<
    { readonly pairingLinkId: string; readonly personId: ParticipantId } | null,
    GuestPairingError
  >;
  /** Forgets the guest a link was made for; `false` when the link is not a guest's. */
  readonly forgetLink: (pairingLinkId: string) => Effect.Effect<boolean, GuestPairingError>;
  /** The unused links recorded for guests, by upstream's link id. */
  readonly linkPeople: Effect.Effect<ReadonlyMap<string, ParticipantId>, GuestPairingError>;
  /**
   * Runs `issue`, which issues the session a guest's link pairs, and ties that session to the
   * guest the link was made for. The two commit together or not at all: a link that names no
   * guest issues nothing, and a session whose person cannot be recorded is not kept.
   */
  readonly issueSession: <S extends { readonly sessionId: AuthSessionId }, E, R>(input: {
    readonly grant: PairingGrant;
    readonly credential: string;
    readonly issue: Effect.Effect<S, E, R>;
  }) => Effect.Effect<S, E | GuestPairingError, R>;
}

export class GuestPairing extends Context.Service<GuestPairing, GuestPairingShape>()(
  "t3/j5/sharing/GuestPairing",
) {}

const make: Layer.Layer<GuestPairing, never, SqlClient.SqlClient | ReadChanges> = Layer.effect(
  GuestPairing,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The People page lists each guest's unused links and devices, which are written here.
    const peopleChanged = (yield* ReadChanges).notify("sharing");
    const storage = (cause: unknown) => new GuestPairingError({ reason: "storage", cause });

    return GuestPairing.of({
      recordLink: Effect.fn("j5.sharing.guestPairing.recordLink")(function* (input) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO j5_a2a_guest_link (pairing_link_id, credential_hash, person_id, created_at)
          SELECT ${input.pairingLinkId}, ${hashCredential(input.credential)}, person_id, ${createdAt}
          FROM j5_a2a_human_person
          WHERE person_id = ${input.personId} AND kind = 'guest'
          RETURNING pairing_link_id
        `.pipe(
          Effect.mapError(storage),
          Effect.filterOrFail(
            (rows) => rows.length === 1,
            () => new GuestPairingError({ reason: "no_person" }),
          ),
        );
        yield* peopleChanged;
      }),

      isGuestLink: (credential) =>
        sql`
          SELECT 1 AS found FROM j5_a2a_guest_link
          WHERE credential_hash = ${hashCredential(credential)}
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(storage),
          Effect.withSpan("j5.sharing.guestPairing.isGuestLink"),
        ),

      linkOf: (credential) =>
        sql<{ readonly pairing_link_id: string; readonly person_id: string }>`
          SELECT pairing_link_id, person_id FROM j5_a2a_guest_link
          WHERE credential_hash = ${hashCredential(credential)}
        `.pipe(
          Effect.map((rows) =>
            rows[0] === undefined
              ? null
              : {
                  pairingLinkId: rows[0].pairing_link_id,
                  personId: rows[0].person_id as ParticipantId,
                },
          ),
          Effect.mapError(storage),
          Effect.withSpan("j5.sharing.guestPairing.linkOf"),
        ),

      forgetLink: (pairingLinkId) =>
        sql`
          DELETE FROM j5_a2a_guest_link WHERE pairing_link_id = ${pairingLinkId}
          RETURNING pairing_link_id
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(storage),
          Effect.tap((forgotten) => (forgotten ? peopleChanged : Effect.void)),
          Effect.withSpan("j5.sharing.guestPairing.forgetLink"),
        ),

      linkPeople: sql<{ readonly pairing_link_id: string; readonly person_id: string }>`
        SELECT pairing_link_id, person_id FROM j5_a2a_guest_link
      `.pipe(
        Effect.map(
          (rows) =>
            new Map(rows.map((row) => [row.pairing_link_id, row.person_id as ParticipantId])),
        ),
        Effect.mapError(storage),
        Effect.withSpan("j5.sharing.guestPairing.linkPeople"),
      ),

      issueSession: Effect.fn("j5.sharing.guestPairing.issueSession")(function* (input) {
        // Checked where the session is made, so a guest's link minted by any other path with
        // more than a guest may hold pairs nothing.
        if (
          !input.grant.scopes.every((scope) =>
            (GUEST_LINK_SCOPES as ReadonlyArray<string>).includes(scope),
          )
        ) {
          return yield* new GuestPairingError({ reason: "scopes" });
        }
        const people = yield* sql<{ readonly person_id: string }>`
          SELECT link.person_id
          FROM j5_a2a_guest_link AS link
          JOIN j5_a2a_human_person AS person ON person.person_id = link.person_id
          WHERE link.credential_hash = ${hashCredential(input.credential)} AND person.kind = 'guest'
        `.pipe(Effect.mapError(storage));
        const personId = people[0]?.person_id;
        if (personId === undefined) return yield* new GuestPairingError({ reason: "no_person" });
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const session = yield* input.issue.pipe(
                Effect.mapError((error) => ({ issue: error })),
              );
              const boundAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
                INSERT INTO j5_a2a_person_session (session_id, person_id, bound_at)
                VALUES (${session.sessionId}, ${personId}, ${boundAt})
              `;
              return session;
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              typeof error === "object" && error !== null && "issue" in error
                ? error.issue
                : storage(error),
            ),
            // Committed: the link is used up and the guest has a device.
            Effect.tap(() => peopleChanged),
          );
      }),
    });
  }),
);

// `readChangesLayer` is the one the rest of the server provides, so it is the same instance
// (see `a2a/runtimeLayer.ts`).
export const layer: Layer.Layer<GuestPairing, never, SqlClient.SqlClient> = make.pipe(
  Layer.provide(readChangesLayer),
);

/**
 * For upstream's pairing code, read once where `EnvironmentAuth` is built: wraps the step that
 * issues a session from a pairing link, as a step in its pipe. Any link but a guest's passes
 * straight through, compared by subject alone, so pairing a member's device costs nothing more. A
 * guest's link issues a session only together with the record of whose it is; on a server where
 * sharing is not wired in, a guest's link pairs nothing rather than a session that belongs to no
 * one.
 */
export const makePairingSessionIssuer = Effect.serviceOption(GuestPairing).pipe(
  Effect.map(
    (pairing) =>
      (grant: PairingGrant, credential: string) =>
      <S extends { readonly sessionId: AuthSessionId }, E, R>(
        issue: Effect.Effect<S, E, R>,
      ): Effect.Effect<S, E | GuestPairingError, R> =>
        !isGuestPairingGrant(grant)
          ? issue
          : Option.match(pairing, {
              onNone: () => Effect.fail(new GuestPairingError({ reason: "not_wired" })),
              onSome: (service) => service.issueSession({ grant, credential, issue }),
            }),
  ),
);
