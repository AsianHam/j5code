import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { ThreadId } from "@t3tools/contracts";
import {
  A2AHomeRegistrar,
  type A2AHomeRegistrationError,
  layer as homeRegistrarLayer,
  type RegisteredThreadHome,
} from "./HomeRegistrar.ts";
import { CommCommandId, LedgerProjectId } from "./contracts.ts";

/** A thread as registration sees it, read from upstream's thread projection. */
export interface RegistrableThread {
  readonly projectId: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

export interface ThreadRegistrationShape {
  /**
   * Makes the thread a participant in its project's ledger and returns its home. Safe to call any
   * number of times, from any path: a thread that already has a home keeps it. Returns null for a
   * thread that is never a participant: a provider Subagent, a deleted thread, or one this server
   * does not have.
   */
  readonly ensureRegistered: (
    threadId: ThreadId,
  ) => Effect.Effect<RegisteredThreadHome | null, A2AHomeRegistrationError>;
  /** The thread, when it is one that registers. */
  readonly readRegistrable: (
    threadId: ThreadId,
  ) => Effect.Effect<RegistrableThread | null, A2AHomeRegistrationError>;
}

/**
 * The one place a thread becomes an agent-to-agent participant. A thread's home is its project,
 * which upstream fixes when the thread is created, so registration takes only the thread id.
 */
export class ThreadRegistration extends Context.Service<
  ThreadRegistration,
  ThreadRegistrationShape
>()("t3/j5/a2a/ThreadRegistration") {}

export const registrationCommandId = (threadId: ThreadId) =>
  CommCommandId.make(`command:j5:a2a:thread-registration:${encodeURIComponent(threadId)}`);

export const layer: Layer.Layer<ThreadRegistration, never, A2AHomeRegistrar | SqlClient.SqlClient> =
  Layer.effect(
    ThreadRegistration,
    Effect.gen(function* () {
      const registrar = yield* A2AHomeRegistrar;
      const sql = yield* SqlClient.SqlClient;

      const readRegistrable: ThreadRegistrationShape["readRegistrable"] = (threadId) =>
        sql<{
          readonly project_id: string;
          readonly created_at: string;
          readonly archived_at: string | null;
        }>`
          SELECT project_id, created_at, archived_at
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
            AND deleted_at IS NULL
            AND COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
        `.pipe(
          Effect.map((rows) =>
            rows[0] === undefined
              ? null
              : {
                  projectId: rows[0].project_id,
                  createdAt: rows[0].created_at,
                  archivedAt: rows[0].archived_at,
                },
          ),
        );

      const ensureRegistered: ThreadRegistrationShape["ensureRegistered"] = Effect.fn(
        "j5.a2a.threadRegistration.ensureRegistered",
      )(function* (threadId) {
        const existing = yield* registrar
          .getHomeForThread(threadId)
          .pipe(Effect.catchTags({ A2AHomeNotFoundError: () => Effect.succeed(null) }));
        if (existing !== null) return existing;
        const thread = yield* readRegistrable(threadId);
        if (thread === null) return null;
        return yield* registrar.registerAtCreation({
          projectId: LedgerProjectId.make(thread.projectId),
          threadId,
          createdAt: thread.createdAt,
          commandId: registrationCommandId(threadId),
          // An older thread can be archived already; it joins as archived in the same command.
          ...(thread.archivedAt === null ? {} : { archivedAt: thread.archivedAt }),
        });
      });

      return ThreadRegistration.of({ ensureRegistered, readRegistrable });
    }),
  );

/**
 * Registration with its registrar built in, for the services that register a caller lazily.
 * Neither holds state of its own (the ledger does), so each service can carry one.
 */
export const selfContainedLayer = layer.pipe(Layer.provide(homeRegistrarLayer));
