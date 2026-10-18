// @effect-diagnostics nodeBuiltinImport:off - random ids for new people.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type PersonLevel,
  type PersonScope,
  highestLevel,
  levelReaches,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { ParticipantId } from "../a2a/contracts.ts";
import { ensureLocalOperatorHumanPerson } from "../a2a/HumanPersonRegistry.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";

/**
 * People, their levels at scopes, and the devices that are theirs
 * (docs/j5/product/features/people-and-access.md). A device is one of upstream's auth sessions. A
 * person's level at the server covers everything; at a project, its threads; at a thread, the
 * thread and the agents beneath it. Where two levels cover one thing the higher applies.
 *
 * What a device reaches is read here on every request, by its session id. A change of what a
 * person holds is made through `Access`, which also renews their devices' sessions.
 */

/**
 * Sessions that are no person's device and are not narrowed: agents signed in over MCP, peer
 * servers, the machine participants of `j5 a2a`, and the CLI's own sessions. Each holds only the
 * permissions upstream issued it for its purpose. MCP clients are approved only by an Owner, and
 * lowering or removing an Owner revokes every one of them (`Access`).
 */
export const isServiceSubject = (subject: string) =>
  subject.startsWith("peer:") ||
  subject.startsWith("machine:") ||
  subject === "mcp-client" ||
  subject === "cli-issued-session";

/**
 * Sessions that are the first owner's by how they were issued: the link the server prints when
 * it starts, the desktop app on its own machine, and the development credential (AC2).
 */
export const FIRST_OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  "administrative-bootstrap",
  "desktop-bootstrap",
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

export type MessageAsset =
  | { readonly kind: "attachment"; readonly attachmentId: string }
  | { readonly kind: "tool-output-image"; readonly threadId: ThreadId; readonly itemId: string };

export interface Person {
  readonly personId: ParticipantId;
  readonly displayName: string | null;
  /** The person the server's own machine belongs to; never lowered or removed (AC51). */
  readonly firstOwner: boolean;
}

export interface HeldLevel {
  readonly scope: PersonScope;
  readonly level: PersonLevel;
}

export interface BoundDevice {
  readonly sessionId: AuthSessionId;
  /** The permissions the device was paired with, which a new session for it never exceeds. */
  readonly ceiling: ReadonlyArray<string> | null;
  readonly renewPendingSince: string | null;
}

export interface PersonRecord {
  readonly person: Person;
  readonly createdAt: string;
  readonly levels: ReadonlyArray<HeldLevel>;
  readonly devices: ReadonlyArray<BoundDevice>;
}

/**
 * What one session is. A person's session carries what they hold at server scope and the
 * highest level they hold anywhere, which is what their device's permissions follow.
 */
export type SessionReach =
  | { readonly kind: "service" }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "person";
      readonly person: Person;
      readonly levels: ReadonlyArray<HeldLevel>;
      readonly serverLevel: PersonLevel | null;
      readonly highest: PersonLevel | null;
      readonly ceiling: ReadonlyArray<string> | null;
    };

/**
 * Whether a session is held to upstream's own checks alone: a service session, or a person who
 * writes to the whole server. Everyone else is narrowed (`AccessGate`), a server-scope Viewer
 * included, since a Viewer is refused what upstream would let `orchestration:read` see.
 */
export const isWide = (reach: SessionReach) =>
  reach.kind === "service" ||
  (reach.kind === "person" && levelReaches(reach.serverLevel, "collaborator"));

/** The person a session belongs to, when it belongs to one. */
export const reachPersonId = (reach: SessionReach) =>
  reach.kind === "person" ? reach.person.personId : null;

export interface SessionIdentity {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
}

/** How someone reaches a thread or project: at its own scope, through a thread above it, its project, or the server. */
export type ReachVia = "thread" | "ancestor" | "project" | "server";

export interface ScopePerson {
  readonly person: Person;
  readonly level: PersonLevel;
  readonly via: ReadonlyArray<{ readonly via: ReachVia; readonly level: PersonLevel }>;
}

export class PersonAccessStorageError extends Schema.TaggedError<PersonAccessStorageError>()(
  "PersonAccessStorageError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

export class PersonNotFoundError extends Schema.TaggedError<PersonNotFoundError>()(
  "PersonNotFoundError",
  { personId: Schema.String },
) {
  override get message(): string {
    return `No person ${this.personId} is recorded on this server.`;
  }
}

export class FirstOwnerFixedError extends Schema.TaggedError<FirstOwnerFixedError>()(
  "FirstOwnerFixedError",
  {},
) {
  override get message(): string {
    return "The first owner is the person the server's own machine belongs to, and cannot be lowered or removed.";
  }
}

export class OwnerOutsideServerError extends Schema.TaggedError<OwnerOutsideServerError>()(
  "OwnerOutsideServerError",
  {},
) {
  override get message(): string {
    return "Owner is held at server scope only.";
  }
}

export class PersonNameTakenError extends Schema.TaggedError<PersonNameTakenError>()(
  "PersonNameTakenError",
  {},
) {
  override get message(): string {
    return "That name is already in use on this server. Choose another.";
  }
}

/**
 * A name folded for comparing, so that near-copies are one name: compatibility-normalised,
 * lower-cased, trimmed, with runs of whitespace made one space. "jackson", " Jackson ", "JACKSON"
 * and fullwidth letters fold alike; look-alike letters across scripts do not. The name itself is
 * stored and shown as typed.
 */
export const personNameKey = (name: string) =>
  name.normalize("NFKC").toLowerCase().normalize("NFKC").trim().replace(/\s+/gu, " ");

/** Whether a failed write broke the rule that no two people share a folded name. */
const brokeNameRule = (cause: unknown): boolean => {
  for (let seen: unknown = cause, depth = 0; depth < 6 && seen != null; depth += 1) {
    const message = (seen as { readonly message?: unknown }).message;
    if (typeof message === "string" && /UNIQUE constraint failed.*name_key/.test(message)) {
      return true;
    }
    seen = (seen as { readonly cause?: unknown }).cause;
  }
  return false;
};

export const scopeColumns = (scope: PersonScope) =>
  scope.kind === "server"
    ? { kind: "server" as const, id: "" }
    : scope.kind === "project"
      ? { kind: "project" as const, id: scope.projectId as string }
      : { kind: "thread" as const, id: scope.threadId as string };

export const sameScope = (a: PersonScope, b: PersonScope) => {
  const left = scopeColumns(a);
  const right = scopeColumns(b);
  return left.kind === right.kind && left.id === right.id;
};

export interface PersonAccessShape {
  /** What a session is: a person's device, a service session, or a device no one has claimed. */
  readonly sessionReach: (
    session: SessionIdentity,
  ) => Effect.Effect<SessionReach, PersonAccessStorageError>;
  /** The highest level a person holds over a thread: at the server, its project, or the thread or one above it. */
  readonly threadLevel: (
    personId: ParticipantId,
    threadId: ThreadId,
  ) => Effect.Effect<PersonLevel | null, PersonAccessStorageError>;
  /** The highest level a person holds over a project as a whole: at the server or the project. */
  readonly projectLevel: (
    personId: ParticipantId,
    projectId: ProjectId,
  ) => Effect.Effect<PersonLevel | null, PersonAccessStorageError>;
  /** The project a thread lives in; `null` for a thread the server does not hold. */
  readonly threadProject: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectId | null, PersonAccessStorageError>;
  /** Whether a project belongs in a person's sidebar: they reach it or a thread in it. */
  readonly projectInFeed: (
    personId: ParticipantId,
    projectId: ProjectId,
  ) => Effect.Effect<boolean, PersonAccessStorageError>;
  /**
   * The highest level a person holds over a thread that carries an attachment or a tool's image:
   * an attachment by the messages that carry its id, a tool's image by its turn item.
   */
  readonly messageAssetLevel: (
    personId: ParticipantId,
    asset: MessageAsset,
  ) => Effect.Effect<PersonLevel | null, PersonAccessStorageError>;
  /** Everyone who reaches a thread or a project, with how. */
  readonly scopePeople: (
    scope: Exclude<PersonScope, { readonly kind: "server" }>,
  ) => Effect.Effect<ReadonlyArray<ScopePerson>, PersonAccessStorageError>;

  readonly readPerson: (
    personId: ParticipantId,
  ) => Effect.Effect<Person | null, PersonAccessStorageError>;
  readonly firstOwner: Effect.Effect<Person, PersonAccessStorageError>;
  /** Every person still on the server, oldest first, with their levels and devices. */
  readonly listPeople: Effect.Effect<ReadonlyArray<PersonRecord>, PersonAccessStorageError>;
  readonly listLevels: (
    personId: ParticipantId,
  ) => Effect.Effect<ReadonlyArray<HeldLevel>, PersonAccessStorageError>;
  readonly listDevices: (
    personId: ParticipantId,
  ) => Effect.Effect<ReadonlyArray<BoundDevice>, PersonAccessStorageError>;

  /** Records a person with a name and no level yet. A name someone else holds is refused. */
  readonly createPerson: (input: {
    readonly displayName: string;
  }) => Effect.Effect<Person, PersonAccessStorageError | PersonNameTakenError>;
  readonly setName: (input: {
    readonly personId: ParticipantId;
    readonly displayName: string;
  }) => Effect.Effect<void, PersonAccessStorageError | PersonNotFoundError | PersonNameTakenError>;
  /** Gives a person a level at a scope, replacing any they held at that scope. */
  readonly setLevel: (input: {
    readonly personId: ParticipantId;
    readonly scope: PersonScope;
    readonly level: PersonLevel;
  }) => Effect.Effect<
    void,
    PersonAccessStorageError | PersonNotFoundError | FirstOwnerFixedError | OwnerOutsideServerError
  >;
  readonly removeLevel: (input: {
    readonly personId: ParticipantId;
    readonly scope: PersonScope;
  }) => Effect.Effect<void, PersonAccessStorageError | FirstOwnerFixedError>;
  /**
   * Takes everything a person holds away: their levels and their devices' bindings. Their record
   * stays, without a name anyone else is kept from, so their messages keep the name they had.
   * Reports the sessions that were theirs, for the caller to end upstream.
   */
  readonly removePerson: (
    personId: ParticipantId,
  ) => Effect.Effect<
    ReadonlyArray<AuthSessionId>,
    PersonAccessStorageError | PersonNotFoundError | FirstOwnerFixedError
  >;

  /** Ties a session to a person, with the ceiling it was paired with. */
  readonly bindSession: (input: {
    readonly sessionId: AuthSessionId;
    readonly personId: ParticipantId;
    readonly ceiling: ReadonlyArray<string> | null;
  }) => Effect.Effect<void, PersonAccessStorageError | PersonNotFoundError>;
  /** Cuts a session loose from its person; reports whose it was. Its renewal mark goes with it. */
  readonly unbindSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<ParticipantId | null, PersonAccessStorageError>;
  /** The same for every session but one. */
  readonly unbindOtherSessions: (
    exceptSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<ParticipantId>, PersonAccessStorageError>;

  /**
   * The person whose reach changed, each time something here commits a change to it. Feeds
   * already open for them re-check.
   */
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<ParticipantId>, never, Scope.Scope>;
  /** Tells subscribers and the People page that a person's reach or name changed. */
  readonly announce: (personId: ParticipantId) => Effect.Effect<void>;
}

export class PersonAccess extends Context.Service<PersonAccess, PersonAccessShape>()(
  "t3/j5/sharing/PersonAccess",
) {}

interface PersonRow {
  readonly person_id: string;
  readonly display_name: string | null;
  readonly is_local_operator: number;
}

interface LevelRow {
  readonly person_id: string;
  readonly scope_kind: "server" | "project" | "thread";
  readonly scope_id: string;
  readonly level: PersonLevel;
}

interface DeviceRow {
  readonly session_id: string;
  readonly person_id: string;
  readonly ceiling_scopes: string | null;
  readonly renew_pending_since: string | null;
}

const toPerson = (row: PersonRow): Person => ({
  personId: ParticipantId.make(row.person_id),
  displayName: row.display_name,
  firstOwner: row.is_local_operator === 1,
});

const toScope = (row: Pick<LevelRow, "scope_kind" | "scope_id">): PersonScope =>
  row.scope_kind === "server"
    ? { kind: "server" }
    : row.scope_kind === "project"
      ? { kind: "project", projectId: row.scope_id as ProjectId }
      : { kind: "thread", threadId: row.scope_id as ThreadId };

const toHeld = (row: LevelRow): HeldLevel => ({ scope: toScope(row), level: row.level });

// A ceiling is stored as upstream stores a session's scopes: a JSON array of permission names.
const StoredCeiling = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStoredCeiling = Schema.decodeUnknownOption(StoredCeiling);
const encodeCeiling = Schema.encodeSync(StoredCeiling);
// A ceiling that cannot be read holds nothing, so a device under it gains nothing.
const decodeCeiling = (stored: string | null): ReadonlyArray<string> | null =>
  stored === null ? null : Option.getOrElse(decodeStoredCeiling(stored), () => []);

const toDevice = (row: DeviceRow): BoundDevice => ({
  sessionId: row.session_id as AuthSessionId,
  ceiling: decodeCeiling(row.ceiling_scopes),
  renewPendingSince: row.renew_pending_since,
});

type PersonAccessError =
  | PersonAccessStorageError
  | PersonNameTakenError
  | PersonNotFoundError
  | FirstOwnerFixedError
  | OwnerOutsideServerError;
const isPersonAccessError = Schema.is(
  Schema.Union([
    PersonAccessStorageError,
    PersonNameTakenError,
    PersonNotFoundError,
    FirstOwnerFixedError,
    OwnerOutsideServerError,
  ]),
);

/** How far up a placement tree a thread's level is looked for; trees are a few levels deep. */
const MAX_ANCESTOR_DEPTH = 64;

const make: Layer.Layer<PersonAccess, never, SqlClient.SqlClient | ReadChanges> = Layer.effect(
  PersonAccess,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* Effect.acquireRelease(PubSub.sliding<ParticipantId>(256), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    const readChanges = yield* ReadChanges;
    const announce = (personId: ParticipantId) =>
      PubSub.publish(changes, personId).pipe(Effect.andThen(readChanges.notify("sharing")));
    // This module's own errors pass through; anything else is the database.
    const storage =
      (operation: string) =>
      <E>(cause: E): PersonAccessStorageError | Extract<E, PersonAccessError> =>
        isPersonAccessError(cause)
          ? (cause as Extract<E, PersonAccessError>)
          : new PersonAccessStorageError({ operation, cause });
    // A write of a name: the unique index on the folded name is what refuses a second holder,
    // so two people writing one name at the same moment cannot both keep it.
    const naming =
      (operation: string) =>
      <E>(
        cause: E,
      ): PersonAccessStorageError | PersonNameTakenError | Extract<E, PersonAccessError> =>
        brokeNameRule(cause) ? new PersonNameTakenError({}) : storage(operation)(cause);

    const readPersonRow = (personId: ParticipantId) =>
      sql<PersonRow>`
        SELECT person_id, display_name, is_local_operator
        FROM j5_a2a_human_person
        WHERE person_id = ${personId} AND removed_at IS NULL
      `.pipe(Effect.map((rows) => rows[0]));

    const requirePerson = Effect.fn("j5.sharing.personAccess.requirePerson")(function* (
      personId: ParticipantId,
    ) {
      const row = yield* readPersonRow(personId);
      if (row === undefined) return yield* new PersonNotFoundError({ personId });
      return toPerson(row);
    });

    const levelsOf = (personId: ParticipantId) =>
      sql<LevelRow>`
        SELECT person_id, scope_kind, scope_id, level FROM j5_a2a_person_level
        WHERE person_id = ${personId}
        ORDER BY scope_kind DESC, scope_id
      `.pipe(Effect.map((rows) => rows.map(toHeld)));

    const firstOwnerRow = Effect.gen(function* () {
      const id = yield* ensureLocalOperatorHumanPerson(sql);
      const row = yield* readPersonRow(id);
      if (row === undefined) {
        return yield* new PersonAccessStorageError({ operation: "read the first owner" });
      }
      return row;
    });

    const personReach = Effect.fn("j5.sharing.personAccess.personReach")(function* (
      person: Person,
      ceiling: ReadonlyArray<string> | null,
    ) {
      const levels = yield* levelsOf(person.personId);
      return {
        kind: "person" as const,
        person,
        levels,
        serverLevel: highestLevel(
          levels.filter((held) => held.scope.kind === "server").map((held) => held.level),
        ),
        highest: highestLevel(levels.map((held) => held.level)),
        ceiling,
      };
    });

    const sessionReach: PersonAccessShape["sessionReach"] = Effect.fn(
      "j5.sharing.personAccess.sessionReach",
    )(
      function* (session) {
        const bound = yield* sql<PersonRow & { readonly ceiling_scopes: string | null }>`
          SELECT person.person_id, person.display_name, person.is_local_operator,
            device.ceiling_scopes
          FROM j5_a2a_person_session AS device
          JOIN j5_a2a_human_person AS person
            ON person.person_id = device.person_id AND person.removed_at IS NULL
          WHERE device.session_id = ${session.sessionId}
        `;
        const row = bound[0];
        if (row !== undefined) {
          return yield* personReach(toPerson(row), decodeCeiling(row.ceiling_scopes));
        }
        if (FIRST_OWNER_SUBJECTS.has(session.subject)) {
          return yield* personReach(toPerson(yield* firstOwnerRow), null);
        }
        if (isServiceSubject(session.subject)) return { kind: "service" as const };
        return { kind: "unknown" as const };
      },
      Effect.mapError(storage("read whose a session is")),
    );

    // Every thread from the one asked about up to the root of its tree. A Subagent's parent is
    // its upstream lineage parent; a Peer Agent's is its placement parent, unless it is a fork.
    const chain = (threadId: ThreadId) => sql`
      WITH RECURSIVE chain(thread_id, depth) AS (
        SELECT ${threadId}, 0
        UNION ALL
        SELECT
          COALESCE(
            (
              SELECT json_extract(thread.payload_json, '$.lineage.parentThreadId')
              FROM orchestration_v2_projection_threads AS thread
              WHERE thread.thread_id = chain.thread_id
                AND json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
            ),
            (
              SELECT parent.thread_id
              FROM j5_a2a_membership AS child
              JOIN j5_a2a_participant_placement AS placement
                ON placement.project_id = child.project_id
               AND placement.participant_id = child.participant_id
              JOIN j5_a2a_membership AS parent
                ON parent.project_id = placement.project_id
               AND parent.participant_id = placement.placement_parent_id
              WHERE child.thread_id = chain.thread_id
                AND placement.provenance_kind <> 'forked-from'
              LIMIT 1
            )
          ),
          chain.depth + 1
        FROM chain
        WHERE chain.thread_id IS NOT NULL AND chain.depth < ${MAX_ANCESTOR_DEPTH}
      )
    `;

    /** Every level row that covers a thread, for one person or for everyone. */
    const coveringThread = (threadId: ThreadId, personId: ParticipantId | null) => sql<LevelRow>`
      ${chain(threadId)}
      SELECT held.person_id, held.scope_kind, held.scope_id, held.level
      FROM j5_a2a_person_level AS held
      WHERE (${personId} IS NULL OR held.person_id = ${personId})
        AND (
          held.scope_kind = 'server'
          OR (held.scope_kind = 'thread' AND held.scope_id IN (
            SELECT thread_id FROM chain WHERE thread_id IS NOT NULL
          ))
          OR (held.scope_kind = 'project' AND held.scope_id = (
            SELECT project_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
          ))
        )
    `;

    const threadLevel: PersonAccessShape["threadLevel"] = Effect.fn(
      "j5.sharing.personAccess.threadLevel",
    )(
      function* (personId, threadId) {
        const rows = yield* coveringThread(threadId, personId);
        return highestLevel(rows.map((row) => row.level));
      },
      Effect.mapError(storage("read a person's level on a thread")),
    );

    const viaOf = (row: LevelRow, threadId: ThreadId | null): ReachVia =>
      row.scope_kind === "server"
        ? "server"
        : row.scope_kind === "project"
          ? "project"
          : row.scope_id === threadId
            ? "thread"
            : "ancestor";

    // The threads whose messages carry the attachment. The text search narrows the rows before
    // each one's attachment list is read; only a narrowed request for an attachment runs it.
    const attachmentThreads = (attachmentId: string) => sql<{ readonly thread_id: string }>`
      SELECT DISTINCT message.thread_id
      FROM orchestration_v2_projection_messages AS message,
        json_each(message.payload_json, '$.attachments') AS attachment
      WHERE instr(message.payload_json, ${attachmentId}) > 0
        AND json_extract(attachment.value, '$.id') = ${attachmentId}
    `;

    const turnItemThreads = (threadId: ThreadId, itemId: string) => sql<{
      readonly thread_id: string;
    }>`
      SELECT thread_id
      FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id = ${itemId} AND thread_id = ${threadId}
    `;

    const refuseFirstOwner = Effect.fn("j5.sharing.personAccess.refuseFirstOwner")(function* (
      personId: ParticipantId,
    ) {
      const row = yield* readPersonRow(personId);
      if (row?.is_local_operator === 1) return yield* new FirstOwnerFixedError({});
    });

    return PersonAccess.of({
      sessionReach,

      threadLevel,

      projectLevel: Effect.fn("j5.sharing.personAccess.projectLevel")(
        function* (personId, projectId) {
          const rows = yield* sql<{ readonly level: PersonLevel }>`
            SELECT level FROM j5_a2a_person_level
            WHERE person_id = ${personId}
              AND (scope_kind = 'server' OR (scope_kind = 'project' AND scope_id = ${projectId}))
          `;
          return highestLevel(rows.map((row) => row.level));
        },
        Effect.mapError(storage("read a person's level on a project")),
      ),

      threadProject: (threadId) =>
        sql<{ readonly project_id: string }>`
          SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : (rows[0].project_id as ProjectId))),
          Effect.mapError(storage("read a thread's project")),
          Effect.withSpan("j5.sharing.personAccess.threadProject"),
        ),

      projectInFeed: Effect.fn("j5.sharing.personAccess.projectInFeed")(
        function* (personId, projectId) {
          // The cheap answers first: the server, the project, or a thread that lives in it.
          const direct = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found
            FROM j5_a2a_person_level AS held
            WHERE held.person_id = ${personId}
              AND (
                held.scope_kind = 'server'
                OR (held.scope_kind = 'project' AND held.scope_id = ${projectId})
                OR (held.scope_kind = 'thread' AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_threads AS thread
                  WHERE thread.thread_id = held.scope_id
                    AND thread.project_id = ${projectId}
                    AND thread.deleted_at IS NULL
                ))
              )
            LIMIT 1
          `;
          if (direct.length > 0) return true;
          // An agent beneath a covered thread can live in another project; its thread is in the
          // person's sidebar, and so is that project.
          const threads = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE project_id = ${projectId} AND deleted_at IS NULL
          `;
          for (const thread of threads) {
            if ((yield* coveringThread(thread.thread_id as ThreadId, personId)).length > 0) {
              return true;
            }
          }
          return false;
        },
        Effect.mapError(storage("read whether a project is in a person's sidebar")),
      ),

      messageAssetLevel: Effect.fn("j5.sharing.personAccess.messageAssetLevel")(
        function* (personId, asset) {
          const holders =
            asset.kind === "attachment"
              ? yield* attachmentThreads(asset.attachmentId)
              : yield* turnItemThreads(asset.threadId, asset.itemId);
          const levels = yield* Effect.forEach(holders, (holder) =>
            coveringThread(holder.thread_id as ThreadId, personId),
          );
          return highestLevel(levels.flat().map((row) => row.level));
        },
        Effect.mapError(storage("read a person's level on an attachment")),
      ),

      scopePeople: Effect.fn("j5.sharing.personAccess.scopePeople")(
        function* (scope) {
          const threadId = scope.kind === "thread" ? scope.threadId : null;
          const rows =
            scope.kind === "thread"
              ? yield* coveringThread(scope.threadId, null)
              : yield* sql<LevelRow>`
                  SELECT person_id, scope_kind, scope_id, level FROM j5_a2a_person_level
                  WHERE scope_kind = 'server'
                    OR (scope_kind = 'project' AND scope_id = ${scope.projectId})
                `;
          const people = yield* sql<PersonRow & { readonly created_at: string }>`
            SELECT person_id, display_name, is_local_operator, created_at
            FROM j5_a2a_human_person
            WHERE removed_at IS NULL
            ORDER BY created_at, person_id
          `;
          return people.flatMap((row): ReadonlyArray<ScopePerson> => {
            const held = rows.filter((level) => level.person_id === row.person_id);
            const level = highestLevel(held.map((entry) => entry.level));
            if (level === null) return [];
            return [
              {
                person: toPerson(row),
                level,
                via: held.map((entry) => ({ via: viaOf(entry, threadId), level: entry.level })),
              },
            ];
          });
        },
        Effect.mapError(storage("read who reaches a thread or project")),
      ),

      readPerson: Effect.fn("j5.sharing.personAccess.readPerson")(
        function* (personId) {
          const row = yield* readPersonRow(personId);
          return row === undefined ? null : toPerson(row);
        },
        Effect.mapError(storage("read a person")),
      ),

      firstOwner: firstOwnerRow.pipe(
        Effect.map(toPerson),
        Effect.mapError(storage("read the first owner")),
        Effect.withSpan("j5.sharing.personAccess.firstOwner"),
      ),

      listPeople: Effect.gen(function* () {
        const people = yield* sql<PersonRow & { readonly created_at: string }>`
          SELECT person_id, display_name, is_local_operator, created_at
          FROM j5_a2a_human_person
          WHERE removed_at IS NULL
          ORDER BY created_at, person_id
        `;
        const levels = yield* sql<LevelRow>`
          SELECT person_id, scope_kind, scope_id, level FROM j5_a2a_person_level
          ORDER BY scope_kind DESC, scope_id
        `;
        const devices = yield* sql<DeviceRow>`
          SELECT session_id, person_id, ceiling_scopes, renew_pending_since
          FROM j5_a2a_person_session
          ORDER BY bound_at, session_id
        `;
        return people.map((row): PersonRecord => ({
          person: toPerson(row),
          createdAt: row.created_at,
          levels: levels.filter((level) => level.person_id === row.person_id).map(toHeld),
          devices: devices.filter((device) => device.person_id === row.person_id).map(toDevice),
        }));
      }).pipe(
        Effect.mapError(storage("list people")),
        Effect.withSpan("j5.sharing.personAccess.listPeople"),
      ),

      listLevels: (personId) =>
        levelsOf(personId).pipe(
          Effect.mapError(storage("list a person's levels")),
          Effect.withSpan("j5.sharing.personAccess.listLevels"),
        ),

      listDevices: (personId) =>
        sql<DeviceRow>`
          SELECT session_id, person_id, ceiling_scopes, renew_pending_since
          FROM j5_a2a_person_session WHERE person_id = ${personId}
          ORDER BY bound_at, session_id
        `.pipe(
          Effect.map((rows) => rows.map(toDevice)),
          Effect.mapError(storage("list a person's devices")),
          Effect.withSpan("j5.sharing.personAccess.listDevices"),
        ),

      createPerson: Effect.fn("j5.sharing.personAccess.createPerson")(
        function* (input) {
          const personId = ParticipantId.make(`human:${NodeCrypto.randomUUID()}`);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO j5_a2a_human_person (
              person_id, is_local_operator, created_at, display_name, name_key
            ) VALUES (
              ${personId}, 0, ${createdAt}, ${input.displayName},
              ${personNameKey(input.displayName)}
            )
          `;
          // A person with no level yet reaches nothing, so only the People page is told.
          yield* readChanges.notify("sharing");
          return { personId, displayName: input.displayName, firstOwner: false };
        },
        Effect.mapError(naming("record a person")),
      ),

      setName: Effect.fn("j5.sharing.personAccess.setName")(
        function* (input) {
          const rows = yield* sql`
            UPDATE j5_a2a_human_person
            SET display_name = ${input.displayName}, name_key = ${personNameKey(input.displayName)}
            WHERE person_id = ${input.personId} AND removed_at IS NULL
            RETURNING person_id
          `;
          if (rows.length === 0)
            return yield* new PersonNotFoundError({ personId: input.personId });
          yield* announce(input.personId);
        },
        Effect.mapError(naming("record a person's name")),
      ),

      setLevel: Effect.fn("j5.sharing.personAccess.setLevel")(
        function* (input) {
          if (input.level === "owner" && input.scope.kind !== "server") {
            return yield* new OwnerOutsideServerError({});
          }
          yield* requirePerson(input.personId);
          yield* refuseFirstOwner(input.personId);
          const scope = scopeColumns(input.scope);
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO j5_a2a_person_level (
              person_id, scope_kind, scope_id, level, created_at, updated_at
            ) VALUES (${input.personId}, ${scope.kind}, ${scope.id}, ${input.level}, ${now}, ${now})
            ON CONFLICT (person_id, scope_kind, scope_id)
            DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at
          `;
          yield* announce(input.personId);
        },
        Effect.mapError(storage("record a level")),
      ),

      removeLevel: Effect.fn("j5.sharing.personAccess.removeLevel")(
        function* (input) {
          yield* refuseFirstOwner(input.personId);
          const scope = scopeColumns(input.scope);
          yield* sql`
            DELETE FROM j5_a2a_person_level
            WHERE person_id = ${input.personId}
              AND scope_kind = ${scope.kind}
              AND scope_id = ${scope.id}
          `;
          yield* announce(input.personId);
        },
        Effect.mapError(storage("remove a level")),
      ),

      removePerson: Effect.fn("j5.sharing.personAccess.removePerson")(
        function* (personId) {
          const sessions = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requirePerson(personId);
              yield* refuseFirstOwner(personId);
              const bound = yield* sql<{ readonly session_id: string }>`
                DELETE FROM j5_a2a_person_session WHERE person_id = ${personId}
                RETURNING session_id
              `;
              yield* sql`DELETE FROM j5_a2a_person_level WHERE person_id = ${personId}`;
              yield* sql`DELETE FROM j5_a2a_pairing_intent WHERE person_id = ${personId}`;
              const removedAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
                UPDATE j5_a2a_human_person SET removed_at = ${removedAt}, name_key = NULL
                WHERE person_id = ${personId}
              `;
              return bound.map((row) => row.session_id as AuthSessionId);
            }),
          );
          yield* announce(personId);
          return sessions;
        },
        Effect.mapError(storage("remove a person")),
      ),

      bindSession: Effect.fn("j5.sharing.personAccess.bindSession")(
        function* (input) {
          yield* requirePerson(input.personId);
          const boundAt = DateTime.formatIso(yield* DateTime.now);
          const ceiling = input.ceiling === null ? null : encodeCeiling(input.ceiling);
          yield* sql`
            INSERT INTO j5_a2a_person_session (session_id, person_id, bound_at, ceiling_scopes)
            VALUES (${input.sessionId}, ${input.personId}, ${boundAt}, ${ceiling})
            ON CONFLICT (session_id) DO UPDATE SET
              person_id = excluded.person_id,
              bound_at = excluded.bound_at,
              ceiling_scopes = excluded.ceiling_scopes,
              renew_pending_since = NULL
          `;
          yield* announce(input.personId);
        },
        Effect.mapError(storage("tie a session to a person")),
      ),

      unbindSession: Effect.fn("j5.sharing.personAccess.unbindSession")(
        function* (sessionId) {
          const rows = yield* sql<{ readonly person_id: string }>`
            DELETE FROM j5_a2a_person_session WHERE session_id = ${sessionId} RETURNING person_id
          `;
          if (rows[0] === undefined) return null;
          const personId = ParticipantId.make(rows[0].person_id);
          yield* announce(personId);
          return personId;
        },
        Effect.mapError(storage("cut a session loose from its person")),
      ),

      unbindOtherSessions: Effect.fn("j5.sharing.personAccess.unbindOtherSessions")(
        function* (exceptSessionId) {
          const rows = yield* sql<{ readonly person_id: string }>`
            DELETE FROM j5_a2a_person_session
            WHERE session_id <> ${exceptSessionId}
            RETURNING person_id
          `;
          const personIds = [...new Set(rows.map((row) => row.person_id))].map((id) =>
            ParticipantId.make(id),
          );
          yield* Effect.forEach(personIds, announce, { discard: true });
          return personIds;
        },
        Effect.mapError(storage("cut sessions loose from their people")),
      ),

      subscribeChanges: PubSub.subscribe(changes),
      announce,
    });
  }),
);

// `readChangesLayer` is the one the rest of the server provides, so it is the same instance
// (see `a2a/runtimeLayer.ts`): what is written here reaches the stream a client follows.
export const layer: Layer.Layer<PersonAccess, never, SqlClient.SqlClient> = make.pipe(
  Layer.provide(readChangesLayer),
);
