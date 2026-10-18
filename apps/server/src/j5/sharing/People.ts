import type { AuthClientSession, AuthSessionId, ThreadId } from "@t3tools/contracts";
import {
  type PersonLevel,
  type PersonScope,
  type SharingGrant,
  type SharingGrantLevel,
  type SharingLink,
  type SharingOwnGrant,
  type SharingPendingLink,
  type SharingPerson,
  SharingThreadPeople,
  devicePermissions,
  highestLevel,
  isPersonName,
  levelReaches,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import { Access, type AccessRenewalError, type NotYoursToLeaveError } from "./Access.ts";
import {
  J5_LINK_PAIRING_SUBJECT,
  PairingIntents,
  type PairingIntentError,
} from "./PairingIntents.ts";
import {
  type FirstOwnerFixedError,
  type HeldLevel,
  type OwnerOutsideServerError,
  PersonAccess,
  type PersonAccessStorageError,
  type PersonNameTakenError,
  PersonNotFoundError,
  type PersonRecord,
  type SessionIdentity,
} from "./PersonAccess.ts";

/**
 * What an Owner does to people, their levels, devices and links, over the requests the People
 * page and the Share dialog make today. Each change goes through `Access`, which renews the
 * person's devices when it must. The transports over it check who may call which: every change
 * needs upstream's Manage access, which only an Owner's devices hold. No agent tool reaches this
 * service: an agent cannot share (AC34).
 *
 * The requests still speak of members, guests and grants; a member here is anyone who writes to
 * the whole server, and a grant a level at a project or thread.
 */

export class GrantTargetNotFoundError extends Schema.TaggedError<GrantTargetNotFoundError>()(
  "GrantTargetNotFoundError",
  { kind: Schema.Literals(["project", "thread"]), id: Schema.String },
) {
  override get message(): string {
    return `There is no ${this.kind} ${this.id} on this server to share.`;
  }
}

export class DeviceNotAPersonsError extends Schema.TaggedError<DeviceNotAPersonsError>()(
  "DeviceNotAPersonsError",
  { sessionId: Schema.String },
) {
  override get message(): string {
    return `Device ${this.sessionId} is not paired as anyone on this server.`;
  }
}

export class LinkNotAPersonsError extends Schema.TaggedError<LinkNotAPersonsError>()(
  "LinkNotAPersonsError",
  { linkId: Schema.String },
) {
  override get message(): string {
    return `Link ${this.linkId} is not a link made for someone on this server.`;
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

export class PeopleUpstreamError extends Schema.TaggedError<PeopleUpstreamError>()(
  "PeopleUpstreamError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

/**
 * A name as it is stored: trimmed, and refused unless it is one a person may have. Every way of
 * naming someone checks it here, the offline build of a live-test home included.
 */
export const checkedPersonName = (name: string): Effect.Effect<string, PersonNameError> => {
  const trimmed = name.trim();
  return isPersonName(trimmed) ? Effect.succeed(trimmed) : Effect.fail(new PersonNameError({}));
};

/** How long a link can be used for once made, by the choices the dialogs offer. */
export const LINK_LIFETIMES = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
} as const;
const LINK_LIFETIME_MILLIS: Record<keyof typeof LINK_LIFETIMES, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

type StorageError = PersonAccessStorageError | PeopleUpstreamError | PairingIntentError;
type ChangeError =
  | StorageError
  | PersonNotFoundError
  | FirstOwnerFixedError
  | OwnerOutsideServerError
  | AccessRenewalError;

/** What the requests call a grant's target: a project or a thread. */
export type GrantTarget = Exclude<PersonScope, { readonly kind: "server" }>;

export interface PeopleShape {
  /** Every person, with what each can reach, their devices and their unused links. */
  readonly list: Effect.Effect<ReadonlyArray<SharingPerson>, StorageError>;
  readonly createGuest: (input: {
    readonly displayName: string;
  }) => Effect.Effect<
    SharingPerson,
    StorageError | PersonNameError | PersonNameTakenError | OwnerNameRequiredError
  >;
  /** Names the server's first owner. */
  readonly setOwnerName: (input: {
    readonly displayName: string;
  }) => Effect.Effect<
    SharingPerson,
    StorageError | PersonNotFoundError | PersonNameError | PersonNameTakenError
  >;
  /** Gives a person a level at a project or thread, or changes the one they hold there. */
  readonly putGrant: (input: {
    readonly personId: string;
    readonly target: GrantTarget;
    readonly level: SharingGrantLevel;
  }) => Effect.Effect<SharingPerson, ChangeError | GrantTargetNotFoundError>;
  readonly removeGrant: (input: {
    readonly personId: string;
    readonly target: GrantTarget;
  }) => Effect.Effect<SharingPerson, ChangeError>;
  /** Removes a person: their devices and unused links end, and what they held goes (AC49). */
  readonly removePerson: (personId: string) => Effect.Effect<void, ChangeError>;
  /** Ends one device of a person's; the person and their levels stay. */
  readonly revokeDevice: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<void, StorageError | DeviceNotAPersonsError>;
  /** A link that pairs one device as this person: their first, or a further one. */
  readonly createLink: (
    personId: string,
    lifetime?: string,
  ) => Effect.Effect<
    SharingLink,
    StorageError | PersonNotFoundError | LinkLifetimeError | OwnerNameRequiredError
  >;
  /** Gives a person a new name, under the rule every person's name is held to. */
  readonly rename: (input: {
    readonly personId: string;
    readonly displayName: string;
  }) => Effect.Effect<
    SharingPerson,
    StorageError | PersonNotFoundError | PersonNameError | PersonNameTakenError
  >;
  /**
   * Who reaches a thread, for a connection that reaches it itself. Someone narrower than the
   * server is told the others' names and levels, and not their ids.
   */
  readonly threadPeople: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Effect.Effect<SharingThreadPeople, StorageError | ThreadNotSharedError>;
  /** A count that moves each time `threadPeople` would answer differently for that connection. */
  readonly watchThreadPeople: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Stream.Stream<number, StorageError | ThreadNotSharedError>;
  /** Cancels a link that has not been used yet. */
  readonly revokeLink: (linkId: string) => Effect.Effect<void, StorageError | LinkNotAPersonsError>;
  /** Refuses while the first owner has no name; what bringing a new person in is held to. */
  readonly requireOwnerName: Effect.Effect<void, StorageError | OwnerNameRequiredError>;
  /** The levels this connection's person holds at projects and threads. */
  readonly ownGrants: (
    session: SessionIdentity,
  ) => Effect.Effect<ReadonlyArray<SharingOwnGrant>, StorageError>;
  /** A person gives up a level they hold (AC48). */
  readonly leaveGrant: (
    session: SessionIdentity,
    target: GrantTarget,
  ) => Effect.Effect<void, ChangeError | NotYoursToLeaveError>;
}

export class People extends Context.Service<People, PeopleShape>()("t3/j5/sharing/People") {}

const toGrantLevel = (level: PersonLevel): SharingGrantLevel =>
  level === "viewer" ? "view" : "collaborate";
const fromGrantLevel = (level: SharingGrantLevel): PersonLevel =>
  level === "view" ? "viewer" : "collaborator";

const grantsOf = (levels: ReadonlyArray<HeldLevel>): ReadonlyArray<SharingGrant> =>
  levels.flatMap((held): ReadonlyArray<SharingGrant> =>
    held.scope.kind === "server"
      ? []
      : [{ target: held.scope, level: toGrantLevel(held.level), note: null }],
  );

/** Whether a person writes to the whole server, which the requests call a member. */
const isMember = (record: { readonly levels: ReadonlyArray<HeldLevel> }) =>
  record.levels.some(
    (held) => held.scope.kind === "server" && levelReaches(held.level, "collaborator"),
  );

const isParticipantId = Schema.is(ParticipantId);
const encodeThreadPeople = Schema.encodeSync(Schema.fromJsonString(SharingThreadPeople));

export const layer: Layer.Layer<
  People,
  never,
  PersonAccess | Access | PairingIntents | EnvironmentAuth.EnvironmentAuth | SqlClient.SqlClient
> = Layer.effect(
  People,
  Effect.gen(function* () {
    const people = yield* PersonAccess;
    const access = yield* Access;
    const intents = yield* PairingIntents;
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

    /** The unused links recorded for people, by upstream's link id. */
    const intentPeople = sql<{ readonly pairing_link_id: string; readonly person_id: string }>`
      SELECT pairing_link_id, person_id FROM j5_a2a_pairing_intent
    `.pipe(upstream("read the links made for people"));

    const describe = (
      records: ReadonlyArray<PersonRecord>,
      sessions: ReadonlyArray<AuthClientSession>,
      links: ReadonlyMap<string, ReadonlyArray<SharingPendingLink>>,
    ) => {
      const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
      return records.map((record): SharingPerson => ({
        personId: record.person.personId,
        kind: isMember(record) ? "member" : "guest",
        displayName: record.person.displayName,
        you: record.person.firstOwner,
        nameSelfGiven: false,
        joinedOpenLinkId: null,
        createdAt: record.createdAt,
        grants: grantsOf(record.levels),
        // A recorded session upstream no longer lists has expired or been ended.
        devices: record.devices.flatMap((device) => {
          const session = sessionById.get(device.sessionId);
          return session === undefined
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
      const records = yield* people.listPeople;
      const sessions = yield* auth.listSessions().pipe(upstream("list devices"));
      const linkPeople = new Map(
        (yield* intentPeople).map((row) => [row.pairing_link_id, row.person_id]),
      );
      const links = new Map<string, Array<SharingPendingLink>>();
      // Upstream lists only links that can still be used.
      for (const link of yield* auth.listPairingLinks().pipe(upstream("list links"))) {
        const personId = linkPeople.get(link.id);
        if (personId === undefined) continue;
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

    const threadPeople: PeopleShape["threadPeople"] = Effect.fn("j5.sharing.people.threadPeople")(
      function* (session, threadId) {
        const reach = yield* people.sessionReach(session);
        const wide = reach.kind === "service" || (reach.kind === "person" && isMember(reach));
        if (
          !wide &&
          (reach.kind !== "person" ||
            (yield* people.threadLevel(reach.person.personId, threadId)) === null)
        ) {
          return yield* new ThreadNotSharedError({});
        }
        const everyone = yield* people.scopePeople({ kind: "thread", threadId });
        const narrowCaller = !wide;
        const callerId = reach.kind === "person" ? reach.person.personId : null;
        const nearness = { thread: 0, ancestor: 1, project: 2, server: 3 } as const;
        const members = everyone.filter((entry) =>
          entry.via.some((via) => via.via === "server" && levelReaches(via.level, "collaborator")),
        );
        const guests = everyone
          .filter((entry) => !members.includes(entry))
          .map((entry) => ({
            ...entry,
            via: entry.via.toSorted((left, right) => nearness[left.via] - nearness[right.via]),
          }));
        return {
          members: members.map((member) => ({
            personId: narrowCaller ? null : member.person.personId,
            displayName: member.person.displayName,
          })),
          openLinks: [],
          guests: guests.map((guest) => ({
            personId: narrowCaller ? null : guest.person.personId,
            displayName: guest.person.displayName,
            level: toGrantLevel(guest.level),
            grants: guest.via.flatMap((via) =>
              via.via === "server" ? [] : [{ via: via.via, level: toGrantLevel(via.level) }],
            ),
            you: callerId === guest.person.personId,
            nameSelfGiven: false,
            joinedByOpenLink: false,
          })),
        };
      },
    );

    /**
     * Bringing someone in waits for the first owner to have a name: the people shared with are
     * told whose server they are on. Giving more access to someone already here does not wait.
     */
    const requireOwnerName = people.firstOwner.pipe(
      Effect.flatMap((owner) =>
        owner.displayName === null ? Effect.fail(new OwnerNameRequiredError({})) : Effect.void,
      ),
    );

    return People.of({
      list,

      createGuest: Effect.fn("j5.sharing.people.createGuest")(function* (input) {
        yield* requireOwnerName;
        const displayName = yield* checkedPersonName(input.displayName);
        const person = yield* people.createPerson({ displayName });
        return yield* one(person.personId).pipe(Effect.orDie);
      }),

      putGrant: Effect.fn("j5.sharing.people.putGrant")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        yield* requireTarget(input.target);
        yield* access.setLevel({
          personId,
          scope: input.target,
          level: fromGrantLevel(input.level),
        });
        return yield* one(personId);
      }),

      removeGrant: Effect.fn("j5.sharing.people.removeGrant")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        // Read first, so a level on someone who does not exist is a refusal and not a silent no.
        yield* one(personId);
        yield* access.removeLevel({ personId, scope: input.target });
        return yield* one(personId);
      }),

      removePerson: Effect.fn("j5.sharing.people.removePerson")(function* (rawPersonId) {
        // `Access` ends their devices and revokes their unused links with them.
        yield* access.removePerson(yield* personIdOf(rawPersonId));
      }),

      revokeDevice: Effect.fn("j5.sharing.people.revokeDevice")(function* (sessionId) {
        const sessions = yield* auth.listSessions().pipe(upstream("list devices"));
        const session = sessions.find((entry) => entry.sessionId === sessionId);
        const reach = session === undefined ? null : yield* people.sessionReach(session);
        if (reach === null || reach.kind !== "person") {
          return yield* new DeviceNotAPersonsError({ sessionId });
        }
        // Ending a session through `auth` cuts it loose from its person first (`AccessGate`).
        yield* auth.revokeSession(sessionId).pipe(upstream("end the device"));
      }),

      createLink: Effect.fn("j5.sharing.people.createLink")(function* (rawPersonId, lifetime) {
        yield* requireOwnerName;
        const choice = lifetime ?? "7d";
        if (!Object.hasOwn(LINK_LIFETIME_MILLIS, choice)) {
          return yield* new LinkLifetimeError({ lifetime: choice });
        }
        const personId = yield* personIdOf(rawPersonId);
        const person = yield* people.readPerson(personId);
        if (person === null) return yield* new PersonNotFoundError({ personId });
        const levels = yield* people.listLevels(personId);
        const link = yield* auth
          .createPairingLink({
            subject: J5_LINK_PAIRING_SUBJECT,
            scopes: devicePermissions(highestLevel(levels.map((held) => held.level)), null),
            ttl: Duration.millis(LINK_LIFETIME_MILLIS[choice as keyof typeof LINK_LIFETIMES]),
            ...(person.displayName === null ? {} : { label: person.displayName }),
          })
          .pipe(upstream("make a link"));
        // A link with no person recorded would pair a device no one owns, so one that cannot be
        // recorded is revoked rather than handed out.
        yield* intents
          .record({
            pairingLinkId: link.id,
            credential: link.credential,
            personId,
            linkId: null,
            ceiling: null,
          })
          .pipe(Effect.tapError(() => Effect.ignore(auth.revokePairingLink(link.id))));
        return {
          linkId: link.id,
          personId,
          credential: link.credential,
          expiresAt: link.expiresAt,
        };
      }),

      revokeLink: Effect.fn("j5.sharing.people.revokeLink")(function* (linkId) {
        // Forgotten first: a link with no person recorded pairs no one's device.
        if (!(yield* intents.forget(linkId))) return yield* new LinkNotAPersonsError({ linkId });
        yield* auth.revokePairingLink(linkId).pipe(upstream("revoke the link"));
      }),

      setOwnerName: Effect.fn("j5.sharing.people.setOwnerName")(function* (input) {
        const displayName = yield* checkedPersonName(input.displayName);
        const owner = yield* people.firstOwner;
        yield* access.rename({ personId: owner.personId, displayName });
        return yield* one(owner.personId).pipe(Effect.orDie);
      }),

      rename: Effect.fn("j5.sharing.people.rename")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        const displayName = yield* checkedPersonName(input.displayName);
        yield* access.rename({ personId, displayName });
        return yield* one(personId);
      }),

      requireOwnerName,

      threadPeople,

      watchThreadPeople: (session, threadId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribed before the first read, so no change between the two is missed.
            const changes = yield* people.subscribeChanges;
            const read = threadPeople(session, threadId).pipe(Effect.map(encodeThreadPeople));
            return Stream.fromEffect(read).pipe(
              Stream.concat(Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => read))),
              Stream.changes,
              Stream.zipWithIndex,
              Stream.map(([, index]) => index),
            );
          }),
        ),

      ownGrants: Effect.fn("j5.sharing.people.ownGrants")(function* (session) {
        const reach = yield* people.sessionReach(session);
        if (reach.kind !== "person") return [];
        return grantsOf(reach.levels).map((grant): SharingOwnGrant => ({
          target: grant.target,
          level: grant.level,
        }));
      }),

      leaveGrant: (session, target) => access.leave(session, target),
    });
  }),
);
