import { type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveThreadHome } from "./HomeRegistrar.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { ExchangeId, ParticipantId, LedgerProjectId, type Urgency } from "./contracts.ts";

export type ArchivePlacementSubtree =
  | {
      readonly state: "unknown";
      readonly reason: "placement-query-failed";
    }
  | { readonly state: "none" }
  | {
      readonly state: "known";
      readonly participantIds: readonly [ParticipantId, ...Array<ParticipantId>];
    };

export class A2AArchivePlacementFactsProviderError extends Schema.TaggedError<A2AArchivePlacementFactsProviderError>()(
  "A2AArchivePlacementFactsProviderError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface A2AArchivePlacementFactsProviderShape {
  readonly readSubtree: (input: {
    readonly projectId: LedgerProjectId;
    readonly participantId: ParticipantId;
  }) => Effect.Effect<ArchivePlacementSubtree, A2AArchivePlacementFactsProviderError>;
}

export class A2AArchivePlacementFactsProvider extends Context.Service<
  A2AArchivePlacementFactsProvider,
  A2AArchivePlacementFactsProviderShape
>()("t3/j5/a2a/ArchiveFactsService/A2AArchivePlacementFactsProvider") {}

/**
 * AR2's production placement reader. `listSubtree` includes the requested
 * participant, while the warning only names agents additionally affected by
 * archive, so the root is deliberately omitted here. It also walks archived
 * membership rows; those agents are already retired and are dropped, while
 * their live descendants stay.
 */
export const placementFactsLayer = Layer.effect(
  A2AArchivePlacementFactsProvider,
  Effect.gen(function* () {
    const placements = yield* ParticipantPlacementService;
    return A2AArchivePlacementFactsProvider.of({
      readSubtree: Effect.fn("A2AArchivePlacementFactsProvider.readSubtree")(function (input) {
        return placements.listSubtree(input).pipe(
          Effect.map((subtree) => {
            const descendantIds = subtree
              .filter(
                (entry) => entry.participantId !== input.participantId && entry.archivedAt === null,
              )
              .map((entry) => entry.participantId);
            return descendantIds.length === 0
              ? { state: "none" as const }
              : {
                  state: "known" as const,
                  participantIds: descendantIds as [ParticipantId, ...Array<ParticipantId>],
                };
          }),
          Effect.mapError(
            (cause) =>
              new A2AArchivePlacementFactsProviderError({
                operation: "read placement subtree",
                cause,
              }),
          ),
        );
      }),
    });
  }),
);

export interface OpenExchangeArchiveFact {
  readonly projectId: LedgerProjectId;
  readonly exchangeId: ExchangeId;
  readonly direction: "inbound" | "outbound";
  readonly replyObligation: "participant-owes-reply" | "counterparty-owes-reply";
  readonly counterpartyId: ParticipantId;
  readonly intent: string;
  readonly urgency: Urgency | null;
  readonly openedAt: string;
}

export type ThreadPreArchiveFacts =
  | {
      readonly state: "not-an-a2a-participant";
      readonly threadId: ThreadId;
      readonly openExchanges: readonly [];
      readonly placementSubtree: { readonly state: "not-applicable" };
    }
  | {
      readonly state: "registered";
      readonly threadId: ThreadId;
      readonly projectId: LedgerProjectId;
      readonly participantId: ParticipantId;
      readonly retired: boolean;
      readonly archived: boolean;
      readonly openExchanges: ReadonlyArray<OpenExchangeArchiveFact>;
      readonly placementSubtree: ArchivePlacementSubtree;
    };

export class A2AArchiveFactsError extends Schema.TaggedError<A2AArchiveFactsError>()(
  "A2AArchiveFactsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface A2AArchiveFactsShape {
  /**
   * Read-only facts for the future human pre-archive dialog. This method does
   * not decide whether archive or settle is allowed and performs no mutation.
   */
  readonly readForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadPreArchiveFacts, A2AArchiveFactsError>;
}

export class A2AArchiveFacts extends Context.Service<A2AArchiveFacts, A2AArchiveFactsShape>()(
  "t3/j5/a2a/ArchiveFactsService/A2AArchiveFacts",
) {}

interface ExchangeRow {
  readonly project_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly intent: string;
  readonly urgency: Urgency | null;
  readonly created_at: string;
}

const archiveFactsError = (operation: string) => (cause: unknown) =>
  new A2AArchiveFactsError({ operation, cause });

export const layer = Layer.effect(
  A2AArchiveFacts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const placement = yield* A2AArchivePlacementFactsProvider;

    const readForThread: A2AArchiveFactsShape["readForThread"] = Effect.fn(
      "j5.a2a.archiveFacts.readForThread",
    )(
      function* (threadId) {
        const resolution = yield* resolveThreadHome(sql, threadId).pipe(
          Effect.catchTags({ A2AHomeNotFoundError: () => Effect.succeed(null) }),
        );
        if (resolution === null) {
          return {
            state: "not-an-a2a-participant",
            threadId,
            openExchanges: [],
            placementSubtree: { state: "not-applicable" },
          } as const;
        }

        const participantId = resolution.home.participantId;
        const rows = yield* sql<ExchangeRow>`
          SELECT
            project_id,
            exchange_id,
            sender_id,
            receiver_id,
            intent,
            urgency,
            created_at
          FROM j5_a2a_exchange
          WHERE status = 'open'
            AND (sender_id = ${participantId} OR receiver_id = ${participantId})
          ORDER BY created_at, project_id, exchange_id
        `;
        const openExchanges = rows.map((row): OpenExchangeArchiveFact => {
          const inbound = row.receiver_id === participantId;
          return {
            projectId: LedgerProjectId.make(row.project_id),
            exchangeId: ExchangeId.make(row.exchange_id),
            direction: inbound ? "inbound" : "outbound",
            replyObligation: inbound ? "participant-owes-reply" : "counterparty-owes-reply",
            counterpartyId: ParticipantId.make(inbound ? row.sender_id : row.receiver_id),
            intent: row.intent,
            urgency: row.urgency,
            openedAt: row.created_at,
          };
        });
        const placementSubtree = yield* placement
          .readSubtree({
            projectId: resolution.home.projectId,
            participantId,
          })
          .pipe(
            Effect.catchCause(() =>
              Effect.succeed({
                state: "unknown" as const,
                reason: "placement-query-failed" as const,
              }),
            ),
          );
        return {
          state: "registered",
          threadId,
          projectId: resolution.home.projectId,
          participantId,
          retired: resolution.retired,
          archived:
            (yield* sql<{
              readonly archived_at: string | null;
            }>`SELECT archived_at FROM j5_a2a_membership WHERE participant_id = ${participantId}`)[0]
              ?.archived_at != null,
          openExchanges,
          placementSubtree,
        } as const;
      },
      Effect.mapError(archiveFactsError("read pre-archive facts")),
    );

    return A2AArchiveFacts.of({ readForThread });
  }),
);
