import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2RuntimePolicy as ProviderAdapterV2RuntimePolicyType,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { withAgentPersonaInstructions } from "../agents/agentPersonaPrompts.ts";
import {
  AgentCrewInstanceService,
  layer as agentCrewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import { CREW_SEAT_QUESTION_INSTRUCTIONS } from "./crewSeatQuestions.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";

export type CrewSeatThread = Pick<OrchestrationV2AppThread, "id" | "createdBy" | "creationSource">;

/** Marks the policy as a seat's and appends the ask-your-Captain rule to its standing instructions. */
export const withCrewSeatQuestions = (
  policy: ProviderAdapterV2RuntimePolicyType,
): ProviderAdapterV2RuntimePolicyType =>
  ProviderAdapterV2RuntimePolicy.make({
    ...policy,
    crewSeat: true,
    agentPersonaInstructions:
      withAgentPersonaInstructions(
        policy.agentPersonaInstructions,
        CREW_SEAT_QUESTION_INSTRUCTIONS,
      ) ?? CREW_SEAT_QUESTION_INSTRUCTIONS,
  });

/**
 * Whether a thread holds a seat in a live Crew. The runtime-policy layers carry no Crew dependency,
 * so the store is built over the ambient SQL client if any (in unit layers nothing is a seat). Only
 * platform-spawned threads are looked up, and an unreadable store logs and answers "not a seat", so
 * an outage never blocks a turn.
 */
export const makeCrewSeatLookup = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return (_thread: CrewSeatThread) => Effect.succeed(false);
  const crews = yield* Effect.service(AgentCrewInstanceService).pipe(
    Effect.provide(agentCrewInstanceLayer),
    Effect.provideService(SqlClient.SqlClient, sql.value),
  );
  return (thread: CrewSeatThread) =>
    thread.createdBy !== "agent" || thread.creationSource !== "mcp"
      ? Effect.succeed(false)
      : crews.findMembership(participantIdForThread(thread.id)).pipe(
          Effect.map((membership) => membership !== null),
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 could not read Crew membership; treating the thread as no seat", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
});
