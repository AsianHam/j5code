// @effect-diagnostics nodeBuiltinImport:off - random ids for new people.
import * as NodeCrypto from "node:crypto";

import type { AuthSessionId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ParticipantId } from "../a2a/contracts.ts";

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

export interface Person {
  readonly personId: ParticipantId;
  readonly kind: PersonKind;
  readonly displayName: string | null;
}

export interface PersonGrant {
  readonly personId: ParticipantId;
  readonly target: GrantTarget;
  readonly level: GrantLevel;
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

export interface SessionIdentity {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
}

export interface PersonAccessShape {
  /** Records a guest under the name the member bringing them in gave them. */
  readonly createGuest: (input: {
    readonly displayName: string;
  }) => Effect.Effect<Person, PersonAccessStorageError>;
  readonly readPerson: (
    personId: ParticipantId,
  ) => Effect.Effect<Person | null, PersonAccessStorageError>;
  /** Gives a guest a level on a project or thread, replacing any level they held on it. */
  readonly putGrant: (
    grant: PersonGrant,
  ) => Effect.Effect<void, PersonAccessStorageError | PersonNotFoundError | GrantOnMemberError>;
  readonly removeGrant: (input: {
    readonly personId: ParticipantId;
    readonly target: GrantTarget;
  }) => Effect.Effect<void, PersonAccessStorageError>;
  readonly listGrants: (
    personId: ParticipantId,
  ) => Effect.Effect<ReadonlyArray<PersonGrant>, PersonAccessStorageError>;
  /** Ties an auth session to the person it was paired as. */
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
   * A connection's access to a thread. A guest's grant on a thread covers the agents beneath it:
   * the Subagents it ran and the Peer Agents placed under it, Crew seats among them. A fork is a
   * thread of its own and is not covered by its source's grant. A grant on the thread's project
   * covers it too; the higher level applies.
   */
  readonly threadAccess: (
    session: SessionIdentity,
    threadId: ThreadId,
  ) => Effect.Effect<Access, PersonAccessStorageError>;
  /** A connection's access to a project as a whole; a grant on one of its threads gives none. */
  readonly projectAccess: (
    session: SessionIdentity,
    projectId: ProjectId,
  ) => Effect.Effect<Access, PersonAccessStorageError>;
}

export class PersonAccess extends Context.Service<PersonAccess, PersonAccessShape>()(
  "t3/j5/sharing/PersonAccess",
) {}

interface PersonRow {
  readonly person_id: string;
  readonly kind: PersonKind;
  readonly display_name: string | null;
}

interface GrantRow {
  readonly person_id: string;
  readonly target_kind: "project" | "thread";
  readonly target_id: string;
  readonly level: GrantLevel;
}

const toPerson = (row: PersonRow): Person => ({
  personId: ParticipantId.make(row.person_id),
  kind: row.kind,
  displayName: row.display_name,
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
});

const highest = (levels: ReadonlyArray<GrantLevel>): Access =>
  levels.includes("collaborate") ? "collaborate" : levels.includes("view") ? "view" : "none";

type PersonAccessError = PersonAccessStorageError | PersonNotFoundError | GrantOnMemberError;
const isPersonAccessError = Schema.is(
  Schema.Union([PersonAccessStorageError, PersonNotFoundError, GrantOnMemberError]),
);

/** How far up a placement tree a thread grant is looked for; trees are a few levels deep. */
const MAX_ANCESTOR_DEPTH = 64;

export const layer: Layer.Layer<PersonAccess, never, SqlClient.SqlClient> = Layer.effect(
  PersonAccess,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // This module's own errors pass through; anything else is the database.
    const storage =
      (operation: string) =>
      <E>(cause: E): PersonAccessStorageError | Extract<E, PersonAccessError> =>
        isPersonAccessError(cause)
          ? (cause as Extract<E, PersonAccessError>)
          : new PersonAccessStorageError({ operation, cause });

    const readPersonRow = (personId: ParticipantId) =>
      sql<PersonRow>`
        SELECT person_id, kind, display_name
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
          SELECT person.person_id, person.kind, person.display_name
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
      SELECT level
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

    return PersonAccess.of({
      createGuest: Effect.fn("j5.sharing.personAccess.createGuest")(
        function* (input) {
          const personId = ParticipantId.make(`human:${NodeCrypto.randomUUID()}`);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
          INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at, kind, display_name)
          VALUES (${personId}, 0, ${createdAt}, 'guest', ${input.displayName})
        `;
          return { personId, kind: "guest" as const, displayName: input.displayName };
        },
        Effect.mapError(storage("record a guest")),
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
          yield* sql`
          INSERT INTO j5_a2a_person_grant (
            person_id, target_kind, target_id, level, created_at, updated_at
          ) VALUES (${grant.personId}, ${target.kind}, ${target.id}, ${grant.level}, ${now}, ${now})
          ON CONFLICT (person_id, target_kind, target_id)
          DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at
        `;
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
        },
        Effect.mapError(storage("remove a grant")),
      ),

      listGrants: Effect.fn("j5.sharing.personAccess.listGrants")(
        function* (personId) {
          const rows = yield* sql<GrantRow>`
          SELECT person_id, target_kind, target_id, level
          FROM j5_a2a_person_grant
          WHERE person_id = ${personId}
          ORDER BY target_kind, target_id
        `;
          return rows.map(toGrant);
        },
        Effect.mapError(storage("list a person's grants")),
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

      threadAccess: Effect.fn("j5.sharing.personAccess.threadAccess")(
        function* (session, threadId) {
          const person = yield* sessionPerson(session);
          if (person === null) return "member";
          if (person.personId === null) return "none";
          return highest((yield* threadLevels(person.personId, threadId)).map((row) => row.level));
        },
        Effect.mapError(storage("read a person's access to a thread")),
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
    });
  }),
);
