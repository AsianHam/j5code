import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

export function selectCurrentProposedPlan(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
): Extract<OrchestrationV2ThreadProjection["plans"][number], { kind: "proposed_plan" }> | null {
  type ProposedPlan = Extract<
    OrchestrationV2ThreadProjection["plans"][number],
    { kind: "proposed_plan" }
  >;
  const currentPlans = new Map<ProposedPlan["id"], ProposedPlan>();
  for (const plan of projection.plans) {
    if (plan.kind === "proposed_plan" && plan.runId === runId && plan.status !== "superseded") {
      currentPlans.set(plan.id, plan);
    }
  }
  for (let index = projection.turnItems.length - 1; index >= 0; index -= 1) {
    const item = projection.turnItems[index]!;
    if (item.type !== "proposed_plan" || item.runId !== runId) continue;
    const plan = currentPlans.get(item.planId);
    if (plan !== undefined) return plan;
  }
  return null;
}

/** Preserves upstream refresh behavior and projects a settled structured plan onto disk. */
export const layer = Layer.effect(
  RunFinalization.RunFinalizationObserver,
  Effect.gen(function* () {
    const artifacts = yield* ArtifactWorkspace;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const upstream = yield* RunFinalization.RunFinalizationObserver;
    return RunFinalization.RunFinalizationObserver.of({
      refreshAfterTurn: upstream.refreshAfterTurn,
      refresh: Effect.fn("RunFinalization.RunFinalizationObserver.refresh")(function (input) {
        return upstream.refresh(input).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const projection = yield* projections.getThreadProjection(input.threadId);
              const plan = selectCurrentProposedPlan(projection, input.runId);
              if (plan === null) return;
              yield* artifacts.exportPlan({
                projectId: projection.thread.projectId,
                markdown: plan.markdown,
              });
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Completed plan could not be exported as an artifact", {
                  cause,
                  threadId: input.threadId,
                  runId: input.runId,
                  cwd: input.cwd,
                }),
              ),
            ),
          ),
        );
      }),
    });
  }),
);
