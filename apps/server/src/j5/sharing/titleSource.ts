import { typedText } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import type { ProjectionRecords } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * Upstream's thread management as its title generator sees it (FORK.md case 91): each person's
 * message it reads is the words they typed, so a title is made from what they wrote and not from
 * the platform's note or author line.
 */
export const layer = Layer.effect(
  ThreadManagementService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inner = yield* ThreadManagementService;
    return ThreadManagementService.of({
      ...inner,
      getThreadRecords: Effect.fn("ThreadManagementService.getThreadRecords")(
        function (threadId, fields, filter) {
          return inner.getThreadRecords(threadId, fields, filter).pipe(
            Effect.flatMap((records) => {
              const { messages } = records as Partial<ProjectionRecords<"messages">>;
              if (messages === undefined) return Effect.succeed(records);
              return sql<{ readonly message_id: string; readonly stored_prefix: string }>`
              SELECT message_id, stored_prefix
              FROM j5_a2a_message_author
              WHERE thread_id = ${threadId} AND stored_prefix <> ''
            `.pipe(
                Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
                Effect.map((rows) => {
                  if (rows.length === 0) return records;
                  const prefixes = new Map(rows.map((row) => [row.message_id, row.stored_prefix]));
                  return {
                    ...records,
                    messages: messages.map((message) => {
                      const storedPrefix = prefixes.get(message.id);
                      return storedPrefix === undefined
                        ? message
                        : { ...message, text: typedText(message.text, { storedPrefix }) };
                    }),
                  } as typeof records;
                }),
              );
            }),
          );
        },
      ),
    });
  }),
);
