import { assert, describe, it } from "@effect/vitest";

import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { J5_DELEGATE_TASK_DESCRIPTION, J5DelegateTaskTool } from "./agentDelegation.ts";

describe("J5 delegate_task description", () => {
  it("leads with the saved-agent use and keeps ordinary subagent requests provider-native", () => {
    assert.equal(J5DelegateTaskTool.description, J5_DELEGATE_TASK_DESCRIPTION);
    assert.include(
      J5_DELEGATE_TASK_DESCRIPTION,
      "Pass persona=ID when the user writes @persona:ID",
    );
    assert.include(J5_DELEGATE_TASK_DESCRIPTION, "omit target and runtimeMode");
    assert.include(J5_DELEGATE_TASK_DESCRIPTION, "provider's native subagent mechanism");
    // Upstream's opening sentences would make this tool the default for any subagent request.
    assert.notInclude(J5_DELEGATE_TASK_DESCRIPTION, "Use this whenever the user asks for an agent");
    assert.notInclude(
      J5_DELEGATE_TASK_DESCRIPTION,
      OrchestratorToolkit.tools.delegate_task.description ?? "upstream",
    );
    // The mechanics the model still needs are kept.
    for (const kept of [
      "mode='async'",
      "timeoutMs",
      "waitTimedOut",
      "task_status",
      "pendingApproval",
      "inheritedOptions",
      "target.options",
    ]) {
      assert.include(J5_DELEGATE_TASK_DESCRIPTION, kept);
    }
  });
});
