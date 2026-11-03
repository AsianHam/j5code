import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ProjectionRecordField,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * A seat's thread under its deterministic id may not exist yet (the spawn never reached it) and
 * that absence is a fact the caller acts on; a store that cannot answer is not, so only a genuine
 * not-found reads as null and every other failure propagates (Jackson's review, 2026-09-18). The
 * orchestrator wraps the store's not-found in its projection error, so the cause is what decides.
 */
const isThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);

export const getThreadRecordsIfPresent = <K extends ProjectionRecordField>(
  threads: Pick<ThreadManagementService["Service"], "getThreadRecords">,
  threadId: ThreadId,
  fields: ReadonlyArray<K>,
  filter?: ProjectionRecordFilter,
) =>
  threads.getThreadRecords(threadId, fields, filter).pipe(
    Effect.map((records): ProjectionRecords<K> | null => records),
    Effect.catchTags({
      OrchestratorProjectionError: (error) =>
        isThreadNotFound(error.cause) ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
