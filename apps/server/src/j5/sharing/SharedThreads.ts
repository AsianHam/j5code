import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { type WriterLevel, levelReaches } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { ParticipantId } from "../a2a/contracts.ts";
import { AccessWriteHook } from "./Access.ts";
import {
  PersonAccess,
  PersonAccessStorageError,
  type ScopePerson,
  layer as personAccessLayer,
} from "./PersonAccess.ts";

/**
 * Who can write to a thread, and whether it is a shared conversation: a thread more than one
 * person can write to, which it stays once it has been (Shared conversations AC6).
 *
 * The first owner writes to every thread, so a thread is shared as soon as anyone else can write
 * to it. That is recorded in two places: inside every change of access that gives someone a
 * writer's level (`recordGainedWriter`, run through `Access`'s write hook), for the threads its
 * scope covers then; and when a person's message reaches a thread with more than one writer
 * (`isShared`), which covers a thread started, or an agent spawned, under a scope shared before.
 */

export interface ThreadWriter {
  readonly personId: ParticipantId;
  readonly displayName: string | null;
  readonly level: WriterLevel;
}

export interface SharedThreadsShape {
  /**
   * Everyone who can write to a thread now: the first owner, the other Owners, then the
   * Collaborators, each group by name. A thread a launch is about to create is not recorded yet; `launchingIn` names its
   * project, whose writers are its writers.
   */
  readonly writers: (
    threadId: ThreadId,
    launchingIn?: ProjectId | null,
  ) => Effect.Effect<ReadonlyArray<ThreadWriter>, PersonAccessStorageError>;
  /** Everyone who can write to every thread in a project, ordered as `writers`. */
  readonly projectWriters: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ThreadWriter>, PersonAccessStorageError>;
  /** The level a person writes to a thread at; `null` when they cannot write to it. */
  readonly writerLevel: (
    personId: ParticipantId,
    threadId: ThreadId,
  ) => Effect.Effect<WriterLevel | null, PersonAccessStorageError>;
  /**
   * Whether a person can write to an agent's thread: whom it may ask, and whose inbox its asks
   * reach (Inbox AC14). An agent with no thread, a machine sender, is its project's.
   */
  readonly writesTo: (
    personId: ParticipantId,
    agent: { readonly threadId: ThreadId | null; readonly projectId: string },
  ) => Effect.Effect<boolean, PersonAccessStorageError>;
  /** Whether a thread is a shared conversation, recording it when it has just become one. */
  readonly isShared: (
    threadId: ThreadId,
    launchingIn?: ProjectId | null,
  ) => Effect.Effect<boolean, PersonAccessStorageError>;
  /**
   * Records as shared every thread a person can write to, when they are not the first owner:
   * each such thread has two writers. Run inside each change of access, before and after it, so a
   * writer added and removed before anyone wrote still leaves the threads they could write to
   * shared, a thread created while they could included.
   */
  readonly recordGainedWriter: (
    personId: ParticipantId,
  ) => Effect.Effect<void, PersonAccessStorageError>;
}

export class SharedThreads extends Context.Service<SharedThreads, SharedThreadsShape>()(
  "t3/j5/sharing/SharedThreads",
) {}

const asWriterLevel = (level: ScopePerson["level"] | null): WriterLevel | null =>
  level === "owner" || level === "collaborator" ? level : null;

/** How deep the tree beneath a shared thread is followed; trees are a few levels deep. */
const MAX_DESCENDANT_DEPTH = 64;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* PersonAccess;
  const storage = (operation: string) => (cause: unknown) =>
    new PersonAccessStorageError({ operation, cause });

  // Owners first, the first owner ahead of them; then each group by name.
  const rank = (entry: ScopePerson) =>
    entry.level === "owner" ? (entry.person.firstOwner ? 0 : 1) : 2;
  const writersOf = (people: ReadonlyArray<ScopePerson>) =>
    people
      .filter((entry) => asWriterLevel(entry.level) !== null)
      .toSorted(
        (left, right) =>
          rank(left) - rank(right) ||
          (left.person.displayName ?? "").localeCompare(right.person.displayName ?? "") ||
          left.person.personId.localeCompare(right.person.personId),
      )
      .map((entry): ThreadWriter => ({
        personId: entry.person.personId,
        displayName: entry.person.displayName,
        level: entry.level as WriterLevel,
      }));

  const projectWriters: SharedThreadsShape["projectWriters"] = (projectId) =>
    access.scopePeople({ kind: "project", projectId }).pipe(Effect.map(writersOf));

  const writers: SharedThreadsShape["writers"] = Effect.fn("j5.sharing.sharedThreads.writers")(
    function* (threadId, launchingIn = null) {
      if (launchingIn !== null && (yield* access.threadProject(threadId)) === null) {
        return yield* projectWriters(launchingIn);
      }
      return writersOf(yield* access.scopePeople({ kind: "thread", threadId }));
    },
  );

  const recordShared = (threadIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (threadIds.length === 0) return;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO j5_a2a_shared_thread ${sql.insert(
          threadIds.map((thread_id) => ({ thread_id, shared_at: at })),
        )}
        ON CONFLICT (thread_id) DO NOTHING
      `;
    });

  /** A thread and every agent beneath it: its Subagents and its placed Peer Agents, not forks. */
  const threadTree = (threadId: ThreadId) => sql<{ readonly thread_id: string }>`
    WITH RECURSIVE tree(thread_id, depth) AS (
      SELECT ${threadId}, 0
      UNION
      SELECT child.thread_id, tree.depth + 1
      FROM tree
      JOIN orchestration_v2_projection_threads AS child
        ON json_extract(child.payload_json, '$.lineage.parentThreadId') = tree.thread_id
       AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      WHERE tree.depth < ${MAX_DESCENDANT_DEPTH}
      UNION
      SELECT placed.thread_id, tree.depth + 1
      FROM tree
      JOIN j5_a2a_membership AS parent ON parent.thread_id = tree.thread_id
      JOIN j5_a2a_participant_placement AS placement
        ON placement.project_id = parent.project_id
       AND placement.placement_parent_id = parent.participant_id
       AND placement.provenance_kind <> 'forked-from'
      JOIN j5_a2a_membership AS placed
        ON placed.project_id = placement.project_id
       AND placed.participant_id = placement.participant_id
      WHERE tree.depth < ${MAX_DESCENDANT_DEPTH} AND placed.thread_id IS NOT NULL
    )
    SELECT DISTINCT thread_id FROM tree
  `;

  return SharedThreads.of({
    writers,
    projectWriters,

    writerLevel: (personId, threadId) =>
      access.threadLevel(personId, threadId).pipe(Effect.map(asWriterLevel)),

    writesTo: (personId, agent) =>
      (agent.threadId === null
        ? access.projectLevel(personId, agent.projectId as ProjectId)
        : access.threadLevel(personId, agent.threadId)
      ).pipe(Effect.map((level) => asWriterLevel(level) !== null)),

    isShared: Effect.fn("j5.sharing.sharedThreads.isShared")(function* (
      threadId,
      launchingIn = null,
    ) {
      // One read answers for nearly every thread: whether it is recorded shared, and whether
      // anyone but the first owner can write to anything at all. On a server one person uses,
      // that is all a message costs.
      const known = yield* sql<{ readonly recorded: number; readonly others: number }>`
        SELECT
          EXISTS (SELECT 1 FROM j5_a2a_shared_thread WHERE thread_id = ${threadId}) AS recorded,
          EXISTS (
            SELECT 1 FROM j5_a2a_person_level AS held
            JOIN j5_a2a_human_person AS person ON person.person_id = held.person_id
            WHERE person.is_local_operator = 0 AND person.removed_at IS NULL
              AND held.level IN ('collaborator', 'owner')
          ) AS others
      `.pipe(Effect.mapError(storage("read whether a thread is shared")));
      if (known[0]?.recorded === 1) return true;
      if (known[0]?.others !== 1) return false;
      if ((yield* writers(threadId, launchingIn)).length < 2) return false;
      yield* recordShared([threadId]).pipe(
        Effect.mapError(storage("record that a thread is shared")),
      );
      return true;
    }),

    recordGainedWriter: Effect.fn("j5.sharing.sharedThreads.recordGainedWriter")(
      function* (personId) {
        const person = yield* access.readPerson(personId);
        if (person === null || person.firstOwner) return;
        const levels = yield* access.listLevels(personId);
        yield* Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          for (const held of levels) {
            if (!levelReaches(held.level, "collaborator")) continue;
            switch (held.scope.kind) {
              case "server":
                yield* sql`
                  INSERT INTO j5_a2a_shared_thread (thread_id, shared_at)
                  SELECT thread_id, ${at} FROM orchestration_v2_projection_threads
                  WHERE deleted_at IS NULL
                  ON CONFLICT (thread_id) DO NOTHING
                `;
                break;
              case "project":
                yield* sql`
                  INSERT INTO j5_a2a_shared_thread (thread_id, shared_at)
                  SELECT thread_id, ${at} FROM orchestration_v2_projection_threads
                  WHERE project_id = ${held.scope.projectId} AND deleted_at IS NULL
                  ON CONFLICT (thread_id) DO NOTHING
                `;
                break;
              case "thread":
                yield* recordShared(
                  (yield* threadTree(held.scope.threadId)).map((row) => row.thread_id),
                );
                break;
            }
          }
        }).pipe(Effect.mapError(storage("record the threads a person can write to as shared")));
      },
    ),
  });
});

/** Over the server's one `PersonAccess` (the same layer object, so the same instance). */
export const layer: Layer.Layer<SharedThreads, never, SqlClient.SqlClient> = Layer.effect(
  SharedThreads,
  make,
).pipe(Layer.provide(personAccessLayer));

/**
 * Runs inside every change of access, before and after it is written: every thread the person
 * can write to then is recorded shared.
 */
export const accessWriteHookLayer: Layer.Layer<AccessWriteHook, never, SqlClient.SqlClient> =
  Layer.effect(
    AccessWriteHook,
    Effect.map(SharedThreads, (shared) =>
      // Before a change too: a thread created while the person could write, then had no
      // message before they lost it, was still shared, and is recorded while their old scope
      // is known (AC6).
      AccessWriteHook.of({
        beforeChange: shared.recordGainedWriter,
        afterChange: shared.recordGainedWriter,
      }),
    ),
  ).pipe(Layer.provide(layer));
