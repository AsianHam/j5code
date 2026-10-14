// @effect-diagnostics nodeBuiltinImport:off - random tokens and their hashes.
import * as NodeCrypto from "node:crypto";

import { ProjectId, StoredProjectIcon, type ThreadId } from "@t3tools/contracts";
import {
  isPersonName,
  type SharingLink,
  type SharingLinkDescription,
  type SharingLinkOpens,
  type SharingOpenLink,
  type SharingThreadPeople,
} from "@t3tools/contracts/j5";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";
import { GuestPairing, type GuestPairingError, linkLifetime } from "./GuestPairing.ts";
import {
  GrantTargetNotFoundError,
  LinkLifetimeError,
  type OwnerNameRequiredError,
  People,
  type PeopleUpstreamError,
  type ThreadNotSharedError,
} from "./People.ts";
import {
  GUEST_SESSION_SUBJECT,
  type GrantTarget,
  PersonAccess,
  type PersonAccessStorageError,
  type PersonNameTakenError,
  type SessionIdentity,
} from "./PersonAccess.ts";

/**
 * A link several people can join one thread with (#541). It gives View and nothing more, which is
 * the level the server enforces, so a link that leaks shows the thread and no more than that.
 * Each person who opens it types a name and becomes a new guest with a View grant on the thread
 * and an ordinary single-use share link of their own; from there they are a guest like any other.
 * A guest already signed in on the browser joins as themselves instead (#614).
 * Joining needs no sign-in: the token is 32 random bytes, which cannot be guessed, and a link
 * brings in only so many people.
 */

/** The most people one open link brings in. Past it, a member makes another. */
export const OPEN_LINK_MAX_PEOPLE = 50;

export class OpenLinkRefusedError extends Schema.TaggedError<OpenLinkRefusedError>()(
  "OpenLinkRefusedError",
  {},
) {
  // One answer for a link that never existed, has expired, was revoked or is full, so a caller
  // without the link learns nothing about which links exist.
  override get message(): string {
    return "This link cannot be used to join. Ask whoever sent it for a new one.";
  }
}

export class OpenLinkNameError extends Schema.TaggedError<OpenLinkNameError>()(
  "OpenLinkNameError",
  {},
) {
  override get message(): string {
    return "A name is one line of ordinary characters, up to 80 of them, with no square brackets.";
  }
}

export class OpenLinkNotFoundError extends Schema.TaggedError<OpenLinkNotFoundError>()(
  "OpenLinkNotFoundError",
  { linkId: Schema.String },
) {
  override get message(): string {
    return `There is no open link ${this.linkId} on this server.`;
  }
}

export class OpenLinkStorageError extends Schema.TaggedError<OpenLinkStorageError>()(
  "OpenLinkStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

type StorageError =
  | OpenLinkStorageError
  | PersonAccessStorageError
  | PeopleUpstreamError
  | GuestPairingError;

/**
 * One thing a link opens, with the id of its project. The id is for the route, which may need the
 * project again; it is never sent on.
 */
export type OpenedEntry = SharingLinkOpens & { readonly projectId: ProjectId | null };

/** What a link opens, but for the server's name, which the route adds. */
export type LinkDescription = Omit<SharingLinkDescription, "serverName" | "opens"> & {
  readonly opens: ReadonlyArray<OpenedEntry>;
};

/**
 * What joining did: recorded a new person, whose browser pairs with the share link made for them,
 * or gave the link's thread to the guest whose browser it already is.
 */
export type JoinOutcome =
  | { readonly kind: "new"; readonly link: SharingLink }
  | { readonly kind: "existing"; readonly threadId: ThreadId };

const decodeChosenIcon = Schema.decodeUnknownOption(Schema.fromJsonString(StoredProjectIcon));
/** The icon a person chose for a project, as it is stored; nothing when none was chosen. */
const chosenIcon = (stored: string | null) =>
  stored === null ? null : Option.getOrNull(decodeChosenIcon(stored));

export interface OpenLinksShape {
  /**
   * What a link would open if it were used now, for either kind of link: a named person's share
   * link or an open link. It reads and changes nothing, however often it is asked. Every link
   * that would not work is refused alike, as the join route refuses. An open link asked about
   * from a guest's own browser also says who that guest is, whom they can join as.
   */
  readonly describe: (
    link: string,
    session: SessionIdentity | null,
  ) => Effect.Effect<LinkDescription, StorageError | OpenLinkRefusedError>;
  /** Makes a link for a thread. The token is shown once, here. */
  readonly create: (
    threadId: ThreadId,
    lifetime?: string,
  ) => Effect.Effect<
    SharingOpenLink & { readonly token: string },
    StorageError | GrantTargetNotFoundError | LinkLifetimeError | OwnerNameRequiredError
  >;
  /**
   * Who can reach a thread, as `People.threadPeople` answers it, with the thread's open links
   * that can still be joined added for a member's connection.
   */
  readonly threadPeople: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Effect.Effect<SharingThreadPeople, StorageError | ThreadNotSharedError>;
  /** A count that moves each time that answer changes, a link being made or revoked included. */
  readonly watchThreadPeople: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Stream.Stream<number, StorageError | ThreadNotSharedError>;
  /** Stops new people joining. People who already joined are removed one at a time. */
  readonly revoke: (linkId: string) => Effect.Effect<void, StorageError | OpenLinkNotFoundError>;
  /** Every open link, newest first, with the people who joined through it. */
  readonly list: Effect.Effect<ReadonlyArray<SharingOpenLink>, StorageError>;
  /**
   * What the join route does. With a name, it records a new person under it, gives them View on
   * the link's thread, and makes them a share link of their own to pair their device with. A
   * name someone on the server already has is refused, and only after the link has been found
   * good, so no one learns whether a name is in use without a link that works.
   *
   * Without a name, it is a guest already signed in on this browser joining as themselves
   * (#614): they are given View on the link's thread, unless they already hold a grant on it, and
   * nothing is paired. A browser that is no guest's must give a name.
   *
   * Either way it checks everything before it writes, its writes commit together or not at all,
   * and the person is counted among the link's joins.
   */
  readonly join: (input: {
    readonly token: string;
    readonly displayName: string | undefined;
    readonly session: SessionIdentity | null;
  }) => Effect.Effect<
    JoinOutcome,
    StorageError | OpenLinkRefusedError | OpenLinkNameError | PersonNameTakenError
  >;
}

export class OpenLinks extends Context.Service<OpenLinks, OpenLinksShape>()(
  "t3/j5/sharing/OpenLinks",
) {}

interface OpenLinkRow {
  readonly link_id: string;
  readonly token_hash: string;
  readonly thread_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest();

const make: Layer.Layer<
  OpenLinks,
  never,
  | People
  | PersonAccess
  | GuestPairing
  | EnvironmentAuth.EnvironmentAuth
  | SqlClient.SqlClient
  | ReadChanges
> = Layer.effect(
  OpenLinks,
  Effect.gen(function* () {
    const people = yield* People;
    const access = yield* PersonAccess;
    const pairing = yield* GuestPairing;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sql = yield* SqlClient.SqlClient;
    const storage = (operation: string) => (cause: unknown) =>
      new OpenLinkStorageError({ operation, cause });
    // One join at a time, so two people cannot both take a link's last place.
    const joining = yield* Semaphore.make(1);

    const joined = (linkId: string) =>
      sql<{ readonly person_id: string }>`
          SELECT person_id FROM j5_a2a_open_link_join
          WHERE link_id = ${linkId} ORDER BY joined_at, person_id
        `.pipe(Effect.mapError(storage("read who joined with a link")));

    /** The guest a browser already is, when it is one; a session bound to no one is no one. */
    const guestOf = (session: SessionIdentity | null) =>
      session === null
        ? Effect.succeed(null)
        : access
            .sessionPerson(session)
            .pipe(
              Effect.map((person) =>
                person !== null && person.kind === "guest" && person.personId !== null
                  ? person
                  : null,
              ),
            );

    // Told when a link is made or revoked, which changes what a thread's people answer holds.
    const linkChanges = yield* Effect.acquireRelease(PubSub.sliding<string>(64), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    const readChanges = yield* ReadChanges;
    /** Said when a link is made or revoked: a thread's people re-read, and so does the People page. */
    const linkChanged = (linkId: string) =>
      PubSub.publish(linkChanges, linkId).pipe(Effect.andThen(readChanges.notify("sharing")));

    const threadPeople: OpenLinksShape["threadPeople"] = Effect.fn(
      "j5.sharing.openLinks.threadPeople",
    )(function* (session, threadId) {
      const answer = yield* people.threadPeople(session, threadId);
      // A guest is told who is on the thread, and not how more people could get onto it.
      if (session.subject === GUEST_SESSION_SUBJECT) return answer;
      const nowMs = yield* Clock.currentTimeMillis;
      const rows = yield* sql<OpenLinkRow>`
        SELECT link_id, token_hash, thread_id, created_at, expires_at, revoked_at
        FROM j5_a2a_open_link
        WHERE thread_id = ${threadId} AND revoked_at IS NULL
        ORDER BY created_at DESC, link_id
      `.pipe(Effect.mapError(storage("read a thread's open links")));
      const openLinks = yield* Effect.forEach(
        rows.filter((row) => Date.parse(row.expires_at) > nowMs),
        (row) =>
          joined(row.link_id).pipe(
            Effect.map((people) => ({
              linkId: row.link_id,
              expiresAt: DateTime.makeUnsafe(row.expires_at),
              joined: people.length,
            })),
          ),
      );
      return { ...answer, openLinks };
    });

    const describe = Effect.fn("j5.sharing.openLinks.describe")(function* (row: OpenLinkRow) {
      return {
        linkId: row.link_id,
        threadId: row.thread_id as ThreadId,
        createdAt: DateTime.makeUnsafe(row.created_at),
        expiresAt: DateTime.makeUnsafe(row.expires_at),
        revoked: row.revoked_at !== null,
        joined: (yield* joined(row.link_id)).map((person) => person.person_id),
      } satisfies SharingOpenLink;
    });

    /** A grant's target by the names a person knows it by; nothing for one that is gone. */
    const opened = Effect.fn("j5.sharing.openLinks.opened")(function* (
      target: GrantTarget,
      level: SharingLinkOpens["level"],
    ) {
      if (target.kind === "project") {
        const rows = yield* sql<{ readonly title: string; readonly icon: string | null }>`
            SELECT title, project_icon_json AS icon FROM projection_projects
            WHERE project_id = ${target.projectId} AND deleted_at IS NULL
          `.pipe(Effect.mapError(storage("read a shared project")));
        return rows.map((row): OpenedEntry => ({
          kind: "project",
          projectTitle: row.title,
          projectIcon: chosenIcon(row.icon),
          // Filled in by the route, which serves the file; this service reads no files.
          projectFaviconUrl: null,
          level,
          projectId: target.projectId,
        }));
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
          WHERE thread.thread_id = ${target.threadId} AND thread.deleted_at IS NULL
        `.pipe(Effect.mapError(storage("read a shared thread")));
      return rows.map((row): OpenedEntry => ({
        kind: "thread",
        threadTitle: row.title,
        projectTitle: row.project_title,
        projectIcon: chosenIcon(row.icon),
        // Filled in by the route, which serves the file; this service reads no files.
        projectFaviconUrl: null,
        level,
        projectId: row.project_id === null ? null : ProjectId.make(row.project_id),
      }));
    });

    /** A named person's share link, while upstream still lists it as usable. */
    const describePersonLink = Effect.fn("j5.sharing.openLinks.describePersonLink")(function* (
      credential: string,
    ) {
      const link = yield* pairing.linkOf(credential);
      if (link === null) return null;
      // Upstream lists a link only while it is unused, unexpired and unrevoked.
      const active = yield* auth
        .listPairingLinks()
        .pipe(Effect.mapError(storage("read the share links still in use")));
      const usable = active.find(
        (entry) => entry.id === link.pairingLinkId && entry.subject === GUEST_SESSION_SUBJECT,
      );
      const person = usable === undefined ? null : yield* access.readPerson(link.personId);
      if (usable === undefined || person === null || person.kind !== "guest") return null;
      const grants = yield* access.listGrants(link.personId);
      const opens = yield* Effect.forEach(grants, (grant) => opened(grant.target, grant.level));
      return {
        kind: "person",
        personName: person.displayName,
        opens: opens.flat(),
        expiresAt: usable.expiresAt,
      } satisfies LinkDescription;
    });

    /** An open link, while it can still be joined with. */
    const describeOpenLink = Effect.fn("j5.sharing.openLinks.describeOpenLink")(function* (
      token: string,
      session: SessionIdentity | null,
    ) {
      const nowMs = yield* Clock.currentTimeMillis;
      const rows = yield* sql<OpenLinkRow>`
          SELECT link_id, token_hash, thread_id, created_at, expires_at, revoked_at
          FROM j5_a2a_open_link WHERE token_hash = ${hashToken(token).toString("hex")}
        `.pipe(Effect.mapError(storage("read an open link")));
      const row = rows[0];
      if (row === undefined || row.revoked_at !== null || Date.parse(row.expires_at) <= nowMs) {
        return null;
      }
      // A full link still works for a guest it already counts, as joining does.
      const joins = yield* joined(row.link_id);
      const guest = yield* guestOf(session);
      const counted = guest !== null && joins.some((join) => join.person_id === guest.personId);
      if (!counted && joins.length >= OPEN_LINK_MAX_PEOPLE) return null;
      const opens = yield* opened({ kind: "thread", threadId: row.thread_id as ThreadId }, "view");
      if (opens.length === 0) return null;
      return {
        kind: "open",
        personName: null,
        opens,
        expiresAt: DateTime.makeUnsafe(row.expires_at),
        ...(guest === null || guest.displayName === null ? {} : { joiningAs: guest.displayName }),
      } satisfies LinkDescription;
    });

    return OpenLinks.of({
      describe: Effect.fn("j5.sharing.openLinks.describe")(function* (link, session) {
        const described =
          (yield* describePersonLink(link)) ?? (yield* describeOpenLink(link, session));
        if (described === null) return yield* new OpenLinkRefusedError({});
        return described;
      }),

      threadPeople,

      watchThreadPeople: (session, threadId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribed before the first read, so no change between the two is missed.
            const grants = yield* access.subscribeGrantChanges;
            const links = yield* PubSub.subscribe(linkChanges);
            const read = threadPeople(session, threadId).pipe(Effect.map(JSON.stringify));
            return Stream.fromEffect(read).pipe(
              Stream.concat(
                Stream.merge(Stream.fromSubscription(grants), Stream.fromSubscription(links)).pipe(
                  Stream.mapEffect(() => read),
                ),
              ),
              Stream.changes,
              Stream.zipWithIndex,
              Stream.map(([, index]) => index),
            );
          }),
        ),

      create: Effect.fn("j5.sharing.openLinks.create")(function* (threadId, lifetime) {
        // An open link brings new people in, which waits for the owner to have a name.
        yield* people.requireOwnerName;
        const ttl = linkLifetime(lifetime);
        if (ttl === undefined) return yield* new LinkLifetimeError({ lifetime: lifetime ?? "" });
        const found = yield* sql`
            SELECT 1 AS found FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId} AND deleted_at IS NULL
          `.pipe(Effect.mapError(storage("read the thread being shared")));
        if (found.length === 0) {
          return yield* new GrantTargetNotFoundError({ kind: "thread", id: threadId });
        }
        const now = yield* DateTime.now;
        const row: OpenLinkRow = {
          link_id: NodeCrypto.randomUUID(),
          token_hash: "",
          thread_id: threadId,
          created_at: DateTime.formatIso(now),
          expires_at: DateTime.formatIso(
            DateTime.add(now, { milliseconds: Duration.toMillis(ttl) }),
          ),
          revoked_at: null,
        };
        const token = NodeCrypto.randomBytes(32).toString("base64url");
        yield* sql`
            INSERT INTO j5_a2a_open_link (link_id, token_hash, thread_id, created_at, expires_at)
            VALUES (
              ${row.link_id}, ${hashToken(token).toString("hex")}, ${threadId}, ${row.created_at},
              ${row.expires_at}
            )
          `.pipe(Effect.mapError(storage("record an open link")));
        yield* linkChanged(row.link_id);
        return { ...(yield* describe(row)), token };
      }),

      revoke: Effect.fn("j5.sharing.openLinks.revoke")(function* (linkId) {
        const revokedAt = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* sql`
            UPDATE j5_a2a_open_link SET revoked_at = COALESCE(revoked_at, ${revokedAt})
            WHERE link_id = ${linkId} RETURNING link_id
          `.pipe(Effect.mapError(storage("revoke an open link")));
        if (rows.length === 0) return yield* new OpenLinkNotFoundError({ linkId });
        yield* linkChanged(linkId);
      }),

      list: sql<OpenLinkRow>`
          SELECT link_id, token_hash, thread_id, created_at, expires_at, revoked_at
          FROM j5_a2a_open_link ORDER BY created_at DESC, link_id
        `.pipe(
        Effect.mapError(storage("list open links")),
        Effect.flatMap((rows) => Effect.forEach(rows, describe)),
        Effect.withSpan("j5.sharing.openLinks.list"),
      ),

      join: Effect.fn("j5.sharing.openLinks.join")(function* (input) {
        // Who is joining: the guest this browser already is, when no name is given, or a new
        // person under the name given. The route's schema checks the name too.
        const { displayName } = input;
        const guest = displayName === undefined ? yield* guestOf(input.session) : null;
        const who =
          guest ??
          (displayName !== undefined && isPersonName(displayName)
            ? { newName: displayName }
            : null);
        if (who === null) return yield* new OpenLinkNameError({});
        const nowMs = yield* Clock.currentTimeMillis;
        const tokenHash = hashToken(input.token).toString("hex");
        const admit = Effect.gen(function* () {
          // A link is found by its token's hash and only while its thread still exists.
          const rows = yield* sql<OpenLinkRow>`
              SELECT link.link_id, link.token_hash, link.thread_id, link.created_at,
                link.expires_at, link.revoked_at
              FROM j5_a2a_open_link AS link
              JOIN orchestration_v2_projection_threads AS thread
                ON thread.thread_id = link.thread_id AND thread.deleted_at IS NULL
              WHERE link.token_hash = ${tokenHash}
            `.pipe(Effect.mapError(storage("read an open link")));
          const row = rows[0];
          const joins = row === undefined ? [] : yield* joined(row.link_id);
          // A guest already counted among the link's joins takes no further place on it.
          const counted = guest !== null && joins.some((join) => join.person_id === guest.personId);
          if (
            row === undefined ||
            row.revoked_at !== null ||
            Date.parse(row.expires_at) <= nowMs ||
            (!counted && joins.length >= OPEN_LINK_MAX_PEOPLE)
          ) {
            return yield* new OpenLinkRefusedError({});
          }
          const threadId = row.thread_id as ThreadId;
          const target = { kind: "thread", threadId } as const;
          const person =
            "newName" in who
              ? yield* access.createGuest({
                  displayName: who.newName,
                  joinedOpenLinkId: row.link_id,
                })
              : who;
          const joinedAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
              INSERT INTO j5_a2a_open_link_join (link_id, person_id, joined_at)
              VALUES (${row.link_id}, ${person.personId}, ${joinedAt})
              ON CONFLICT (link_id, person_id) DO NOTHING
            `.pipe(Effect.mapError(storage("record someone joining")));
          // View, or the level already held on the thread itself, whichever is higher: a guest
          // who collaborates on it keeps that.
          const held = (yield* access.listGrants(person.personId)).some(
            (grant) => grant.target.kind === "thread" && grant.target.threadId === threadId,
          );
          if (!held) yield* people.putGrant({ personId: person.personId, target, level: "view" });
          if (guest !== null) return { kind: "existing" as const, threadId };
          // Used at once by the browser that asked, so it need not outlive the hour.
          return { kind: "new" as const, link: yield* people.createLink(person.personId, "1h") };
        });
        return yield* joining
          .withPermits(1)(sql.withTransaction(admit))
          .pipe(
            Effect.catchTags({
              SqlError: (cause) => Effect.fail(storage("record someone joining")(cause)),
              // None of these can happen to a guest recorded a statement ago, in a transaction.
              GrantTargetNotFoundError: () => Effect.fail(new OpenLinkRefusedError({})),
              PersonNotFoundError: (cause) => Effect.fail(storage("record a grant")(cause)),
              GrantOnMemberError: (cause) => Effect.fail(storage("record a grant")(cause)),
              LinkForMemberError: (cause) => Effect.fail(storage("make a share link")(cause)),
              LinkLifetimeError: (cause) => Effect.fail(storage("make a share link")(cause)),
              // A link exists only on a server whose owner has a name, and a name is never un-set.
              OwnerNameRequiredError: (cause) => Effect.fail(storage("make a share link")(cause)),
              NameNotConfirmedError: (cause) => Effect.fail(storage("record a grant")(cause)),
            }),
            // Committed: the link has one more person, who the People page now lists.
            Effect.tap(() => readChanges.notify("sharing")),
          );
      }),
    });
  }),
);

// `readChangesLayer` is the one the rest of the server provides, so it is the same instance
// (see `a2a/runtimeLayer.ts`).
export const layer: Layer.Layer<
  OpenLinks,
  never,
  People | PersonAccess | GuestPairing | EnvironmentAuth.EnvironmentAuth | SqlClient.SqlClient
> = make.pipe(Layer.provide(readChangesLayer));
