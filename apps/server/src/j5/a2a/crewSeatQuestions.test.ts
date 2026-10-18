import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  buildCodexTurnStartParams,
  codexThreadRuntimeParams,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { CREW_SEAT_QUESTION_INSTRUCTIONS, J5_CODEX_CREW_SEAT_CONFIG } from "./crewSeatQuestions.ts";
import { withCrewSeatQuestions } from "./crewSeatRuntime.ts";

const basePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const seatPolicy = withCrewSeatQuestions(basePolicy);

describe("Crew seat question tools on Codex", () => {
  it("turns request_user_input off in a seat's thread config and nowhere else", () => {
    const threadId = ThreadId.make("thread-codex-crew-seat");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-codex-crew-seat"),
      threadId,
      providerSessionId: "mcp-session-codex-crew-seat",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    };
    const seat = codexThreadRuntimeParams({ mcpSession, runtimePolicy: seatPolicy }).config;
    assert.strictEqual(seat?.["features.default_mode_request_user_input"], false);
    assert.strictEqual(seat?.["tools.experimental_request_user_input.enabled"], false);
    assert.property(seat, "mcp_servers");

    const captain = codexThreadRuntimeParams({ mcpSession, runtimePolicy: basePolicy }).config;
    for (const key of Object.keys(J5_CODEX_CREW_SEAT_CONFIG)) assert.notProperty(captain, key);
  });

  it.effect("sends the ask-your-Captain rule with a seat's turn and no other", () =>
    Effect.gen(function* () {
      const turn = (runtimePolicy: typeof basePolicy) =>
        buildCodexTurnStartParams({
          nativeThreadId: "native-crew-seat",
          codexInput: [{ type: "text", text: "review the change" }],
          runtimePolicy,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
          hasT3Mcp: true,
        });
      const seat = yield* turn(seatPolicy);
      assert.deepEqual(seat.additionalContext?.j5_agent_persona, {
        kind: "application",
        value: CREW_SEAT_QUESTION_INSTRUCTIONS,
      });
      const captain = yield* turn(basePolicy);
      assert.notProperty(captain.additionalContext, "j5_agent_persona");
    }),
  );
});
