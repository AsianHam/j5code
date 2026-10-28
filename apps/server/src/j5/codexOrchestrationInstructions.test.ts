import { assert, describe, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_SECTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";

// Codex reads the sectioned constant, not the joined one, so J5's text has to replace the
// sections too or Codex silently runs on upstream's instructions.
describe("Codex orchestration instructions", () => {
  it("sends J5's orchestration sections, in order", () => {
    const context = buildCodexAdditionalContext({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });
    const orchestration = Object.entries(context)
      .filter(([key]) => key.startsWith("t3_code_orchestration"))
      .map(([, entry]) => entry.value);

    assert.deepEqual(orchestration, [...T3_CODE_ORCHESTRATION_SECTIONS]);
    assert.include(orchestration.join("\n"), "j5_send_message");
    assert.notInclude(orchestration.join("\n"), "t3_thread_launch");
  });
});
