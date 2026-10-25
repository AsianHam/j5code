import type { AuthSessionId } from "@t3tools/contracts";
import {
  type PersonLevel,
  type PersonScope,
  devicePermissions,
  levelForUnknownDevice,
  levelReaches,
  samePermissions,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import type { ParticipantId } from "../a2a/contracts.ts";
import {
  type FirstOwnerFixedError,
  type HeldLevel,
  type OwnerOutsideServerError,
  PersonAccess,
  PersonAccessStorageError,
  type PersonNameTakenError,
  type PersonNotFoundError,
  type SessionIdentity,
  sameScope,
} from "./PersonAccess.ts";

/**
 * Every change to what a person holds, and what follows from it (People and access AC12, AC17).
 *
 * A device's permissions are fixed in its session when upstream issues it, and whether a
 * connection is narrowed is decided when it opens. So a change that lowers or takes away anything
 * a person holds, moves them between narrowed and not, or changes the permissions their level
 * gives, revokes each of their devices' sessions for renewal: upstream closes the sockets open on
 * a revoked session at once, and the device then renews on J5's route with its old token
 * (`SessionRenewal.ts`), getting a session that holds its new permissions. A change that only adds
 * a scope stays live: a narrowed connection checks its scope on every request, and the feeds it
 * has open follow `PersonAccess.subscribeChanges`.
 *
 * The change, the renewal marks and the revocations commit together, so a lowered level never
 * outlives a failed revocation. What is told to subscribers is told after the commit.
 */

export class AccessRenewalError extends Schema.TaggedError<AccessRenewalError>()(
  "AccessRenewalError",
  { sessionId: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not end device ${this.sessionId}'s session so that it renews; nothing was changed.`;
  }
}

export class NotYoursToLeaveError extends Schema.TaggedError<NotYoursToLeaveError>()(
  "NotYoursToLeaveError",
  {},
) {
  override get message(): string {
    return "You hold no level of your own there, so there is nothing to leave.";
  }
}

export class DeviceAlreadyClaimedError extends Schema.TaggedError<DeviceAlreadyClaimedError>()(
  "DeviceAlreadyClaimedError",
  {},
) {
  override get message(): string {
    return "This device already belongs to someone on this server.";
  }
}

export class StaleMcpApprovalError extends Schema.TaggedError<StaleMcpApprovalError>()(
  "StaleMcpApprovalError",
  {},
) {
  override get message(): string {
    return "The server's Owners changed while this MCP client's approval was waiting. Approve it again.";
  }
}

/**
 * What an MCP client's approval was checked against, given to the exchange of its code: which
 * change of the server's Owners it was, and the person whose device or pairing code approved it,
 * or `null` when that names no one (the first owner's startup link, or a device no one claimed).
 */
export interface McpClientApproval {
  readonly generation: number;
  readonly approver: ParticipantId | null;
}

/** What changed for a person, told after it commits. */
export interface AccessChange {
  readonly personId: ParticipantId;
  readonly kind: "reach" | "name" | "removed";
}

type ChangeError =
  | PersonAccessStorageError
  | PersonNotFoundError
  | FirstOwnerFixedError
  | OwnerOutsideServerError
  | AccessRenewalError;

export interface AccessShape {
  readonly setLevel: (input: {
    readonly personId: ParticipantId;
    readonly scope: PersonScope;
    readonly level: PersonLevel;
  }) => Effect.Effect<void, ChangeError>;
  readonly removeLevel: (input: {
    readonly personId: ParticipantId;
    readonly scope: PersonScope;
  }) => Effect.Effect<void, ChangeError>;
  /** A person gives up a level they hold at a scope (AC48). */
  readonly leave: (
    session: SessionIdentity,
    scope: PersonScope,
  ) => Effect.Effect<void, ChangeError | NotYoursToLeaveError>;
  /**
   * Removes a person: every device of theirs is ended, the way any device is, and what they held
   * goes (AC49). Their record stays for the messages they wrote.
   */
  readonly removePerson: (personId: ParticipantId) => Effect.Effect<void, ChangeError>;
  /** A person's new name, told to whatever follows it, such as a shared conversation's note. */
  readonly rename: (input: {
    readonly personId: ParticipantId;
    readonly displayName: string;
  }) => Effect.Effect<void, PersonAccessStorageError | PersonNotFoundError | PersonNameTakenError>;
  /**
   * A device the server could not place says whose it is (AC5): someone already on the server, or
   * a new person at server scope at the level its permissions suggest. Its permissions as they
   * stand are its ceiling, so naming someone with more never gives it more. Its session is then
   * renewed, which is the one reconnect the person sees.
   */
  readonly claimDevice: (
    session: SessionIdentity & { readonly scopes: ReadonlyArray<string> },
    choice:
      | { readonly kind: "person"; readonly personId: ParticipantId }
      | { readonly kind: "new"; readonly displayName: string },
  ) => Effect.Effect<ParticipantId, ChangeError | PersonNameTakenError | DeviceAlreadyClaimedError>;
  /**
   * Revokes for renewal every live device whose permissions are not what its person's level and
   * its ceiling give now. Run once at startup, so a device paired under an older mapping, or a
   * guest's device from before levels, renews into the mapping this server has.
   */
  readonly renewOutdatedDevices: Effect.Effect<number, ChangeError>;
  readonly subscribe: Effect.Effect<PubSub.Subscription<AccessChange>, never, Scope.Scope>;
  /**
   * Which change of the server's Owners this is. Read under the same lock as a change of level,
   * before an MCP client's approval is checked, so whatever the check saw is no older than it.
   */
  readonly ownersGeneration: Effect.Effect<number, PersonAccessStorageError>;
  /**
   * Issues an MCP client's session, unless an Owner was lowered or removed since its approval was
   * checked: the approval may have been an Owner's who is not one now, and is refused to be
   * approved again. The session is recorded as its approver's, so lowering or removing them as an
   * Owner ends it. Held under the same lock as a change of level, so the two never cross.
   */
  readonly issueMcpClient: <
    A extends { readonly token: string; readonly expiresAt: DateTime.DateTime },
    E,
    R,
  >(
    approval: McpClientApproval,
    issue: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StaleMcpApprovalError | PersonAccessStorageError, R>;
}

export class Access extends Context.Service<Access, AccessShape>()("t3/j5/sharing/Access") {}

/**
 * Runs inside the transaction of every change `Access` makes to a person, after the change is
 * written and before it commits (and, through `beforeChange`, before it is written): a level set or removed, a scope left, a device claimed, a person
 * removed or renamed. What it records commits with the change or not at all. Shared
 * conversations record here that a thread gained a second writer, which a notice told after the
 * commit could miss when the writer was added and removed before it was read. Optional: without
 * it, a change does nothing more.
 */
export class AccessWriteHook extends Context.Service<
  AccessWriteHook,
  {
    readonly afterChange: (
      personId: ParticipantId,
    ) => Effect.Effect<void, PersonAccessStorageError>;
    /**
     * The same, before a change that can take something away is written, while what the person
     * held is still known: a level set or removed, a scope left, a person removed.
     */
    readonly beforeChange?: (
      personId: ParticipantId,
    ) => Effect.Effect<void, PersonAccessStorageError>;
  }
>()("t3/j5/sharing/Access/AccessWriteHook") {}

interface Snapshot {
  readonly levels: ReadonlyArray<HeldLevel>;
  readonly wide: boolean;
  readonly owner: boolean;
}

const snapshotOf = (levels: ReadonlyArray<HeldLevel>): Snapshot => {
  const server = levels.find((held) => held.scope.kind === "server")?.level ?? null;
  return {
    levels,
    wide: levelReaches(server, "collaborator"),
    owner: server === "owner",
  };
};

/** Whether `after` lost anything `before` held: a scope gone, or a level lower at one. */
const lowered = (before: Snapshot, after: Snapshot) =>
  before.levels.some(
    (held) =>
      !after.levels.some(
        (now) => sameScope(now.scope, held.scope) && levelReaches(now.level, held.level),
      ),
  );

const highestOf = (levels: ReadonlyArray<HeldLevel>): PersonLevel | null =>
  levels.reduce<PersonLevel | null>(
    (held, entry) => (levelReaches(held, entry.level) ? held : entry.level),
    null,
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* PersonAccess;
  const sessions = yield* SessionStore.SessionStore;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const writeHook = yield* Effect.serviceOption(AccessWriteHook);
  const afterChange = (personId: ParticipantId) =>
    Option.match(writeHook, {
      onNone: () => Effect.void,
      onSome: (hook) => hook.afterChange(personId),
    });
  const beforeChange = (personId: ParticipantId) =>
    Option.match(writeHook, {
      onNone: () => Effect.void,
      onSome: (hook) => hook.beforeChange?.(personId) ?? Effect.void,
    });
  // Unbounded: a subscriber withdraws a person's queued messages and ends their asks from what it
  // is told, so a change dropped in a burst would leave them standing. Changes are made by hand.
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<AccessChange>(), (pubsub) =>
    PubSub.shutdown(pubsub),
  );
  const tell = (change: AccessChange) => PubSub.publish(changes, change);
  // One transaction for a change and the renewals it requires; a failure to commit is storage's.
  const isSqlError = Schema.is(SqlError.SqlError);
  const committed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          isSqlError(cause)
            ? new PersonAccessStorageError({ operation: "commit a change of access", cause })
            : (cause as Exclude<E, SqlError.SqlError>),
        ),
      );

  /**
   * Marks a live device's session as one J5 ended for renewal, and ends it upstream. The mark is
   * set only on a binding not already marked, and only together with upstream revoking a session
   * that was live; anything else fails, and with it the change being made.
   */
  const revokeForRenewal = Effect.fn("j5.sharing.access.revokeForRenewal")(function* (
    sessionId: AuthSessionId,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const marked = yield* sql`
      UPDATE j5_a2a_person_session SET renew_pending_since = ${now}
      WHERE session_id = ${sessionId} AND renew_pending_since IS NULL
      RETURNING session_id
    `.pipe(Effect.mapError((cause) => new AccessRenewalError({ sessionId, cause })));
    const revoked = yield* sessions
      .revoke(sessionId)
      .pipe(Effect.mapError((cause) => new AccessRenewalError({ sessionId, cause })));
    if (marked.length !== 1 || !revoked) return yield* new AccessRenewalError({ sessionId });
  });

  /** The live sessions bound to a person, with the permissions each holds now. */
  const liveDevices = Effect.fn("j5.sharing.access.liveDevices")(function* (
    personId: ParticipantId,
  ) {
    const bound = yield* people.listDevices(personId);
    if (bound.length === 0) return [];
    const active = yield* sessions
      .listActive()
      .pipe(Effect.mapError((cause) => new AccessRenewalError({ sessionId: "", cause })));
    return bound.flatMap((device) => {
      const session = active.find((entry) => entry.sessionId === device.sessionId);
      return session === undefined || device.renewPendingSince !== null
        ? []
        : [{ ...device, scopes: session.permissions ?? session.scopes }];
    });
  });

  const ownersGeneration = yield* Ref.make(0);
  /**
   * Every MCP approval not yet issued, voided, whoever gave it: it may have been an Owner's who
   * is not one now, and the Owners who remain approve it again.
   */
  const voidWaitingMcpApprovals = Ref.update(ownersGeneration, (generation) => generation + 1);

  const mcpStorage = (operation: string) => (cause: unknown) =>
    new PersonAccessStorageError({ operation, cause });

  /** Records an issued MCP client's session as `personId`'s, and forgets those since expired. */
  const recordMcpApprover = Effect.fn("j5.sharing.access.recordMcpApprover")(function* (
    personId: ParticipantId,
    issued: { readonly token: string; readonly expiresAt: DateTime.DateTime },
  ) {
    const { sessionId } = yield* sessions
      .verify(issued.token)
      .pipe(Effect.mapError(mcpStorage("read the MCP client's session")));
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      DELETE FROM j5_a2a_mcp_client_approver WHERE expires_at <= ${now}
    `.pipe(Effect.mapError(mcpStorage("forget expired MCP clients")));
    yield* sql`
      INSERT INTO j5_a2a_mcp_client_approver (session_id, person_id, expires_at)
      VALUES (${sessionId}, ${personId}, ${DateTime.formatIso(issued.expiresAt)})
    `.pipe(Effect.mapError(mcpStorage("record who approved an MCP client")));
  });

  /**
   * Ends the MCP clients `personId` approved, in the transaction that lowers or removes them. A
   * session already ended or expired is passed over.
   */
  const endApprovedMcpClients = Effect.fn("j5.sharing.access.endApprovedMcpClients")(function* (
    personId: ParticipantId,
  ) {
    const approved = yield* sql<{ readonly session_id: AuthSessionId }>`
      DELETE FROM j5_a2a_mcp_client_approver WHERE person_id = ${personId}
      RETURNING session_id
    `.pipe(Effect.mapError(mcpStorage("read the MCP clients a person approved")));
    for (const { session_id: sessionId } of approved) {
      yield* sessions
        .revoke(sessionId)
        .pipe(Effect.mapError(mcpStorage("end an MCP client a person approved")));
    }
  });

  /**
   * Runs a change to one person and renews whichever of their devices it requires, all in one
   * transaction; then tells subscribers.
   */
  const changing = <A, E>(personId: ParticipantId, change: Effect.Effect<A, E>) =>
    committed(
      Effect.gen(function* () {
        const before = snapshotOf(yield* people.listLevels(personId));
        yield* beforeChange(personId);
        const result = yield* change;
        yield* afterChange(personId);
        const after = snapshotOf(yield* people.listLevels(personId));
        const narrowed = lowered(before, after) || before.wide !== after.wide;
        const highest = highestOf(after.levels);
        for (const device of yield* liveDevices(personId)) {
          const target = devicePermissions(highest, device.ceiling);
          if (narrowed || !samePermissions(target, device.scopes)) {
            yield* revokeForRenewal(device.sessionId);
          }
        }
        if (before.owner && !after.owner) {
          yield* voidWaitingMcpApprovals;
          yield* endApprovedMcpClients(personId);
        }
        return result;
      }),
    ).pipe(Effect.tap(() => tell({ personId, kind: "reach" })));

  return Access.of({
    setLevel: (input) => changing(input.personId, people.setLevel(input)),

    removeLevel: (input) => changing(input.personId, people.removeLevel(input)),

    leave: Effect.fn("j5.sharing.access.leave")(function* (session, scope) {
      const reach = yield* people.sessionReach(session);
      if (reach.kind !== "person" || !reach.levels.some((held) => sameScope(held.scope, scope))) {
        return yield* new NotYoursToLeaveError({});
      }
      yield* changing(
        reach.person.personId,
        people.removeLevel({ personId: reach.person.personId, scope }),
      );
    }),

    removePerson: Effect.fn("j5.sharing.access.removePerson")(function* (personId) {
      yield* committed(
        Effect.gen(function* () {
          // Read inside the transaction, so a promotion just before cannot be missed.
          const owner = snapshotOf(yield* people.listLevels(personId)).owner;
          // The pairing links still waiting to pair a device as them are revoked upstream, so
          // none of them can pair a device the server would then not know (AC49).
          const waiting = yield* sql<{ readonly pairing_link_id: string }>`
            SELECT pairing_link_id FROM j5_a2a_pairing_intent WHERE person_id = ${personId}
          `.pipe(
            Effect.mapError(
              (cause) =>
                new PersonAccessStorageError({ operation: "read a person's links", cause }),
            ),
          );
          for (const link of waiting) {
            yield* grants
              .revoke(link.pairing_link_id)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new PersonAccessStorageError({ operation: "revoke a person's link", cause }),
                ),
              );
          }
          // So are the J5 links made for them that have not been used.
          const revokedAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            UPDATE j5_a2a_link SET revoked_at = ${revokedAt}
            WHERE person_id = ${personId} AND revoked_at IS NULL
          `.pipe(
            Effect.mapError(
              (cause) =>
                new PersonAccessStorageError({ operation: "revoke a person's links", cause }),
            ),
          );
          yield* beforeChange(personId);
          const ended = yield* people.removePerson(personId);
          for (const sessionId of ended) {
            yield* sessions
              .revoke(sessionId)
              .pipe(Effect.mapError((cause) => new AccessRenewalError({ sessionId, cause })));
          }
          yield* afterChange(personId);
          if (owner) yield* voidWaitingMcpApprovals;
          yield* endApprovedMcpClients(personId);
        }),
      );
      yield* tell({ personId, kind: "removed" });
    }),

    rename: Effect.fn("j5.sharing.access.rename")(function* (input) {
      yield* committed(people.setName(input).pipe(Effect.andThen(afterChange(input.personId))));
      yield* tell({ personId: input.personId, kind: "name" });
    }),

    claimDevice: Effect.fn("j5.sharing.access.claimDevice")(function* (session, choice) {
      const reach = yield* people.sessionReach(session);
      if (reach.kind !== "unknown") return yield* new DeviceAlreadyClaimedError({});
      const personId = yield* committed(
        Effect.gen(function* () {
          const personId =
            choice.kind === "person"
              ? choice.personId
              : (yield* people.createPerson({ displayName: choice.displayName })).personId;
          if (choice.kind === "new") {
            yield* people.setLevel({
              personId,
              scope: { kind: "server" },
              level: levelForUnknownDevice(session.scopes),
            });
          }
          yield* people.bindSession({
            sessionId: session.sessionId,
            personId,
            ceiling: session.scopes,
          });
          yield* afterChange(personId);
          yield* revokeForRenewal(session.sessionId);
          return personId;
        }),
      );
      yield* tell({ personId, kind: "reach" });
      return personId;
    }),

    renewOutdatedDevices: Effect.gen(function* () {
      const everyone = yield* people.listPeople;
      let renewed = 0;
      // The first owner's devices are left as they are: their level never changes, their
      // permissions are their ceiling, and a phone among them could not renew.
      for (const record of everyone.filter((entry) => !entry.person.firstOwner)) {
        const highest = highestOf(record.levels);
        yield* committed(
          Effect.gen(function* () {
            for (const device of yield* liveDevices(record.person.personId)) {
              if (!samePermissions(devicePermissions(highest, device.ceiling), device.scopes)) {
                yield* revokeForRenewal(device.sessionId);
                renewed += 1;
              }
            }
          }),
        );
      }
      return renewed;
    }).pipe(Effect.withSpan("j5.sharing.access.renewOutdatedDevices")),

    subscribe: PubSub.subscribe(changes),

    ownersGeneration: committed(Ref.get(ownersGeneration)),

    issueMcpClient: (approval, issue) =>
      committed(
        Effect.gen(function* () {
          if ((yield* Ref.get(ownersGeneration)) !== approval.generation) {
            return yield* new StaleMcpApprovalError({});
          }
          const issued = yield* issue;
          if (approval.approver !== null) yield* recordMcpApprover(approval.approver, issued);
          return issued;
        }),
      ),
  });
});

export const layer: Layer.Layer<
  Access,
  never,
  | SqlClient.SqlClient
  | PersonAccess
  | SessionStore.SessionStore
  | PairingGrantStore.PairingGrantStore
> = Layer.effect(Access, make);

/**
 * Renews at startup every device whose permissions are not what its level gives: a guest's device
 * from before levels, or any device after an upstream advance reshaped the mapping. If it cannot
 * be done the server does not start, rather than run with devices above their level.
 */
export const renewOutdatedDevicesAtStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const access = yield* Access;
    const renewed = yield* access.renewOutdatedDevices;
    if (renewed > 0) yield* Effect.logInfo("J5 renewed devices into their level", { renewed });
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logError("J5 could not renew devices into their level; the server will not start", {
        cause,
      }),
    ),
    Effect.orDie,
  ),
);
