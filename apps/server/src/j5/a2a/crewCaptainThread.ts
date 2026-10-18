import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * The thread of the Captain a Crew request belongs to: a roster or a request for a further seat,
 * a Crew, or a seat's thread. Who may answer one is whoever can write to that thread (Crews
 * AC23). `null` when nothing names it.
 */
export const crewCaptainThread = (
  sql: SqlClient.SqlClient,
  target:
    | { readonly kind: "proposal"; readonly proposalId: string }
    | { readonly kind: "crew"; readonly crewInstanceId: string }
    | { readonly kind: "seat"; readonly threadId: string },
) =>
  Effect.suspend(() => {
    const rows =
      target.kind === "proposal"
        ? sql<{ readonly captain_thread_id: string }>`
          SELECT captain_thread_id FROM j5_agent_crew_proposal WHERE id = ${target.proposalId}
        `
        : target.kind === "crew"
          ? sql<{ readonly captain_thread_id: string }>`
            SELECT captain_thread_id FROM j5_agent_crew_instance
            WHERE id = ${target.crewInstanceId}
          `
          : sql<{ readonly captain_thread_id: string }>`
            SELECT crew.captain_thread_id
            FROM j5_agent_crew_member AS member
            JOIN j5_agent_crew_instance AS crew ON crew.id = member.crew_instance_id
            WHERE member.thread_id = ${target.threadId} AND crew.archived_at IS NULL
            LIMIT 1
          `;
    return rows.pipe(
      Effect.map((found) =>
        found[0] === undefined ? null : ThreadId.make(found[0].captain_thread_id),
      ),
    );
  });
