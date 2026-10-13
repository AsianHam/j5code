// @effect-diagnostics nodeBuiltinImport:off - random ids for new people.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ParticipantId } from "../a2a/contracts.ts";
import { ensureLocalOperatorHumanPerson } from "../a2a/HumanPersonRegistry.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";

/**
 * Shared server's people and grants (docs/j5/product/features/shared-server.md). A member reaches
 * everything on the server; a guest reaches what their grants cover, at the grant's level.
 */
export type PersonKind = "member" | "guest";
export type GrantLevel = "view" | "collaborate";
export type GrantTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "thread"; readonly threadId: ThreadId };

/** What a person may do with one thread or project: a member's reach, a guest's level, or none. */
export type Access = "member" | GrantLevel | "none";

/**
 * Something a message in a thread carries, which a client asks the server for a URL to. The server
 * finds the thread in its own records: a client's word for which thread it belongs to is not used.
 */
export type MessageAsset =
  | { readonly kind: "attachment"; readonly attachmentId: string }
  | { readonly kind: "tool-output-image"; readonly threadId: ThreadId; readonly itemId: string };

export interface Person {
  readonly personId: ParticipantId;
  readonly kind: PersonKind;
  readonly displayName: string | null;
  /** The person typed this name themselves, joining by an open link; no member has confirmed it. */
  readonly nameSelfGiven: boolean;
  /** The open link the person joined through, when they did. */
  readonly joinedOpenLinkId: string | null;
}

export interface PersonGrant {
  readonly personId: ParticipantId;
  readonly target: GrantTarget;
  readonly level: GrantLevel;
  /** The line the member wrote when sharing, saying what the guest is there for. */
  readonly note: string | null;
}

/** A person as the people list shows them: what they hold and the sessions paired as them. */
export interface PersonRecord {
  readonly person: Person;
  readonly createdAt: string;
  readonly grants: ReadonlyArray<PersonGrant>;
  readonly sessionIds: ReadonlyArray<AuthSessionId>;
}

/**
 * The subject a guest's pairing link carries, which upstream copies onto every session made from
 * it and which nothing a client sends can change. It is what marks a connection as a guest's;
 * `j5_a2a_person_session` then says which guest. A marked session with no person recorded is a
 * guest with no grants. A session without the mark is a member's own device and is never looked
 * up, so members pay nothing for guests existing.
 */
export const GUEST_SESSION_SUBJECT = "j5:guest";

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

export class GrantOnMemberError extends Schema.TaggedError<GrantOnMemberError>()(
  "GrantOnMemberError",
  { personId: Schema.String },
) {
  override get message(): string {
    return `${this.personId} is a member of this server and already reaches everything on it; only a guest holds grants.`;
  }
}

export class MemberNotRemovableError extends Schema.TaggedError<MemberNotRemovableError>()(
  "MemberNotRemovableError",
  { personId: Schema.String },
) {
  override get message(): string {
    return `${this.personId} is a member of this server; only a guest can be removed.`;
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

export interface SessionIdentity {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
}

export interface PersonAccessShape {
  /**
   * Records a guest under the name the member bringing them in gave them. `joinedOpenLinkId`
   * marks one who joined by an open link instead, under a name they typed themselves. A name
   * another person on the server already has, compared folded, is refused.
   */
  readonly createGuest: (input: {
    readonly displayName: string;
    readonly joinedOpenLinkId?: string;
  }) => Effect.Effect<Person, PersonAccessStorageError | PersonNameTakenError>;
  /** The name of the person the server belongs to; `null` until one is set. */
  readonly operatorName: Effect.Effect<string | null, PersonAccessStorageError>;
  /**
   * Names the person the server belongs to: the one member there is, whom every device that is
   * not a guest's is taken to be. It is the name guests and agents know them by.
   */
  readonly setOperatorName: (
    displayName: string,
  ) => Effect.Effect<Person, PersonAccessStorageError | PersonNameTakenError>;
  readonly readPerson: (
    personId: ParticipantId,
  ) => Effect.Effect<Person | null, PersonAccessStorageError>;
  /**
   * Gives a guest a level on a project or thread, replacing any level they held on it. A `note`
   * left out keeps the one already recorded; `null` clears it.
   */
  readonly putGrant: (
    grant: Omit<PersonGrant, "note"> & { readonly note?: string | null },
  ) => Effect.Effect<void, PersonAccessStorageError | PersonNotFoundError | GrantOnMemberError>;
  readonly removeGrant: (input: {
    readonly personId: ParticipantId;
    readonly target: GrantTarget;
  }) => Effect.Effect<void, PersonAccessStorageError>;
  readonly listGrants: (
    personId: ParticipantId,
  ) => Effect.Effect<ReadonlyArray<PersonGrant>, PersonAccessStorageError>;
  /**
   * Gives a guest a new name, which is from then on a member's word for them and no longer one
   * they gave themselves. Told to open feeds, as a change to who is on a thread.
   */
  readonly setGuestName: (input: {
    readonly personId: ParticipantId;
    readonly displayName: string;
  }) => Effect.Effect<void, PersonAccessStorageError | PersonNotFoundError | PersonNameTakenError>;
  /**
   * Every guest whose grants cover a thread, each with every grant that covers it: on the thread
   * itself, on a thread above it, or on its project. Members reach every thread and are listed
   * apart.
   */
  readonly threadPeople: (threadId: ThreadId) => Effect.Effect<
    {
      readonly members: ReadonlyArray<Person>;
      readonly guests: ReadonlyArray<{
        readonly person: Person;
        readonly grants: ReadonlyArray<{
          readonly via: GrantVia;
          readonly level: GrantLevel;
          /** The line the member wrote for the agent when sharing; not for the guest. */
          readonly note: string | null;
        }>;
      }>;
    },
    PersonAccessStorageError
  >;
  /** Every person recorded on this server, oldest first, with their grants and sessions. */
  readonly listPeople: Effect.Effect<ReadonlyArray<PersonRecord>, PersonAccessStorageError>;
  /**
   * Removes a guest with everything recorded for them: their grants, the sessions paired as them
   * and their unused links. Reports those sessions and links so the caller can end them upstream.
   * From the moment it commits, a connection still open for them reaches nothing.
   */
  readonly removeGuest: (personId: ParticipantId) => Effect.Effect<
    {
      readonly sessionIds: ReadonlyArray<AuthSessionId>;
      readonly pairingLinkIds: ReadonlyArray<string>;
    },
    PersonAccessStorageError | PersonNotFoundError | MemberNotRemovableError
  >;
  /**
   * Cuts a session loose from the guest it was paired as, and reports who that was; `null` when
   * the session is no guest's. A connection still open on it reaches nothing from then on.
   */
  readonly unbindSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<ParticipantId | null, PersonAccessStorageError>;
  /**
   * The same for every guest's session but one, as when a member ends all other devices. Reports
   * the guests it cut sessions loose from.
   */
  readonly unbindOtherSessions: (
    exceptSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<ParticipantId>, PersonAccessStorageError>;
  /**
   * Ties an auth session to a person. Only tests call it: a real session is tied as upstream
   * issues it, by `GuestPairing.issueSession`.
   */
  readonly bindSession: (input: {
    readonly sessionId: AuthSessionId;
    readonly personId: ParticipantId;
  }) => Effect.Effect<void, PersonAccessStorageError | PersonNotFoundError>;
  /**
   * The guest a connection belongs to, or `null` for a member's own device: every session that
   * does not carry `GUEST_SESSION_SUBJECT`. A marked session with no person recorded is reported
   * as a guest with no id, so it reaches nothing.
   */
  readonly sessionPerson: (
    session: SessionIdentity,
  ) => Effect.Effect<
    Person | { readonly kind: "guest"; readonly personId: null } | null,
    PersonAccessStorageError
  >;
  /**
   * A connection's access to a thread, as the level it may act at. A guest writes only where a
   * Collaborate grant names the thread or its project; a thread covered through one above it is
   * read at View whatever that grant's level. A guest's grant on a thread covers the agents beneath it:
   * the Subagents it ran and the Peer Agents placed under it, Crew seats among them. A fork is a
   * thread of its own and is not covered by its source's grant. A grant on the thread's project
   * covers it too; the higher level applies.
   */
  readonly threadAccess: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Effect.Effect<Access, PersonAccessStorageError>;
  /**
   * A connection's access to a thread now, then again each time a change to its guest's grants
   * alters it, so a client already showing the thread follows the change (AC10). A member's
   * connection is told once.
   */
  readonly watchThreadAccess: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Stream.Stream<Access, PersonAccessStorageError>;
  /**
   * A connection's access to an attachment or a tool's image, through a thread that holds it: an
   * attachment by the messages that carry its id, a tool's image by the thread its turn item is
   * stored under. Something no thread holds, or held only by threads out of reach, gives `none`.
   */
  readonly messageAssetAccess: (
    session: SessionIdentity,
    asset: MessageAsset,
  ) => Effect.Effect<Access, PersonAccessStorageError>;
  /** A connection's access to a project as a whole; a grant on one of its threads gives none. */
  readonly projectAccess: (
    session: SessionIdentity,
    projectId: ProjectId,
  ) => Effect.Effect<Access, PersonAccessStorageError>;
  /**
   * Whether a project is one a connection's sidebar holds: a member's always; a guest's when
   * they hold a grant on it or can see a thread that lives in it.
   */
  readonly projectInFeed: (
    session: SessionIdentity,
    projectId: ProjectId,
  ) => Effect.Effect<boolean, PersonAccessStorageError>;
  /**
   * The guest whose reach just changed, each time `putGrant`, `removeGrant`, `removeGuest` or
   * `unbindSession` commits. A feed already open for that guest subscribes so the change reaches
   * them without reconnecting.
   */
  readonly subscribeGrantChanges: Effect.Effect<
    PubSub.Subscription<ParticipantId>,
    never,
    Scope.Scope
  >;
}

export class PersonAccess extends Context.Service<PersonAccess, PersonAccessShape>()(
  "t3/j5/sharing/PersonAccess",
) {}

interface PersonRow {
  readonly person_id: string;
  readonly kind: PersonKind;
  readonly display_name: string | null;
  readonly name_self_given: number;
  readonly joined_open_link_id: string | null;
}

interface GrantRow {
  readonly person_id: string;
  readonly target_kind: "project" | "thread";
  readonly target_id: string;
  readonly level: GrantLevel;
  readonly note: string | null;
}

const toPerson = (row: PersonRow): Person => ({
  personId: ParticipantId.make(row.person_id),
  kind: row.kind,
  displayName: row.display_name,
  nameSelfGiven: row.name_self_given === 1,
  joinedOpenLinkId: row.joined_open_link_id,
});

const targetColumns = (target: GrantTarget) =>
  target.kind === "project"
    ? { kind: "project" as const, id: target.projectId as string }
    : { kind: "thread" as const, id: target.threadId as string };

const toGrant = (row: GrantRow): PersonGrant => ({
  personId: ParticipantId.make(row.person_id),
  target:
    row.target_kind === "project"
      ? { kind: "project", projectId: row.target_id as ProjectId }
      : { kind: "thread", threadId: row.target_id as ThreadId },
  level: row.level,
  note: row.note,
});

const highest = (levels: ReadonlyArray<GrantLevel>): Access =>
  levels.includes("collaborate") ? "collaborate" : levels.includes("view") ? "view" : "none";

type PersonAccessError =
  | PersonAccessStorageError
  | PersonNameTakenError
  | PersonNotFoundError
  | GrantOnMemberError
  | MemberNotRemovableError;
const isPersonAccessError = Schema.is(
  Schema.Union([
    PersonAccessStorageError,
    PersonNameTakenError,
    PersonNotFoundError,
    GrantOnMemberError,
    MemberNotRemovableError,
  ]),
);

/** How far up a placement tree a thread grant is looked for; trees are a few levels deep. */
const MAX_ANCESTOR_DEPTH = 64;

/** How a grant comes to cover a thread: it names the thread, a thread above it, or its project. */
export type GrantVia = "thread" | "ancestor" | "project";

export const grantVia = (
  grant: { readonly target_kind: "project" | "thread"; readonly target_id: string },
  threadId: ThreadId,
): GrantVia =>
  grant.target_kind === "project"
    ? "project"
    : grant.target_id === threadId
      ? "thread"
      : "ancestor";

/**
 * The one rule for where a grant lets its holder write, at the grant's level: on the thread it
 * names, or anywhere in the project it names. A grant on a thread above gives reading only: a
 * guest with Collaborate on a Captain's thread reads its seats and the agents beneath it and
 * writes to none of them, so what reaches them goes through the thread the guest was given.
 * Everything that asks "may this guest write here" goes through this function.
 */
export const writesVia = (via: GrantVia) => via !== "ancestor";

export const grantWrites = (
  grant: { readonly target_kind: "project" | "thread"; readonly target_id: string },
  threadId: ThreadId,
) => writesVia(grantVia(grant, threadId));

/** Whether a thread is a Crew seat's. A guest answers no prompt on one (Shared conversations AC12). */
export const isCrewSeatThread = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found FROM j5_agent_crew_member WHERE thread_id = ${threadId} LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0));

/**
 * Every grant a guest holds that covers a thread: on the thread itself, on a thread above it, or
 * on its project. The same walk up from the thread as `threadLevels`, for everyone at once.
 */
const guestGrantsOnThread = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<PersonRow & GrantRow>`
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
        SELECT person.person_id, person.kind, person.display_name, person.name_self_given,
          person.joined_open_link_id, held.target_kind, held.target_id, held.level, held.note
        FROM j5_a2a_person_grant AS held
        JOIN j5_a2a_human_person AS person
          ON person.person_id = held.person_id AND person.kind = 'guest'
        WHERE (held.target_kind = 'thread' AND held.target_id IN (
            SELECT thread_id FROM chain WHERE thread_id IS NOT NULL
          ))
          OR (held.target_kind = 'project' AND held.target_id = (
            SELECT project_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
          ))
        ORDER BY person.created_at, person.person_id, held.target_kind DESC, held.target_id
      `;

/**
 * Whether a thread is a shared conversation: one a guest holds Collaborate on
 * (docs/j5/product/features/shared-conversations.md). For code that has the database and no
 * session, such as an agent's tool.
 */
export const isSharedConversation = Effect.fn("j5.sharing.isSharedConversation")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  // A server where no guest holds Collaborate on anything, which is most, is asked no more.
  const any = yield* sql<{ readonly found: number }>`
    SELECT 1 AS found FROM j5_a2a_person_grant WHERE level = 'collaborate' LIMIT 1
  `;
  if (any.length === 0) return false;
  return (yield* guestGrantsOnThread(sql, threadId)).some(
    (row) => row.level === "collaborate" && grantWrites(row, threadId),
  );
});

const make: Layer.Layer<PersonAccess, never, SqlClient.SqlClient | ReadChanges> = Layer.effect(
  PersonAccess,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const grantChanges = yield* Effect.acquireRelease(
      PubSub.sliding<ParticipantId>(256),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const readChanges = yield* ReadChanges;
    /**
     * Said after every write that changes what a person holds or who they are: the open feeds
     * of that person's connections re-check, and the People page re-reads.
     */
    const changed = (personId: ParticipantId) =>
      PubSub.publish(grantChanges, personId).pipe(Effect.andThen(readChanges.notify("sharing")));
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
        SELECT person_id, kind, display_name, name_self_given, joined_open_link_id
        FROM j5_a2a_human_person
        WHERE person_id = ${personId}
      `.pipe(Effect.map((rows) => rows[0]));

    const requirePerson = Effect.fn("j5.sharing.personAccess.requirePerson")(function* (
      personId: ParticipantId,
    ) {
      const row = yield* readPersonRow(personId);
      if (row === undefined) return yield* new PersonNotFoundError({ personId });
      return toPerson(row);
    });

    const sessionPerson: PersonAccessShape["sessionPerson"] = Effect.fn(
      "j5.sharing.personAccess.sessionPerson",
    )(
      function* (session) {
        if (session.subject !== GUEST_SESSION_SUBJECT) return null;
        const rows = yield* sql<PersonRow>`
          SELECT person.person_id, person.kind, person.display_name, person.name_self_given,
            person.joined_open_link_id
          FROM j5_a2a_person_session AS bound
          JOIN j5_a2a_human_person AS person ON person.person_id = bound.person_id
          WHERE bound.session_id = ${session.sessionId} AND person.kind = 'guest'
        `;
        return rows[0] === undefined
          ? { kind: "guest" as const, personId: null }
          : toPerson(rows[0]);
      },
      Effect.mapError(storage("read the person a session belongs to")),
    );

    // Every thread from the one asked about up to the root of its tree. A Subagent's parent is
    // its upstream lineage parent; a Peer Agent's is its placement parent, unless it is a fork.
    const threadLevels = (personId: ParticipantId, threadId: ThreadId) => sql<{
      readonly level: GrantLevel;
      readonly target_kind: "project" | "thread";
      readonly target_id: string;
    }>`
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
      SELECT level, target_kind, target_id
      FROM j5_a2a_person_grant
      WHERE person_id = ${personId}
        AND (
          (target_kind = 'thread' AND target_id IN (
            SELECT thread_id FROM chain WHERE thread_id IS NOT NULL
          ))
          OR (target_kind = 'project' AND target_id = (
            SELECT project_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
          ))
        )
    `;

    const threadAccess: PersonAccessShape["threadAccess"] = Effect.fn(
      "j5.sharing.personAccess.threadAccess",
    )(
      function* (session, threadId) {
        const person = yield* sessionPerson(session);
        if (person === null) return "member";
        if (person.personId === null) return "none";
        return highest(
          (yield* threadLevels(person.personId, threadId)).map((row) =>
            grantWrites(row, threadId) ? row.level : "view",
          ),
        );
      },
      Effect.mapError(storage("read a person's access to a thread")),
    );

    // The threads whose messages carry the attachment. The text search narrows the rows before
    // each one's attachment list is read; only a guest's request for an attachment runs it.
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

    return PersonAccess.of({
      createGuest: Effect.fn("j5.sharing.personAccess.createGuest")(
        function* (input) {
          const personId = ParticipantId.make(`human:${NodeCrypto.randomUUID()}`);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const openLinkId = input.joinedOpenLinkId ?? null;
          yield* sql`
            INSERT INTO j5_a2a_human_person (
              person_id, is_local_operator, created_at, kind, display_name, name_key,
              name_self_given, joined_open_link_id
            ) VALUES (
              ${personId}, 0, ${createdAt}, 'guest', ${input.displayName},
              ${personNameKey(input.displayName)}, ${openLinkId === null ? 0 : 1}, ${openLinkId}
            )
          `;
          // A guest with no grant yet is on no thread, so only the People page is told.
          yield* readChanges.notify("sharing");
          return {
            personId,
            kind: "guest" as const,
            displayName: input.displayName,
            nameSelfGiven: openLinkId !== null,
            joinedOpenLinkId: openLinkId,
          };
        },
        Effect.mapError(naming("record a guest")),
      ),

      operatorName: sql<{ readonly display_name: string | null }>`
        SELECT display_name FROM j5_a2a_human_person WHERE is_local_operator = 1 LIMIT 1
      `.pipe(
        Effect.map((rows) => rows[0]?.display_name ?? null),
        Effect.mapError(storage("read the owner's name")),
        Effect.withSpan("j5.sharing.personAccess.operatorName"),
      ),

      setOperatorName: Effect.fn("j5.sharing.personAccess.setOperatorName")(
        function* (displayName) {
          const personId = yield* ensureLocalOperatorHumanPerson(sql);
          yield* sql`
            UPDATE j5_a2a_human_person
            SET display_name = ${displayName}, name_key = ${personNameKey(displayName)}
            WHERE person_id = ${personId}
          `;
          // Told as a change to who is on every thread: the member is on all of them.
          yield* changed(personId);
          return {
            personId,
            kind: "member" as const,
            displayName,
            nameSelfGiven: false,
            joinedOpenLinkId: null,
          };
        },
        Effect.mapError(naming("record the owner's name")),
      ),

      readPerson: Effect.fn("j5.sharing.personAccess.readPerson")(
        function* (personId) {
          const row = yield* readPersonRow(personId);
          return row === undefined ? null : toPerson(row);
        },
        Effect.mapError(storage("read a person")),
      ),

      putGrant: Effect.fn("j5.sharing.personAccess.putGrant")(
        function* (grant) {
          const person = yield* requirePerson(grant.personId);
          if (person.kind === "member") {
            return yield* new GrantOnMemberError({ personId: grant.personId });
          }
          const target = targetColumns(grant.target);
          const now = DateTime.formatIso(yield* DateTime.now);
          const keepNote = grant.note === undefined ? 1 : 0;
          yield* sql`
          INSERT INTO j5_a2a_person_grant (
            person_id, target_kind, target_id, level, created_at, updated_at, note
          ) VALUES (
            ${grant.personId}, ${target.kind}, ${target.id}, ${grant.level}, ${now}, ${now},
            ${grant.note ?? null}
          )
          ON CONFLICT (person_id, target_kind, target_id)
          DO UPDATE SET
            level = excluded.level,
            updated_at = excluded.updated_at,
            note = CASE WHEN ${keepNote} = 1 THEN j5_a2a_person_grant.note ELSE excluded.note END
        `;
          yield* changed(grant.personId);
        },
        Effect.mapError(storage("record a grant")),
      ),

      removeGrant: Effect.fn("j5.sharing.personAccess.removeGrant")(
        function* (input) {
          const target = targetColumns(input.target);
          yield* sql`
          DELETE FROM j5_a2a_person_grant
          WHERE person_id = ${input.personId}
            AND target_kind = ${target.kind}
            AND target_id = ${target.id}
        `;
          yield* changed(input.personId);
        },
        Effect.mapError(storage("remove a grant")),
      ),

      listGrants: Effect.fn("j5.sharing.personAccess.listGrants")(
        function* (personId) {
          const rows = yield* sql<GrantRow>`
          SELECT person_id, target_kind, target_id, level, note
          FROM j5_a2a_person_grant
          WHERE person_id = ${personId}
          ORDER BY target_kind, target_id
        `;
          return rows.map(toGrant);
        },
        Effect.mapError(storage("list a person's grants")),
      ),

      setGuestName: Effect.fn("j5.sharing.personAccess.setGuestName")(
        function* (input) {
          const rows = yield* sql`
            UPDATE j5_a2a_human_person
            SET display_name = ${input.displayName},
              name_key = ${personNameKey(input.displayName)}, name_self_given = 0
            WHERE person_id = ${input.personId} AND kind = 'guest'
            RETURNING person_id
          `;
          if (rows.length === 0)
            return yield* new PersonNotFoundError({ personId: input.personId });
          yield* changed(input.personId);
        },
        Effect.mapError(naming("record a guest's name")),
      ),

      threadPeople: Effect.fn("j5.sharing.personAccess.threadPeople")(
        function* (threadId) {
          const rows = yield* guestGrantsOnThread(sql, threadId);
          const members = yield* sql<PersonRow>`
            SELECT person_id, kind, display_name, name_self_given, joined_open_link_id
            FROM j5_a2a_human_person
            WHERE kind = 'member'
            ORDER BY created_at, person_id
          `;
          const guests = new Map<
            string,
            {
              person: Person;
              grants: Array<{
                via: GrantVia;
                level: GrantLevel;
                note: string | null;
              }>;
            }
          >();
          for (const row of rows) {
            const entry = guests.get(row.person_id) ?? { person: toPerson(row), grants: [] };
            entry.grants.push({
              via: grantVia(row, threadId),
              level: row.level,
              note: row.note,
            });
            guests.set(row.person_id, entry);
          }
          return { members: members.map(toPerson), guests: [...guests.values()] };
        },
        Effect.mapError(storage("read who can reach a thread")),
      ),

      listPeople: Effect.gen(function* () {
        const people = yield* sql<PersonRow & { readonly created_at: string }>`
          SELECT person_id, kind, display_name, name_self_given, joined_open_link_id, created_at
          FROM j5_a2a_human_person
          ORDER BY created_at, person_id
        `;
        const grants = yield* sql<GrantRow>`
          SELECT person_id, target_kind, target_id, level, note
          FROM j5_a2a_person_grant
          ORDER BY target_kind, target_id
        `;
        const sessions = yield* sql<{ readonly session_id: string; readonly person_id: string }>`
          SELECT session_id, person_id FROM j5_a2a_person_session ORDER BY bound_at, session_id
        `;
        return people.map((row): PersonRecord => ({
          person: toPerson(row),
          createdAt: row.created_at,
          grants: grants.filter((grant) => grant.person_id === row.person_id).map(toGrant),
          sessionIds: sessions
            .filter((session) => session.person_id === row.person_id)
            .map((session) => session.session_id as AuthSessionId),
        }));
      }).pipe(
        Effect.mapError(storage("list people")),
        Effect.withSpan("j5.sharing.personAccess.listPeople"),
      ),

      removeGuest: Effect.fn("j5.sharing.personAccess.removeGuest")(
        function* (personId) {
          const removed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const person = yield* requirePerson(personId);
              if (person.kind === "member") {
                return yield* new MemberNotRemovableError({ personId });
              }
              const sessions = yield* sql<{ readonly session_id: string }>`
                SELECT session_id FROM j5_a2a_person_session WHERE person_id = ${personId}
              `;
              const links = yield* sql<{ readonly pairing_link_id: string }>`
                SELECT pairing_link_id FROM j5_a2a_guest_link WHERE person_id = ${personId}
              `;
              // Each by name, so nothing is left to reach if a connection has cascades off.
              yield* sql`DELETE FROM j5_a2a_person_grant WHERE person_id = ${personId}`;
              yield* sql`DELETE FROM j5_a2a_person_session WHERE person_id = ${personId}`;
              yield* sql`DELETE FROM j5_a2a_guest_link WHERE person_id = ${personId}`;
              // Off every open link's list of who joined, which frees their place on it.
              yield* sql`DELETE FROM j5_a2a_open_link_join WHERE person_id = ${personId}`;
              yield* sql`
                DELETE FROM j5_a2a_human_person WHERE person_id = ${personId} AND kind = 'guest'
              `;
              return {
                sessionIds: sessions.map((row) => row.session_id as AuthSessionId),
                pairingLinkIds: links.map((row) => row.pairing_link_id),
              };
            }),
          );
          yield* changed(personId);
          return removed;
        },
        Effect.mapError(storage("remove a guest")),
      ),

      unbindSession: Effect.fn("j5.sharing.personAccess.unbindSession")(
        function* (sessionId) {
          const rows = yield* sql<{ readonly person_id: string }>`
            DELETE FROM j5_a2a_person_session WHERE session_id = ${sessionId} RETURNING person_id
          `;
          if (rows[0] === undefined) return null;
          const personId = ParticipantId.make(rows[0].person_id);
          yield* changed(personId);
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
          yield* Effect.forEach(personIds, changed, {
            discard: true,
          });
          return personIds;
        },
        Effect.mapError(storage("cut sessions loose from their people")),
      ),

      bindSession: Effect.fn("j5.sharing.personAccess.bindSession")(
        function* (input) {
          yield* requirePerson(input.personId);
          const boundAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
          INSERT INTO j5_a2a_person_session (session_id, person_id, bound_at)
          VALUES (${input.sessionId}, ${input.personId}, ${boundAt})
        `;
        },
        Effect.mapError(storage("tie a session to a person")),
      ),

      sessionPerson,

      threadAccess,

      messageAssetAccess: Effect.fn("j5.sharing.personAccess.messageAssetAccess")(
        function* (session, asset) {
          const person = yield* sessionPerson(session);
          if (person === null) return "member";
          const { personId } = person;
          if (personId === null) return "none";
          const holders =
            asset.kind === "attachment"
              ? yield* attachmentThreads(asset.attachmentId)
              : yield* turnItemThreads(asset.threadId, asset.itemId);
          const levels = yield* Effect.forEach(holders, (holder) =>
            threadLevels(personId, holder.thread_id as ThreadId),
          );
          return highest(levels.flat().map((row) => row.level));
        },
        Effect.mapError(storage("read a person's access to an attachment")),
      ),

      watchThreadAccess: (session, threadId) =>
        session.subject !== GUEST_SESSION_SUBJECT
          ? Stream.make<[Access]>("member")
          : Stream.unwrap(
              Effect.gen(function* () {
                // Subscribed before the first read, so no change between the two is missed.
                const changes = yield* PubSub.subscribe(grantChanges);
                const read = threadAccess(session, threadId);
                return Stream.fromEffect(read).pipe(
                  Stream.concat(
                    Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => read)),
                  ),
                  Stream.changes,
                );
              }),
            ),

      projectAccess: Effect.fn("j5.sharing.personAccess.projectAccess")(
        function* (session, projectId) {
          const person = yield* sessionPerson(session);
          if (person === null) return "member";
          if (person.personId === null) return "none";
          const rows = yield* sql<{ readonly level: GrantLevel }>`
          SELECT level
          FROM j5_a2a_person_grant
          WHERE person_id = ${person.personId}
            AND target_kind = 'project'
            AND target_id = ${projectId}
        `;
          return highest(rows.map((row) => row.level));
        },
        Effect.mapError(storage("read a person's access to a project")),
      ),

      projectInFeed: Effect.fn("j5.sharing.personAccess.projectInFeed")(
        function* (session, projectId) {
          const person = yield* sessionPerson(session);
          if (person === null) return true;
          const { personId } = person;
          if (personId === null) return false;
          // The cheap answers first: a grant on the project, or on a thread that lives in it.
          const direct = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found
            FROM j5_a2a_person_grant AS held
            WHERE held.person_id = ${personId}
              AND (
                (held.target_kind = 'project' AND held.target_id = ${projectId})
                OR (held.target_kind = 'thread' AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_threads AS thread
                  WHERE thread.thread_id = held.target_id
                    AND thread.project_id = ${projectId}
                    AND thread.deleted_at IS NULL
                ))
              )
            LIMIT 1
          `;
          if (direct.length > 0) return true;
          // An agent beneath a granted thread can live in another project; its thread is in the
          // guest's sidebar, and so is that project.
          const threads = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE project_id = ${projectId} AND deleted_at IS NULL
          `;
          for (const thread of threads) {
            if ((yield* threadLevels(personId, thread.thread_id as ThreadId)).length > 0) {
              return true;
            }
          }
          return false;
        },
        Effect.mapError(storage("read whether a project is in a person's sidebar")),
      ),

      subscribeGrantChanges: PubSub.subscribe(grantChanges),
    });
  }),
);

// `readChangesLayer` is the one the rest of the server provides, so it is the same instance
// (see `a2a/runtimeLayer.ts`): what is written here reaches the stream a client follows.
/**
 * Whether a guest, by id, may write to a thread now. For code that acts on a person and has no
 * session of theirs, such as withdrawing what they left queued.
 */
export const guestWritesTo = (sql: SqlClient.SqlClient, personId: string, threadId: ThreadId) =>
  guestGrantsOnThread(sql, threadId).pipe(
    Effect.map((rows) =>
      rows.some(
        (row) =>
          row.person_id === personId && row.level === "collaborate" && grantWrites(row, threadId),
      ),
    ),
  );

export const layer: Layer.Layer<PersonAccess, never, SqlClient.SqlClient> = make.pipe(
  Layer.provide(readChangesLayer),
);
