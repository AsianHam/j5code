// @effect-diagnostics nodeBuiltinImport:off - random link ids and tokens.
import * as NodeCrypto from "node:crypto";

import { ProjectId, StoredProjectIcon, ThreadId } from "@t3tools/contracts";
import {
  type CreateLinkRequest,
  type LinkDescription,
  type LinkOpens,
  type PeopleLink,
  type PersonLevel,
  type PersonScope,
  devicePermissions,
  highestLevel,
  levelReaches,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";
import { Access, type AccessRenewalError } from "./Access.ts";
import {
  J5_LINK_PAIRING_SUBJECT,
  PairingIntents,
  type PairingIntentError,
} from "./PairingIntents.ts";
import {
  type FirstOwnerFixedError,
  OwnerOutsideServerError,
  PersonAccess,
  type PersonAccessStorageError,
  type PersonNameTakenError,
  PersonNotFoundError,
  type SessionIdentity,
  personNameKey,
  scopeColumns,
} from "./PersonAccess.ts";
import { type PersonNameError, checkedPersonName } from "./personNames.ts";

/**
 * The one kind of link (People and access AC31 to AC43). A link is J5's own token, kept as it was
 * made so an Owner can copy it again. Whoever opens it is told what it opens, and joins on a route
 * that takes no sign-in (`LinkHttp.ts`): the token is all it trusts. A link that pairs a device
 * mints upstream's single-use pairing credential for that device there and then, recorded with
 * the person it pairs (`PairingIntents`), and the browser exchanges it on upstream's pairing route
 * at once.
 *
 * A `device` link is for someone already on the server, and stores no level: their new device
 * follows what they hold. An `invite` makes its person when it is used and gives them its level at
 * its scope; for many people, at Viewer only (AC40). A link for one person is spent by the join
 * that uses it, in the join's transaction, so two browsers racing for it cannot both have it.
 */

export class LinkRefusedError extends Schema.TaggedError<LinkRefusedError>()(
  "LinkRefusedError",
  {},
) {
  // One answer for a link that never existed, has expired, was revoked, was used, or opens
  // something no longer there, so a caller without a working link learns nothing (AC42).
  override get message(): string {
    return "This link doesn't work. Ask whoever sent it for a new one.";
  }
}

export class LinkNotFoundError extends Schema.TaggedError<LinkNotFoundError>()(
  "LinkNotFoundError",
  { linkId: Schema.String },
) {
  override get message(): string {
    return `There is no link ${this.linkId} on this server.`;
  }
}

export class LinkForManyIsViewerError extends Schema.TaggedError<LinkForManyIsViewerError>()(
  "LinkForManyIsViewerError",
  {},
) {
  override get message(): string {
    return "A link for many people gives Viewer, and names no one. Make a link for one person to bring someone in at a higher level.";
  }
}

export class PersonAlreadyHereError extends Schema.TaggedError<PersonAlreadyHereError>()(
  "PersonAlreadyHereError",
  { name: Schema.String },
) {
  override get message(): string {
    return `${this.name} is already on this server. Give them more access from the People page rather than a link.`;
  }
}

export class ScopeNotFoundError extends Schema.TaggedError<ScopeNotFoundError>()(
  "ScopeNotFoundError",
  { kind: Schema.Literals(["project", "thread"]), id: Schema.String },
) {
  override get message(): string {
    return `There is no ${this.kind} ${this.id} on this server.`;
  }
}

export class OwnerNameNeededError extends Schema.TaggedError<OwnerNameNeededError>()(
  "OwnerNameNeededError",
  {},
) {
  override get message(): string {
    return "Set your name first, so the people you share with know who you are.";
  }
}

/** A browser already paired as one person, opening a link for another (AC32). */
export class LinkForSomeoneElseError extends Schema.TaggedError<LinkForSomeoneElseError>()(
  "LinkForSomeoneElseError",
  {},
) {
  override get message(): string {
    return "This device is already paired as someone else on this server. Open the link on the device it is for.";
  }
}

/** A browser already paired as the person a device link is for (AC43). */
export class LinkAlreadyYoursError extends Schema.TaggedError<LinkAlreadyYoursError>()(
  "LinkAlreadyYoursError",
  {},
) {
  override get message(): string {
    return "This device is already paired as the person this link is for. Open it on the device it was made for.";
  }
}

export class LinkNameNeededError extends Schema.TaggedError<LinkNameNeededError>()(
  "LinkNameNeededError",
  {},
) {
  override get message(): string {
    return "Type the name people and agents on this server should call you.";
  }
}

export class LinkStorageError extends Schema.TaggedError<LinkStorageError>()("LinkStorageError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

/** How long a link can be used once made, by the choices the Share dialog offers (AC31). */
const LINK_LIFETIME_MILLIS = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
} as const;

type StorageError = LinkStorageError | PersonAccessStorageError | PairingIntentError;

/** What a link opens, with the project whose favicon the route serves, which is never sent on. */
export interface DescribedLink {
  readonly description: Omit<LinkDescription, "serverName">;
  readonly faviconProject: ProjectId | null;
}

export type JoinOutcome =
  | { readonly kind: "pair"; readonly credential: string }
  | { readonly kind: "joined" };

export interface LinksShape {
  /** Makes a link; an invite waits for the first owner to have a name. */
  readonly create: (
    maker: SessionIdentity,
    request: CreateLinkRequest,
  ) => Effect.Effect<
    PeopleLink,
    | StorageError
    | PersonNotFoundError
    | ScopeNotFoundError
    | OwnerOutsideServerError
    | LinkForManyIsViewerError
    | PersonAlreadyHereError
    | OwnerNameNeededError
  >;
  /** The links in force, newest first (AC41). */
  readonly list: Effect.Effect<ReadonlyArray<PeopleLink>, StorageError>;
  /** Stops new people joining with a link; no one who joined is removed (AC39). */
  readonly revoke: (linkId: string) => Effect.Effect<void, StorageError | LinkNotFoundError>;
  /** What a link would open if used now, and what the browser asking already is; spends nothing. */
  readonly describe: (
    token: string,
    session: SessionIdentity | null,
  ) => Effect.Effect<DescribedLink, StorageError | LinkRefusedError>;
  /**
   * Joins with a link. Everything is checked before anything is written, and the writes commit
   * together or not at all, so a refusal leaves the link as usable as it was (AC32, AC43).
   */
  readonly join: (input: {
    readonly token: string;
    readonly name: string | undefined;
    readonly session: SessionIdentity | null;
  }) => Effect.Effect<
    JoinOutcome,
    | StorageError
    | LinkRefusedError
    | LinkForSomeoneElseError
    | LinkAlreadyYoursError
    | LinkNameNeededError
    | PersonNameError
    | PersonNameTakenError
    | PersonNotFoundError
    | FirstOwnerFixedError
    | OwnerOutsideServerError
    | AccessRenewalError
  >;
}

export class Links extends Context.Service<Links, LinksShape>()("t3/j5/sharing/Links") {}

interface LinkRow {
  readonly link_id: string;
  readonly token: string;
  readonly kind: "device" | "invite";
  readonly scope_kind: "server" | "project" | "thread" | null;
  readonly scope_id: string | null;
  readonly level: PersonLevel | null;
  readonly use: "one" | "many";
  readonly person_id: string | null;
  readonly person_name: string | null;
  readonly offered_name: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly joined: number;
}

const toScope = (kind: LinkRow["scope_kind"], id: string | null): PersonScope | null =>
  kind === null || id === null
    ? null
    : kind === "server"
      ? { kind: "server" }
      : kind === "project"
        ? { kind: "project", projectId: ProjectId.make(id) }
        : { kind: "thread", threadId: ThreadId.make(id) };

const toLink = (row: LinkRow): PeopleLink => ({
  linkId: row.link_id,
  token: row.token,
  kind: row.kind,
  scope: toScope(row.scope_kind, row.scope_id),
  level: row.level,
  use: row.use,
  personId: row.person_id,
  personName: row.kind === "device" ? row.person_name : row.offered_name,
  createdAt: DateTime.makeUnsafe(row.created_at),
  expiresAt: DateTime.makeUnsafe(row.expires_at),
  joined: row.joined,
});

const decodeChosenIcon = Schema.decodeUnknownOption(Schema.fromJsonString(StoredProjectIcon));
const chosenIcon = (stored: string | null) =>
  stored === null ? null : Option.getOrNull(decodeChosenIcon(stored));

/** Refuses a project or thread the server does not hold; the server is always there. */
export const requireScope = Effect.fn("j5.sharing.links.requireScope")(function* (
  sql: SqlClient.SqlClient,
  scope: PersonScope,
) {
  if (scope.kind === "server") return;
  const found = yield* (
    scope.kind === "project"
      ? sql`
          SELECT 1 AS found FROM projection_projects
          WHERE project_id = ${scope.projectId} AND deleted_at IS NULL
        `
      : sql`
          SELECT 1 AS found FROM orchestration_v2_projection_threads
          WHERE thread_id = ${scope.threadId} AND deleted_at IS NULL
        `
  ).pipe(
    Effect.mapError((cause) => new LinkStorageError({ operation: "read what is shared", cause })),
  );
  if (found.length === 0) {
    return yield* new ScopeNotFoundError({
      kind: scope.kind,
      id: scope.kind === "project" ? scope.projectId : scope.threadId,
    });
  }
});

/** What a scope opens, by the names a person knows it by; `null` for one no longer there. */
const opensOf = Effect.fn("j5.sharing.links.opensOf")(function* (
  sql: SqlClient.SqlClient,
  scope: PersonScope,
) {
  if (scope.kind === "server") {
    return { opens: { kind: "server" } as LinkOpens, faviconProject: null };
  }
  if (scope.kind === "project") {
    const rows = yield* sql<{ readonly title: string; readonly icon: string | null }>`
      SELECT title, project_icon_json AS icon FROM projection_projects
      WHERE project_id = ${scope.projectId} AND deleted_at IS NULL
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const projectIcon = chosenIcon(row.icon);
    return {
      opens: {
        kind: "project",
        projectTitle: row.title,
        projectIcon,
        projectFaviconUrl: null,
      } as LinkOpens,
      // A chosen icon is what a client draws; a favicon is asked for only without one.
      faviconProject: projectIcon === null ? scope.projectId : null,
    };
  }
  const rows = yield* sql<{
    readonly title: string;
    readonly project_id: string | null;
    readonly project_title: string | null;
    readonly icon: string | null;
  }>`
    SELECT thread.title, project.project_id, project.title AS project_title,
      project.project_icon_json AS icon
    FROM orchestration_v2_projection_threads AS thread
    LEFT JOIN projection_projects AS project
      ON project.project_id = thread.project_id AND project.deleted_at IS NULL
    WHERE thread.thread_id = ${scope.threadId} AND thread.deleted_at IS NULL
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const projectIcon = chosenIcon(row.icon);
  return {
    opens: {
      kind: "thread",
      threadTitle: row.title,
      projectTitle: row.project_title,
      projectIcon,
      projectFaviconUrl: null,
    } as LinkOpens,
    faviconProject:
      projectIcon === null && row.project_id !== null ? ProjectId.make(row.project_id) : null,
  };
});

const isSqlError = Schema.is(SqlError.SqlError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* PersonAccess;
  const access = yield* Access;
  const intents = yield* PairingIntents;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const peopleChanged = (yield* ReadChanges).notify("sharing");
  const storage = (operation: string) => (cause: unknown) =>
    new LinkStorageError({ operation, cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // A link with who it is for and how many joined with it. A device link's person is named as
  // they are now.
  const selectLinks = sql`
    SELECT link.link_id, link.token, link.kind, link.scope_kind, link.scope_id, link.level,
      link.use, link.person_id, person.display_name AS person_name, link.offered_name,
      link.created_at, link.expires_at,
      (SELECT COUNT(*) FROM j5_a2a_link_join AS joined WHERE joined.link_id = link.link_id)
        AS joined
    FROM j5_a2a_link AS link
    LEFT JOIN j5_a2a_human_person AS person ON person.person_id = link.person_id
  `;

  /**
   * In force: not revoked, not expired, not used if it is for one person, and, for a device
   * link, for someone still on the server.
   */
  const inForce = (at: string) => sql`
    link.revoked_at IS NULL AND link.expires_at > ${at}
    AND (link.use = 'many' OR link.used_at IS NULL)
    AND (link.person_id IS NULL OR person.removed_at IS NULL)
  `;

  const list: LinksShape["list"] = Effect.gen(function* () {
    const at = yield* now;
    const rows = yield* sql<LinkRow>`
      ${selectLinks} WHERE ${inForce(at)}
      ORDER BY link.created_at DESC, link.link_id
    `.pipe(Effect.mapError(storage("list links")));
    return rows.map(toLink);
  }).pipe(Effect.withSpan("j5.sharing.links.list"));

  /** A link that works now, with what its scope opens; `null` for any that does not. */
  const usable = Effect.fn("j5.sharing.links.usable")(
    function* (token: string) {
      const at = yield* now;
      const rows = yield* sql<LinkRow>`
        ${selectLinks} WHERE link.token = ${token} AND ${inForce(at)}
      `;
      const row = rows[0];
      if (row === undefined) return null;
      const scope =
        row.kind === "invite"
          ? toScope(row.scope_kind, row.scope_id)
          : yield* deviceScope(ParticipantId.make(row.person_id ?? ""));
      const opened = scope === null ? null : yield* opensOf(sql, scope);
      return opened === null ? null : { row, ...opened };
    },
    Effect.mapError(storage("read a link")),
  );

  /**
   * What a device link is said to open: the one project or thread its person holds a level at,
   * when that is all they hold; otherwise the server.
   */
  const deviceScope = (personId: ParticipantId) =>
    people.listLevels(personId).pipe(
      Effect.map((levels): PersonScope => {
        const only = levels.length === 1 ? levels[0] : undefined;
        return only === undefined ? { kind: "server" } : only.scope;
      }),
    );

  /** The person a browser's session is, when it is one. */
  const pairedAs = (session: SessionIdentity | null) =>
    session === null
      ? Effect.succeed(null)
      : people
          .sessionReach(session)
          .pipe(Effect.map((reach) => (reach.kind === "person" ? reach.person : null)));

  /** One transaction for a join; a failure to commit is storage's, and the rest pass through. */
  const committed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          isSqlError(cause)
            ? new LinkStorageError({ operation: "join with a link", cause })
            : (cause as Exclude<E, SqlError.SqlError>),
        ),
      );

  /** Spends a link for one person; a link a race already spent is refused like any other. */
  const spend = Effect.fn("j5.sharing.links.spend")(function* (linkId: string) {
    const at = yield* now;
    const spent = yield* sql`
      UPDATE j5_a2a_link SET used_at = ${at}
      WHERE link_id = ${linkId} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${at}
      RETURNING link_id
    `.pipe(Effect.mapError(storage("use a link")));
    if (spent.length !== 1) return yield* new LinkRefusedError({});
  });

  const recordJoin = Effect.fn("j5.sharing.links.recordJoin")(function* (
    linkId: string,
    personId: ParticipantId,
  ) {
    const at = yield* now;
    yield* sql`
      INSERT OR IGNORE INTO j5_a2a_link_join (link_id, person_id, joined_at)
      VALUES (${linkId}, ${personId}, ${at})
    `.pipe(Effect.mapError(storage("record who joined with a link")));
  });

  /**
   * Upstream's single-use pairing credential for the device joining, holding what the person's
   * highest level gives, recorded with the person it pairs.
   */
  const mint = Effect.fn("j5.sharing.links.mint")(function* (input: {
    readonly linkId: string;
    readonly personId: ParticipantId;
    readonly name: string | null;
  }) {
    const levels = yield* people.listLevels(input.personId);
    const issued = yield* grants
      .issueOneTimeToken({
        scopes: [...devicePermissions(highestLevel(levels.map((held) => held.level)), null)],
        subject: J5_LINK_PAIRING_SUBJECT,
        ...(input.name === null ? {} : { label: input.name }),
      })
      .pipe(Effect.mapError(storage("make a pairing credential")));
    yield* intents.record({
      pairingLinkId: issued.id,
      credential: issued.credential,
      personId: input.personId,
      linkId: input.linkId,
      ceiling: null,
    });
    return { kind: "pair" as const, credential: issued.credential };
  });

  /** Whether someone already reaches a link's scope, at any level, so joining adds nothing. */
  const reaches = (personId: ParticipantId, scope: PersonScope) =>
    scope.kind === "server"
      ? people
          .listLevels(personId)
          .pipe(Effect.map((levels) => levels.some((held) => held.scope.kind === "server")))
      : (scope.kind === "project"
          ? people.projectLevel(personId, scope.projectId)
          : people.threadLevel(personId, scope.threadId)
        ).pipe(Effect.map((level) => levelReaches(level, "viewer")));

  return Links.of({
    create: Effect.fn("j5.sharing.links.create")(function* (maker, request) {
      const makerReach = yield* people.sessionReach(maker);
      const createdBy = makerReach.kind === "person" ? makerReach.person.personId : null;
      const at = yield* DateTime.now;
      const expiresAt = DateTime.add(at, {
        milliseconds: LINK_LIFETIME_MILLIS[request.lifetime ?? "7d"],
      });
      const linkId = `link:${NodeCrypto.randomUUID()}`;
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const base = {
        linkId,
        token,
        createdAt: DateTime.formatIso(at),
        expiresAt: DateTime.formatIso(expiresAt),
        createdBy,
      };
      if (request.kind === "device") {
        const personId = ParticipantId.make(request.personId);
        if ((yield* people.readPerson(personId)) === null) {
          return yield* new PersonNotFoundError({ personId: request.personId });
        }
        yield* sql`
          INSERT INTO j5_a2a_link (
            link_id, token, kind, use, person_id, created_by, created_at, expires_at
          ) VALUES (
            ${base.linkId}, ${base.token}, 'device', 'one', ${personId}, ${base.createdBy},
            ${base.createdAt}, ${base.expiresAt}
          )
        `.pipe(Effect.mapError(storage("make a link")));
      } else {
        // Bringing someone in waits for the first owner to have a name: whoever joins is told
        // whose server it is.
        if ((yield* people.firstOwner).displayName === null) {
          return yield* new OwnerNameNeededError({});
        }
        if (request.level === "owner" && request.scope.kind !== "server") {
          return yield* new OwnerOutsideServerError({});
        }
        if (request.use === "many" && (request.level !== "viewer" || request.name !== null)) {
          return yield* new LinkForManyIsViewerError({});
        }
        yield* requireScope(sql, request.scope);
        // Someone already here is given more access in place, not a link (AC35).
        if (request.name !== null) {
          const taken = yield* sql`
            SELECT 1 AS found FROM j5_a2a_human_person
            WHERE name_key = ${personNameKey(request.name)} AND removed_at IS NULL
          `.pipe(Effect.mapError(storage("read who is on the server")));
          if (taken.length > 0) return yield* new PersonAlreadyHereError({ name: request.name });
        }
        const scope = scopeColumns(request.scope);
        yield* sql`
          INSERT INTO j5_a2a_link (
            link_id, token, kind, scope_kind, scope_id, level, use, offered_name, created_by,
            created_at, expires_at
          ) VALUES (
            ${base.linkId}, ${base.token}, 'invite', ${scope.kind}, ${scope.id}, ${request.level},
            ${request.use}, ${request.name}, ${base.createdBy}, ${base.createdAt}, ${base.expiresAt}
          )
        `.pipe(Effect.mapError(storage("make a link")));
      }
      yield* peopleChanged;
      const rows = yield* sql<LinkRow>`${selectLinks} WHERE link.link_id = ${linkId}`.pipe(
        Effect.mapError(storage("read a link")),
      );
      return toLink(rows[0]!);
    }),

    list,

    revoke: Effect.fn("j5.sharing.links.revoke")(function* (linkId) {
      const at = yield* now;
      const rows = yield* sql`
        UPDATE j5_a2a_link SET revoked_at = COALESCE(revoked_at, ${at})
        WHERE link_id = ${linkId}
        RETURNING link_id
      `.pipe(Effect.mapError(storage("revoke a link")));
      if (rows.length === 0) return yield* new LinkNotFoundError({ linkId });
      yield* peopleChanged;
    }),

    describe: Effect.fn("j5.sharing.links.describe")(function* (token, session) {
      const found = yield* usable(token);
      if (found === null) return yield* new LinkRefusedError({});
      const { row } = found;
      const paired = yield* pairedAs(session);
      return {
        description: {
          kind: row.kind,
          use: row.use,
          opens: found.opens,
          level: row.level,
          personName: row.kind === "device" ? row.person_name : row.offered_name,
          device:
            paired === null
              ? { state: "unpaired" as const }
              : {
                  state: "paired" as const,
                  name: paired.displayName,
                  samePerson: row.kind === "device" && paired.personId === row.person_id,
                },
          expiresAt: DateTime.makeUnsafe(row.expires_at),
        },
        faviconProject: found.faviconProject,
      };
    }),

    join: Effect.fn("j5.sharing.links.join")(function* (input) {
      const outcome = yield* committed(
        Effect.gen(function* () {
          const found = yield* usable(input.token);
          if (found === null) return yield* new LinkRefusedError({});
          const { row } = found;
          const paired = yield* pairedAs(input.session);

          if (row.kind === "device") {
            const personId = ParticipantId.make(row.person_id ?? "");
            if (paired !== null) {
              return yield* paired.personId === personId
                ? new LinkAlreadyYoursError({})
                : new LinkForSomeoneElseError({});
            }
            const name = input.name === undefined ? null : yield* checkedPersonName(input.name);
            yield* spend(row.link_id);
            // The person confirms or corrects their name as they pair (AC42).
            if (name !== null && name !== row.person_name) {
              yield* access.rename({ personId, displayName: name });
            }
            yield* recordJoin(row.link_id, personId);
            return yield* mint({ linkId: row.link_id, personId, name: name ?? row.person_name });
          }

          const scope = toScope(row.scope_kind, row.scope_id)!;
          if (row.use === "many" && paired !== null) {
            // Someone already here joins as themselves, keeping anything higher (AC33).
            if (!(yield* reaches(paired.personId, scope))) {
              yield* access.setLevel({ personId: paired.personId, scope, level: "viewer" });
            }
            yield* recordJoin(row.link_id, paired.personId);
            return { kind: "joined" as const };
          }
          if (paired !== null) return yield* new LinkForSomeoneElseError({});
          const offered = input.name ?? (row.use === "one" ? row.offered_name : null);
          if (offered === null) return yield* new LinkNameNeededError({});
          const name = yield* checkedPersonName(offered);
          if (row.use === "one") yield* spend(row.link_id);
          const person = yield* people.createPerson({ displayName: name });
          yield* access.setLevel({ personId: person.personId, scope, level: row.level! });
          yield* recordJoin(row.link_id, person.personId);
          return yield* mint({ linkId: row.link_id, personId: person.personId, name });
        }),
      );
      yield* peopleChanged;
      return outcome;
    }),
  });
});

// `readChangesLayer` is the one the rest of the server provides, so it is the same instance
// (see `a2a/runtimeLayer.ts`).
export const layer: Layer.Layer<
  Links,
  never,
  SqlClient.SqlClient | PersonAccess | Access | PairingIntents | PairingGrantStore.PairingGrantStore
> = Layer.effect(Links, make).pipe(Layer.provide(readChangesLayer));
