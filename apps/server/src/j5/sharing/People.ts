import type { AuthSessionId } from "@t3tools/contracts";
import {
  type PeopleEntry,
  type PersonDevice,
  type PersonLevel,
  type PersonScope,
  type ProjectOrThreadScope,
  type ScopePeople,
  ScopePeople as ScopePeopleSchema,
  type ScopeReach,
  levelReaches,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../../auth/SessionStore.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import { Access, type AccessRenewalError } from "./Access.ts";
import { Links, type LinkStorageError, type ScopeNotFoundError, requireScope } from "./Links.ts";
import { type PersonNameError, checkedPersonName } from "./personNames.ts";
import {
  type FirstOwnerFixedError,
  type OwnerOutsideServerError,
  PersonAccess,
  type PersonAccessStorageError,
  type PersonNameTakenError,
  PersonNotFoundError,
  type SessionIdentity,
  isWide,
  scopeColumns,
} from "./PersonAccess.ts";
import type { PairingIntentError } from "./PairingIntents.ts";

/**
 * People and their levels, as an Owner manages them from the People page and the Share dialog,
 * and as anyone who reaches a thread or project sees who else does
 * (docs/j5/product/features/people-and-access.md). Each change goes through `Access`, which
 * renews the person's devices when it must and runs its write hook. The transports over this
 * check who may call which: every change needs upstream's Manage access, which only an Owner's
 * devices hold. No agent tool reaches this service: an agent cannot share (AC34).
 */

export class ScopeNotSharedError extends Schema.TaggedError<ScopeNotSharedError>()(
  "ScopeNotSharedError",
  {},
) {
  override get message(): string {
    return "This is not shared with you on this server.";
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

export class NotAPersonError extends Schema.TaggedError<NotAPersonError>()("NotAPersonError", {}) {
  override get message(): string {
    return "This device is no one's on this server yet. Say who you are first.";
  }
}

export class DeviceEndError extends Schema.TaggedError<DeviceEndError>()("DeviceEndError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not end the device.";
  }
}

type StorageError =
  | PersonAccessStorageError
  | LinkStorageError
  | PairingIntentError
  | PeopleStorageError;
type ChangeError =
  | StorageError
  | PersonNotFoundError
  | FirstOwnerFixedError
  | OwnerOutsideServerError
  | AccessRenewalError;

export class PeopleStorageError extends Schema.TaggedError<PeopleStorageError>()(
  "PeopleStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

export interface PeopleShape {
  /** Everyone on the server, with their levels, devices and unused device links. */
  readonly list: (
    asker: SessionIdentity,
  ) => Effect.Effect<ReadonlyArray<PeopleEntry>, StorageError>;
  /**
   * Who reaches a thread or project, for a connection that reaches it itself (AC26). Only an
   * Owner is told each person's id, by which they act on them, and where each level is held.
   */
  readonly scopePeople: (
    asker: SessionIdentity,
    scope: ProjectOrThreadScope,
  ) => Effect.Effect<ScopePeople, StorageError | ScopeNotSharedError>;
  /** A count that moves each time `scopePeople` would answer differently for that connection. */
  readonly watchScopePeople: (
    asker: SessionIdentity,
    scope: ProjectOrThreadScope,
  ) => Stream.Stream<number, StorageError | ScopeNotSharedError>;
  /** Gives a person a level at a scope, or changes the one they hold there. */
  readonly setLevel: (input: {
    readonly personId: string;
    readonly scope: PersonScope;
    readonly level: PersonLevel;
  }) => Effect.Effect<void, ChangeError | ScopeNotFoundError>;
  readonly removeLevel: (input: {
    readonly personId: string;
    readonly scope: PersonScope;
  }) => Effect.Effect<void, ChangeError>;
  /** Removes a person: their devices and unused links end, and what they held goes (AC49). */
  readonly remove: (personId: string) => Effect.Effect<void, ChangeError>;
  readonly rename: (input: {
    readonly personId: string;
    readonly name: string;
  }) => Effect.Effect<
    void,
    StorageError | PersonNotFoundError | PersonNameError | PersonNameTakenError
  >;
  /** A person renames themselves (AC46). */
  readonly renameSelf: (
    session: SessionIdentity,
    name: string,
  ) => Effect.Effect<
    void,
    StorageError | PersonNotFoundError | PersonNameError | PersonNameTakenError | NotAPersonError
  >;
  /** Ends one device of a person's; the person and their levels stay (AC50). */
  readonly revokeDevice: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<void, StorageError | DeviceNotAPersonsError | DeviceEndError>;
}

export class People extends Context.Service<People, PeopleShape>()("t3/j5/sharing/People") {}

const isParticipantId = Schema.is(ParticipantId);
const encodeScopePeople = Schema.encodeSync(Schema.fromJsonString(ScopePeopleSchema));
const NEARNESS = { thread: 0, ancestor: 1, project: 2, server: 3 } as const;

export const layer: Layer.Layer<
  People,
  never,
  | PersonAccess
  | Access
  | Links
  | SessionStore.SessionStore
  | AuthSessionRepository
  | SqlClient.SqlClient
> = Layer.effect(
  People,
  Effect.gen(function* () {
    const people = yield* PersonAccess;
    const access = yield* Access;
    const links = yield* Links;
    const sessions = yield* SessionStore.SessionStore;
    const repository = yield* AuthSessionRepository;
    const sql = yield* SqlClient.SqlClient;

    /** A person id as a client sent it. One that could not be an id names no one. */
    const personIdOf = (personId: string) =>
      isParticipantId(personId)
        ? Effect.succeed(personId)
        : Effect.fail(new PersonNotFoundError({ personId }));

    const titleOf = Effect.fn("j5.sharing.people.titleOf")(function* (scope: PersonScope) {
      if (scope.kind === "server") return null;
      const rows = yield* (
        scope.kind === "project"
          ? sql<{ readonly title: string }>`
              SELECT title FROM projection_projects WHERE project_id = ${scope.projectId}
            `
          : sql<{ readonly title: string }>`
              SELECT title FROM orchestration_v2_projection_threads
              WHERE thread_id = ${scope.threadId}
            `
      ).pipe(
        Effect.mapError(
          (cause) => new PeopleStorageError({ operation: "read what is shared", cause }),
        ),
      );
      return rows[0]?.title ?? null;
    });

    const scopePeople: PeopleShape["scopePeople"] = Effect.fn("j5.sharing.people.scopePeople")(
      function* (asker, scope) {
        const reach = yield* people.sessionReach(asker);
        if (!isWide(reach)) {
          const held =
            reach.kind !== "person"
              ? null
              : scope.kind === "thread"
                ? yield* people.threadLevel(reach.person.personId, scope.threadId)
                : yield* people.projectLevel(reach.person.personId, scope.projectId);
          if (!levelReaches(held, "viewer")) return yield* new ScopeNotSharedError({});
        }
        const owner = reach.kind === "person" && levelReaches(reach.serverLevel, "owner");
        const askerId = reach.kind === "person" ? reach.person.personId : null;
        const everyone = yield* people.scopePeople(scope);
        const titles = new Map<string, string | null>();
        const title = (held: PersonScope) =>
          Effect.gen(function* () {
            const columns = scopeColumns(held);
            const key = `${columns.kind}:${columns.id}`;
            if (!titles.has(key)) titles.set(key, yield* titleOf(held));
            return titles.get(key) ?? null;
          });
        return {
          people: yield* Effect.forEach(everyone, (entry) =>
            Effect.gen(function* () {
              // Where a level is held is told only to an Owner: someone narrower would learn of a
              // thread or project above theirs that was never shared with them (AC26).
              const via = !owner
                ? []
                : yield* Effect.forEach(
                    entry.via.toSorted((left, right) => NEARNESS[left.via] - NEARNESS[right.via]),
                    (held): Effect.Effect<ScopeReach, PeopleStorageError> =>
                      title(held.scope).pipe(
                        Effect.map((scopeTitle) => ({
                          via: held.via,
                          level: held.level,
                          scope: held.scope,
                          scopeTitle,
                        })),
                      ),
                  );
              return {
                personId: owner ? entry.person.personId : null,
                name: entry.person.displayName,
                level: entry.level,
                via,
                firstOwner: entry.person.firstOwner,
                you: entry.person.personId === askerId,
              };
            }),
          ),
        };
      },
    );

    return People.of({
      list: Effect.fn("j5.sharing.people.list")(function* (asker) {
        const askerReach = yield* people.sessionReach(asker);
        const askerId = askerReach.kind === "person" ? askerReach.person.personId : null;
        const records = yield* people.listPeople;
        const active = yield* sessions
          .listActive()
          .pipe(
            Effect.mapError(
              (cause) => new PeopleStorageError({ operation: "list devices", cause }),
            ),
          );
        const sessionById = new Map(active.map((session) => [session.sessionId, session]));
        // A device J5 ended so it can renew is no longer live upstream, but is still theirs, and
        // an Owner may end it for good before it comes back.
        const at = yield* DateTime.now;
        const awaiting = new Map<string, PersonDevice>();
        for (const record of records) {
          for (const device of record.devices) {
            if (sessionById.has(device.sessionId) || device.renewPendingSince === null) continue;
            const stored = yield* repository
              .getById({ sessionId: device.sessionId })
              .pipe(
                Effect.mapError(
                  (cause) => new PeopleStorageError({ operation: "read a device", cause }),
                ),
              );
            if (Option.isNone(stored) || !DateTime.isGreaterThan(stored.value.expiresAt, at)) {
              continue;
            }
            const { client } = stored.value;
            awaiting.set(device.sessionId, {
              sessionId: device.sessionId,
              client: {
                deviceType: client.deviceType,
                ...(client.label ? { label: client.label } : {}),
                ...(client.ipAddress ? { ipAddress: client.ipAddress } : {}),
                ...(client.userAgent ? { userAgent: client.userAgent } : {}),
                ...(client.os ? { os: client.os } : {}),
                ...(client.browser ? { browser: client.browser } : {}),
              },
              issuedAt: stored.value.issuedAt,
              expiresAt: stored.value.expiresAt,
              lastConnectedAt: stored.value.lastConnectedAt,
              connected: false,
              permissions: [...stored.value.scopes],
              ceiling: device.ceiling === null ? null : [...device.ceiling],
            });
          }
        }
        const deviceLinks = (yield* links.list).filter((link) => link.kind === "device");
        return records.map((record): PeopleEntry => ({
          personId: record.person.personId,
          name: record.person.displayName,
          firstOwner: record.person.firstOwner,
          you: record.person.personId === askerId,
          levels: record.levels,
          // A recorded session upstream no longer lists, and that is not waiting to renew, has
          // expired or been ended.
          devices: record.devices.flatMap((device) => {
            const session = sessionById.get(device.sessionId);
            const waiting = awaiting.get(device.sessionId);
            return session === undefined
              ? waiting === undefined
                ? []
                : [waiting]
              : [
                  {
                    sessionId: session.sessionId,
                    client: session.client,
                    issuedAt: session.issuedAt,
                    expiresAt: session.expiresAt,
                    lastConnectedAt: session.lastConnectedAt,
                    connected: session.connected,
                    permissions: [...(session.permissions ?? session.scopes)],
                    ceiling: device.ceiling === null ? null : [...device.ceiling],
                  },
                ];
          }),
          unusedLinks: deviceLinks.filter((link) => link.personId === record.person.personId),
        }));
      }),

      scopePeople,

      watchScopePeople: (asker, scope) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribed before the first read, so no change between the two is missed.
            const changes = yield* people.subscribeChanges;
            const read = scopePeople(asker, scope).pipe(Effect.map(encodeScopePeople));
            return Stream.fromEffect(read).pipe(
              Stream.concat(Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => read))),
              Stream.changes,
              Stream.zipWithIndex,
              Stream.map(([, index]) => index),
            );
          }),
        ),

      setLevel: Effect.fn("j5.sharing.people.setLevel")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        yield* requireScope(sql, input.scope);
        yield* access.setLevel({ personId, scope: input.scope, level: input.level });
      }),

      removeLevel: Effect.fn("j5.sharing.people.removeLevel")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        // Read first, so a level on someone who does not exist is a refusal and not a silent no.
        if ((yield* people.readPerson(personId)) === null) {
          return yield* new PersonNotFoundError({ personId });
        }
        yield* access.removeLevel({ personId, scope: input.scope });
      }),

      remove: Effect.fn("j5.sharing.people.remove")(function* (rawPersonId) {
        // `Access` ends their devices and revokes their unused links with them.
        yield* access.removePerson(yield* personIdOf(rawPersonId));
      }),

      rename: Effect.fn("j5.sharing.people.rename")(function* (input) {
        const personId = yield* personIdOf(input.personId);
        const displayName = yield* checkedPersonName(input.name);
        yield* access.rename({ personId, displayName });
      }),

      renameSelf: Effect.fn("j5.sharing.people.renameSelf")(function* (session, name) {
        const reach = yield* people.sessionReach(session);
        if (reach.kind !== "person") return yield* new NotAPersonError({});
        const displayName = yield* checkedPersonName(name);
        yield* access.rename({ personId: reach.person.personId, displayName });
      }),

      revokeDevice: Effect.fn("j5.sharing.people.revokeDevice")(function* (sessionId) {
        // Cut loose from its person and ended together, so it can never renew (AC49, AC50).
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const owner = yield* people.unbindSession(sessionId);
              if (owner === null) return yield* new DeviceNotAPersonsError({ sessionId });
              yield* sessions
                .revoke(sessionId)
                .pipe(Effect.mapError((cause) => new DeviceEndError({ cause })));
            }),
          )
          .pipe(
            Effect.catchTags({
              SqlError: (cause) =>
                Effect.fail(new PeopleStorageError({ operation: "end a device", cause })),
            }),
          );
      }),
    });
  }),
);
