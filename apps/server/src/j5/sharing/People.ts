import type { AuthClientSession, AuthSessionId, ThreadId } from "@t3tools/contracts";
import {
  isPersonName,
  type SharingGrant,
  type SharingLink,
  type SharingOwnGrant,
  type SharingPendingLink,
  type SharingPerson,
  type SharingThreadPeople,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import {
  GUEST_LINK_SCOPES,
  linkLifetime,
  GuestPairing,
  type GuestPairingError,
} from "./GuestPairing.ts";
import {
  GUEST_SESSION_SUBJECT,
  type GrantLevel,
  type GrantOnMemberError,
  type GrantTarget,
  type MemberNotRemovableError,
  PersonAccess,
  type PersonAccessStorageError,
  type PersonGrant,
  type PersonNameTakenError,
  PersonNotFoundError,
  type PersonRecord,
  type SessionIdentity,
} from "./PersonAccess.ts";

/**
 * Bringing people in and deciding what they reach (Shared server AC17 to AC20, AC25). Everything a
 * member who manages access does to people, grants, devices and links is a method here, and so is
 * the one thing a guest does to its own access: leaving a grant. The transports over it check who
 * may call which. No agent tool reaches this service: an agent cannot share (AC17).
 */

export class GrantTargetNotFoundError extends Schema.TaggedError<GrantTargetNotFoundError>()(
  "GrantTargetNotFoundError",
  { kind: Schema.Literals(["project", "thread"]), id: Schema.String },
) {
  override get message(): string {
    return `There is no ${this.kind} ${this.id} on this server to share.`;
  }
}

export class DeviceNotAGuestsError extends Schema.TaggedError<DeviceNotAGuestsError>()(
  "DeviceNotAGuestsError",
  { sessionId: Schema.String },
) {
  override get message(): string {
    return `Device ${this.sessionId} is not paired as a guest. A member's device is ended from the server's own list of clients.`;
  }
}

export class LinkForMemberError extends Schema.TaggedError<LinkForMemberError>()(
  "LinkForMemberError",
  { personId: Schema.String },
) {
  override get message(): string {
    return `${this.personId} is a member of this server; a share link is made for a guest.`;
  }
}

export class LinkNotAGuestsError extends Schema.TaggedError<LinkNotAGuestsError>()(
  "LinkNotAGuestsError",
  { linkId: Schema.String },
) {
  override get message(): string {
    return `Link ${this.linkId} is not a share link made for a guest. A member's pairing link is revoked from the server's own list of pairing links.`;
  }
}

export class PersonNameError extends Schema.TaggedError<PersonNameError>()("PersonNameError", {}) {
  override get message(): string {
    return "A name is one line of ordinary, visible characters, up to 80 of them, with no square brackets.";
  }
}

export class LinkLifetimeError extends Schema.TaggedError<LinkLifetimeError>()(
  "LinkLifetimeError",
  { lifetime: Schema.String },
) {
  override get message(): string {
    return `A link lasts 1 hour, 24 hours, 7 days or 30 days; "${this.lifetime}" is none of those.`;
  }
}

export class ThreadNotSharedError extends Schema.TaggedError<ThreadNotSharedError>()(
  "ThreadNotSharedError",
  {},
) {
  override get message(): string {
    return "This is not shared with you on this server.";
  }
}

export class OwnerNameRequiredError extends Schema.TaggedError<OwnerNameRequiredError>()(
  "OwnerNameRequiredError",
  {},
) {
  override get message(): string {
    return "Set your name first, so the people you share with know who you are.";
  }
}

export class NotAGuestError extends Schema.TaggedError<NotAGuestError>()("NotAGuestError", {}) {
  override get message(): string {
    return "Only a guest can leave what was shared with them; this connection is a member's.";
  }
}

export class GrantNotHeldError extends Schema.TaggedError<GrantNotHeldError>()(
  "GrantNotHeldError",
  {},
) {
  override get message(): string {
    return "You do not hold that grant, so there is nothing to leave.";
  }
}

export class PeopleUpstreamError extends Schema.TaggedError<PeopleUpstreamError>()(
  "PeopleUpstreamError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

type StorageError = PersonAccessStorageError | PeopleUpstreamError | GuestPairingError;

export interface PeopleShape {
  /** Every person, with what each can reach, their devices and their unused links. */
  readonly list: Effect.Effect<ReadonlyArray<SharingPerson>, StorageError>;
  readonly createGuest: (input: {
    readonly displayName: string;
  }) => Effect.Effect<
    SharingPerson,
    StorageError | PersonNameError | PersonNameTakenError | OwnerNameRequiredError
  >;
  /**
   * Names the person the server belongs to. Every device that is not a guest's is that one
   * member's; there is one name to set, and no per-member identity.
   */
  readonly setOwnerName: (input: {
    readonly displayName: string;
  }) => Effect.Effect<SharingPerson, StorageError | PersonNameError | PersonNameTakenError>;
  /** Adds a grant, or changes one the guest already holds on that project or thread. */
  readonly putGrant: (input: {
    readonly personId: string;
    readonly target: GrantTarget;
    readonly level: GrantLevel;
    readonly note?: string | null;
  }) => Effect.Effect<
    SharingPerson,
    StorageError | PersonNotFoundError | GrantOnMemberError | GrantTargetNotFoundError
  >;
  readonly removeGrant: (input: {
    readonly personId: string;
    readonly target: GrantTarget;
  }) => Effect.Effect<SharingPerson, StorageError | PersonNotFoundError>;
  /** Removes a guest altogether, and ends their devices and unused links. */
  readonly removePerson: (
    personId: string,
  ) => Effect.Effect<void, StorageError | PersonNotFoundError | MemberNotRemovableError>;
  /** Ends one device of a guest's; the guest and their grants stay. */
  readonly revokeDevice: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<void, StorageError | DeviceNotAGuestsError>;
  /** A link that pairs one device as this guest: their first, or a further one (AC19, AC20). */
  readonly createLink: (
    personId: string,
    lifetime?: string,
  ) => Effect.Effect<
    SharingLink,
    | StorageError
    | PersonNotFoundError
    | LinkForMemberError
    | LinkLifetimeError
    | OwnerNameRequiredError
  >;
  /** Gives a guest a new name, under the rule every person's name is held to. */
  readonly rename: (input: {
    readonly personId: string;
    readonly displayName: string;
  }) => Effect.Effect<
    SharingPerson,
    StorageError | PersonNotFoundError | PersonNameError | PersonNameTakenError
  >;
  /**
   * Who can reach a thread, for a connection that can reach it itself: any member's, or a
   * guest's whose own grants cover it. A guest is told the others' names and levels, and not
   * their ids, devices, links or anything else they reach.
   */
  readonly threadPeople: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Effect.Effect<SharingThreadPeople, StorageError | ThreadNotSharedError>;
  /**
   * A count that starts at zero and moves each time `threadPeople` would answer differently for
   * that connection, so a client knows to ask again. It ends when the connection loses the
   * thread.
   */
  readonly watchThreadPeople: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Stream.Stream<number, StorageError | ThreadNotSharedError>;
  /** Cancels a share link that has not been used yet. */
  readonly revokeLink: (linkId: string) => Effect.Effect<void, StorageError | LinkNotAGuestsError>;
  /** Refuses while the owner has no name; what bringing a new person in is held to. */
  readonly requireOwnerName: Effect.Effect<void, StorageError | OwnerNameRequiredError>;
  /** The grants the guest on this connection holds; none for a member's connection. */
  readonly ownGrants: (
    session: SessionIdentity,
  ) => Effect.Effect<ReadonlyArray<SharingOwnGrant>, StorageError>;
  /** A guest gives up one grant it holds itself (AC25). */
  readonly leaveGrant: (
    session: SessionIdentity,
    target: GrantTarget,
  ) => Effect.Effect<void, StorageError | NotAGuestError | GrantNotHeldError>;
}

export class People extends Context.Service<People, PeopleShape>()("t3/j5/sharing/People") {}

const toSharingGrant = (grant: PersonGrant): SharingGrant => ({
  target: grant.target,
  level: grant.level,
  note: grant.note,
});

export const sameTarget = (left: GrantTarget, right: GrantTarget) =>
  left.kind === "project"
    ? right.kind === "project" && left.projectId === right.projectId
    : right.kind === "thread" && left.threadId === right.threadId;

const isParticipantId = Schema.is(ParticipantId);

export const layer: Layer.Layer<
  People,
  never,
  PersonAccess | GuestPairing | EnvironmentAuth.EnvironmentAuth | SqlClient.SqlClient
> = Layer.effect(
  People,
  Effect.gen(function* () {
    const access = yield* PersonAccess;
    const pairing = yield* GuestPairing;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sql = yield* SqlClient.SqlClient;

    const upstream =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.mapError((cause) => new PeopleUpstreamError({ operation, cause })));

    /** A person id as a client sent it. One that could not be an id names no one. */
    const personIdOf = (personId: string) =>
      isParticipantId(personId)
        ? Effect.succeed(personId)
        : Effect.fail(new PersonNotFoundError({ personId }));

    const describe = (
      records: ReadonlyArray<PersonRecord>,
      sessions: ReadonlyArray<AuthClientSession>,
      links: ReadonlyMap<ParticipantId, ReadonlyArray<SharingPendingLink>>,
    ) => {
      const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
      return records.map((record): SharingPerson => ({
        personId: record.person.personId,
        kind: record.person.kind,
        displayName: record.person.displayName,
        // Only a member's connection is told of people, and every such connection is the one
        // member there is.
        you: record.person.kind === "member",
        createdAt: record.createdAt,
        grants: record.grants.map(toSharingGrant),
        // A recorded session upstream no longer lists has expired or been ended.
        devices: record.sessionIds.flatMap((sessionId) => {
          const session = sessionById.get(sessionId);
          return session === undefined || session.subject !== GUEST_SESSION_SUBJECT
            ? []
            : [
                {
                  sessionId: session.sessionId,
                  client: session.client,
                  issuedAt: session.issuedAt,
                  expiresAt: session.expiresAt,
                  lastConnectedAt: session.lastConnectedAt,
                  connected: session.connected,
                },
              ];
        }),
        pendingLinks: links.get(record.person.personId) ?? [],
      }));
    };

    const list: PeopleShape["list"] = Effect.gen(function* () {
      const records = yield* access.listPeople;
      const sessions = yield* auth.listSessions().pipe(upstream("list devices"));
      const linkPeople = yield* pairing.linkPeople;
      const links = new Map<ParticipantId, Array<SharingPendingLink>>();
      // Upstream lists only links that can still be used.
      for (const link of yield* auth.listPairingLinks().pipe(upstream("list share links"))) {
        const personId = linkPeople.get(link.id);
        if (personId === undefined || link.subject !== GUEST_SESSION_SUBJECT) continue;
        links.set(personId, [
          ...(links.get(personId) ?? []),
          { linkId: link.id, createdAt: link.createdAt, expiresAt: link.expiresAt },
        ]);
      }
      return describe(records, sessions, links);
    }).pipe(Effect.withSpan("j5.sharing.people.list"));

    const one = Effect.fn("j5.sharing.people.one")(function* (personId: ParticipantId) {
      const person = (yield* list).find((candidate) => candidate.personId === personId);
      if (person === undefined) return yield* new PersonNotFoundError({ personId });
      return person;
    });

    const requireTarget = Effect.fn("j5.sharing.people.requireTarget")(function* (
      target: GrantTarget,
    ) {
      const found = yield* (
        target.kind === "project"
          ? sql<{ readonly found: number }>`
              SELECT 1 AS found FROM projection_projects
              WHERE project_id = ${target.projectId} AND deleted_at IS NULL
            `
          : sql<{ readonly found: number }>`
              SELECT 1 AS found FROM orchestration_v2_projection_threads
              WHERE thread_id = ${target.threadId} AND deleted_at IS NULL
            `
      ).pipe(upstream("read what is being shared"));
      if (found.length === 0) {
        return yield* new GrantTargetNotFoundError({
          kind: target.kind,
          id: target.kind === "project" ? target.projectId : target.threadId,
        });
      }
    });

    const higher = (levels: ReadonlyArray<GrantLevel>): GrantLevel =>
      levels.includes("collaborate") ? "collaborate" : "view";

    const threadPeople: PeopleShape["threadPeople"] = Effect.fn("j5.sharing.people.threadPeople")(
      function* (session, threadId) {
        const caller = yield* access.sessionPerson(session);
        // The gate asks the same of a guest's request; this holds for any other caller.
        if (caller !== null && (yield* access.threadAccess(session, threadId)) === "none") {
          return yield* new ThreadNotSharedError({});
        }
        const reach = yield* access.threadPeople(threadId);
        const toGuest = caller !== null;
        // The nearest grant first, and the people nearest the thread first, then by name.
        const nearness = { thread: 0, ancestor: 1, project: 2 } as const;
        const guests = reach.guests
          .map((guest) => ({
            person: guest.person,
            grants: guest.grants.toSorted(
              (left, right) => nearness[left.via] - nearness[right.via],
            ),
          }))
          .toSorted(
            (left, right) =>
              nearness[left.grants[0]!.via] - nearness[right.grants[0]!.via] ||
              (left.person.displayName ?? "").localeCompare(right.person.displayName ?? "") ||
              left.person.personId.localeCompare(right.person.personId),
          );
        return {
          members: reach.members.map((member) => ({
            personId: toGuest ? null : member.personId,
            displayName: member.displayName,
          })),
          guests: guests.map((guest) => ({
            personId: toGuest ? null : guest.person.personId,
            displayName: guest.person.displayName,
            level: higher(guest.grants.map((grant) => grant.level)),
            grants: guest.grants,
            you: caller !== null && caller.personId === guest.person.personId,
          })),
        };
      },
    );

    /**
     * Bringing someone in waits for the owner to have a name: the people shared with are told
     * who they are on the server of. Giving more access to someone already here does not wait.
     */
    const requireOwnerName = access.operatorName.pipe(
      Effect.flatMap((name) =>
        name === null ? Effect.fail(new OwnerNameRequiredError({})) : Effect.void,
      ),
    );

    return People.of({
      list,

      createGuest: Effect.fn("j5.sharing.people.createGuest")(function* (input) {
        yield* requireOwnerName;
        if (!isPersonName(input.displayName.trim())) return yield* new PersonNameError({});
        const guest = yield* access.createGuest({ displayName: input.displayName });
        return yield* one(guest.personId).pipe(Effect.orDie);
      }),

      putGrant: Effect.fn("j5.sharing.people.putGrant")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        yield* requireTarget(input.target);
        yield* access.putGrant({
          personId,
          target: input.target,
          level: input.level,
          ...(input.note === undefined ? {} : { note: input.note }),
        });
        return yield* one(personId);
      }),

      removeGrant: Effect.fn("j5.sharing.people.removeGrant")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        // Read first, so a grant on someone who does not exist is a refusal and not a silent no.
        yield* one(personId);
        yield* access.removeGrant({ personId, target: input.target });
        return yield* one(personId);
      }),

      removePerson: Effect.fn("j5.sharing.people.removePerson")(function* (rawPersonId) {
        const personId = yield* personIdOf(rawPersonId);
        // The record goes first: from here the guest's connections reach nothing, whatever
        // becomes of ending their sessions and links upstream.
        const removed = yield* access.removeGuest(personId);
        yield* Effect.forEach(removed.sessionIds, (sessionId) => auth.revokeSession(sessionId), {
          discard: true,
        }).pipe(upstream("end the person's devices"));
        yield* Effect.forEach(removed.pairingLinkIds, (id) => auth.revokePairingLink(id), {
          discard: true,
        }).pipe(upstream("revoke the person's unused links"));
      }),

      revokeDevice: Effect.fn("j5.sharing.people.revokeDevice")(function* (sessionId) {
        // Cut loose here because that is also how it is known to be a guest's; ending any
        // session through `auth` cuts it loose too (`layerGatedEnvironmentAuth`).
        const personId = yield* access.unbindSession(sessionId);
        if (personId === null) return yield* new DeviceNotAGuestsError({ sessionId });
        yield* auth.revokeSession(sessionId).pipe(upstream("end the device"));
      }),

      createLink: Effect.fn("j5.sharing.people.createLink")(function* (rawPersonId, lifetime) {
        yield* requireOwnerName;
        const ttl = linkLifetime(lifetime);
        if (ttl === undefined) return yield* new LinkLifetimeError({ lifetime: lifetime ?? "" });
        const personId = yield* personIdOf(rawPersonId);
        const person = yield* access.readPerson(personId);
        if (person === null) return yield* new PersonNotFoundError({ personId });
        if (person.kind !== "guest") return yield* new LinkForMemberError({ personId });
        const link = yield* auth
          .createPairingLink({
            subject: GUEST_SESSION_SUBJECT,
            scopes: GUEST_LINK_SCOPES,
            ttl,
            ...(person.displayName === null ? {} : { label: person.displayName }),
          })
          .pipe(upstream("make a share link"));
        // A link with no guest recorded pairs nothing, so one that cannot be recorded is revoked
        // rather than handed out.
        yield* pairing
          .recordLink({ pairingLinkId: link.id, credential: link.credential, personId })
          .pipe(Effect.tapError(() => Effect.ignore(auth.revokePairingLink(link.id))));
        return {
          linkId: link.id,
          personId,
          credential: link.credential,
          expiresAt: link.expiresAt,
        };
      }),

      revokeLink: Effect.fn("j5.sharing.people.revokeLink")(function* (linkId) {
        // Forgotten first: a link with no guest recorded pairs nothing, whatever upstream does.
        if (!(yield* pairing.forgetLink(linkId))) return yield* new LinkNotAGuestsError({ linkId });
        yield* auth.revokePairingLink(linkId).pipe(upstream("revoke the share link"));
      }),

      setOwnerName: Effect.fn("j5.sharing.people.setOwnerName")(function* (input) {
        const displayName = input.displayName.trim();
        if (!isPersonName(displayName)) return yield* new PersonNameError({});
        const owner = yield* access.setOperatorName(displayName);
        return yield* one(owner.personId).pipe(Effect.orDie);
      }),

      rename: Effect.fn("j5.sharing.people.rename")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        const displayName = input.displayName.trim();
        // The contract says the same; this holds for any other caller.
        if (!isPersonName(displayName)) return yield* new PersonNameError({});
        yield* access.setGuestName({ personId, displayName });
        return yield* one(personId);
      }),

      requireOwnerName,

      threadPeople,

      watchThreadPeople: (session, threadId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribed before the first read, so no change between the two is missed.
            const changes = yield* access.subscribeGrantChanges;
            const read = threadPeople(session, threadId).pipe(Effect.map(JSON.stringify));
            return Stream.fromEffect(read).pipe(
              Stream.concat(Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => read))),
              Stream.changes,
              Stream.zipWithIndex,
              Stream.map(([, index]) => index),
            );
          }),
        ),

      ownGrants: Effect.fn("j5.sharing.people.ownGrants")(function* (session) {
        const person = yield* access.sessionPerson(session);
        if (person === null || person.personId === null) return [];
        // The line a member wrote about the guest is for the agent, and is not told to the guest.
        return (yield* access.listGrants(person.personId)).map((grant): SharingOwnGrant => ({
          target: grant.target,
          level: grant.level,
        }));
      }),

      leaveGrant: Effect.fn("j5.sharing.people.leaveGrant")(function* (session, target) {
        const person = yield* access.sessionPerson(session);
        if (person === null) return yield* new NotAGuestError({});
        const personId = person.personId;
        if (personId === null) return yield* new GrantNotHeldError({});
        const held = yield* access.listGrants(personId);
        if (!held.some((grant) => sameTarget(grant.target, target))) {
          return yield* new GrantNotHeldError({});
        }
        yield* access.removeGrant({ personId, target });
      }),
    });
  }),
);
