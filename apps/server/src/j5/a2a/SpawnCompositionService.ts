import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  A2AHomeRegistrationTransaction,
  type A2AHomeRegistrationError,
  type RegisteredThreadHome,
} from "./HomeRegistrar.ts";
import { A2ALedgerTransactionWriter } from "./LedgerService.ts";
import { ParticipantPlacementTransactionWriter, type PlacementError } from "./PlacementService.ts";
import type { CommCommandId, LedgerProjectId } from "./contracts.ts";
import { recordOutsideAgentName } from "./outsideAgentNames.ts";
import type {
  ParticipantPlacement,
  ParticipantProvenance,
  PlacementCommandId,
} from "./placementContracts.ts";

export interface RecordSpawnFactsInput {
  readonly homeCommandId: CommCommandId;
  readonly placementCommandId: PlacementCommandId;
  readonly projectId: LedgerProjectId;
  readonly threadId: ThreadId;
  readonly provenance: ParticipantProvenance;
  /**
   * Set when the spawner is an outside agent: the label its client signed in with, recorded with
   * the placement so the spawner named in provenance is one this server knows.
   */
  readonly outsideSpawnerName?: string;
  readonly createdAt: string;
}

export interface RecordSpawnFactsResult {
  readonly home: RegisteredThreadHome;
  readonly placement: ParticipantPlacement;
}

export type RecordSpawnFactsError = A2AHomeRegistrationError | PlacementError | SqlError;

export interface SpawnCompositionServiceShape {
  readonly recordFacts: (
    input: RecordSpawnFactsInput,
  ) => Effect.Effect<RecordSpawnFactsResult, RecordSpawnFactsError>;
}

export class SpawnCompositionService extends Context.Service<
  SpawnCompositionService,
  SpawnCompositionServiceShape
>()("t3/j5/a2a/SpawnCompositionService") {}

export const layer: Layer.Layer<
  SpawnCompositionService,
  never,
  | A2AHomeRegistrationTransaction
  | A2ALedgerTransactionWriter
  | ParticipantPlacementTransactionWriter
  | SqlClient.SqlClient
> = Layer.effect(
  SpawnCompositionService,
  Effect.gen(function* () {
    const homes = yield* A2AHomeRegistrationTransaction;
    const ledgerWriter = yield* A2ALedgerTransactionWriter;
    const placements = yield* ParticipantPlacementTransactionWriter;
    const sql = yield* SqlClient.SqlClient;

    // Lifecycle writers share one total lock order:
    // drainPermit ≺ appendPermit ≺ mutationPermit ≺ DB. Spawn never drains: this
    // coordinator never acquires drainPermit, which is private to DeliveryWorker
    // and cannot be held across this call. A delivery drain may be in flight while
    // this runs; it simply contends for appendPermit. If a future lifecycle path
    // exposes and holds a drain permit while composing, it must acquire that
    // permit before appendPermit.
    const recordFacts: SpawnCompositionServiceShape["recordFacts"] = (input) =>
      ledgerWriter.withPermit(
        placements.withPermit(
          sql
            .withTransaction(
              Effect.gen(function* () {
                const registered = yield* homes.registerAtCreationInTransaction({
                  commandId: input.homeCommandId,
                  projectId: input.projectId,
                  threadId: input.threadId,
                  createdAt: input.createdAt,
                });
                if (
                  input.outsideSpawnerName !== undefined &&
                  input.provenance.kind === "spawned-by"
                ) {
                  yield* recordOutsideAgentName(sql, {
                    participantId: input.provenance.spawnedByParticipantId,
                    name: input.outsideSpawnerName,
                    at: input.createdAt,
                  });
                }
                const placement = yield* placements.recordCreationInTransaction({
                  commandId: input.placementCommandId,
                  projectId: input.projectId,
                  participantId: registered.home.participantId,
                  actor: "agent",
                  provenance: input.provenance,
                  createdAt: input.createdAt,
                });
                return {
                  home: registered.home,
                  placement: placement.placement,
                  committedEvents: registered.committedEvents,
                };
              }),
            )
            .pipe(
              Effect.tap((result) => ledgerWriter.publishCommitted(result.committedEvents)),
              Effect.map(({ home, placement }) => ({ home, placement })),
            ),
        ),
      );

    return SpawnCompositionService.of({ recordFacts });
  }),
);
